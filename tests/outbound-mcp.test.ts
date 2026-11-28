import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const profile = await mkdtemp(path.join(tmpdir(), "lh-outbound-mcp-"));
test.after(() => rm(profile, { recursive: true, force: true }));
process.env.LH_DATA_DIR = profile;

const origin = "http://localhost:3000";
const token = "test-only-outbound-mcp-token";

function request(body?: unknown, requestOrigin = origin) {
	return new Request(`${origin}/api/mcp/outbound`, body === undefined ? {} : {
		method: "POST",
		headers: { "content-type": "application/json", origin: requestOrigin },
		body: JSON.stringify(body),
	});
}

async function endpoint(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void) {
	const server = createServer(handle);
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve, reject) => {
		server.close(error => error ? reject(error) : resolve());
		server.closeAllConnections();
	}));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return `http://127.0.0.1:${address.port}/mcp`;
}

test("outbound Settings discovers tools and authorizes only individually enabled calls", async t => {
	const { handleOutboundMcpRequest } = await import("../src/server/outbound-mcp-routes.ts");
	const { callConfiguredMcpTool } = await import("../src/server/outbound-mcp.ts");
	const calls: unknown[] = [];
	const auth: string[] = [];
	const url = await endpoint(t, (req, res) => {
		auth.push(req.headers.authorization ?? "");
		if (req.method !== "POST") { res.writeHead(405).end(); return; }
		let data = "";
		req.setEncoding("utf8");
		req.on("data", chunk => { data += chunk; });
		req.on("end", () => {
			const { id, method, params } = JSON.parse(data);
			if (id === undefined) { res.writeHead(202).end(); return; }
			let result: unknown;
			if (method === "initialize") result = {
				protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Fixture MCP", version: "1" },
			};
			if (method === "tools/list") result = params?.cursor ? {
				tools: [{ name: "write_notes", inputSchema: { type: "object" } }],
			} : {
				tools: [{ name: "read_notes", description: "Read notes", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
				nextCursor: "next",
			};
			if (method === "tools/call") {
				calls.push(params);
				result = { content: [{ type: "text", text: "A saved note" }] };
			}
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
		});
	});
	const add = await handleOutboundMcpRequest(request({ action: "add", name: "Notes", url, token }));
	assert.equal(add.status, 200);
	const raw = await add.text();
	assert.ok(!raw.includes(token));
	const { server, tools } = JSON.parse(raw);
	assert.deepEqual(server, { id: server.id, name: "Notes", url, tokenConfigured: true, allowedTools: [] });
	assert.deepEqual(tools, [
		{ name: "read_notes", description: "Read notes", readOnlyHint: true, inputSchema: { type: "object" } },
		{ name: "write_notes", readOnlyHint: false, inputSchema: { type: "object" } },
	]);
	assert.ok(!(await (await handleOutboundMcpRequest(request())).text()).includes(token));
	await assert.rejects(callConfiguredMcpTool(server.id, "read_notes", {}), /enabled/i);
	assert.equal(calls.length, 0);
	const scope = await handleOutboundMcpRequest(request({ action: "permissions", id: server.id, allowedTools: ["read_notes"] }));
	assert.equal(scope.status, 200);
	const repeated = await handleOutboundMcpRequest(request({ action: "add", name: "Notes", url, token }));
	assert.deepEqual((await repeated.json()).server, { ...server, allowedTools: ["read_notes"] });
	await assert.rejects(callConfiguredMcpTool(server.id, "write_notes", {}), /enabled/i);
	const result = await callConfiguredMcpTool(server.id, "read_notes", { limit: 1 });
	assert.deepEqual(result.content, [{ type: "text", text: "A saved note" }]);
	assert.deepEqual(calls, [{ name: "read_notes", arguments: { limit: 1 } }]);
	assert.ok(auth.length && auth.every(value => value === `Bearer ${token}`));
	assert.equal((await handleOutboundMcpRequest(request({ action: "remove", id: server.id }))).status, 200);
	await assert.rejects(callConfiguredMcpTool(server.id, "read_notes", {}), /not found/i);
});

test("outbound MCP rejects cross-site configuration, plain external HTTP and redirects", async t => {
	const { handleOutboundMcpRequest } = await import("../src/server/outbound-mcp-routes.ts");
	const previous = await (await handleOutboundMcpRequest(request())).json();
	let leaked = false;
	const outside = await endpoint(t, (_req, res) => { leaked = true; res.writeHead(200).end(); });
	const redirect = await endpoint(t, (_req, res) => { res.writeHead(307, { location: outside }).end(); });
	assert.equal((await handleOutboundMcpRequest(request({ action: "add", name: "Outside", url: outside, token }, "https://elsewhere.example"))).status, 403);
	assert.equal((await handleOutboundMcpRequest(request({ action: "add", name: "Outside", url: "http://example.org/mcp", token }))).status, 400);
	const response = await handleOutboundMcpRequest(request({ action: "add", name: "Redirect", url: redirect, token }));
	assert.equal(response.status, 502);
	assert.ok(!(await response.text()).includes(token));
	assert.deepEqual(await (await handleOutboundMcpRequest(request())).json(), previous);
	assert.equal(leaked, false);
});
