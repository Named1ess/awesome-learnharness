import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const entry = fileURLToPath(new URL("../scripts/learnharness-mcp.mjs", import.meta.url));
const rpcOptions = { timeout: 8_000 };
const nativeV1Id = "chat_mcp_v1";
const nativeV2Id = "chat_mcp_v2";
const premiseId = "n_000000000001";
const conclusionId = "n_000000000002";
const chainId = "arg_000000000001";

type ListPage<T> = { items: T[]; next_offset: number | null };
type SessionPage = { id: string; title: string; markdown: string; next_offset: number | null };
type WithId = { id: string };

async function createRoot(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "lh mcp stdio "));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

function createClient(args: string[]) {
	const client = new Client({ name: "learnharness-stdio-test", version: "1.0.0" });
	const transport = new StdioClientTransport({ command: process.execPath, args: [entry, ...args], stderr: "pipe" });
	const diagnostics: Buffer[] = [];
	transport.stderr?.on("data", (chunk: Buffer) => diagnostics.push(chunk));
	return { client, transport, diagnostics: () => Buffer.concat(diagnostics).toString("utf8") };
}

async function connect(t: TestContext, root: string): Promise<Client> {
	const { client, transport, diagnostics } = createClient(["--data-dir", root]);
	t.after(() => client.close());
	const protocolErrors: Error[] = [];
	client.onerror = (error) => protocolErrors.push(error);
	try {
		await client.connect(transport, rpcOptions);
	} catch (error) {
		throw new Error(`MCP initialization failed: ${diagnostics()}`, { cause: error });
	}
	t.after(() => assert.deepEqual(protocolErrors, [], "only MCP messages may be written to stdout"));
	return client;
}

async function jsonResult<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
	const result = await client.callTool({ name, arguments: args }, undefined, rpcOptions);
	assert.equal(result.isError ?? false, false, JSON.stringify(result));
	assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 128 * 1024, `${name} keeps each response within 128 KiB`);
	assert.ok(Array.isArray(result.content));
	const blocks = result.content.filter((block) => block.type === "text");
	assert.equal(blocks.length, 1, `${name} returns one JSON text block`);
	const block = blocks[0];
	assert.ok(block);
	return JSON.parse(block.text) as T;
}

async function writeFixture(root: string): Promise<string[]> {
	await mkdir(join(root, "chats"));
	await mkdir(join(root, "graph"));
	const createdAt = "2026-10-13T00:00:00.000Z";
	const messageId = "m_mcp_fixture";
	const provenance = [{ chatId: nativeV1Id, messageId }];
	const files = {
		[join("chats", `${nativeV1Id}.json`)]: {
			id: nativeV1Id, title: "Native v1", version: 1, createdAt, updatedAt: createdAt,
			messages: [{ role: "user", id: messageId, content: "A study note 😀 on invariants.", timestamp: 1 }],
		},
		[join("chats", `${nativeV2Id}.json`)]: {
			id: nativeV2Id, title: "Native v2", kind: "practice", version: 2, createdAt, updatedAt: createdAt,
			messages: [{ role: "user", id: messageId, content: "A practice note.", timestamp: 1 }],
		},
		[join("graph", "format.json")]: { version: 1 },
	};
	for (const [file, data] of Object.entries(files)) await writeFile(join(root, file), JSON.stringify(data));
	const nodes = [
		{ id: premiseId, name: "Base invariant", statement: "The premises remain true.", aliases: ["fixed relation"], createdAt, provenance },
		{ id: conclusionId, name: "Derived invariant", statement: "The proof establishes the conclusion.", aliases: [], createdAt, provenance },
	];
	const chain = { id: chainId, premises: [premiseId], conclusion: conclusionId, createdAt, provenance };
	const nodeFile = join("graph", "nodes.jsonl");
	const chainFile = join("graph", "chains.jsonl");
	const legacyFile = join("graph", "edges.jsonl");
	await writeFile(join(root, nodeFile), nodes.map(node => JSON.stringify(node)).join("\n") + "\n");
	await writeFile(join(root, chainFile), JSON.stringify(chain) + "\n");
	await writeFile(join(root, legacyFile), "legacy data must remain untouched\n");
	return [...Object.keys(files), nodeFile, chainFile, legacyFile];
}

