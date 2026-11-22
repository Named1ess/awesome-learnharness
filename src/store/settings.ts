/**
 * Server-side persistence for THE user settings record (settings-storage
 * wave, 2026-09-19): data/settings.json (config.SETTINGS_FILE), under the
 * LH_DATA_DIR seam — read-modify-write, NOT a ledger. Non-secret product
 * preferences only; secrets stay in auth.json / .env.local.
 *
 * This adapter OWNS the lazy migrations:
 *  1. schema-version bumps (CURRENT_SETTINGS_VERSION) slot in here — the
 *     chain is empty today (v1 is the first shape); pure additions never
 *     bump, so an up-to-date file is always a no-op pass-through.
 *    (The legacy default-settings.json fold died with the chat section —
 *     per-session models, owner 2026-09-28.)
 *
 * Everything off disk is sanitized (core/settings.ts) before it reaches a
 * caller; everything written was already validated by the routes
 * (settings-body.ts) and is sanitized here again — the file can never hold
 * a value that would silently shift a knob.
 */

import fs from "node:fs";
import path from "node:path";
import { SETTINGS_FILE } from "../../config.ts";
import {
	CURRENT_SETTINGS_VERSION,
	sanitizeUserSettings,
	type UserSettings,
} from "../core/settings.ts";
import type { SettingsStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";
import { parseFileAccessSettings, type FileAccessSettingsResult } from "../core/file-access.ts";
import { BLOCKED_MCP_SETTINGS, DEFAULT_MCP_SETTINGS, parseMcpSettings, type McpSettings } from "../core/mcp-settings.ts";

const FILE_ACCESS_ERROR = "File-access configuration cannot be read reliably. Learner-file access is blocked. Repair File access in Settings → Agent → Tools.";
const MCP_SETTINGS_ERROR = "MCP settings cannot be read reliably. MCP writes are blocked. Repair the configuration in Settings → MCP.";

/** Separate strict view: the ordinary settings API keeps its historical
 * null/default behavior, but source access must distinguish absent prefs
 * from existing corrupt/unreadable settings. Never expose raw JSON/errors. */
function fileAccessFromDocument(document: SettingsDocument): FileAccessSettingsResult {
	if (document.kind === "invalid") return { ok: false, error: FILE_ACCESS_ERROR };
	const agent = document.kind === "record" ? document.record.agent : undefined;
	if (agent === undefined) return { ok: true, settings: { restricted: false, folders: [] } };
	if (!agent || typeof agent !== "object" || Array.isArray(agent)) return { ok: false, error: FILE_ACCESS_ERROR };
	const value = (agent as Record<string, unknown>).fileAccess;
	if (value === undefined) return { ok: true, settings: { restricted: false, folders: [] } };
	const parsed = parseFileAccessSettings(value);
	if (!parsed.ok || parsed.settings.folders.some((folder) => folder !== "~" && !folder.startsWith("~/") && !path.isAbsolute(folder))) {
		return { ok: false, error: FILE_ACCESS_ERROR };
	}
	return parsed;
}

/** ENOENT from a dangling settings/ancestor symlink is NOT first boot.
 * Find the nearest existing entry and verify its directory is usable. */
function settingsAreAbsent(): boolean {
	let candidate = SETTINGS_FILE;
	for (;;) {
		try { fs.lstatSync(/* turbopackIgnore: true */ candidate); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
			const parent = path.dirname(candidate);
			if (parent === candidate) return false;
			candidate = parent;
			continue;
		}
		if (candidate === SETTINGS_FILE) return false;
		try {
			if (!fs.statSync(/* turbopackIgnore: true */ candidate).isDirectory()) return false;
			fs.accessSync(/* turbopackIgnore: true */ candidate, fs.constants.R_OK | fs.constants.X_OK);
			return true;
		} catch { return false; }
	}
}

type SettingsDocument =
	| { kind: "missing" | "invalid" }
	| { kind: "record"; record: Record<string, unknown> };

function readSettingsDocument(): SettingsDocument {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
		return raw && typeof raw === "object" && !Array.isArray(raw)
			? { kind: "record", record: raw as Record<string, unknown> }
			: { kind: "invalid" };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" && settingsAreAbsent()
			? { kind: "missing" }
			: { kind: "invalid" };
	}
}

export function readFileAccessSettings(): FileAccessSettingsResult {
	return fileAccessFromDocument(readSettingsDocument());
}

function mcpFromDocument(document: SettingsDocument): { settings?: McpSettings; error?: string } {
	if (document.kind === "missing") return {};
	if (document.kind === "record") {
		if (document.record.mcp === undefined) return {};
		const parsed = parseMcpSettings(document.record.mcp);
		if (parsed.ok) return { settings: parsed.settings };
	}
	return { settings: { ...BLOCKED_MCP_SETTINGS }, error: MCP_SETTINGS_ERROR };
}

export function readMcpSettings(): { settings: McpSettings; error?: string } {
	return { settings: { ...DEFAULT_MCP_SETTINGS }, ...mcpFromDocument(readSettingsDocument()) };
}

/** The persisted record, or null when none exists (first boot). Runs the
 *  migration chain on every read — cheap: a no-op file check when current. */
export function readSettings(): UserSettings | null {
	const document = readSettingsDocument();
	if (document.kind !== "record") return null;
	const record = sanitizeUserSettings(document.record);
	if (!record) return null;
	if (!fileAccessFromDocument(document).ok) {
		// Unrelated section writes carry this safe placeholder, not a dropped
		// malformed policy that would silently restore unrestricted reads.
		record.agent = { ...record.agent, fileAccess: { restricted: true, folders: [] } };
	}
	// Version chain (empty today): a future v2 migration slots in here —
	// `if (record.version > CURRENT_SETTINGS_VERSION) …`. Unknown NEWER
	// versions pass through untouched (the sanitizer preserved unknowns).
	return record;
}

function persistSettings(settings: UserSettings, document: SettingsDocument): UserSettings {
	if (!fileAccessFromDocument(document).ok && settings.agent?.fileAccess === undefined) {
		// A whole-file corruption cannot be carried by readSettings (null).
		// Saving another preference repairs it into a BLOCKED policy unless
		// the write explicitly supplies a valid file-access preference.
		settings.agent = { ...settings.agent, fileAccess: { restricted: true, folders: [] } };
	}
	fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
	writeFileAtomicSync(SETTINGS_FILE, JSON.stringify(settings, null, "\t"), { allowInPlaceFallback: true });
	return settings;
}

/** Ordinary settings writes carry MCP's latest persisted policy. */
export function writeSettings(raw: unknown): UserSettings {
	const settings = sanitizeUserSettings(raw);
	if (!settings) throw new Error("settings record must be a JSON object");
	const document = readSettingsDocument();
	const { settings: mcp } = mcpFromDocument(document);
	if (mcp) settings.mcp = mcp;
	else delete settings.mcp;
	return persistSettings(settings, document);
}

/** The guarded MCP settings route is the only caller that replaces MCP policy. */
export function writeMcpSettings(settings: McpSettings): McpSettings {
	const parsed = parseMcpSettings(settings);
	if (!parsed.ok) throw new TypeError(parsed.error);
	const document = readSettingsDocument();
	const record = document.kind === "record" ? sanitizeUserSettings(document.record) : null;
	persistSettings({ ...(record ?? { version: CURRENT_SETTINGS_VERSION }), mcp: parsed.settings }, document);
	return parsed.settings;
}

/** The typed adapter (core/ports.ts SettingsStore), for the composition root. */
export const settingsStore: SettingsStore = {
	readSettings,
	writeSettings,
};
