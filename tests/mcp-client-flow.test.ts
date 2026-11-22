import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

interface Operation {
	operation_id: string;
	status: string;
	steps: { id: string; role: string }[];
	result?: unknown;
	error?: string;
}
type Reply = { text?: string; tool_calls?: { name: string; arguments: Record<string, unknown> }[] };
type Transcript = { messages: { role: string; content?: unknown; tools?: { name: string }[] }[] };
const tool = (name: string, args: Record<string, unknown>): Reply => ({ tool_calls: [{ name, arguments: args }] });

test("client-driven stdio runs all approved native learning workflows with no app models or keys", { timeout: 55_000 }, async t => {
	const scratch = await mkdtemp(join(tmpdir(), "learnharness mcp current caller "));
	let app: ReturnType<typeof createServer> | undefined;
	let client: Client | undefined;
	t.after(async () => {
		try { await client?.close(); }
		finally {
			const server = app;
			try {
				if (server?.listening) await new Promise<void>((resolve, reject) => {
					server.close(error => error ? reject(error) : resolve());
					server.closeAllConnections();
				});
			} finally { await rm(scratch, { recursive: true, force: true }); }
		}
	});
	const data = join(scratch, "learning data");
	const files = join(scratch, "shared notes");
	const auth = join(scratch, "auth.json");
	const token = "d9".repeat(32);
	await mkdir(data);
	await mkdir(files);
	await writeFile(auth, "{}");
	await writeFile(join(files, "lesson notes.md"), "# A lesson about invariants.\n\nMarkdown fixture.");
	await writeFile(join(files, "plain.txt"), "UTF-8 text about 不变量.");
	await writeFile(join(files, "lesson.pdf"), tinyPdf([{ runs: [{ text: "A PDF about invariants.", x: 72, y: 720 }] }]));
	const outsideFile = join(scratch, "outside.txt");
	await writeFile(outsideFile, "THIS-CONTENT-MUST-NOT-REACH-CODEX");
	Object.assign(process.env, { LH_DATA_DIR: data, LH_AUTH_FILE: auth, LH_IGNORE_ENV_KEYS: "1" });

	const { handleMcpWriteRequest } = await import("../src/server/mcp-write.ts");
	const { handleMcpClientOperation } = await import("../src/server/mcp-client-operations.ts");
	const { handleMcpAttachment } = await import("../src/server/chat-handler.ts");
	const { importGraphNotes } = await import("../src/server/notes-import.ts");
	const { stores } = await import("../src/server/stores.ts");
	assert.equal(stores.settingsStore.readSettings(), null);

	const httpErrors: unknown[] = [];
	app = createServer((request, response) => {
		void (async () => {
			assert.equal(request.method, "POST");
			assert.equal(request.url, "/api/mcp/write");
			const headers = new Headers();
			for (const [name, value] of Object.entries(request.headers)) {
				for (const item of typeof value === "string" ? [value] : value ?? []) headers.append(name, item);
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk);
			const result = await handleMcpWriteRequest(new Request(`http://${headers.get("host")}${request.url}`, {
				method: "POST", headers, body: Buffer.concat(chunks).toString("utf8"),
			}), { env: { LH_MCP_WRITE_TOKEN: token, LH_MCP_FILES_DIR: files }, handleMcpClientOperation, handleMcpAttachment, importGraphNotes });
			response.writeHead(result.status, Object.fromEntries(result.headers)).end(await result.text());
		})().catch(error => {
			httpErrors.push(error);
			response.writeHead(500).end();
		});
	});
	app.listen(0, "127.0.0.1");
	await once(app, "listening");
	const port = (app.address() as AddressInfo).port;
	async function connect() {
		const connected = new Client({ name: "current-mcp-client-fixture", version: "1" });
		await connected.connect(new StdioClientTransport({
			command: process.execPath,
			args: [fileURLToPath(new URL("../scripts/learnharness-mcp.mjs", import.meta.url)),
				"--data-dir", data, "--app-url", `http://127.0.0.1:${port}`, "--client-reasoning"],
			cwd: scratch, env: { LH_MCP_WRITE_TOKEN: token },
		}));
		return connected;
	}
	client = await connect();
	const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
		const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
		assert.equal(response.isError ?? false, false, JSON.stringify({ name, response, httpErrors }));
		assert.ok(Array.isArray(response.content));
		const block = response.content[0];
		assert.equal(block?.type, "text");
		return JSON.parse(block.text) as T;
	};
	const poll = (operationId: string) => call<Operation>("get_operation", { operation_id: operationId });
	async function readContext(operationId: string, stepId: string) {
		let offset: number | null = 0;
		let context = "";
		do {
			const page: { context: string; next_offset: number | null } = await call("read_inference_step", { operation_id: operationId, step_id: stepId, offset });
			context += page.context;
			offset = page.next_offset;
		} while (offset !== null);
		return JSON.parse(context) as Transcript;
	}
	async function drive(start: Operation, answer: (role: string, transcript: Transcript) => Reply, terminal = "completed") {
		const expires = Date.now() + 12_000;
		while (Date.now() < expires) {
			const status = await poll(start.operation_id);
			if (["completed", "failed", "cancelled"].includes(status.status)) {
				assert.equal(status.status, terminal, JSON.stringify(status));
				return status;
			}
			for (const step of status.steps) {
				const context = await readContext(start.operation_id, step.id);
				const reply = answer(step.role, context);
				await call("submit_inference_step", { operation_id: start.operation_id, step_id: step.id, reply });
			}
			await delay(15);
		}
		assert.fail("Operation did not settle: " + JSON.stringify(await poll(start.operation_id)));
	}
	const startInput = (session_id: string, request_id: string, input: Record<string, unknown>) =>
		call<Operation>("submit_session_input", { session_id, request_id, input });

	const lesson = await call<{ id: string }>("create_session", { kind: "teach", title: "Invariants" });
	const teach = await startInput(lesson.id, "teach-1", { type: "text", text: "I can recognize an invariant. Teach me to use it in a proof." });
	let probe = 0;
	await drive(teach, role => role === "teacher" ? { text: "First establish the invariant and then prove it is preserved." }
		: probe++ === 0 ? tool("probe_done", { assessment: { strands: [{ strand: "Invariants", assessment: "Can identify them, needs proof practice." }] } })
			: { text: "Let's use what you know." });
	const lessonState = await call<{ phase: string; latest_side_anchor: unknown }>("get_session_state", { session_id: lesson.id });
	assert.equal(lessonState.phase, "teach");
	assert.ok(lessonState.latest_side_anchor);
	const transcript = await call<{ markdown: string }>("read_session", { session_id: lesson.id });
	assert.match(transcript.markdown, /prove it is preserved/);

	const side = await call<Operation>("ask_follow_up", { session_id: lesson.id, request_id: "side-1",
		input: { anchor: lessonState.latest_side_anchor, text: "What does preserved mean?" } });
	await drive(side, role => {
		assert.equal(role, "sideQuestion");
		return { text: "It still holds after the update." };
	});
	const threads = await call<{ items: { id: string; last_message: { text: string } }[] }>("list_side_threads", { session_id: lesson.id });
	assert.equal(threads.items[0]?.last_message.text, "It still holds after the update.");
	const sideThread = await call<{ transcript: string }>("read_side_thread", { session_id: lesson.id, thread_id: threads.items[0]!.id });
	assert.match(sideThread.transcript, /What does preserved mean\?/);
	assert.match(sideThread.transcript, /It still holds after the update/);

	const attached = await call<Operation>("attach_file", { session_id: lesson.id, path: "lesson notes.md", message: "Use this reference.", request_id: "attach-1" });
	await drive(attached, (role, context) => {
		assert.equal(role, "teacher");
		assert.match(JSON.stringify(context), /lesson notes\.md/);
		return { text: "The reference gives another invariant example." };
	});
	const questionTurn = await startInput(lesson.id, "teach-question", { type: "text", text: "Ask me a short follow-up." });
	await drive(questionTurn, () => tool("ask_user_question", { question: "Which part of the proof is preserved?" }));
	const asked = await call<{ pending_question: { tool_call_id: string; occurrence: unknown; prompt: string } }>("get_session_state", { session_id: lesson.id });
	assert.match(asked.pending_question.prompt, /Which part of the proof is preserved/);
	const answered = await startInput(lesson.id, "teach-answer", { type: "answer", toolCallId: asked.pending_question.tool_call_id,
		occurrence: asked.pending_question.occurrence, answer: { text: "The property holds after every step." } });
	await drive(answered, (_, context) => {
		assert.match(JSON.stringify(context), /property holds after every step/);
		return { text: "Exactly. Establish the base case too." };
	});
	assert.equal((await call<{ pending_question: unknown }>("get_session_state", { session_id: lesson.id })).pending_question, null);
	const filePolicyTurn = await startInput(lesson.id, "file-scope", { type: "text", text: "Check the shared notes directory." });
	let guardStep = 0;
	await drive(filePolicyTurn, (_, context) => {
		if (guardStep++ === 0) return tool("read", { path: outsideFile });
		const visible = JSON.stringify(context);
		assert.match(visible, /outside the allowed folders/);
		assert.doesNotMatch(visible, /THIS-CONTENT-MUST-NOT-REACH-CODEX/);
		return { text: "That file is outside the shared directory." };
	});

	const practice = await call<{ id: string }>("create_session", { kind: "practice", title: "Proof practice" });
	const firstProblem = await startInput(practice.id, "practice-1", { type: "text", text: "Start practice on even numbers." });
	await drive(firstProblem, () => tool("problem", { statement: "Show that the sum of even numbers is even.", mode: "composition", modelSolution: "SECRET-SOLUTION twice the sum of the half values." }));
	const posed = await call<{ active_problem: { tool_call_id: string; occurrence: unknown } }>("get_session_state", { session_id: practice.id });
	assert.ok(posed.active_problem);
	assert.doesNotMatch(JSON.stringify(posed), /SECRET-SOLUTION/);
	const work = await startInput(practice.id, "practice-2", { type: "thinking", problemCallId: posed.active_problem.tool_call_id,
		occurrence: posed.active_problem.occurrence, text: "Let them be 2a and 2b. The sum is 2(a+b)." });
	let conclusion = 0;
	await drive(work, () => conclusion++ === 0
		? tool("conclude", { outcome: "solved", verdict: "Correct factorization.", rung: null, missClass: null, retest: false })
		: { text: "Your factorization proves the claim." });
	const next = await startInput(practice.id, "practice-3", { type: "next" });
	await drive(next, () => tool("problem", { statement: "Show that the product of an even number and any integer is even.",
		mode: "composition", modelSolution: "Factor out two." }));
	assert.match(JSON.stringify((await call<{ active_problem: unknown }>("get_session_state", { session_id: practice.id })).active_problem), /product/);

	for (const [index, file] of ["lesson notes.md", "plain.txt", "lesson.pdf"].entries()) {
		const imported = await call<Operation>("import_file", { path: file, request_id: "import-" + index });
		const outcome = await drive(imported, role => role === "extractor"
			? tool("submit_findings", { propositions: [{ id: "p1", name: "Fixture source " + index, statement: "A property preserved by an operation is invariant.", aliases: [] }], chains: [] })
			: tool("submit_review", { links: [] }));
		assert.match(JSON.stringify(outcome.result), /"outcome":"completed"/);
	}
	const nativeLesson = stores.chatStore.getChat(lesson.id);
	const messageId = nativeLesson?.messages.find(message => message.role === "assistant" &&
		message.content.some(block => block.type === "text" && block.text.includes("prove it is preserved")))?.id;
	assert.ok(messageId);
	const extraction = await call<Operation>("extract_session_graph", { session_id: lesson.id, request_id: "extract-1" });
	await drive(extraction, role => role === "extractor"
		? tool("submit_findings", { propositions: [{ id: "p1", name: "Session invariant", statement: "An invariant holds after each update.", aliases: [], messageId }], chains: [] })
		: tool("submit_review", { links: [] }));
	const graph = await call<{ items: { name: string }[] }>("list_propositions", { query: "Session invariant" });
	assert.equal(graph.items[0]?.name, "Session invariant");
	assert.equal((await call<{ items: unknown[] }>("list_chains", {})).items.length, 0);
	const folder = await call<{ createdFolderId: string }>("update_graph_sources", { action: { action: "create-folder", name: "Course source", parentId: null } });
	await call("update_graph_sources", { action: { action: "move", kind: "source", id: lesson.id, parentId: folder.createdFolderId } });
	const sources = await call<{ items: { id: string; parentId: string | null }[] }>("list_graph_sources", {});
	assert.equal(sources.items.find(row => row.id === lesson.id)?.parentId, folder.createdFolderId);

	const waiting = await startInput(lesson.id, "reconnect-1", { type: "text", text: "Keep this accepted input on cancellation." });
	for (let attempt = 0; attempt < 100 && (await poll(waiting.operation_id)).status !== "needs_model_reply"; attempt++) await delay(20);
	assert.equal((await poll(waiting.operation_id)).status, "needs_model_reply");
	await client.close();
	client = await connect();
	assert.equal((await poll(waiting.operation_id)).status, "needs_model_reply");
	await call("cancel_operation", { operation_id: waiting.operation_id });
	await drive(waiting, () => assert.fail("Cancelled runs should not request inference."), "cancelled");
	assert.ok(stores.chatStore.getChat(lesson.id)?.messages.some(message =>
		message.role === "user" && String(message.content).includes("Keep this accepted input")));
	assert.deepEqual(httpErrors, []);
	assert.equal(stores.settingsStore.readSettings(), null);
});
