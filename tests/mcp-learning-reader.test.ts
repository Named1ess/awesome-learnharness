import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { LearningReader } from "../src/mcp/learning-reader.ts";
import { directoryLinkType, fileSymlinkUnavailable, tryFileSymlink } from "./helpers/filesystem-links.ts";

function fixture(t: TestContext) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mcp-reader-"));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const root = path.join(base, "learning data");
	fs.mkdirSync(root);
	return { base, root };
}

function write(root: string, relative: string, text: string) {
	const file = path.join(root, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, "utf8");
	return file;
}

const now = "2026-10-01T00:00:00.000Z";
function chat(id: string, extras: Record<string, unknown> = {}) {
	return { id, title: id, createdAt: now, updatedAt: now, messages: [], ...extras };
}

test("requires an existing absolute root and canonicalizes an explicit root alias", async t => {
	const { base, root } = fixture(t);
	assert.throws(() => new LearningReader("relative/data"), /absolute/i);
	assert.throws(() => new LearningReader(path.join(base, "absent")), /directory/i);
	assert.throws(() => new LearningReader(write(base, "plain-file", "unused")), /directory/i);
	const alias = path.join(base, "data alias");
	fs.symlinkSync(root, alias, directoryLinkType);
	assert.deepEqual(await new LearningReader(alias).listSessions(), []);
});

test("missing session and graph records stay missing", async t => {
	const { root } = fixture(t);
	const reader = new LearningReader(root);
	assert.deepEqual(await reader.listSessions(), []);
	assert.deepEqual(await reader.readGraph(), { nodes: [], chains: [] });
	await assert.rejects(reader.readSession("chat_missing"), /not found/i);
	assert.deepEqual(fs.readdirSync(root), []);
});

test("lists only valid session summaries in updatedAt descending and ID order", async t => {
	const { root } = fixture(t);
	const save = (id: string, value: unknown) => write(root, `chats/${id}.json`, JSON.stringify(value));
	save("chat_z", chat("chat_z", { version: 2, kind: "practice", sideChats: [{ text: "private side text" }] }));
	save("chat_a", chat("chat_a"));
	save("chat_new", chat("chat_new", { version: 1, updatedAt: "2026-11-01T00:00:00.000Z" }));
	save("chat_future", chat("chat_future", { version: 99 }));
	save("chat_invalid", chat("chat_invalid", { messages: [null] }));
	save("chat_wrong_id", chat("chat_other"));
	save("chat_invalid_version", chat("chat_invalid_version", { version: 0 }));
	write(root, "chats/chat_bad.json", "{");
	fs.mkdirSync(path.join(root, "chats/chat_dir.json"));
	const reader = new LearningReader(root);
	assert.deepEqual(await reader.listSessions(), [
		{ id: "chat_new", title: "chat_new", kind: "teach", createdAt: now, updatedAt: "2026-11-01T00:00:00.000Z" },
		{ id: "chat_a", title: "chat_a", kind: "teach", createdAt: now, updatedAt: now },
		{ id: "chat_z", title: "chat_z", kind: "practice", createdAt: now, updatedAt: now },
	]);
	await assert.rejects(reader.readSession("chat_invalid"), /invalid/i);
	await assert.rejects(reader.readSession("chat_bad"), /invalid/i);
	await assert.rejects(reader.readSession("chat_invalid_version"), /version/i);
	await assert.rejects(reader.readSession("chat_future"), /version 99/i);
});

test("exports v1 and v2 sessions as native Markdown without binary attachments or side threads", async t => {
	const { root } = fixture(t);
	const messages = [
		{ id: "msg_learn", role: "user", content: [{ type: "text", text: "学习内容" }, { type: "image", mimeType: "image/png", data: "ATTACHMENT_SENTINEL" }] },
		{ id: "msg_teach", role: "assistant", content: [{ type: "thinking", thinking: "REASONING_SENTINEL" }, { type: "text", text: "A teacher explanation." }] },
	];
	for (const version of [1, 2]) {
		const id = `chat_v${version}`;
		const original = JSON.stringify(chat(id, { version, title: "Lesson", messages, imageSnapshots: { snapshot: { data: "ATTACHMENT_SENTINEL" } }, sideChats: [{ messages: [{ text: "SIDE_THREAD_SENTINEL" }] }] }));
		const file = write(root, `chats/${id}.json`, original);
		assert.deepEqual(await new LearningReader(root).readSession(id), {
			id, title: "Lesson", markdown: "# Lesson\n\n### Learner\n\n学习内容\n\n### Teacher\n\nA teacher explanation.",
		});
		assert.equal(fs.readFileSync(file, "utf8"), original);
	}
});

test("rejects path-like IDs and descendant junctions without reading them", async t => {
	const { base, root } = fixture(t);
	const reader = new LearningReader(root);
	for (const id of ["", "../private", "chat/a", "chat\\a", "chat:stream", "/chat_a"]) {
		await assert.rejects(reader.readSession(id), /invalid session ID/i);
	}
	const outside = path.join(base, "outside");
	write(outside, "chat_outside.json", JSON.stringify(chat("chat_outside")));
	fs.symlinkSync(outside, path.join(root, "chats"), directoryLinkType);
	fs.symlinkSync(outside, path.join(root, "graph"), directoryLinkType);
	await assert.rejects(reader.listSessions(), /unsafe/i);
	await assert.rejects(reader.readSession("chat_outside"), /unsafe/i);
	await assert.rejects(reader.readGraph(), /unsafe/i);
});

