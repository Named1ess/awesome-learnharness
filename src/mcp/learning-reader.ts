import { realpathSync, statSync, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { CURRENT_CHAT_VERSION, type ChatKind } from "../core/contracts/chat.ts";
import { CURRENT_GRAPH_FORMAT_VERSION, type ProvenancePoint } from "../core/contracts/graph.ts";
import { getGraph, type DerivedGraph } from "../core/graph.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { sessionMarkdown } from "../core/session-markdown.ts";
import { isGraphChain, isGraphNode, isRecord, parseGraphLedger } from "../store/graph-records.ts";

const MAX_INPUT_BYTES = 64 * 1024 * 1024;

export interface SessionSummary {
	id: string;
	title: string;
	kind: ChatKind;
	createdAt: string;
	updatedAt: string;
}

class LearningDataError extends Error {}

function readFailure(error: unknown): null {
	if (error instanceof LearningDataError) throw error;
	if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
	throw new LearningDataError("Could not read learning data.", { cause: error });
}

function isSingleLinkFile(stat: Stats): boolean {
	return stat.isFile() && stat.nlink === 1;
}

async function checkedPath(root: string, filename: string, kind: "directory" | "file"): Promise<{ filename: string; stat: Stats } | null> {
	try {
		const stat = await lstat(filename);
		if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !isSingleLinkFile(stat))) {
			throw new LearningDataError("Unsafe learning data path.");
		}
		const canonical = await realpath(filename);
		const relative = path.relative(root, canonical);
		if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative) || path.relative(filename, canonical) !== "") {
			throw new LearningDataError("Unsafe learning data path.");
		}
		return { filename: canonical, stat };
	} catch (error) {
		return readFailure(error);
	}
}

function isSessionId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !/[^A-Za-z0-9_-]/.test(value);
}

function isContentBlocks(value: unknown): boolean {
	return Array.isArray(value) && value.every(block => isRecord(block) && typeof block.type === "string");
}

function isNativeMessage(value: unknown): value is LhMessage {
	if (!isRecord(value) || typeof value.id !== "string") return false;
	switch (value.role) {
		case "user": return typeof value.content === "string" || isContentBlocks(value.content);
		case "assistant": return isContentBlocks(value.content);
		case "toolResult": return typeof value.toolName === "string" && typeof value.toolCallId === "string" && isContentBlocks(value.content);
		case "custom": return typeof value.customType === "string";
		default: return false;
	}
}

function parseSession(raw: string, id: string): { summary: SessionSummary; messages: LhMessage[] } {
	let record: unknown;
	try { record = JSON.parse(raw); }
	catch { throw new LearningDataError("Invalid session record."); }
	if (!isRecord(record)) throw new LearningDataError("Invalid session record.");
	const { title, kind, createdAt, updatedAt, messages, version = 1 } = record;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
		throw new LearningDataError("Invalid session format version.");
	}
	if (version > CURRENT_CHAT_VERSION) {
		throw new LearningDataError(`Session format version ${version} is newer than supported version ${CURRENT_CHAT_VERSION}.`);
	}
	if (record.id !== id || typeof title !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string" ||
		(kind !== undefined && kind !== "teach" && kind !== "practice") || !Array.isArray(messages) || !messages.every(isNativeMessage)) {
		throw new LearningDataError("Invalid session record.");
	}
	return { summary: { id, title, kind: kind ?? "teach", createdAt, updatedAt }, messages };
}

function graphVersion(raw: string | null): number {
	// Like the app's graph store, missing or malformed stamps read as the original format.
	let stamp: unknown;
	try { stamp = raw === null ? null : JSON.parse(raw); }
	catch { return 1; }
	return isRecord(stamp) && typeof stamp.version === "number" && Number.isInteger(stamp.version) ? stamp.version : 1;
}

function provenance(points: ProvenancePoint[]): ProvenancePoint[] {
	return points.map(({ chatId, messageId }) => ({ chatId, messageId }));
}

/** Reads one explicit learning-data root without starting the application. */
export class LearningReader {
	readonly #root: string;

