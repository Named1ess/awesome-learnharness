import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { ResolvedFileAccessPolicy } from "../agent/tools/file-access.ts";
import { resolveSourcePath } from "../agent/tools/fs-shared.ts";

const INVALID_PATH_CHARACTER = /[\\:\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const WINDOWS_DEVICE = /^(?:CON(?:IN\$|OUT\$)?|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i;

export class InvalidDocument extends Error {}

export function isRelativeFile(relative: string): boolean {
	if (INVALID_PATH_CHARACTER.test(relative)) return false;
	return relative.split("/").every(segment => segment !== "" && segment !== "." && segment !== ".." &&
		(process.platform !== "win32" || (!/[<>"|?*]|[. ]$/.test(segment) && !WINDOWS_DEVICE.test(segment))));
}

export function isSingleLinkFile(stat: Stats): boolean {
	return stat.isFile() && stat.nlink === 1;
}

/** Check every component before opening a file, including canonical protected paths. */
export async function checkedFile(root: string, relative: string, policy: ResolvedFileAccessPolicy): Promise<{ filename: string; stat: Stats }> {
	const components = relative.split("/");
	let candidate = root;
	for (const [index, part] of components.entries()) {
		candidate = path.join(/* turbopackIgnore: true */ candidate, part);
		const stat = await lstat(/* turbopackIgnore: true */ candidate);
		const last = index === components.length - 1;
		if (stat.isSymbolicLink() || (last ? !isSingleLinkFile(stat) : !stat.isDirectory())) throw new InvalidDocument();
		const canonical = await realpath(/* turbopackIgnore: true */ candidate);
		if (path.relative(candidate, canonical) !== "") throw new InvalidDocument();
		if (last) {
			const filename = resolveSourcePath(candidate, policy);
			if (path.relative(canonical, filename) !== "") throw new InvalidDocument();
			return { filename, stat };
		}
	}
	throw new InvalidDocument();
}
