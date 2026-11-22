import type { GraphChain, GraphNode, ProvenancePoint } from "../core/contracts/graph.ts";

export function parseGraphLedger(raw: string): unknown[] {
	const records: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			records.push(JSON.parse(trimmed));
		} catch {
			// A torn append must not hide the intact records in the ledger.
		}
	}
	return records;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export const isString = (value: unknown): value is string => typeof value === "string";

const isProvenancePoint = (value: unknown): value is ProvenancePoint =>
	isRecord(value) && isString(value.chatId) && isString(value.messageId);

export const isGraphNode = (value: unknown): value is GraphNode =>
	isRecord(value) &&
	isString(value.id) &&
	isString(value.name) &&
	isString(value.statement) &&
	Array.isArray(value.aliases) &&
	value.aliases.every(isString) &&
	isString(value.createdAt) &&
	Array.isArray(value.provenance) &&
	value.provenance.every(isProvenancePoint);

/** Endpoint existence is a derivation concern. The ledger only validates shape. */
export const isGraphChain = (value: unknown): value is GraphChain =>
	isRecord(value) &&
	isString(value.id) &&
	Array.isArray(value.premises) &&
	value.premises.length > 0 &&
	value.premises.every(isString) &&
	isString(value.conclusion) &&
	Array.isArray(value.provenance) &&
	value.provenance.every(isProvenancePoint) &&
	isString(value.createdAt);
