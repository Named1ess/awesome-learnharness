import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";

const scratch = mkdtempSync(join(tmpdir(), "lh-mcp-attach-"));
Object.assign(process.env, {
	LH_DATA_DIR: scratch,
	LH_AUTH_FILE: join(scratch, "auth.json"),
	NODE_ENV: "test",
	OPENROUTER_API_KEY: "fixture-only",
});
after(() => rmSync(scratch, { recursive: true, force: true }));

const { handleMcpAttachment } = await import("../src/server/chat-handler.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { quoteFilePath } = await import("../src/core/file-paths.ts");
const { newUserMessage } = await import("../src/core/native-messages.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { compactionInFlight, ensureCompacted } = await import("../src/server/compaction.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");

const message = `Read these notes: ${quoteFilePath(join(scratch, "my 学习 notes.md"))}`;

function createChat(kind?: "practice") {
	const chat = chatStore.createChat("MCP attachment", kind);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "openrouter/free" } });
	return chat.id;
}

function question(): LhMessage {
	return {
		...fauxAssistantMessage([fauxToolCall("probe", {
			question: "Which answer is right?",
			options: [{ label: "One" }, { label: "Two" }],
			correctAnswer: "One", explanation: "Fixture", type: "check",
		}, { id: "call-question" })], { stopReason: "toolUse" }),
		id: "mcp-fixture-question",
	};
}

test("MCP attachment refuses a running turn before saving or building an Agent", async () => {
	const id = createChat();
	assert.equal(beginTurn(id), true);
	try {
		const response = await handleMcpAttachment(id, message, () => assert.fail("Agent must not start"));
		assert.equal(response.status, 409);
		assert.deepEqual(chatStore.getChat(id)?.messages, []);
	} finally { endTurn(id); }
});

test("MCP attachment refuses a pending question or an active practice problem", async () => {
	const pending = createChat();
	const pendingMessages = [question()];
	chatStore.saveMessages(pending, pendingMessages);
	const practicing = createChat("practice");
	const problemMessages: LhMessage[] = [
		{
			...fauxAssistantMessage([fauxToolCall("problem", {
				statement: "Find a proof.", mode: "composition", modelSolution: "A fixture solution.",
			}, { id: "call-problem" })], { stopReason: "toolUse" }),
			id: "mcp-fixture-problem",
		},
		{ role: "toolResult", id: "mcp-fixture-ack", toolCallId: "call-problem", toolName: "problem", content: [], details: null, isError: false, timestamp: 1 },
	];
	chatStore.saveMessages(practicing, problemMessages);

	for (const [id, history] of [[pending, pendingMessages], [practicing, problemMessages]] as const) {
		const response = await handleMcpAttachment(id, message, () => assert.fail("Agent must not start"));
		assert.equal(response.status, 409);
		assert.deepEqual(chatStore.getChat(id)?.messages, history);
	}
});

test("MCP attachment rechecks for a pending question added during preflight", async () => {
	const id = createChat();
	const pending = handleMcpAttachment(id, message, () => assert.fail("Agent must not start"));
	const history = [question()];
	chatStore.saveMessages(id, history);
	assert.equal((await pending).status, 409);
	assert.deepEqual(chatStore.getChat(id)?.messages, history);
});

function compactionFixture() {
	const id = createChat();
	const history = [newUserMessage("x".repeat(100_000)), newUserMessage("y".repeat(100_000)), newUserMessage("Recent work")];
	chatStore.saveMessages(id, history);
	const faux = createFauxCore({});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const compaction = ensureCompacted({
		chatStore,
		engine: { model: faux.getModel(), streamFn: faux.streamSimple },
		modelId: "faux:fixture", kind: "teach", thresholdTokens: 4000, systemPromptTokens: 100,
		async summarize() {
			entered.resolve();
			await release.promise;
			return {
				summary: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
		},
	}, id);
	return { id, history, entered, release, compaction };
}

test("MCP attachment refuses an in-flight compaction without waiting or saving", async () => {
	const { id, history, entered, release, compaction } = compactionFixture();
	try {
		await Promise.race([entered.promise, compaction.then(() => assert.fail("Compaction fixture did not start"))]);
		assert.equal(compactionInFlight(id), true);
		const response = await handleMcpAttachment(id, message, () => assert.fail("Agent must not start"));
		assert.equal(response.status, 409);
		assert.deepEqual(chatStore.getChat(id)?.messages, history);
	} finally {
		release.resolve();
		await compaction;
	}
});

test("MCP attachment refuses a compaction that claims the session during model preflight", async () => {
	const { id, history, entered, release, compaction } = compactionFixture();
	const originalNodeEnv = process.env.NODE_ENV;
	Object.assign(process.env, { NODE_ENV: "development" }); // Exercise the real wait instead of its test shortcut.
	const attachment = handleMcpAttachment(id, message, () => assert.fail("Agent must not start"));
	try {
		await Promise.race([entered.promise, compaction.then(() => assert.fail("Compaction fixture did not start"))]);
		assert.equal(compactionInFlight(id), true);
		const status = await Promise.race([attachment.then(response => response.status), nextEventLoopTurn("joined compaction")]);
		assert.equal(status, 409);
		assert.deepEqual(chatStore.getChat(id)?.messages, history);
	} finally {
		Object.assign(process.env, { NODE_ENV: originalNodeEnv });
		release.resolve();
		await Promise.all([attachment, compaction]);
	}
});

test("MCP attachment persists the quoted path before inference and accepts one normal turn", async () => {
	const id = createChat();
	const faux = createFauxCore({});
	let calls = 0;
	faux.setResponses([(context) => {
		calls++;
		const saved = chatStore.getChat(id)?.messages;
		assert.equal(saved?.length, 1);
		assert.equal(saved?.[0]?.role, "user");
		assert.equal(saved[0].content, message);
		assert.ok(context.messages.some(entry => entry.role === "user" && entry.content === message));
		return fauxAssistantMessage([fauxText("Attachment received.")]);
	}]);
	const response = await handleMcpAttachment(id, message, (options) => createTeacherAgent(undefined, {
		...options,
		engine: { model: faux.getModel(), streamFn: faux.streamSimple },
	}));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
	const running = runningTurn(id);
	if (running) await new Response(running.subscribe()).text();
	assert.equal(calls, 1);
	const settled = chatStore.getChat(id)?.messages;
	assert.equal(settled?.length, 2);
	assert.match(JSON.stringify(settled[1]), /Attachment received\./);
});
