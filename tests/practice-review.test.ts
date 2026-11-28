import assert from "node:assert/strict";
import test from "node:test";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { practiceReviewItems, reviewProblemAt } from "../src/core/practice-review.ts";

const problem = { statement: "Why does it converge?", modelSolution: "Bounded monotone sequences converge.", mode: "recall" };
function call(messageId: string, name: string, args: Record<string, unknown>, id = messageId): LhMessage {
	return { role: "assistant", id: messageId, timestamp: 1, content: [{ type: "toolCall", id, name, arguments: args }] } as LhMessage;
}
function ack(name: string, id: string, isError = false): LhMessage {
	return { role: "toolResult", id: "ack-" + id, timestamp: 2, toolName: name, toolCallId: id, isError, content: [] } as unknown as LhMessage;
}
function chat(messages: LhMessage[]): ChatRecord {
	return { id: "practice", title: "Sequences", kind: "practice", createdAt: "", updatedAt: "", messages };
}
const pose = call("first", "problem", problem, "shared");
const finish = call("end", "conclude", { outcome: "solvedWithHints", rung: "R2", verdict: "Needed the bound." });

test("review joins physical acknowledged occurrences and keeps solutions out of the library", () => {
	const source = chat([pose, ack("problem", "shared"), call("refused", "problem", { ...problem, statement: "Other" }, "shared"),
		ack("problem", "shared", true), finish, ack("conclude", "end")]);
	const rows = practiceReviewItems(source);
	assert.equal(rows.length, 1);
	const [item] = rows;
	assert.ok(item);
	assert.equal(item.messageId, "first");
	assert.equal(item.rung, "R2");
	assert.equal(item.bookmarked, false);
	assert.equal(item.outcome, "solvedWithHints");
	assert.equal(JSON.stringify(rows).includes(problem.modelSolution), false);
	assert.deepEqual(reviewProblemAt(source.messages, "first", 0)?.input, problem);
	assert.equal(reviewProblemAt(source.messages, "refused", 0), null);
});

test("a skipped prompt appears immediately and its later synthesized conclusion does not count twice", () => {
	const dismissed = { id: "skip", role: "custom", customType: "problem-dismissed", timestamp: 3, details: { problemCallId: "shared" } } as LhMessage;
	const source = chat([pose, ack("problem", "shared"), dismissed]);
	assert.deepEqual(practiceReviewItems(source).map(item => item.outcome), ["dismissed"]);
	source.messages.push(call("end", "conclude", { outcome: "dismissed" }), ack("conclude", "end"));
	assert.equal(practiceReviewItems(source).length, 1);
});

test("unfinished problems and failed conclusions do not appear as completed attempts", () => {
	assert.deepEqual(practiceReviewItems(chat([pose, finish, ack("conclude", "end")])), []);
	assert.deepEqual(practiceReviewItems(chat([pose, ack("problem", "shared"), finish, ack("conclude", "end", true)])), []);
});

test("a legacy conclusion can supply its saved solution for retry; incomplete history remains readable", () => {
	const legacy = call("old", "problem", { statement: "Prove it.", mode: "composition" });
	const source = chat([legacy, ack("problem", "old"), call("end", "conclude", { outcome: "solved", solutionReveal: "Old proof." }), ack("conclude", "end")]);
	assert.equal(reviewProblemAt(source.messages, "old", 0)?.input.modelSolution, "Old proof.");
	source.messages[2] = call("end", "conclude", { outcome: "solved" });
	assert.equal(practiceReviewItems(source)[0]?.retryable, false);
	assert.equal(reviewProblemAt(source.messages, "old", 0), null);
});
