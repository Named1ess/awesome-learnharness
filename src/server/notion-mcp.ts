import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { PATHS } from "../../config.ts";
import type { VideoLessonQuestion } from "../core/video-lessons.ts";
import { browserOnlyMode } from "./desktop-access.ts";
import { fetchNotionMcp, NOTION_MCP_URL, NotionConnectionError, notionAccessToken } from "./notion-mcp-oauth.ts";
import { atomicNotionWrite, hasNotionConnection } from "./notion-mcp-store.ts";

interface NotionLessonInput {
	title: string;
	problem: string;
	question: VideoLessonQuestion;
	notionUrl?: string;
	lessonUrl: string;
	operationId: string;
	signal: AbortSignal;
}

type NotionTool = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
const operationDirectory = path.join(/* turbopackIgnore: true */ PATHS.data, "notion-mcp-saves");
const PAGE_ID = /([\da-f]{32}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i;
const UNCERTAIN = "Notion may already have saved this answer. Check your private Notion pages, then retry the same save to recover its link.";

export function isNotionMcpConnected(): boolean {
	return browserOnlyMode() && hasNotionConnection();
}

async function connectNotion(signal?: AbortSignal): Promise<Client> {
	signal?.throwIfAborted();
	if (!browserOnlyMode() || process.platform !== "win32") throw new NotionConnectionError("Notion is available in the local LearnHarness web app on Windows.");
	const clientFor = async (token: string) => {
		const client = new Client({ name: "LearnHarness", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(NOTION_MCP_URL, {
			fetch: fetchNotionMcp,
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
		});
		try { await client.connect(transport, { signal, timeout: 30000 }); }
		catch (error) { await client.close().catch(() => {}); throw error; }
		return client;
	};
	const token = await notionAccessToken();
	try { return await clientFor(token); }
	catch (error) {
		if (!(error instanceof StreamableHTTPError) || error.code !== 401) throw new NotionConnectionError("Could not connect to Notion. Try again in a moment.");
		return clientFor(await notionAccessToken(token));
	}
}

export async function readNotionMcpTool(name: "notion-search" | "notion-fetch", args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
	if (name !== "notion-search" && name !== "notion-fetch") throw new Error("Only read-only Notion lookups are available here.");
	const client = await connectNotion(signal);
	try { return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, { signal, timeout: 30000 })); }
	finally { await client.close().catch(() => {}); }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readToolPayload(result: CallToolResult): Record<string, unknown> {
	let output = asObject(result.structuredContent);
	if (!output) {
		for (const item of result.content) {
			if (item.type !== "text") continue;
			try { output = asObject(JSON.parse(item.text)); } catch { /* A tool can also include prose. */ }
			if (output) break;
		}
	}
	if (result.isError || !output) throw new NotionConnectionError("Notion did not confirm the requested operation.");
	return output;
}

export async function saveNotionLesson(input: NotionLessonInput): Promise<string> {
	const client = await connectNotion(input.signal);
	try {
		return await saveNotionLessonWith(input, operationDirectory, async (name, args) => {
			input.signal.throwIfAborted();
			const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, { signal: input.signal, timeout: 45000 });
			return readToolPayload(CallToolResultSchema.parse(result));
		});
	} finally { await client.close().catch(() => {}); }
}

function pageLocation(value: unknown): { url: string; id: string } | undefined {
	if (typeof value !== "string") return;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.port || url.username || url.password ||
			(url.hostname !== "app.notion.com" && !/(^|\.)notion\.(so|site)$/.test(url.hostname))) return;
		const id = PAGE_ID.exec(url.pathname)?.[1];
		if (id) return { url: url.href, id };
	} catch { /* An invalid Notion URL cannot name a destination. */ }
}