async function snapshot(root: string, files: string[]) {
	return {
		root: (await readdir(root)).sort(),
		chats: (await readdir(join(root, "chats"))).sort(),
		graph: (await readdir(join(root, "graph"))).sort(),
		files: await Promise.all(files.map(async (file) => {
			const fullPath = join(root, file);
			return { file, bytes: await readFile(fullPath), modifiedAt: (await stat(fullPath)).mtimeMs };
		})),
	};
}

test("initializes over stdio and discovers exactly the four read-only tools", { timeout: 20_000 }, async (t) => {
	const root = await createRoot(t);
	const client = await connect(t, root);
	assert.ok(client.getServerVersion()?.name);
	const { tools } = await client.listTools(undefined, rpcOptions);
	assert.deepEqual(tools.map(tool => tool.name).sort(), ["list_chains", "list_propositions", "list_sessions", "read_session"]);
	for (const tool of tools) {
		assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
		assert.equal(tool.inputSchema.type, "object", tool.name);
		const expected = {
			list_sessions: ["limit", "offset"],
			read_session: ["limit", "offset", "session_id"],
			list_propositions: ["limit", "offset", "query"],
			list_chains: ["limit", "offset", "proposition_id"],
		};
		assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), expected[tool.name as keyof typeof expected]);
	}
	for (const name of ["list_sessions", "list_propositions", "list_chains"]) {
		assert.deepEqual(await jsonResult(client, name), { items: [], next_offset: null });
	}
	await client.close();
	assert.deepEqual(await readdir(root), []);
});

test("paginates sessions and graph results, reads both native formats and leaves data unchanged", { timeout: 20_000 }, async (t) => {
	const root = await createRoot(t);
	const files = await writeFixture(root);
	const before = await snapshot(root, files);
	const client = await connect(t, root);
	for (const [tool, ids] of [
		["list_sessions", [nativeV1Id, nativeV2Id]],
		["list_propositions", [premiseId, conclusionId]],
	] as const) {
		const first = await jsonResult<ListPage<WithId>>(client, tool, { limit: 1 });
		assert.equal(first.items.length, 1);
		assert.equal(first.next_offset, 1);
		const second = await jsonResult<ListPage<WithId>>(client, tool, { offset: first.next_offset, limit: 1 });
		assert.equal(second.items.length, 1);
		assert.equal(second.next_offset, null);
		assert.deepEqual([...first.items, ...second.items].map(item => item.id).sort(), [...ids].sort());
	}

	const firstSession = await jsonResult<SessionPage>(client, "read_session", { session_id: nativeV1Id });
	assert.equal(firstSession.id, nativeV1Id);
	assert.equal(firstSession.title, "Native v1");
	assert.match(firstSession.markdown, /A study note 😀 on invariants\./);
	assert.equal(firstSession.next_offset, null);
	const emojiOffset = Array.from(firstSession.markdown).indexOf("😀");
	assert.ok(emojiOffset >= 0);
	const emoji = await jsonResult<SessionPage>(client, "read_session", { session_id: nativeV1Id, offset: emojiOffset, limit: 1 });
	assert.equal(emoji.markdown, "😀");
	assert.equal(emoji.next_offset, emojiOffset + 1);
	const secondSession = await jsonResult<SessionPage>(client, "read_session", { session_id: nativeV2Id });
	assert.equal(secondSession.title, "Native v2");
	assert.match(secondSession.markdown, /A practice note\./);

	for (const query of ["BASE INVARIANT", "REMAIN TRUE", "FIXED RELATION"]) {
		const page = await jsonResult<ListPage<WithId>>(client, "list_propositions", { query });
		assert.deepEqual(page.items.map(item => item.id), [premiseId]);
		assert.equal(page.next_offset, null);
	}
	for (const proposition_id of [premiseId, conclusionId]) {
		const page = await jsonResult<ListPage<WithId>>(client, "list_chains", { proposition_id });
		assert.deepEqual(page.items.map(item => item.id), [chainId]);
		assert.equal(page.next_offset, null);
	}
	assert.deepEqual(await jsonResult(client, "list_chains", { proposition_id: "n_999999999999" }), { items: [], next_offset: null });
	await client.close();
	assert.deepEqual(await snapshot(root, files), before);
});

