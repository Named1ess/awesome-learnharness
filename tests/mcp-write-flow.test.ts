import assert from "node:assert/strict";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

test("stdio import and attachment use the application's real write handlers", { timeout: 30_000 }, async t => {
	const scratch = await mkdtemp(join(tmpdir(), "lh mcp write flow "));
	const client = new Client({ name: "mcp-write-flow-fixture", version: "1" });
	let app: ReturnType<typeof createServer> | undefined;
	t.after(async () => {
		try { await client.close(); }
		finally {
			const server = app;
			try {
				if (server?.listening) await new Promise<void>((resolve, reject) => {
					server.close(error => error ? reject(error) : resolve());
				});
			} finally { await rm(scratch, { recursive: true, force: true }); }
		}
	});
	const data = join(scratch, "learning data");
	const files = join(scratch, "files");
	const auth = join(scratch, "auth.json");
	const token = "ab".repeat(32);
	const filePath = "Course Notes/学习 notes.md";
	const document = join(files, ...filePath.split("/"));
	const originalNotes = "# Study notes\n\nA fixture proposition about invariants.";
	const plainText = "A UTF-8 text fixture about 不变量.";
	await mkdir(data);
	await mkdir(join(files, "Course Notes"), { recursive: true });
	await writeFile(auth, "{}");
	await writeFile(document, originalNotes);
	await writeFile(join(files, "plain.txt"), plainText);
	await writeFile(join(files, "lesson.pdf"), tinyPdf([{ runs: [{ text: "A PDF lesson about invariants.", x: 72, y: 720 }] }]));
	Object.assign(process.env, { LH_DATA_DIR: data, LH_AUTH_FILE: auth, OPENROUTER_API_KEY: "fixture-only" });

	const { handleMcpWriteRequest } = await import("../src/server/mcp-write.ts");
	const { extraction, handleMcpAttachment } = await import("../src/server/chat-handler.ts");
	const { importGraphNotes } = await import("../src/server/notes-import.ts");
	const { createExtractionPipeline } = await import("../src/agent/subagents/extraction.ts");
	const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
	const { quoteFilePath } = await import("../src/core/file-paths.ts");
	const { stores } = await import("../src/server/stores.ts");
	const { runningTurn } = await import("../src/server/turn-runs.ts");

	const importedInputs: { filePath: string; text: string }[] = [];
	const pipeline = createExtractionPipeline({
		...stores,
		engineFor(role) {
			const faux = createFauxCore({});
			const response = role === "extractor"
				? fauxToolCall("submit_findings", {
					propositions: [{ id: "p1", name: "Invariants", statement: "A fixture proposition about invariants.", aliases: [] }],
					chains: [],
				})
				: fauxToolCall("submit_review", { links: [] });
			faux.setResponses([() => fauxAssistantMessage([response], { stopReason: "toolUse" })]);
			return { model: faux.getModel(), streamFn: faux.streamSimple };
		},
	});
	t.mock.method(extraction, "importNotes", async (input: { filePath: string; text: string }) => {
		importedInputs.push(input);
		return pipeline.importNotes(input);
	});

	const { chatStore, graphStore, sourceOrganizationStore } = stores;
	const { id } = chatStore.createChat("MCP flow");
	chatStore.saveSettings(id, { model: { provider: "openrouter", id: "openrouter/free" } });
	const teacher = createFauxCore({});
	const message = "Explain these notes";
	const expectedText = `${message}\n${quoteFilePath(realpathSync.native(document))}`;
	let agentBuilds = 0;
	let teacherRequests = 0;
	teacher.setResponses([(context) => {
		teacherRequests++;
		const saved = chatStore.getChat(id)?.messages;
		assert.equal(saved?.length, 1);
		assert.equal(saved[0]?.role, "user");
		assert.equal(saved[0]?.content, expectedText);
		assert.ok(context.messages.some(entry => entry.role === "user" && entry.content === expectedText));
		return fauxAssistantMessage([fauxText("Fixture response.")]);
	}]);

	const errors: unknown[] = [];
	app = createServer((request, response) => {
		void (async () => {
			assert.equal(request.method, "POST");
			assert.equal(request.url, "/api/mcp/write");
			const headers = new Headers();
			for (const [name, value] of Object.entries(request.headers)) {
				for (const entry of typeof value === "string" ? [value] : value ?? []) headers.append(name, entry);
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk);
			const result = await handleMcpWriteRequest(new Request(`http://${headers.get("host")}${request.url}`, {
				method: "POST", headers, body: Buffer.concat(chunks).toString("utf8"),
			}), {
				env: { LH_MCP_WRITE_TOKEN: token, LH_MCP_FILES_DIR: files },
				importGraphNotes,
				handleMcpAttachment: (sessionId, text) => handleMcpAttachment(sessionId, text, options => {
					agentBuilds++;
					return createTeacherAgent(undefined, {
						...options,
						engine: { model: teacher.getModel(), streamFn: teacher.streamSimple },
					});
				}),
			});
			response.writeHead(result.status, Object.fromEntries(result.headers)).end(await result.text());
		})().catch(error => {
			errors.push(error);
			response.writeHead(500).end();
		});
	});
	app.listen(0, "127.0.0.1");
	await once(app, "listening");

	const entry = fileURLToPath(new URL("../scripts/learnharness-mcp.mjs", import.meta.url));
	await client.connect(new StdioClientTransport({
		command: process.execPath,
		args: [entry, "--data-dir", data, "--app-url", `http://127.0.0.1:${(app.address() as AddressInfo).port}`],
		cwd: scratch,
		env: { LH_MCP_WRITE_TOKEN: token },
	}));
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
		assert.equal(result.isError ?? false, false, JSON.stringify({ result, errors }));
		assert.ok(Array.isArray(result.content));
		const block = result.content[0];
		assert.equal(block?.type, "text");
		return JSON.parse(block.text);
	};

	const imported = await call("import_file", { path: filePath });
	assert.deepEqual(imported, { results: [{ filePath, requestIndex: 0, outcome: "completed", ok: true, stats: { nodes: 1, chains: 0 } }] });
	assert.deepEqual(importedInputs, [{ filePath, text: originalNotes }]);
	const [source] = graphStore.readSources();
	assert.equal(source?.filePath, filePath);
	assert.ok(sourceOrganizationStore.read().placements[source.id]?.folderId);
	assert.equal(graphStore.readNodes()[0]?.provenance[0]?.chatId, source.id);
	const textImport = await call("import_file", { path: "plain.txt" });
	assert.equal(textImport.results[0]?.outcome, "completed");
	assert.deepEqual(importedInputs[1], { filePath: "plain.txt", text: plainText });
	const pdfImport = await call("import_file", { path: "lesson.pdf" });
	assert.equal(pdfImport.results[0]?.outcome, "completed");
	assert.match(pdfImport.results[0]?.notice, /Scanned pages may have errors/);
	assert.equal(importedInputs[2]?.filePath, "lesson.pdf");
	assert.match(importedInputs[2]?.text ?? "", /--- Page 1 ---\s+A PDF lesson about invariants\./);

	assert.deepEqual(await call("attach_file", { session_id: id, path: filePath, message }), { session_id: id, status: "accepted" });
	const active = runningTurn(id);
	if (active) await new Response(active.subscribe()).text();
	assert.equal(agentBuilds, 1);
	assert.equal(teacherRequests, 1);
	const settled = chatStore.getChat(id)?.messages;
	assert.equal(settled?.length, 2);
	assert.equal(settled[0]?.content, expectedText);
	assert.match(JSON.stringify(settled[1]), /Fixture response\./);
	assert.deepEqual(errors, []);
});
