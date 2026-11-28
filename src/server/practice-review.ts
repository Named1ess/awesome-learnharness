import { practiceReviewItems, type PracticeReviewItem } from "../core/practice-review.ts";
import type { PracticeReviewStore } from "../core/ports.ts";
import { isPracticePluginRetryAvailable, type ProblemTypeResolver } from "./plugin-problems.ts";

export function listPracticeReview(store: PracticeReviewStore, resolve?: ProblemTypeResolver): PracticeReviewItem[] {
	const items: PracticeReviewItem[] = [];
	for (const chat of store.listPracticeRecords()) {
		try {
			const entries = practiceReviewItems(chat, snapshot => isPracticePluginRetryAvailable(snapshot, resolve));
			for (const entry of entries) items.push(entry);
		} catch (error) {
			// As in the session picker, isolate unreadable legacy transcripts.
			console.error(`[chat ${chat.id}] practice review projection failed:`, error);
		}
	}
	return items.sort((a, b) => b.updatedAt - a.updatedAt || a.chatId.localeCompare(b.chatId) || a.messageId.localeCompare(b.messageId) || a.contentIndex - b.contentIndex);
}

export async function putPracticeBookmark(request: Request, store: PracticeReviewStore): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const invalid = () => Response.json({ error: "Expected a practice problem occurrence and bookmark state" }, { status: 400 });
	if (!body || typeof body !== "object" || Array.isArray(body)) return invalid();
	const { chatId, messageId, contentIndex, bookmarked } = body as Record<string, unknown>;
	if (typeof chatId !== "string" || !/^[A-Za-z0-9_-]+$/.test(chatId)
		|| typeof messageId !== "string" || !messageId.trim()
		|| typeof contentIndex !== "number" || !Number.isSafeInteger(contentIndex) || contentIndex < 0
		|| typeof bookmarked !== "boolean") return invalid();
	if (!store.setPracticeBookmark(chatId, { messageId, contentIndex }, bookmarked)) {
		return Response.json({ error: "Practice problem not found" }, { status: 404 });
	}
	return Response.json({ bookmarked });
}
