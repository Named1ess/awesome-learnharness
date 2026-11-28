import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { activeProblemOf, modelSolutionForConclude, needsContinuation, newGraphContextMessage, newThinkingMessage, type LhMessage } from "../src/core/native-messages.ts";
import { inputAppends } from "../src/core/input-events.ts";
import { chatStore } from "../src/store/chats.ts";
import { handlePracticeRetry } from "../src/server/practice-retry.ts";
import type { ProblemTypeResolver } from "../src/server/plugin-problems.ts";
import { createPracticeAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";

function sourceSession(t: TestContext, plugin = false, starter = "x") {
	const source = chatStore.createChat("Algebra", "practice");
	t.after(() => chatStore.deleteChat(source.id));
	const toolName = plugin ? "example_problem" : "problem";
	const input = { statement: "Expand (x + 1)².", mode: "recall", modelSolution: "x² + 2x + 1",
		...(plugin ? { payload: { starter } } : {}) };
	const snapshot = { problemId: "old-problem", protocolVersion: 1, pluginId: "example", typeId: "code",
		label: "Code", contractVersion: 1, input, problemSchema: { type: "object", properties: { starter: { type: "string" } } },
		submissionSchema: { type: "string" }, requiresSubmissionRefinement: false, requiresProcessing: false };
	const pose = { ...fauxAssistantMessage([fauxToolCall(toolName, input, { id: "old-pose" })]), id: "pose-message" };
	const ack = { id: "old-ack", role: "toolResult", toolCallId: "old-pose", toolName,
		content: [{ type: "text", text: "Posed." }], details: plugin ? { pluginProblem: snapshot } : null, isError: false, timestamp: 1 };
	const conclude = { outcome: "solvedWithHints", verdict: "Nice work", rung: "R2", missClass: "execution", retest: false };
	const messages = [
		newGraphContextMessage([{ id: "algebra", name: "Algebra", statement: "Expand the product." }], []),
		pose, ack, newThinkingMessage("old-pose", "My previous attempt."),
		{ ...fauxAssistantMessage([fauxToolCall("conclude", conclude, { id: "old-conclude" })]), id: "grade" },
		{ ...ack, id: "grade-ack", toolCallId: "old-conclude", toolName: "conclude", details: null },
	] as LhMessage[];
	chatStore.saveMessages(source.id, messages);
	return { source, input, messages, body: { chatId: source.id, messageId: pose.id, contentIndex: 0, requestId: randomUUID() } };
}

function retry(body: unknown, resolve?: ProblemTypeResolver) {
	return handlePracticeRetry(new Request("http://local/api/practice-review/retry", { method: "POST", body: JSON.stringify(body) }), resolve);
}

test("a retry opens the identical native problem, accepts fresh thinking and survives duplicate requests", async t => {
	const { source, input, messages, body } = sourceSession(t);
	const responses = await Promise.all([retry(body), retry(body)]);
	for (const res of responses) assert.equal(res.status, 200, await res.clone().text());
	const ids = await Promise.all(responses.map(async res => (await res.json()).id as string));
	assert.equal(ids[0], ids[1]);
	const id = ids[0]!;
	t.after(() => chatStore.deleteChat(id));
	assert.notEqual(id, source.id);
	const created = chatStore.getChat(id)!;
	const active = activeProblemOf(created.messages)!;
	assert.deepEqual(active.input, input);
	assert.notEqual(active.toolCallId, "old-pose");
	assert.equal(needsContinuation(created.messages), false);
	assert.equal(created.messages[0]?.role, "custom");
	assert.doesNotMatch(JSON.stringify(created.messages), /My previous attempt|Nice work/);
	const additions = inputAppends(created, { type: "thinking", problemCallId: active.toolCallId, text: "A fresh attempt." });
	chatStore.saveMessages(id, [...created.messages, ...additions]);
	chatStore.deleteChat(source.id);
	assert.equal((await (await retry(body)).json()).id, id);
	assert.deepEqual(chatStore.getChat(id)!.messages, [...created.messages, ...additions]);
	assert.ok(messages.length > created.messages.length);
});

test("a plugin retry keeps the stored renderer contract, with fresh occurrence and problem identities", async t => {
	const snapshotId = createHash("sha256").update("fixture").digest("hex");
	const otherId = createHash("sha256").update("other").digest("hex");
	const { body, input, source } = sourceSession(t, true, snapshotId);
	for (const [id, data] of [[snapshotId, "fixture"], [otherId, "other"]] as const) {
		chatStore.saveImageSnapshot(source.id, id, { data: Buffer.from(data).toString("base64"), mimeType: "image/png", width: 1, height: 1 });
	}
	assert.equal((await retry(body, () => ({ status: "incompatible" }))).status, 409);
	const response = await retry(body, (pluginId, typeId, version) => {
		assert.deepEqual([pluginId, typeId, version], ["example", "code", 1]);
		return { status: "available", signal: new AbortController().signal, requireActive() {},
			definition: { id: "code", label: "Code", contractVersion: 1, tool: { toolName: "example_problem", description: "Example" },
				problemSchema: Type.Object({ starter: Type.String() }), submissionSchema: Type.String() } };
	});
	assert.equal(response.status, 200, await response.clone().text());
	const { id } = await response.json();
	t.after(() => chatStore.deleteChat(id));
	const record = chatStore.getChat(id)!;
	const active = activeProblemOf(record.messages)!;
	assert.deepEqual(active.pluginProblem?.input, input);
	assert.notEqual(active.pluginProblem?.problemId, "old-problem");
	assert.equal(active.pluginProblem?.pluginId, "example");
	assert.equal(active.pluginProblem?.contractVersion, 1);
	assert.equal(needsContinuation(record.messages), false);
	assert.deepEqual(Object.keys(record.imageSnapshots!), [snapshotId]);
});

test("submitting the fresh retry runs the ordinary practice agent and reveals the committed solution", async t => {
	process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
	const { body, input } = sourceSession(t);
	const { id } = await (await retry(body)).json();
	t.after(() => chatStore.deleteChat(id));
	chatStore.saveSettings(id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const active = activeProblemOf(chatStore.getChat(id)!.messages)!;
	const faux = createFauxCore({});
	const grade = { outcome: "solved", verdict: "Correct.", rung: null, missClass: null, retest: false };
	faux.setResponses([
		ctx => {
			assert.doesNotMatch(JSON.stringify(ctx.messages), /My previous attempt/);
			return fauxAssistantMessage([fauxToolCall("conclude", grade, { id: "retry-end" })], { stopReason: "toolUse" });
		},
		() => fauxAssistantMessage("Correct."),
	]);
	const ack = await handleChatRequest(new Request("http://test/api/chat", { method: "POST",
		body: JSON.stringify({ chatId: id, input: { type: "thinking", problemCallId: active.toolCallId, text: "x² + 2x + 1" } }) }),
		opts => createPracticeAgent({ chatId: id, chatStore }, { messages: opts.messages, engine: { model: faux.getModel(), streamFn: faux.streamSimple } }));
	assert.equal(ack.status, 200, await ack.clone().text());
	const turn = runningTurn(id);
	if (turn) await new Response(turn.subscribe()).text();
	const history = chatStore.getChat(id)!.messages;
	assert.equal(activeProblemOf(history), null);
	assert.equal(modelSolutionForConclude(history, "retry-end"), input.modelSolution);
});

test("invalid, missing and unfinished source references cannot start a retry", async t => {
	const { source, messages, body } = sourceSession(t);
	assert.equal((await retry({ ...body, contentIndex: -1 })).status, 400);
	assert.equal((await retry({ ...body, chatId: "../outside" })).status, 400);
	assert.equal((await retry({ ...body, messageId: "missing" })).status, 404);
	chatStore.saveMessages(source.id, messages.slice(0, 3));
	assert.equal((await retry(body)).status, 404);
});