	constructor(dataDirectory: string) {
		if (!path.isAbsolute(dataDirectory)) throw new LearningDataError("The learning data directory must be an absolute path.");
		try {
			this.#root = realpathSync(dataDirectory);
			if (!statSync(this.#root).isDirectory()) throw new LearningDataError("The learning data path must be a directory.");
		} catch (error) {
			if (error instanceof LearningDataError) throw error;
			throw new LearningDataError("The learning data directory could not be opened.", { cause: error });
		}
	}

	async #directory(name: "chats" | "graph"): Promise<string | null> {
		const directory = await checkedPath(this.#root, path.join(this.#root, name), "directory");
		return directory?.filename ?? null;
	}

	async #readFile(directory: string, name: string): Promise<string | null> {
		const file = await checkedPath(this.#root, path.join(directory, name), "file");
		if (!file) return null;
		try {
			const handle = await open(file.filename, "r");
			try {
				const stat = await handle.stat();
				if (!isSingleLinkFile(stat)) throw new LearningDataError("Unsafe learning data path.");
				if (stat.dev !== file.stat.dev || stat.ino !== file.stat.ino) {
					throw new LearningDataError("Learning data file changed while it was being opened.");
				}
				if (stat.size > MAX_INPUT_BYTES) throw new LearningDataError("Learning data file exceeds the 64 MiB limit.");

				// Read at most the observed size so an append cannot grow this input past the limit.
				const bytes = Buffer.allocUnsafe(stat.size);
				let total = 0;
				while (total < bytes.length) {
					const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
					if (bytesRead === 0) break;
					total += bytesRead;
				}
				return bytes.toString("utf8", 0, total);
			} finally {
				await handle.close();
			}
		} catch (error) {
			return readFailure(error);
		}
	}

	async listSessions(): Promise<SessionSummary[]> {
		const directory = await this.#directory("chats");
		if (!directory) return [];
		let entries;
		try { entries = await readdir(directory, { withFileTypes: true }); }
		catch (error) { return readFailure(error) ?? []; }
		const summaries: SessionSummary[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const id = entry.name.slice(0, -5);
			if (!isSessionId(id)) continue;
			try {
				const raw = await this.#readFile(directory, entry.name);
				if (raw !== null) summaries.push(parseSession(raw, id).summary);
			} catch (error) {
				if (!(error instanceof LearningDataError)) throw error;
				// A bad record must not make every other session disappear.
			}
		}
		return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id, "en"));
	}

	async readSession(sessionId: string): Promise<{ id: string; title: string; markdown: string }> {
		if (!isSessionId(sessionId)) throw new LearningDataError("Invalid session ID.");
		const directory = await this.#directory("chats");
		const raw = directory === null ? null : await this.#readFile(directory, `${sessionId}.json`);
		if (raw === null) throw new LearningDataError("Session not found.");
		const { summary: { id, title }, messages } = parseSession(raw, sessionId);
		try {
			return { id, title, markdown: sessionMarkdown(messages, { title, anchors: false }) };
		} catch (error) {
			throw new LearningDataError("Invalid session transcript.", { cause: error });
		}
	}

	async readGraph(): Promise<DerivedGraph> {
		const directory = await this.#directory("graph");
		if (!directory) return { nodes: [], chains: [] };
		const version = graphVersion(await this.#readFile(directory, "format.json"));
		if (version > CURRENT_GRAPH_FORMAT_VERSION) {
			throw new LearningDataError(`Graph format version ${version} is newer than supported version ${CURRENT_GRAPH_FORMAT_VERSION}.`);
		}
		const nodes = parseGraphLedger(await this.#readFile(directory, "nodes.jsonl") ?? "").filter(isGraphNode)
			.map(({ id, name, statement, aliases, createdAt, provenance: points }) => ({
				id, name, statement, aliases, createdAt, provenance: provenance(points),
			}));
		const chains = parseGraphLedger(await this.#readFile(directory, "chains.jsonl") ?? "").filter(isGraphChain)
			.map(({ id, premises, conclusion, createdAt, provenance: points }) => ({
				id, premises, conclusion, createdAt, provenance: provenance(points),
			}));
		return getGraph({ readNodes: () => nodes, readChains: () => chains });
	}
}
