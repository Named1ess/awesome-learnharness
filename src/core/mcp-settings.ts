/** Nonsecret preferences for the authenticated local MCP write bridge. */
export interface McpSettings {
	allowWrites: boolean;
	allowClientReasoning: boolean;
	filesDirectory: string | null;
}

export interface McpSetup {
	settings: McpSettings;
	settingsError?: string;
	status: {
		sourceMode: boolean;
		tokenConfigured: boolean;
		filesDirectory: string | null;
		filesAvailable: boolean;
		dataDirectory: string;
		nodeCommand: string;
		scriptPath: string | null;
		appUrl: string | null;
	};
}

export const DEFAULT_MCP_SETTINGS: Readonly<McpSettings> = Object.freeze({
	allowWrites: true,
	allowClientReasoning: true,
	filesDirectory: null,
});

export const BLOCKED_MCP_SETTINGS: Readonly<McpSettings> = Object.freeze({
	allowWrites: false,
	allowClientReasoning: false,
	filesDirectory: null,
});

type McpSettingsParseResult =
	| { ok: true; settings: McpSettings }
	| { ok: false; error: string };

const invalidSettingsMessage = "MCP settings require allowWrites and allowClientReasoning booleans and a filesDirectory path or null.";

/** The server validates the path on its own filesystem before using it. */
export function parseMcpSettings(raw: unknown): McpSettingsParseResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, error: invalidSettingsMessage };
	}
	const keys = Object.keys(raw);
	if (keys.length !== 3 || keys.some(key => key !== "allowWrites" && key !== "allowClientReasoning" && key !== "filesDirectory")) {
		return { ok: false, error: invalidSettingsMessage };
	}
	const { allowWrites, allowClientReasoning, filesDirectory } = raw as Record<string, unknown>;
	if (typeof allowWrites !== "boolean" || typeof allowClientReasoning !== "boolean" ||
		(filesDirectory !== null && (typeof filesDirectory !== "string" || !filesDirectory.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(filesDirectory)))) {
		return { ok: false, error: invalidSettingsMessage };
	}
	return { ok: true, settings: { allowWrites, allowClientReasoning, filesDirectory } };
}
