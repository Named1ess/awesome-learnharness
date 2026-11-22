import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
	createAssistantMessageEventStream, getCurrentTools, validateToolCall,
	type AssistantMessage, type AssistantMessageEventStream, type Model, type Api, type Tool, type ToolCall,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../agent/models.ts";

export const CLIENT_INFERENCE_PROVIDER = "learnharness-mcp-client";
const IDLE_MS = 10 * 60_000;
const RECEIPT_MS = 30 * 60_000;
const MAX_LIVE = 8;
const MAX_HISTORY = 64;
const MAX_PENDING_STEPS = 16;
const MAX_OPERATION_STEPS = 512;
const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;
const PAGE_UNITS = 12_000;

const clientModel: Model<Api> = {
	id: "mcp-client",
	name: "MCP client",
	provider: CLIENT_INFERENCE_PROVIDER,
	api: "openai-completions",
	baseUrl: "",
	input: ["text", "image"],
	reasoning: false,
	contextWindow: 150_000,
	maxTokens: 12_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export interface ClientInference {
	engine(role: string): PiEngine;
	readonly signal: AbortSignal;
	readonly filesDirectory?: string;
	track<T>(work: Promise<T>): Promise<T>;
}

const scopeKey = Symbol.for("lh.mcp-client-inference-scope");
const globals = globalThis as typeof globalThis & { [scopeKey]?: AsyncLocalStorage<ClientInference> };
const scope = globals[scopeKey] ??= new AsyncLocalStorage<ClientInference>();

export function currentClientInference(): ClientInference | undefined {
	return scope.getStore();
}

export function runWithClientInference<T>(client: ClientInference, action: () => T): T {
	return scope.run(client, action);
}

const errorKey = Symbol.for("lh.mcp-client-inference-error");

export class ClientInferenceError extends Error {
	readonly [errorKey] = true;
	constructor(message: string, readonly status: number) { super(message); }
}

export function isClientInferenceError(error: unknown): error is ClientInferenceError {
	// The broker spans route module copies and development reloads.
	return error instanceof Error && errorKey in error && error[errorKey] === true;
}

export interface ClientInferenceReply {
	text?: string;
	tool_calls?: { name: string; arguments: Record<string, unknown> }[];
}

type Terminal = "completed" | "failed" | "cancelled";

interface Step {
	id: string;
	role: string;
	context: string;
	tools: Tool[];
	finish(content: AssistantMessage["content"]): void;
}

function blankMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant", provider: model.provider, api: model.api, model: model.id,
		content: [], timestamp: Date.now(), stopReason: "pending",
		// The calling client owns its accounting. No provider usage is reported here.
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function completeStream(stream: AssistantMessageEventStream, message: AssistantMessage, content: AssistantMessage["content"]): void {
	for (const block of content) {
		const contentIndex = message.content.length;
		if (block.type === "text") {
			message.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex, partial: message });
			message.content[contentIndex] = block;
			stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
			stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
		} else if (block.type === "toolCall") {
			message.content.push({ ...block, arguments: {} });
			stream.push({ type: "toolcall_start", contentIndex, partial: message });
			message.content[contentIndex] = block;
			stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial: message });
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
		}
	}
	message.stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
	stream.push({ type: "done", reason: message.stopReason, message });
}

function replyContent(step: Step, reply: ClientInferenceReply): AssistantMessage["content"] {
	const text = reply.text?.trim() ? [{ type: "text" as const, text: reply.text }] : [];
	const calls = (reply.tool_calls ?? []).map(({ name, arguments: args }): ToolCall => {
		const call: ToolCall = { type: "toolCall", id: "mcp_" + randomUUID().replaceAll("-", ""), name, arguments: args as ToolCall["arguments"] };
		try { return { ...call, arguments: validateToolCall(step.tools, call) }; }
		catch (error) { throw new ClientInferenceError(error instanceof Error ? error.message.split("\n\nReceived arguments:")[0]! : "Invalid tool arguments.", 400); }
	});
	if (!text.length && !calls.length) throw new ClientInferenceError("Submit text or at least one advertised tool call.", 400);
	return [...text, ...calls];
}