function lessonContent(input: NotionLessonInput, marker: string): string {
	const seconds = Math.floor(input.question.timeMs / 1000);
	const timestamp = [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
	const lessonUrl = new URL(input.lessonUrl);
	if (lessonUrl.protocol !== "http:" && lessonUrl.protocol !== "https:") throw new NotionConnectionError("The lesson link is invalid.");
	return ["## Video lesson question", "", marker, "", `**Timestamp** ${timestamp}`, "", "### Problem", "", input.problem,
		"", "### Question", "", input.question.text, "", "### Answer", "", input.question.answer,
		"", `[Open the lesson in LearnHarness](<${lessonUrl.href}>)`].join("\n");
}

async function fetchPage(call: NotionTool, url: string): Promise<Record<string, unknown> & { text: string }> {
	const page = await call("notion-fetch", { id: url });
	if (typeof page.text !== "string") throw new NotionConnectionError("Notion could not read the destination page.");
	return { ...page, text: page.text };
}

function contentAnchor(fetched: string): string | undefined {
	const wrapper = /<content(?:\s[^>]*)?>([\s\S]*?)<\/content>/.exec(fetched);
	const body = wrapper?.[1] ?? fetched;
	if (!body.trim() || /^<content\s*\/>$/.test(body.trim()) || /^<content>\s*<\/content>$/.test(body.trim())) return;
	for (const block of fromMarkdown(body).children.reverse()) {
		if ((block.type !== "paragraph" && block.type !== "heading") || !block.position) continue;
		const anchor = body.slice(block.position.start.offset, block.position.end.offset);
		if (anchor && body.indexOf(anchor) === body.lastIndexOf(anchor)) return anchor;
	}
	throw new NotionConnectionError("The Notion page has no safe place to append this answer.");
}

async function waitForWrite(call: NotionTool, result: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
	const task = typeof result.id === "string" && result.object === "async_task" ? result : asObject(result.async_task);
	if (!task || typeof task.id !== "string") return result;
	let waitMs = 2000;
	for (let count = 0; count < 15; count++) {
		await setTimeout(waitMs, undefined, { signal });
		const status = await call("notion-get-async-task", { task_id: task.id });
		if (status.status === "succeeded") return asObject(status.result) ?? status;
		if (status.status === "failed") break;
		if (typeof status.poll_after_seconds === "number") waitMs = Math.max(1000, Math.min(status.poll_after_seconds * 1000, 10000));
	}
	throw new NotionConnectionError("Notion did not confirm the requested operation.");
}

async function findPrivateDraft(call: NotionTool, title: string, marker: string): Promise<string | undefined> {
	let cursor: string | undefined;
	let match: string | undefined;
	const seen = new Set<string>();
	do {
		const listed = await call("notion-list-private-pages", { limit: 200, ...(cursor ? { cursor } : {}) });
		const results = listed.results ?? listed.pages ?? listed.items;
		if (!Array.isArray(results)) break;
		for (const entry of results) {
			const page = asObject(entry);
			const target = pageLocation(page?.url);
			if (!target || page?.title !== title || page?.type !== "page") continue;
			const fetched = await fetchPage(call, target.url);
			if (!fetched.text.includes(marker)) continue;
			if (match && match !== target.url) return;
			match = target.url;
		}
		cursor = typeof listed.nextCursor === "string" ? listed.nextCursor : undefined;
		if (!cursor) return match;
		if (seen.has(cursor)) break;
		seen.add(cursor);
	} while (seen.size < 15);
}

async function readJournal(file: string): Promise<{ pending: true } | { url: string } | undefined> {
	try {
		const body = await readFile(/* turbopackIgnore: true */ file, "utf8");
		const location = pageLocation(body.trim());
		return location ? { url: location.url } : { pending: true };
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** A durable admission record precedes every remote write. An interrupted call
 * may have committed at Notion, so resume by looking for the operation marker. */
export async function saveNotionLessonWith(input: NotionLessonInput, directory: string, call: NotionTool): Promise<string> {
	if (!input.question.answer?.trim()) throw new NotionConnectionError("Answer the lesson question before saving it to Notion.");
	input.signal.throwIfAborted();
	const operation = createHash("sha256").update(input.operationId).digest("hex");
	const marker = `LearnHarness operation ${operation}`;
	const content = lessonContent(input, marker);
	const existing = pageLocation(input.notionUrl);
	if (input.notionUrl && !existing) throw new NotionConnectionError("The saved Notion page link is invalid.");
	const file = path.join(/* turbopackIgnore: true */ directory, operation);
	const pending = await readJournal(file);
	if (pending && "url" in pending) return pending.url;
	const fetched = existing ? await fetchPage(call, existing.url) : undefined;
	if (existing && fetched?.text.includes(marker)) {
		await atomicNotionWrite(file, existing.url);
		return existing.url;
	}
	if (pending) {
		const found = existing ? undefined : await findPrivateDraft(call, input.title, marker).catch(() => undefined);
		if (!found) throw new NotionConnectionError(UNCERTAIN);
		await atomicNotionWrite(file, found);
		return found;
	}
	const anchor = fetched ? contentAnchor(fetched.text) : undefined;
	if (fetched?.truncated === true && !anchor) throw new NotionConnectionError("Notion could only read part of the destination page.");
	await mkdir(/* turbopackIgnore: true */ directory, { recursive: true });
	try { await writeFile(/* turbopackIgnore: true */ file, "pending", { flag: "wx", mode: 0o600, flush: true }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new NotionConnectionError(UNCERTAIN);
		throw error;
	}
	if (input.signal.aborted) {
		await rm(/* turbopackIgnore: true */ file, { force: true });
		input.signal.throwIfAborted();
	}
	try {
		let url: string | undefined;
		if (existing) {
			const changes = anchor
				? { command: "update_content", content_updates: [{ old_str: anchor, new_str: `${anchor}\n\n${content}` }] }
				: { command: "replace_content", new_str: content, content_updates: [] };
			const result = await waitForWrite(call, await call("notion-update-page", {
				page_id: existing.id, allow_async: false, properties: {}, ...changes,
			}), input.signal);
			if (typeof result.page_id === "string") url = existing.url;
		} else {
			const result = await waitForWrite(call, await call("notion-create-pages", {
				allow_async: false, pages: [{ properties: { title: input.title }, content }],
			}), input.signal);
			const created = Array.isArray(result.pages) && asObject(result.pages[0]);
			url = created ? pageLocation(created.url)?.url : undefined;
		}
		if (!url) throw new NotionConnectionError(UNCERTAIN);
		await atomicNotionWrite(file, url);
		return url;
	} catch {
		throw new NotionConnectionError(UNCERTAIN);
	}
}
