/** The application entry point for importing validated uploads into the knowledge graph. */
import { IMPORT_EXTENSIONS, MAX_IMPORT_BYTES, UNSUPPORTED_TYPE_MESSAGE, validNotesPath } from "../../lib/notes-import-limits.ts";
import { NotesImportError } from "../agent/subagents/extraction.ts";
import { joinPages } from "../agent/subagents/pdf-markdown.ts";
import { convertPdf } from "../agent/subagents/pdf-ops.ts";
import type { EmissionStats } from "../core/contracts/graph.ts";
import { emit } from "../core/events.ts";
import { ModelsNotConfiguredError, PROVIDER_KEY_MISSING_CODE, ProviderKeyMissingError } from "../core/settings.ts";
import { extraction } from "./chat-handler.ts";
import { currentClientInference } from "./mcp-inference.ts";
import { sourceDirectory } from "./source-organization.ts";

interface ImportResult {
	requestIndex: number;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	filePath: string;
	ok: boolean;
	stats?: EmissionStats;
	error?: string;
	/** The machine discriminator when ok:false is a config refusal — the
	 * BYOK models refusal (owner, 2026-09-22) or the provider-key refusal
	 * (2026-09-25); the client can open the setup/keys flow off it. */
	code?: "models_not_configured" | (typeof PROVIDER_KEY_MISSING_CODE);
	missing?: string[];
	/** The key-refusal specifics (provider_key_missing only). */
	provider?: string;
	slots?: string[];
	/** Shown beside a completed import (every PDF: scanner text may be wrong). */
	notice?: string;
}

const MAX_PDF_PAGES = 1000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

type NotesFile = { kind: "notes"; text: string; notice?: string } | { kind: "refused"; error: string };

/** A PDF becomes page-marked Markdown; any other accepted file is read as text. */
async function readNotesFile(file: File, signal?: AbortSignal): Promise<NotesFile> {
	if (!IMPORT_EXTENSIONS.test(file.name)) return { kind: "refused", error: UNSUPPORTED_TYPE_MESSAGE };
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (!PDF_MAGIC.every((byte, i) => bytes[i] === byte)) {
		if (bytes.subarray(0, 8192).includes(0)) return { kind: "refused", error: "This file isn't plain text." };
		return { kind: "notes", text: new TextDecoder().decode(bytes) };
	}
	const pdf = await convertPdf(bytes, MAX_PDF_PAGES, { signal });
	switch (pdf.kind) {
		case "unreadable":
			return { kind: "refused", error: "Could not open this PDF." };
		case "too-long":
			return { kind: "refused", error: "Too long. Max 1,000 pages." };
		case "converted": {
			const text = joinPages(pdf.pages);
			if (!text) return { kind: "refused", error: "OCR not supported yet." };
			const skipped = pdf.pages.filter((page) => page.kind === "image-only").length;
			const omission = skipped > 0 ? ` Skipped ${skipped} image-only ${skipped === 1 ? "page" : "pages"}; OCR is not supported.` : "";
			return { kind: "notes", text, notice: `Scanned pages may have errors.${omission}` };
		}
	}
}

/** Validate all logical paths before dispatching any of the files.
 * The same extraction pipeline serves application sessions and imports.
 * At most three files in this request can convert or extract at once. */
export async function importGraphNotes(files: File[], suppliedPaths: FormDataEntryValue[] = []): Promise<Response> {
	if (files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES) {
		return Response.json({ results: [] as ImportResult[], error: "Too big. Max 25 MB." }, { status: 413 });
	}
	if (files.length === 0) {
		return Response.json({ results: [] as ImportResult[], error: "no files" }, { status: 400 });
	}

	// PR198: folder-relative identity, matched to either browser filename form.
	// Validate every path before conversions, metadata writes, or model calls.
	if (suppliedPaths.length > 0 && (suppliedPaths.length !== files.length || suppliedPaths.some((p) => typeof p !== "string"))) {
		return Response.json({ results: [], error: "Invalid import paths" }, { status: 400 });
	}
	const paths = suppliedPaths.length > 0 ? suppliedPaths as string[] : files.map((f) => f.name);
	if (files.some((file, i) => !validNotesPath(paths[i]!, file.name))) {
		return Response.json({ results: [], error: "Import contains an unsafe or mismatched relative path" }, { status: 400 });
	}
	const results: ImportResult[] = [];
	const signal = currentClientInference()?.signal;
	const checkCancellation = () => {
		if (signal?.aborted) throw new NotesImportError("aborted", { nodes: 0, chains: 0 }, "Caller extraction cancelled.");
	};
	const queue = files.map((file, requestIndex) => ({ file, requestIndex, filePath: paths[requestIndex]! }));
	const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const { file, requestIndex, filePath } = next;
			try {
				checkCancellation();
				const notes = await readNotesFile(file, signal);
				checkCancellation();
				if (notes.kind === "refused") {
					results.push({ filePath, requestIndex, outcome: "failed", ok: false, error: notes.error });
					continue;
				}
				sourceDirectory.registerImport(filePath);
				const stats = await extraction.importNotes({ filePath, text: notes.text });
				results.push({ filePath, requestIndex, outcome: "completed", ok: true, stats, ...(notes.notice ? { notice: notes.notice } : {}) });
			} catch (err) {
				if (err instanceof ModelsNotConfiguredError) {
					results.push({ filePath, ok: false, requestIndex, outcome: "failed", error: err.envelope.error,
						code: "models_not_configured", missing: err.envelope.missing });
				} else if (err instanceof ProviderKeyMissingError) {
					results.push({ filePath, ok: false, requestIndex, outcome: "failed", error: err.envelope.error,
						code: PROVIDER_KEY_MISSING_CODE, provider: err.envelope.provider, slots: err.envelope.slots });
				} else if (signal?.aborted && !(err instanceof NotesImportError)) {
					results.push({ filePath, requestIndex, outcome: "aborted", ok: false, error: "Caller extraction cancelled." });
				} else {
					results.push({ filePath, requestIndex, ok: false,
						outcome: err instanceof NotesImportError ? err.outcome : "failed",
						...(err instanceof NotesImportError ? { stats: err.partialStats } : {}),
						error: err instanceof Error ? err.message : String(err) });
				}
			} finally { emit("sources-changed", {}); }
		}
	});
	await Promise.all(workers);
	return Response.json({ results });
}