test("lists past file symlinks without opening them and rejects linked graph inputs", async t => {
	const { base, root } = fixture(t);
	const outside = write(base, "outside.json", JSON.stringify(chat("chat_link")));
	write(root, "chats/chat_good.json", JSON.stringify(chat("chat_good")));
	fs.mkdirSync(path.join(root, "graph"));
	if (!tryFileSymlink(outside, path.join(root, "chats/chat_link.json"))) return t.skip(fileSymlinkUnavailable);
	fs.symlinkSync(outside, path.join(root, "graph/nodes.jsonl"), "file");
	const reader = new LearningReader(root);
	assert.deepEqual((await reader.listSessions()).map(session => session.id), ["chat_good"]);
	await assert.rejects(reader.readSession("chat_link"), /unsafe/i);
	await assert.rejects(reader.readGraph(), /unsafe/i);
});

test("refuses multiply linked session and graph input files", async t => {
	const { base, root } = fixture(t);
	const outside = write(base, "outside-session.json", JSON.stringify(chat("chat_link")));
	const outsideLedger = write(base, "outside-nodes.jsonl", "");
	write(root, "chats/chat_good.json", JSON.stringify(chat("chat_good")));
	fs.mkdirSync(path.join(root, "graph"));
	const sessionLink = path.join(root, "chats/chat_link.json");
	const ledgerLink = path.join(root, "graph/nodes.jsonl");
	fs.linkSync(outside, sessionLink);
	fs.linkSync(outsideLedger, ledgerLink);
	assert.equal(fs.statSync(sessionLink).nlink, 2);
	assert.equal(fs.statSync(ledgerLink).nlink, 2);

	const reader = new LearningReader(root);
	await assert.rejects(reader.readSession("chat_link"), /unsafe/i);
	assert.deepEqual((await reader.listSessions()).map(session => session.id), ["chat_good"]);
	await assert.rejects(reader.readGraph(), /unsafe/i);
});

test("native graph merging skips malformed lines, keeps provenance, and projects known fields", async t => {
	const { root } = fixture(t);
	const firstPoint = { chatId: "chat_a", messageId: "msg_a" };
	const secondPoint = { chatId: "chat_b", messageId: "msg_b" };
	const firstNode = { id: "n_a", name: "A", statement: "First", aliases: ["first alias"], createdAt: now, provenance: [firstPoint] };
	const secondNode = { id: "n_b", name: "B", statement: "Second", aliases: [], createdAt: now, provenance: [] };
	const firstChain = { id: "arg_a", premises: ["n_a"], conclusion: "n_b", createdAt: now, provenance: [firstPoint] };
	const nodeText = [
		JSON.stringify({ ...firstNode, provenance: [{ ...firstPoint, extra: "point extra" }], extra: "node extra" }),
		"bad JSON",
		JSON.stringify({ id: "bad shape" }),
		JSON.stringify({ ...firstNode, name: "Changed", statement: "Alternate", aliases: [], provenance: [firstPoint, secondPoint] }),
		JSON.stringify(secondNode),
		"{torn line",
	].join("\n");
	const chainText = [
		JSON.stringify({ ...firstChain, extra: "chain extra" }),
		JSON.stringify({ ...firstChain, id: "arg_b", provenance: [secondPoint] }),
	].join("\n");
	const nodes = write(root, "graph/nodes.jsonl", nodeText);
	const chains = write(root, "graph/chains.jsonl", chainText);
	const reader = new LearningReader(root);
	assert.deepEqual(await reader.readGraph(), {
		nodes: [{ ...firstNode, aliases: ["first alias", "Alternate"], provenance: [firstPoint, secondPoint] }, secondNode],
		chains: [{ ...firstChain, provenance: [firstPoint, secondPoint] }],
	});
	const stamp = write(root, "graph/format.json", '{"version":1}');
	assert.equal((await reader.readGraph()).nodes.length, 2);
	fs.writeFileSync(stamp, '{"version":99}');
	await assert.rejects(reader.readGraph(), /version 99/i);
	assert.equal(fs.readFileSync(stamp, "utf8"), '{"version":99}');
	assert.equal(fs.readFileSync(nodes, "utf8"), nodeText);
	assert.equal(fs.readFileSync(chains, "utf8"), chainText);
});

test("refuses input files over 64 MiB and non-regular paths", async t => {
	const { root } = fixture(t);
	const size = 64 * 1024 * 1024 + 1;
	fs.truncateSync(write(root, "chats/chat_large.json", ""), size);
	fs.truncateSync(write(root, "graph/nodes.jsonl", ""), size);
	fs.mkdirSync(path.join(root, "chats/chat_directory.json"));
	const reader = new LearningReader(root);
	assert.deepEqual(await reader.listSessions(), []);
	await assert.rejects(reader.readSession("chat_large"), /64 MiB/i);
	await assert.rejects(reader.readSession("chat_directory"), /unsafe/i);
	await assert.rejects(reader.readGraph(), /64 MiB/i);
});
