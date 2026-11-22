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
		assert.equal(headers["x-learnharness-mcp-client"], undefined);
	}
});

test("client reasoning discovers workflow tools and preserves the authenticated app protocol", { timeout: 20_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "learnharness mcp client "));
	const calls: { url: string | undefined; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
	const appReply = { operation_id: "op_1", status: "needs_model_reply", steps: [{ id: "step_1", role: "extractor" }] };
	const stepReply = { context: '{"system_prompt":"Extract', next_offset: 10 };
	const app = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		calls.push({ url: request.url, headers: request.headers, body });
		response.setHeader("Content-Type", "application/json");
		if (body.operation === "cancel_operation") {
			response.writeHead(409).end(JSON.stringify({ error: "The operation already settled", code: "settled" }));
		} else if (body.operation === "read_inference_step") {
			response.end(JSON.stringify(stepReply));
		} else {
			response.end(JSON.stringify(appReply));
		}
	});
	await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
	const client = new Client({ name: "learnharness-client-reasoning-test", version: "1" });
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
		command: process.execPath, args: [entry, "--data-dir", root, "--app-url", url, "--client-reasoning"],
		cwd: root, env: { LH_MCP_WRITE_TOKEN: token }, stderr: "pipe",
	}), rpcOptions);
	const { tools } = await client.listTools();
	assert.deepEqual(tools.map(tool => tool.name).sort(), [
		"ask_follow_up", "attach_file", "cancel_operation", "create_session", "extract_session_graph", "get_operation",
		"get_session_state", "import_file", "list_chains", "list_graph_sources", "list_propositions", "list_sessions",
		"list_side_threads", "read_inference_step", "read_session", "read_side_thread", "submit_inference_step", "submit_session_input", "update_graph_sources",
	]);
	assert.equal(tools.find(tool => tool.name === "read_inference_step")?.annotations?.readOnlyHint, true);
	assert.equal(tools.find(tool => tool.name === "submit_inference_step")?.annotations?.readOnlyHint, false);
	const invoke = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, undefined, rpcOptions);
	const decode = (result: Awaited<ReturnType<typeof invoke>>) => {
		assert.ok(Array.isArray(result.content));
		const block = result.content[0];
		assert.equal(block?.type, "text");
		return JSON.parse(block.text);
	};
	assert.equal((await invoke("list_sessions", {})).isError ?? false, false);
	assert.equal((await invoke("import_file", { path: "course notes/lecture.pdf" })).isError, true);
	assert.equal((await invoke("submit_session_input", { session_id: "chat_fixture", request_id: "send_1", input: { type: "text", text: " " } })).isError, true);
	assert.equal((await invoke("update_graph_sources", { action: { action: "delete-folder", id: "folder_1" } })).isError, true);
	assert.equal((await invoke("submit_inference_step", { operation_id: "op_1", step_id: "step_1", reply: {} })).isError, true);
	assert.equal(calls.length, 0);
	const importArgs = { path: "course notes/lecture.pdf", request_id: "import_1" };
	const imported = await invoke("import_file", importArgs);
	assert.equal(imported.isError ?? false, false);
	assert.deepEqual(decode(imported), appReply);
	const attachArgs = { session_id: "chat_fixture", path: "course notes/lecture.pdf", message: "Explain the proof", request_id: "attach_1" };
	assert.deepEqual(decode(await invoke("attach_file", attachArgs)), appReply);
	const ids = { operation_id: "op_1", step_id: "step_1" };
	const sideList = { session_id: "chat_fixture", offset: 10, limit: 5 };
	assert.equal((await invoke("list_side_threads", sideList)).isError ?? false, false);
	assert.deepEqual(decode(await invoke("read_inference_step", { ...ids, offset: 0 })), stepReply);
	const submitted = { ...ids, reply: { tool_calls: [{ name: "emit_proposition", arguments: { name: "Causal inference", related: ["Statistics", null] } }] } };
	assert.deepEqual(decode(await invoke("submit_inference_step", submitted)), appReply);
	const tooLarge = await invoke("submit_inference_step", { ...ids, reply: { tool_calls: [{ name: "emit_proposition", arguments: { large: "x".repeat(256 * 1024) } }] } });
	assert.equal(tooLarge.isError, true);
	assert.match(JSON.stringify(tooLarge), /256 KiB/);
	const cancelled = await invoke("cancel_operation", { operation_id: "op_1" });
	assert.equal(cancelled.isError, true);
	assert.deepEqual(decode(cancelled), { error: "The operation already settled", code: "settled" });
	assert.deepEqual(calls.map(({ body }) => body), [
		{ operation: "import_file", ...importArgs },
		{ operation: "attach_file", ...attachArgs },
		{ operation: "list_side_threads", ...sideList },
		{ operation: "read_inference_step", ...ids, offset: 0 },
		{ operation: "submit_inference_step", ...submitted },
		{ operation: "cancel_operation", operation_id: "op_1" },
	]);
	const proof = createHmac("sha256", token).update("learnharness-mcp-write-v1\0").update(realpathSync.native(root)).digest("hex");
	for (const { url: endpoint, headers } of calls) {
		assert.equal(endpoint, "/api/mcp/write");
		assert.equal(headers.authorization, `Bearer ${token}`);
		assert.equal(headers["x-learnharness-mcp-profile"], proof);
		assert.equal(headers["x-learnharness-mcp-client"], "1");
	}
});

test("client reasoning mode requires a local app URL", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "learnharness mcp client "));
	t.after(() => rm(root, { recursive: true, force: true }));
	const result = spawnSync(process.execPath, [entry, "--data-dir", root, "--client-reasoning"], {
		cwd: root, env: { ...process.env, LH_MCP_WRITE_TOKEN: token }, encoding: "utf8", timeout: 8_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 1, result.stderr);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /--client-reasoning requires --app-url/);
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
