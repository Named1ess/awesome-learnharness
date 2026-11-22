import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ClientInference } from "../src/server/mcp-inference.ts";

const scratch = mkdtempSync(join(tmpdir(), "lh-client-engine-turn-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = join(scratch, "auth.json");
after(() => rmSync(scratch, { recursive: true, force: true }));

const { handleChatInput, handleMcpAttachment } = await import("../src/server/chat-handler.ts");
const { clientInferenceBroker, runWithClientInference } = await import("../src/server/mcp-inference.ts");
const { sideChats } = await import("../src/server/side-chat.ts");
const { stores } = await import("../src/server/stores.ts");
const { activeProblemOf } = await import("../src/core/native-messages.ts");
const { parseSideAskInput } = await import("../src/core/side-chat.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");

function fixture(response: AssistantMessage) {
	const faux = createFauxCore({});
	const work: Promise<unknown>[] = [];
	const controller = new AbortController();
	faux.setResponses([() => response]);
	const client: ClientInference = {
		engine: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }),
		signal: controller.signal,
		track(promise) {
			work.push(promise);
			return promise;
		},
	};
	return { client, work, controller };
}

test("a caller turn uses normal native persistence without configuring an app model", async () => {
	const { id } = stores.chatStore.createChat("Caller lesson");
	const { client, work } = fixture(fauxAssistantMessage([fauxText("Learning with the caller model.")]));
	const input = { type: "text" as const, text: "Teach me about invariants." };
	const native = await handleChatInput(id, input);
	assert.equal(native.status, 503);
	assert.deepEqual(stores.chatStore.getChat(id)?.messages, []);

	const accepted = await runWithClientInference(client, () => handleChatInput(id, input));
	assert.equal(accepted.status, 200);
	assert.ok(work.length > 0, "The relay must track settlement before returning acceptance");
	await Promise.all(work);
	const saved = stores.chatStore.getChat(id)?.messages;
	assert.equal(saved?.[0]?.role, "user");
	assert.equal(saved[0].content, input.text);
	assert.match(JSON.stringify(saved[1]), /Learning with the caller model/);
	assert.equal(stores.chatStore.getChat(id)?.settings?.model, undefined);
	assert.equal(stores.settingsStore.readSettings()?.models, undefined);
});

test("an attachment uses the actual practice agent and persists an active problem", async () => {
	const { id } = stores.chatStore.createChat("Caller practice", "practice");
	const { client, work } = fixture(fauxAssistantMessage([fauxToolCall("problem", {
		statement: "Show that the sum of two even numbers is even.",
		mode: "composition", modelSolution: "Write the numbers as twice integers.",
	})], { stopReason: "toolUse" }));
	const accepted = await runWithClientInference(client, () => handleMcpAttachment(id, "Use the attached notes for a practice problem."));
	assert.equal(accepted.status, 200);
	await Promise.all(work);
	const record = stores.chatStore.getChat(id);
	assert.ok(record && activeProblemOf(record.messages));
	assert.match(JSON.stringify(record.messages), /sum of two even numbers/);
});

test("a caller side question takes the original anchor and settles its own native thread", async () => {
	const { id } = stores.chatStore.createChat("Caller side question");
	const messageId = "caller-segment";
	stores.chatStore.saveMessages(id, [{ ...fauxAssistantMessage([fauxText("An invariant is preserved by each operation.")]), id: messageId }]);
	const input = parseSideAskInput({
		anchor: { messageId, partId: `${messageId}-t0`, blockIndex: 0, blockText: "Misstated input must not replace saved prose" },
		text: "What does preserved mean?",
	});
	const { client, work } = fixture(fauxAssistantMessage([fauxText("It stays true after the operation.")]));
	const response = await runWithClientInference(client, () => sideChats.ask(id, input));
	assert.equal(response.status, 200);
	assert.match(await response.text(), /It stays true after the operation/);
	assert.ok(work.length > 0);
	await Promise.all(work);
	const thread = sideChats.list(id)?.threads[0];
	assert.equal(thread?.anchor.blockText, "An invariant is preserved by each operation.");
	assert.equal(thread?.messages.at(-1)?.text, "It stays true after the operation.");
});

async function waitForOperation(operationId: string, predicate: (operation: ReturnType<typeof clientInferenceBroker.status>) => boolean) {
	const expires = Date.now() + 5_000;
	for (;;) {
		const operation = clientInferenceBroker.status(operationId);
		if (predicate(operation)) return operation;
		if (operation.status === "failed" || operation.status === "completed" || operation.status === "cancelled" || Date.now() >= expires) {
			assert.fail(`Unexpected MCP operation state: ${JSON.stringify(operation)}`);
		}
		await delay(20);
	}
}

