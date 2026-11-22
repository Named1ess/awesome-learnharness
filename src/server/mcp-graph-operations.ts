import { extractionInFlight } from "../agent/subagents/extraction.ts";
import type { EmissionStats } from "../core/contracts/graph.ts";
import { emit } from "../core/events.ts";
import { parseOrganizationAction, placementOf } from "../core/source-organization.ts";
import { extraction } from "./chat-handler.ts";
import { sourceDirectory, SourceOrganizationInputError } from "./source-organization.ts";
import { stores } from "./stores.ts";

const SOURCE_PAGE_BYTES = 32 * 1024;
const SOURCE_LABEL_UNITS = 2048;
const EMPTY_PAGE_BYTES = Buffer.byteLength(JSON.stringify({ items: [], next_offset: null }), "utf8");

function presentLabel(label: string | null): string | null {
	if (label === null || label.length <= SOURCE_LABEL_UNITS) return label;
	return label.slice(0, SOURCE_LABEL_UNITS - 1).replace(/[\uD800-\uDBFF]$/u, "") + "…";
}

export class McpGraphExtractionError extends Error {
	constructor(message: string, readonly status: 404 | 409) { super(message); }
}

/** Await native session extraction while the caller's inference scope is available. */
export async function mcpExtractSessionGraph(sessionId: string): Promise<EmissionStats> {
	if (!stores.chatStore.getChat(sessionId)) throw new McpGraphExtractionError("Session not found.", 404);
	if (extractionInFlight(sessionId)) throw new McpGraphExtractionError("An extraction run is already in flight for this session.", 409);
	return extraction.runExtraction(sessionId);
}

export function mcpGraphSources(offset: number, limit: number) {
	const { organization, sources } = sourceDirectory.read();
	const items = [
		...organization.folders.map(({ id, name, parentId, createdAt }) => ({
			id, kind: "folder" as const, label: name, parentId, createdAt,
		})),
		...sources.map(({ id, kind, chatKind, label, createdAt }) => ({
			id, kind, chatKind, label, parentId: placementOf(organization, id)?.folderId ?? null, createdAt,
		})),
	].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	const present = (item: (typeof items)[number]) => ({ ...item, label: presentLabel(item.label) });
	const page: ReturnType<typeof present>[] = [];
	// Count item bytes and separators, reserving enough room for either continuation form.
	let bytes = EMPTY_PAGE_BYTES + String(items.length).length;
	for (const item of items.slice(offset, offset + limit)) {
		const row = present(item);
		bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + (page.length === 0 ? 0 : 1);
		if (bytes > SOURCE_PAGE_BYTES) {
			if (page.length === 0) throw new SourceOrganizationInputError(`The source at offset ${offset} exceeds the page limit. Continue at the following offset.`);
			break;
		}
		page.push(row);
	}
	const next = offset + page.length;
	return { items: page, next_offset: next < items.length ? next : null };
}

export function mcpUpdateGraphSources(input: unknown) {
	let action;
	try { action = parseOrganizationAction(input); }
	catch (error) { throw new SourceOrganizationInputError((error as Error).message); }
	if (action.action === "delete-folder") throw new SourceOrganizationInputError("This source organization action is not supported.");
	const { createdFolderId } = sourceDirectory.change(action);
	emit("sources-changed", {});
	return { ok: true, ...(createdFolderId === undefined ? {} : { createdFolderId }) };
}
