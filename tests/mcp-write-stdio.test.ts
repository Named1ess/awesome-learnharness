import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = fileURLToPath(new URL("../scripts/learnharness-mcp.mjs", import.meta.url));
const token = "ab".repeat(32);
const rpcOptions = { timeout: 10_000 };

test("stdio write tools call only the configured running LearnHarness and preserve outcomes", { timeout: 20_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "learnharness mcp write "));
	const calls: { url: string | undefined; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
	const app = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		calls.push({ url: request.url, headers: request.headers, body });
		if (body.path === "redirect.md") {
			response.writeHead(307, { Location: "/unexpected-target" }).end();
			return;
		}
		response.setHeader("Content-Type", "application/json");
		if (body.path === "fail.md") {
			response.writeHead(500).end(JSON.stringify({ error: "Failed to start the turn" }));
			return;
		}
		if (body.path === "large.md") {
			response.end(JSON.stringify({ results: [{ filePath: body.path, outcome: "partial", ok: false, error: '"'.repeat(42_000) }] }));
			return;
		}
		if (body.operation === "import_file") {
			response.end(JSON.stringify({ results: [{ filePath: body.path, outcome: "partial", ok: false, error: "Mock extractor stopped" }] }));
		} else {
			response.end(JSON.stringify({ session_id: body.session_id, status: "accepted" }));
		}
	});
	await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
	const client = new Client({ name: "learnharness-write-test", version: "1" });
	t.after(async () => {
		try { await client.close(); }
		finally {
			try {
				await new Promise<void>((resolve, reject) => {
					app.close(error => error ? reject(error) : resolve());
					app.closeAllConnections();
				});
			} finally { await rm(root, { recursive: true, force: true }); }
		}
	});
	await client.connect(new StdioClientTransport({
		command: process.execPath, args: [entry, "--data-dir", root, "--app-url", url],
		cwd: root, env: { LH_MCP_WRITE_TOKEN: token, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "" }, stderr: "pipe",
	}), rpcOptions);
	const tools = (await client.listTools()).tools;
	assert.deepEqual(tools.map(tool => tool.name).sort(), ["attach_file", "import_file", "list_chains", "list_propositions", "list_sessions", "read_session"]);
	assert.equal(tools.find(tool => tool.name === "attach_file")?.annotations?.readOnlyHint, false);
	assert.equal(tools.find(tool => tool.name === "import_file")?.annotations?.readOnlyHint, false);
	const invoke = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, undefined, rpcOptions);
	const imported = await invoke("import_file", { path: "course notes/lecture.pdf" });
	assert.match(JSON.stringify(imported), /\bpartial\b/);
	const attached = await invoke("attach_file", { session_id: "chat_fixture", path: "course notes/lecture.pdf", message: "Explain the proof" });
	assert.equal(attached.isError ?? false, false);
	assert.match(JSON.stringify(attached), /\baccepted\b/);
	const rejected = await invoke("import_file", { path: "redirect.md" });
	assert.equal(rejected.isError, true);
	assert.match(JSON.stringify(rejected), /outcome (?:is )?unknown/i);
	const failed = await invoke("attach_file", { session_id: "chat_fixture", path: "fail.md" });
	assert.equal(failed.isError, true);
	assert.match(JSON.stringify(failed), /Failed to start the turn/);
	assert.match(JSON.stringify(failed), /outcome is unknown/i);
	const large = await invoke("import_file", { path: "large.md" });
	assert.equal(large.isError, true);
	assert.match(JSON.stringify(large), /outcome is unknown/i);
	assert.deepEqual(calls.map(({ url: endpoint }) => endpoint), Array(5).fill("/api/mcp/write"));
	assert.deepEqual(calls.map(({ body }) => body), [
		{ operation: "import_file", path: "course notes/lecture.pdf" },
		{ operation: "attach_file", session_id: "chat_fixture", path: "course notes/lecture.pdf", message: "Explain the proof" },
		{ operation: "import_file", path: "redirect.md" },
		{ operation: "attach_file", session_id: "chat_fixture", path: "fail.md" },
		{ operation: "import_file", path: "large.md" },
	]);
	const canonical = realpathSync.native(root);
	const proof = createHmac("sha256", token).update("learnharness-mcp-write-v1\0").update(canonical).digest("hex");
	for (const { headers } of calls) {
		assert.equal(headers.authorization, `Bearer ${token}`);
		assert.equal(headers["x-learnharness-mcp-profile"], proof);
	}
});

test("write startup rejects absent tokens and origins outside the local app", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "learnharness mcp write "));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [url, value, diagnostic] of [
		["http://localhost:3000", "", /LH_MCP_WRITE_TOKEN/],
		["http://example.invalid:3000", token, /loopback/i],
		["http://localhost:3000/other/..", token, /loopback/i],
	] as const) {
		const result = spawnSync(process.execPath, [entry, "--data-dir", root, "--app-url", url], {
			cwd: root, env: { ...process.env, LH_MCP_WRITE_TOKEN: value }, encoding: "utf8", timeout: 8_000,
		});
		assert.ifError(result.error);
		assert.equal(result.status, 1, result.stderr);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, diagnostic);
	}
});
