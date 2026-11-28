import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "lh-practice-review-"));
process.env.LH_DATA_DIR = dataDir;
const { chatStore } = await import("../src/store/chats.ts");
const { listPracticeReview, putPracticeBookmark } = await import("../src/server/practice-review.ts");
after(() => rmSync(dataDir, { recursive: true, force: true }));

function callPair(name: string, args: Parameters<typeof fauxToolCall>[1], timestamp: number): LhMessage[] {
	const callId = `call-${name}`;
	const call = fauxAssistantMessage([fauxToolCall(name, args, { id: callId })], { stopReason: "toolUse" });
	const result: ToolResultMessage = {
		role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "OK" }],
		isError: false, timestamp: timestamp + 1,
	};
	return [{ ...call, id: `msg-${name}`, timestamp }, { ...result, id: `ack-${name}` }];
}

function completedProblem(timestamp: number): LhMessage[] {
	return [
		...callPair("problem", { statement: "What is 3 + 3?", target: ["addition"], mode: "recall", modelSolution: "6" }, timestamp),
		...callPair("conclude", { outcome: "solved", verdict: "Correct", missClass: null, rung: null, retest: false }, timestamp + 2),
	];
}

function bookmark(body: unknown) {
	return putPracticeBookmark(new Request("http://localhost/api/practice-review/bookmark", { method: "PUT", body: JSON.stringify(body) }), chatStore);
}

it("bookmarks persist by occurrence, are idempotent, and preserve chat ordering and transcript", async () => {
	const chat = chatStore.createChat("Practice", "practice");
	const messages = completedProblem(100);
	chatStore.saveMessages(chat.id, messages);
	const original = chatStore.getChat(chat.id)!;
	const occurrence = { messageId: "msg-problem", contentIndex: 0 };
	const body = { chatId: chat.id, ...occurrence, bookmarked: true };
	assert.equal((await bookmark(body)).status, 200);
	assert.equal((await bookmark(body)).status, 200);
	const saved = chatStore.getChat(chat.id)!;
	assert.deepEqual(saved.practiceBookmarks, [occurrence]);
	assert.equal(saved.updatedAt, original.updatedAt);
	assert.deepEqual(saved.messages, original.messages);
	assert.equal("practiceBookmarks" in chatStore.listChats()[0]!, false);
	assert.equal(listPracticeReview(chatStore)[0]?.bookmarked, true);
	chatStore.saveMessages(chat.id, messages);
	assert.deepEqual(chatStore.getChat(chat.id)?.practiceBookmarks, [occurrence]);
	assert.equal((await bookmark({ ...body, bookmarked: false })).status, 200);
	assert.equal((await bookmark({ ...body, bookmarked: false })).status, 200);
	assert.equal(listPracticeReview(chatStore)[0]?.bookmarked, false);
	chatStore.deleteChat(chat.id);
	assert.equal(listPracticeReview(chatStore).length, 0);
});

it("returns practice items newest first, with no entries from teaching sessions", () => {
	const ids = [
		chatStore.createChat("Later", "practice").id,
		chatStore.createChat("Earlier", "practice").id,
		chatStore.createChat("Teaching").id,
	];
	try {
		ids.forEach((id, i) => chatStore.saveMessages(id, completedProblem(999 - i * 50)));
		writeFileSync(path.join(dataDir, "chats", "unreadable.json"), "null");
		assert.deepEqual(listPracticeReview(chatStore).map(item => item.chatId), ids.slice(0, 2));
	} finally {
		ids.forEach(id => chatStore.deleteChat(id));
		rmSync(path.join(dataDir, "chats", "unreadable.json"), { force: true });
	}
});

it("rejects malformed, missing and unrelated targets", async () => {
	const chat = chatStore.createChat("Practice", "practice");
	chatStore.saveMessages(chat.id, completedProblem(100));
	try {
		const body = { chatId: chat.id, messageId: "msg-conclude", contentIndex: 0, bookmarked: true };
		for (const invalid of [null, [], {}, { ...body, chatId: "../elsewhere" }, { ...body, contentIndex: -1 }, { ...body, bookmarked: "yes" }]) {
			assert.equal((await bookmark(invalid)).status, 400);
		}
		assert.equal((await bookmark({ ...body, chatId: "missing" })).status, 404);
		assert.equal((await bookmark(body)).status, 404);
		assert.equal(chatStore.getChat(chat.id)?.practiceBookmarks, undefined);
	} finally {
		chatStore.deleteChat(chat.id);
	}
});
