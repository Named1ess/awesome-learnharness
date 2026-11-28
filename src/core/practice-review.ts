import type { ToolCall } from "@earendil-works/pi-ai";
import type { ChatRecord } from "./contracts/chat.ts";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMessage } from "./native-messages.ts";
import { readPluginProblemSnapshot, type PluginProblemSnapshot } from "./plugin-problems.ts";

export interface PracticeReviewItem {
	chatId: string;
	chatTitle: string;
	messageId: string;
	contentIndex: number;
	statement: string;
	outcome: string;
	verdict: string;
	rung: string | null;
	missClass: string | null;
	updatedAt: number;
	bookmarked: boolean;
	retryable: boolean;
}

interface ReviewPose {
	messageId: string;
	contentIndex: number;
	toolCallId: string;
	toolName: string;
	statement: string;
	input: ToolCall["arguments"];
	plugin?: PluginProblemSnapshot;
}

interface FinishedPose {
	pose: ReviewPose;
	conclusion: Record<string, unknown>;
	timestamp: number;
}

function savedPoses(messages: readonly LhMessage[]): FinishedPose[] {
	const finished: FinishedPose[] = [];
	let active: ReviewPose | undefined;
	for (const [index, message] of messages.entries()) {
		if (message.role === "custom" && message.customType === "problem-dismissed") {
			const details = message.details as { problemCallId?: unknown } | undefined;
			if (active && details?.problemCallId === active.toolCallId) {
				finished.push({ pose: active, conclusion: { outcome: "dismissed" }, timestamp: message.timestamp });
				active = undefined;
			}
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

		// Tool IDs can repeat in a later turn. Bind each call only to its own
		// result batch, then process the calls in their original content order.
		const results = new Map<string, Extract<LhMessage, { role: "toolResult" }>>();
		for (let next = index + 1; next < messages.length; next++) {
			const result = messages[next]!;
			if (result.role === "assistant") break;
			if (result.role === "toolResult") results.set(result.toolCallId, result);
		}
		for (const [contentIndex, call] of message.content.entries()) {
			if (call.type !== "toolCall") continue;
			const result = results.get(call.id);
			if (!result || result.isError || result.toolName !== call.name) continue;
			if (call.name === PRACTICE_CONCLUDE_TOOL) {
				if (active && call.arguments && typeof call.arguments.outcome === "string") {
					finished.push({ pose: active, conclusion: call.arguments, timestamp: result.timestamp });
				}
				active = undefined;
				continue;
			}
			const plugin = readPluginProblemSnapshot((result.details as { pluginProblem?: unknown } | null)?.pluginProblem);
			if (!plugin && call.name !== PRACTICE_PROBLEM_TOOL) continue;
			const input = plugin ? { ...plugin.input } : call.arguments;
			if (typeof input?.statement !== "string" || !input.statement.trim()) continue;
			active = { messageId: message.id, contentIndex, toolCallId: call.id, toolName: call.name,
				statement: input.statement, input, ...(plugin && { plugin }) };
		}
	}
	return finished;
}

function retryInput({ pose, conclusion }: FinishedPose): ToolCall["arguments"] | null {
	const { mode, modelSolution } = pose.input;
	if (mode !== "recall" && mode !== "composition" && mode !== "discrimination") return null;
	if (typeof modelSolution === "string" && modelSolution.trim()) return pose.input;
	// Older native sessions recorded the reveal on the conclusion.
	if (!pose.plugin && typeof conclusion.solutionReveal === "string" && conclusion.solutionReveal.trim())
		return { ...pose.input, modelSolution: conclusion.solutionReveal };
	return null;
}

/** Internal replay input. The library projection below never sends the solution or plugin payload. */
export function reviewProblemAt(messages: readonly LhMessage[], messageId: string, contentIndex: number) {
	const saved = savedPoses(messages).find(({ pose }) => pose.messageId === messageId && pose.contentIndex === contentIndex);
	const input = saved && retryInput(saved);
	return saved && input ? { ...saved.pose, input } : null;
}

export function practiceReviewItems(chat: ChatRecord, pluginAvailable?: (snapshot: PluginProblemSnapshot) => boolean): PracticeReviewItem[] {
	if (chat.kind !== "practice" || !Array.isArray(chat.messages)) return [];
	const bookmarks = new Set(chat.practiceBookmarks?.map(mark => `${mark.contentIndex}:${mark.messageId}`));
	return savedPoses(chat.messages).map(saved => {
		const { pose, conclusion, timestamp } = saved;
		return {
			chatId: chat.id, chatTitle: chat.title, messageId: pose.messageId, contentIndex: pose.contentIndex,
			statement: pose.statement, outcome: String(conclusion.outcome),
			verdict: typeof conclusion.verdict === "string" ? conclusion.verdict : "",
			rung: typeof conclusion.rung === "string" ? conclusion.rung : null,
			missClass: typeof conclusion.missClass === "string" ? conclusion.missClass : null,
			updatedAt: Number.isFinite(timestamp) ? timestamp : Date.parse(chat.updatedAt) || 0,
			bookmarked: bookmarks.has(`${pose.contentIndex}:${pose.messageId}`),
			retryable: !!retryInput(saved) && (!pose.plugin || !pluginAvailable || pluginAvailable(pose.plugin)),
		};
	});
}
