import { createHash, randomUUID } from "node:crypto";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { problemResult } from "../agent/tool-execute.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import type { ChatRecord } from "../core/contracts/chat.ts";
import { newMessageId, newUserMessage, type LhMessage } from "../core/native-messages.ts";
import { reviewProblemAt } from "../core/practice-review.ts";
import { getPluginHost } from "./plugins.ts";
import { isPracticePluginRetryAvailable, type ProblemTypeResolver } from "./plugin-problems.ts";
import { stores } from "./stores.ts";

type RetryRequest = { chatId: string; messageId: string; contentIndex: number; requestId: string };
type ReviewProblem = NonNullable<ReturnType<typeof reviewProblemAt>>;

function isRetryRequest(value: unknown): value is RetryRequest {
	if (!value || typeof value !== "object") return false;
	const { chatId, messageId, contentIndex, requestId } = value as Partial<RetryRequest>;
	return typeof chatId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(chatId)
		&& typeof messageId === "string" && messageId.length > 0 && messageId.length <= 256
		&& typeof contentIndex === "number" && Number.isSafeInteger(contentIndex) && contentIndex >= 0
		&& typeof requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(requestId);
}

/** Seed just the selected pose and its ACK. No previous thinking, hints, verdict or usage ride along. */
function retryMessages(source: ChatRecord, problem: ReviewProblem): LhMessage[] {
	const messages: LhMessage[] = [];
	const graph = source.messages[0];
	if (graph?.role === "custom" && graph.customType === "graph-context") {
		messages.push({ ...graph, id: newMessageId(), timestamp: Date.now() });
	}
	messages.push(newUserMessage("Retry this problem."));
	const callId = randomUUID().replaceAll("-", "").slice(0, 9);
	const timestamp = Date.now();
	const plugin = problem.plugin ? { ...problem.plugin, problemId: randomUUID() } : undefined;
	messages.push({
		id: newMessageId(), role: "assistant", timestamp, api: "faux", provider: "synthetic", model: "practice-retry",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		content: [{ type: "toolCall", name: problem.toolName, id: callId, arguments: problem.input }],
	}, {
		id: newMessageId(), role: "toolResult", timestamp, toolCallId: callId, toolName: problem.toolName, isError: false,
		content: problemResult().content, details: plugin ? { pluginProblem: plugin } as unknown as ToolResultMessage["details"] : null,
	});
	return messages;
}

function imagesForRetry(source: ChatRecord, input: ReviewProblem["input"]) {
	if (!source.imageSnapshots) return undefined;
	const referenced = new Set(JSON.stringify(input).match(/[a-f0-9]{64}/g));
	const entries = Object.entries(source.imageSnapshots).filter(([id]) => referenced.has(id));
	return entries.length ? Object.fromEntries(entries) : undefined;
}

export async function handlePracticeRetry(req: Request, resolveProblemType?: ProblemTypeResolver): Promise<Response> {
	const body: unknown = await req.json().catch(() => null);
	if (!isRetryRequest(body)) return Response.json({ error: "Invalid practice problem reference or retry request ID." }, { status: 400 });
	const { chatId, messageId, contentIndex, requestId } = body;
	const digest = createHash("sha256").update(JSON.stringify([chatId, messageId, contentIndex, requestId])).digest("hex");
	const id = `chat_retry_${digest}`;
	if (stores.chatStore.getChat(id)) return Response.json({ id });

	let source = stores.chatStore.getChat(chatId);
	let problem = source?.kind === "practice" ? reviewProblemAt(source.messages, messageId, contentIndex) : null;
	if (problem?.plugin && !resolveProblemType) {
		try { resolveProblemType = (await getPluginHost()).resolveProblemType; }
		catch { /* A missing host leaves the saved plugin question unavailable. */ }
		// Plugin startup can yield. Resolve the source again in the same synchronous section as creation.
		if (stores.chatStore.getChat(id)) return Response.json({ id });
		source = stores.chatStore.getChat(chatId);
		problem = source?.kind === "practice" ? reviewProblemAt(source.messages, messageId, contentIndex) : null;
	}
	if (!source || !problem) return Response.json({ error: "Practice problem no longer available." }, { status: 404 });
	if (problem.plugin && !isPracticePluginRetryAvailable(problem.plugin, resolveProblemType)) {
		return Response.json({ error: "The plugin for this problem is unavailable." }, { status: 409 });
	}
	const strong = stores.settingsStore.readSettings()?.models?.strong;
	const settings = strong?.model ? { model: strong.model, thinkingLevel: strong.thinkingLevel } : undefined;
	const title = titleFromPrompt(`Retry: ${String(problem.input.statement)}`);
	stores.chatStore.createChat(title, "practice", {
		id, messages: retryMessages(source, problem), settings, imageSnapshots: imagesForRetry(source, problem.input),
	});
	return Response.json({ id });
}
