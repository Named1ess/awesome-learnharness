import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { parseMcpSettings, type McpSettings, type McpSetup } from "../core/mcp-settings.ts";
import { isMcpWriteToken } from "../mcp/write-protocol.ts";
import { readMcpSettings, writeMcpSettings } from "../store/settings.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { apiRequestRefusal, browserOnlyMode, subscriptionRequestOrigin } from "./desktop-access.ts";

export const MCP_LOOPBACK_AUTHORITY = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i;

async function canonicalDirectory(configured: string | undefined): Promise<string | null> {
	if (!configured || !path.isAbsolute(configured)) return null;
	if (process.platform === "win32" && /^[\\/]$/.test(path.parse(configured).root)) return null;
	try {
		const stat = await lstat(/* turbopackIgnore: true */ configured);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
		const canonical = await realpath(/* turbopackIgnore: true */ configured);
		const checked = await lstat(/* turbopackIgnore: true */ canonical);
		return checked.isDirectory() && stat.dev === checked.dev && stat.ino === checked.ino ? canonical : null;
	} catch {
		return null;
	}
}

function containsPath(root: string, directory: string): boolean {
	const relative = path.relative(root, directory);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** The launcher sets the maximum scope. An unavailable saved folder never
 * falls back to that broader scope. Resolve both paths on each request. */
export async function resolveMcpFilesDirectory(approved: string | undefined, selected: string | null): Promise<string | null> {
	const root = await canonicalDirectory(approved);
	if (!root || selected === null) return root;
	// Check the spelling before probing a user-supplied path. In particular,
	// never touch a different drive or network share just to reject it.
	if (!path.isAbsolute(selected) || (!containsPath(root, selected) && !(approved && containsPath(approved, selected)))) return null;
	const directory = await canonicalDirectory(selected);
	return directory && containsPath(root, directory) ? directory : null;
}

async function localScriptPath(): Promise<string | null> {
	const script = path.join(/* turbopackIgnore: true */ process.cwd(), "scripts", "learnharness-mcp.mjs");
	try {
		return (await lstat(/* turbopackIgnore: true */ script)).isFile() ? script : null;
	} catch {
		return null;
	}
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleMcpSettingsRequest(request: Request, env: Record<string, string | undefined> = process.env): Promise<Response> {
	const host = request.headers.get("host");
	const origin = subscriptionRequestOrigin(request);
	const requestOrigin = request.headers.get("origin");
	const site = request.headers.get("sec-fetch-site");
	const sourceMode = browserOnlyMode(env);
	const saving = request.method === "PUT";
	if (apiRequestRefusal(request, env) || !host || !MCP_LOOPBACK_AUTHORITY.test(host) || !origin ||
		((saving || requestOrigin !== null) && requestOrigin !== origin) || (site !== null && site !== "same-origin" && site !== "none")) {
		return json({ error: "MCP settings are available in the local LearnHarness app." }, 403);
	}

	let { settings, error: settingsError } = readMcpSettings();
	const approved = sourceMode ? env.LH_MCP_FILES_DIR : undefined;
	if (saving) {
		if (!sourceMode) return json({ error: "MCP writes require a running LearnHarness source server." }, 403);
		let body: unknown;
		try { body = await readBoundedJson(request, 16 * 1024); }
		catch (error) {
			return error instanceof CustomBodyLimitError
				? json({ error: "MCP settings exceed the 16 KiB limit." }, 413)
				: json({ error: "Invalid MCP settings JSON." }, 400);
		}
		const parsed = parseMcpSettings(body);
		if (!parsed.ok) return json({ error: parsed.error }, 400);
		const selected = parsed.settings.filesDirectory;
		if (selected !== null && selected !== settings.filesDirectory && !await resolveMcpFilesDirectory(approved, selected)) {
			return json({ error: "Enter an existing absolute folder within the launcher’s LH_MCP_FILES_DIR." }, 400);
		}
		try { settings = writeMcpSettings(parsed.settings); }
		catch { return json({ error: "Could not save MCP settings." }, 500); }
		settingsError = undefined;
	}

	return json(await setupResponse(settings, settingsError, sourceMode, origin, approved, env.LH_MCP_WRITE_TOKEN));
}

async function setupResponse(
	settings: McpSettings,
	settingsError: string | undefined,
	sourceMode: boolean,
	origin: string,
	approved: string | undefined,
	token: string | undefined,
): Promise<McpSetup> {
	const [filesDirectory, scriptPath] = await Promise.all([
		resolveMcpFilesDirectory(approved, settings.filesDirectory),
		sourceMode ? localScriptPath() : null,
	]);
	return {
		settings,
		...(settingsError ? { settingsError } : {}),
		status: {
			sourceMode,
			tokenConfigured: sourceMode && isMcpWriteToken(token),
			filesDirectory: sourceMode ? settings.filesDirectory ?? approved ?? null : null,
			filesAvailable: filesDirectory !== null,
			dataDirectory: PATHS.data,
			nodeCommand: sourceMode ? process.execPath : "node",
			scriptPath,
			appUrl: sourceMode && origin.startsWith("http://") ? origin : null,
		},
	};
}
