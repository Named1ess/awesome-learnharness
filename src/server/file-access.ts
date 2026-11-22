/** Current optional learner-source preferences, wired by the server
 * composition root into the #157 policy seam. Mandatory #421 protection
 * stays in fs-shared; do NOT add a whole data/userData denial here. */
import os from "node:os";
import path from "node:path";
import { isWithin, resolvePolicy, type FileAccessPolicy } from "../agent/tools/file-access.ts";
import { readFileAccessSettings } from "../store/settings.ts";
import { currentClientInference } from "./mcp-inference.ts";

export function expandFolder(folder: string, home: string = os.homedir()): string {
	if (folder === "~") return home;
	if (folder.startsWith("~/")) return path.join(home, folder.slice(2));
	if (!path.isAbsolute(folder)) throw new Error("Invalid file-access folder for this server filesystem");
	return path.resolve(folder);
}

export function fileAccessPolicy(): FileAccessPolicy {
	const result = readFileAccessSettings();
	if (!result.ok) return { restricted: true, folders: [], error: result.error };
	const native = { restricted: result.settings.restricted, folders: result.settings.folders.map((folder) => expandFolder(folder)) };
	const client = currentClientInference();
	if (!client) return native;
	const root = client.filesDirectory;
	if (!root || !resolvePolicy({ restricted: true, folders: [root] }).folders.some(folder => path.relative(root, folder) === "")) {
		return { restricted: true, folders: [] };
	}
	if (!native.restricted) return { restricted: true, folders: [root] };
	return { restricted: true, folders: resolvePolicy(native).folders.flatMap(folder => {
		if (isWithin(root, folder)) return [root];
		return isWithin(folder, root) ? [folder] : [];
	}) };
}

/** Safe UI diagnostic, no raw JSON/file contents. A corrupt record must
 * not make the restriction toggle appear safely OFF while reads are blocked. */
export function fileAccessConfigurationError(): string | null {
	const result = readFileAccessSettings();
	return result.ok ? null : result.error;
}