test("probe handoff wakes the native teacher with the same caller operation and no app model", async () => {
	const { id } = stores.chatStore.createChat("Caller handoff");
	const { operation_id: operation } = clientInferenceBroker.start("teaching-handoff", "handoff fixture", id, async () => {
		const response = await handleChatInput(id, { type: "text", text: "I know what an invariant is but want to use one in a proof." });
		assert.equal(response.status, 200);
	});
	try {
		const step = (await waitForOperation(operation, run => run.steps.some(step => step.role === "prober"))).steps[0]!;
		clientInferenceBroker.submit(operation, step.id, { tool_calls: [{ name: "probe_done", arguments: {
			assessment: { strands: [{ strand: "Invariants", assessment: "Can name an invariant; needs the proof structure." }] },
		} }] });
		const close = (await waitForOperation(operation, run => run.steps.some(next => next.role === "prober" && next.id !== step.id))).steps[0];
		assert.ok(close);
		clientInferenceBroker.submit(operation, close.id, { text: "Let's build on that definition." });
		const teacher = (await waitForOperation(operation, run => run.steps.some(step => step.role === "teacher"))).steps[0]!;
		clientInferenceBroker.submit(operation, teacher.id, { text: "Prove the invariant at the start and after every step." });
		await waitForOperation(operation, run => run.status === "completed");
		const saved = stores.chatStore.getChat(id)?.messages ?? [];
		assert.ok(saved.some(message => message.role === "custom" && message.customType === "probe-handoff"));
		assert.match(JSON.stringify(saved.at(-1)), /after every step/);
	} finally {
		clientInferenceBroker.cancel(operation);
	}
});

test("cancelling the caller retains accepted input and releases the native session", async () => {
	const { id } = stores.chatStore.createChat("Caller cancellation");
	const { operation_id: operation } = clientInferenceBroker.start("turn-cancellation", "cancellation fixture", id, async () => {
		const response = await handleChatInput(id, { type: "text", text: "Save this as my accepted question." });
		assert.equal(response.status, 200);
	});
	try {
		await waitForOperation(operation, run => run.status === "needs_model_reply");
		clientInferenceBroker.cancel(operation);
		await waitForOperation(operation, run => run.status === "cancelled");
		const accepted = stores.chatStore.getChat(id)?.messages[0];
		assert.equal(accepted?.role, "user");
		assert.equal(accepted.content, "Save this as my accepted question.");
		assert.equal(clientInferenceBroker.forChat(id), undefined);
	} finally {
		clientInferenceBroker.cancel(operation);
	}
});

test("a native background researcher wakes the caller chat after the first reply settles", async () => {
	const { id } = stores.chatStore.createChat("Caller background research");
	const { operation_id: operation } = clientInferenceBroker.start("research-wake", "research fixture", id, async () => {
		const response = await handleChatInput(id, { type: "text", text: "Give me a worked example of an invariant." });
		assert.equal(response.status, 200);
	});
	try {
		const prober = (await waitForOperation(operation, run => run.steps.some(step => step.role === "prober"))).steps.find(step => step.role === "prober")!;
		clientInferenceBroker.submit(operation, prober.id, { tool_calls: [{ name: "research", arguments: { question: "Find a simple parity invariant example." } }] });
		const resumed = (await waitForOperation(operation, run => run.steps.some(step => step.role === "prober" && step.id !== prober.id))).steps.find(step => step.role === "prober")!;
		clientInferenceBroker.submit(operation, resumed.id, { text: "The background worker is looking for an example." });
		const waiting = await waitForOperation(operation, run => !isTurnRunning(id) && run.steps.some(step => step.role === "researcher"));
		clientInferenceBroker.submit(operation, waiting.steps.find(step => step.role === "researcher")!.id, { text: "Moving pebbles in pairs preserves the parity of their count." });
		const wake = await waitForOperation(operation, run => run.steps.some(step => step.role === "prober"));
		clientInferenceBroker.submit(operation, wake.steps.find(step => step.role === "prober")!.id, { text: "Try moving two pebbles at a time." });
		await waitForOperation(operation, run => run.status === "completed");
		const saved = stores.chatStore.getChat(id)?.messages ?? [];
		assert.ok(saved.some(message => message.role === "custom" && message.customType === "subagent-steer"));
		assert.match(JSON.stringify(saved.at(-1)), /two pebbles at a time/);
	} finally {
		clientInferenceBroker.cancel(operation);
	}
});