test("reports invalid tool arguments and refuses a missing data directory at startup", { timeout: 20_000 }, async (t) => {
	const root = await createRoot(t);
	const client = await connect(t, root);
	for (const [name, args] of [
		["list_sessions", { offset: -1 }],
		["list_propositions", { limit: 101 }],
		["list_chains", { limit: 1.5 }],
		["read_session", { session_id: nativeV1Id, limit: 30_001 }],
		["read_session", {}],
	] as const) {
		try {
			const result = await client.callTool({ name, arguments: args }, undefined, rpcOptions);
			assert.equal(result.isError, true, `${name} must reject ${JSON.stringify(args)}`);
		} catch (error) {
			if (!(error instanceof McpError && error.code === ErrorCode.InvalidParams)) throw error;
		}
	}
	const missing = join(root, "missing directory");
	const failed = createClient(["--data-dir", missing]);
	t.after(() => failed.client.close());
	await assert.rejects(failed.client.connect(failed.transport, rpcOptions), /connection closed/i);
	assert.match(failed.diagnostics(), /LearnHarness MCP: .*learning data directory/i);
	assert.deepEqual(await readdir(root), []);
});

test("uses the default list limit and paginates results that exceed the byte budget", { timeout: 20_000 }, async (t) => {
	const root = await createRoot(t);
	await mkdir(join(root, "graph"));
	const createdAt = "2026-10-13T00:00:00.000Z";
	const nodes = Array.from({ length: 60 }, (_, index) => ({
		id: `n_${index.toString(16).padStart(12, "0")}`,
		name: index < 29 ? "small" : "large",
		statement: index < 29 ? "Short proposition." : "🌍".repeat(2000),
		aliases: [], createdAt, provenance: [],
	}));
	const ledger = join(root, "graph", "nodes.jsonl");
	await writeFile(ledger, nodes.map(node => JSON.stringify(node)).join("\n") + "\n");
	const client = await connect(t, root);
	const defaultPage = await jsonResult<ListPage<WithId>>(client, "list_propositions", { query: "small" });
	assert.equal(defaultPage.items.length, 25);
	assert.equal(defaultPage.next_offset, 25);

	const received: string[] = [];
	let offset: number | null = 0;
	while (offset !== null) {
		const page: ListPage<WithId> = await jsonResult(client, "list_propositions", { query: "large", limit: 100, offset });
		assert.ok(page.items.length > 0);
		assert.ok(page.items.length < 31, "the byte limit must take effect before the requested item limit");
		assert.ok(page.next_offset === null || (page.next_offset > offset && page.next_offset <= 31));
		received.push(...page.items.map(item => item.id));
		offset = page.next_offset;
	}
	assert.deepEqual(received.sort(), nodes.slice(29).map(node => node.id));
});

test("bounds SDK-generated argument error results", { timeout: 20_000 }, async (t) => {
	const client = await connect(t, await createRoot(t));
	const unknownKey = "x".repeat(150 * 1024);
	const result = await client.callTool({ name: "list_sessions", arguments: { [unknownKey]: true } }, undefined, rpcOptions);
	assert.equal(result.isError, true);
	const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
	assert.ok(resultBytes <= 128 * 1024, `argument error result was ${resultBytes} bytes`);
});

test("reports the offset of an oversized graph row so later rows remain readable", { timeout: 20_000 }, async (t) => {
	const root = await createRoot(t);
	await mkdir(join(root, "graph"));
	const followingId = "n_000000000003";
	const createdAt = "2026-10-13T00:00:00.000Z";
	const nodes = [
		{ id: premiseId, statement: "A proposition before the oversized row." },
		{ id: conclusionId, statement: "🌍".repeat(40_000) },
		{ id: followingId, statement: "A proposition after the oversized row." },
	].map(node => ({ ...node, name: node.id, aliases: [], createdAt, provenance: [] }));
	await writeFile(join(root, "graph", "nodes.jsonl"), nodes.map(node => JSON.stringify(node)).join("\n") + "\n");
	const client = await connect(t, root);
	const result = await client.callTool({ name: "list_propositions", arguments: { offset: 1, limit: 1 } }, undefined, rpcOptions);
	assert.equal(result.isError, true);
	assert.ok(Array.isArray(result.content));
	const message = result.content.find(block => block.type === "text");
	assert.ok(message);
	assert.match(message.text, /\boffset\D*1\b/i);

	const following = await jsonResult<ListPage<WithId>>(client, "list_propositions", { offset: 2 });
	assert.deepEqual(following.items.map(item => item.id), [followingId]);
	assert.equal(following.next_offset, null);
});