class ClientRun implements ClientInference {
	readonly id = randomUUID();
	readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	readonly steps = new Map<string, Step>();
	readonly receipts = new Map<string, string>();
	#active = 0;
	#contextBytes = 0;
	#terminal?: Terminal;
	#failure?: string;
	#result: unknown;
	#timer?: ReturnType<typeof setTimeout>;
	#endedAt?: number;
	#started = false;

	constructor(readonly requestId: string, readonly fingerprint: string, readonly chatId: string | undefined, readonly onEnd: () => void,
		readonly filesDirectory?: string) {
		this.touch();
	}

	get endedAt() { return this.#endedAt; }

	touch(): void {
		if (this.#terminal || this.signal.aborted) return;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.cancel("The operation expired while waiting for the MCP client."), IDLE_MS);
		this.#timer.unref();
	}

	start(work: (run: ClientInference) => Promise<unknown>): void {
		this.#started = true;
		const launched = Promise.resolve().then(() => runWithClientInference(this, () => {
			this.signal.throwIfAborted();
			return work(this);
		}));
		this.track(launched.then(result => { this.#result = result; }));
	}

	track<T>(work: Promise<T>): Promise<T> {
		this.#active++;
		const finish = () => {
			this.#active--;
			if (this.#active === 0) setImmediate(() => this.#settle()).unref();
		};
		void work.then(finish, (error: unknown) => {
			this.#failure ??= error instanceof Error ? error.message : String(error);
			finish();
		});
		return work;
	}

	#settle(): void {
		if (!this.#started || this.#active !== 0 || this.#terminal) return;
		this.#terminal = this.signal.aborted ? "cancelled" : this.#failure ? "failed" : "completed";
		this.#endedAt = Date.now();
		clearTimeout(this.#timer);
		this.onEnd();
	}

	status() {
		this.touch();
		return {
			operation_id: this.id,
			status: this.#terminal ?? (this.signal.aborted ? "cancelling" : this.steps.size ? "needs_model_reply" : "running"),
			steps: [...this.steps.values()].map(({ id, role }) => ({ id, role })),
			...(this.#terminal && this.#result !== undefined ? { result: this.#result } : {}),
			...(this.#failure ? { error: this.#failure.slice(0, 2000) } : {}),
		};
	}

	cancel(message = "The MCP client cancelled the operation."): void {
		if (this.#terminal || this.signal.aborted) return;
		this.#failure ??= message;
		clearTimeout(this.#timer);
		this.controller.abort(new Error(message));
	}

	engine(role: string): PiEngine {
		return {
			model: clientModel,
			level: "off",
			streamFn: (model, context, options) => {
				const stream = createAssistantMessageEventStream();
				const message = blankMessage(model);
				const signal = options?.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
				const fail = (reason: "aborted" | "error", errorMessage: string) => {
					message.stopReason = reason;
					message.errorMessage = errorMessage;
					stream.push({ type: "error", reason, error: message });
				};
				if (signal.aborted) {
					fail("aborted", "The inference step was cancelled.");
					return stream;
				}
				const snapshot = JSON.stringify({ messages: context.messages });
				const snapshotBytes = Buffer.byteLength(snapshot);
				if (this.#contextBytes + snapshotBytes > MAX_CONTEXT_BYTES || this.steps.size >= MAX_PENDING_STEPS ||
					this.steps.size + this.receipts.size >= MAX_OPERATION_STEPS) {
					fail("error", "The operation exceeds the MCP inference limits.");
					return stream;
				}

				const id = randomUUID();
				const remove = () => {
					if (this.steps.delete(id)) this.#contextBytes -= snapshotBytes;
					signal.removeEventListener("abort", abort);
				};
				this.#contextBytes += snapshotBytes;
				const abort = () => {
					remove();
					fail("aborted", "The inference step was cancelled.");
				};
				this.steps.set(id, {
					id, role, context: snapshot, tools: getCurrentTools(context.messages),
					finish: (content) => {
						remove();
						completeStream(stream, message, content);
					},
				});
				signal.addEventListener("abort", abort, { once: true });
				stream.push({ type: "start", partial: message });
				this.touch();
				return stream;
			},
		};
	}

	read(stepId: string, offset: number) {
		const step = this.steps.get(stepId);
		if (!step) throw new ClientInferenceError("The inference step is no longer pending.", 409);
		if (offset > step.context.length) throw new ClientInferenceError("Invalid context offset.", 400);
		this.touch();
		let end = Math.min(offset + PAGE_UNITS, step.context.length);
		const tail = step.context.charCodeAt(end - 1);
		if (end < step.context.length && tail >= 0xd800 && tail <= 0xdbff) end--;
		return { context: step.context.slice(offset, end), next_offset: end < step.context.length ? end : null };
	}

	submit(stepId: string, reply: ClientInferenceReply) {
		const hash = createHash("sha256").update(JSON.stringify(reply)).digest("hex");
		const prior = this.receipts.get(stepId);
		if (prior !== undefined) {
			if (prior !== hash) throw new ClientInferenceError("The inference step already has a different reply.", 409);
		} else {
			const step = this.steps.get(stepId);
			if (!step || this.signal.aborted) throw new ClientInferenceError("The inference step is no longer pending.", 409);
			const content = replyContent(step, reply);
			this.receipts.set(stepId, hash);
			step.finish(content);
			this.touch();
		}
		return { step_id: stepId, status: "submitted" as const };
	}
}

export function createClientInferenceBroker() {
	const operations = new Map<string, ClientRun>();
	const requests = new Map<string, ClientRun>();
	const chats = new Map<string, ClientRun>();
	const get = (id: string) => {
		const run = operations.get(id);
		if (!run) throw new ClientInferenceError("Unknown operation. Check saved results before restarting it.", 404);
		return run;
	};
	const prune = () => {
		const history = [...operations.values()].filter(run => run.endedAt !== undefined)
			.sort((a, b) => a.endedAt! - b.endedAt!);
		for (const [index, run] of history.entries()) {
			if (index < history.length - MAX_HISTORY || run.endedAt! + RECEIPT_MS < Date.now()) {
				operations.delete(run.id);
				requests.delete(run.requestId);
			}
		}
	};

	return {
		start(requestId: string, fingerprint: string, chatId: string | undefined, work: (run: ClientInference) => Promise<unknown>, filesDirectory?: string) {
			prune();
			const existing = requests.get(requestId);
			if (existing) {
				if (existing.fingerprint !== fingerprint) throw new ClientInferenceError("This request_id already names another operation.", 409);
				return existing.status();
			}
			if (chatId && chats.has(chatId)) throw new ClientInferenceError("This session already has an MCP operation.", 409);
			if ([...operations.values()].filter(run => !run.endedAt).length >= MAX_LIVE) {
				throw new ClientInferenceError("Too many MCP operations are running.", 409);
			}
			const run = new ClientRun(requestId, fingerprint, chatId, () => {
				if (chatId && chats.get(chatId) === run) chats.delete(chatId);
			}, filesDirectory);
			operations.set(run.id, run);
			requests.set(requestId, run);
			if (chatId) chats.set(chatId, run);
			run.start(work);
			return run.status();
		},
		status: (id: string) => get(id).status(),
		read: (id: string, step: string, offset: number) => get(id).read(step, offset),
		submit: (id: string, step: string, reply: ClientInferenceReply) => get(id).submit(step, reply),
		cancel: (id: string) => { const run = get(id); run.cancel(); return run.status(); },
		forChat: (chatId: string): ClientInference | undefined => chats.get(chatId),
	};
}

const brokerKey = Symbol.for("lh.mcp-client-inference-broker");
const brokerGlobals = globalThis as typeof globalThis & { [brokerKey]?: ReturnType<typeof createClientInferenceBroker> };
export const clientInferenceBroker = brokerGlobals[brokerKey] ??= createClientInferenceBroker();

export function clientInferenceForChat(chatId: string): ClientInference | undefined {
	return clientInferenceBroker.forChat(chatId);
}
