import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createClientInferenceBroker, currentClientInference } from "../src/server/mcp-inference.ts";

async function waitForStatus(broker: ReturnType<typeof createClientInferenceBroker>, id: string, expected: string) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (broker.status(id).status === expected) return;
		await setImmediate();
	}
	assert.equal(broker.status(id).status, expected);
}

test("caller replies drive a native stream with scoped visibility, validation, and replay receipts", async () => {
	const broker = createClientInferenceBroker();
	let result: unknown;
	const start = broker.start("request-1", "one action", "chat_fixture", async run => {
		assert.equal(currentClientInference(), run);
		const { model, streamFn } = run.engine("teacher");
		const events = streamFn(model, normalizeContext({
			systemPrompt: "Teach with native tools",
			messages: [{ role: "user", content: "Explain state machines", timestamp: 1 }],
			tools: [{ name: "explain", description: "Explain a topic", parameters: { type: "object", required: ["text"], properties: { text: { type: "string" } } } }],
		}));
		result = await events.result();
		return { session_id: "chat_fixture" };
	});
	assert.equal(currentClientInference(), undefined);
	assert.equal(broker.start("request-1", "one action", "chat_fixture", async () => assert.fail()).operation_id, start.operation_id);
	assert.throws(() => broker.start("request-1", "other action", undefined, async () => null), /request_id/);
	await setImmediate();
	const status = broker.status(start.operation_id);
	assert.equal(status.status, "needs_model_reply");
	const [step] = status.steps;
	assert.equal(step?.role, "teacher");
	const page = broker.read(start.operation_id, step.id, 0);
	assert.match(page.context, /Explain state machines/);
	assert.match(page.context, /"explain"/);
	assert.throws(() => broker.submit(start.operation_id, step.id, { tool_calls: [{ name: "shell", arguments: {} }] }), /not found/);
	assert.throws(() => broker.submit(start.operation_id, step.id, { tool_calls: [{ name: "explain", arguments: {} }] }), /Validation failed/);
	const reply = { text: "Native text", tool_calls: [{ name: "explain", arguments: { text: "A state has transitions." } }] };
	assert.deepEqual(broker.submit(start.operation_id, step.id, reply), broker.submit(start.operation_id, step.id, reply));
	assert.throws(() => broker.submit(start.operation_id, step.id, { text: "different" }), /different reply/);
	await waitForStatus(broker, start.operation_id, "completed");
	assert.match(JSON.stringify(result), /A state has transitions/);
	assert.match(JSON.stringify(result), /Native text/);
	assert.throws(() => broker.read(start.operation_id, step.id, 0), /no longer pending/);
});

test("cancellation wakes blocked native streams and releases the main-session reservation", async () => {
	const broker = createClientInferenceBroker();
	const first = broker.start("request-1", "first", "chat_fixture", async run => {
		const { model, streamFn } = run.engine("practice");
		const result = await streamFn(model, normalizeContext({ messages: [] })).result();
		assert.equal(result.stopReason, "aborted");
	});
	await setImmediate();
	assert.throws(() => broker.start("request-2", "second", "chat_fixture", async () => null), /already has/);
	broker.cancel(first.operation_id);
	await waitForStatus(broker, first.operation_id, "cancelled");
	const second = broker.start("request-2", "second", "chat_fixture", async () => "ready");
	await waitForStatus(broker, second.operation_id, "completed");
	assert.equal(broker.status(second.operation_id).result, "ready");
});
