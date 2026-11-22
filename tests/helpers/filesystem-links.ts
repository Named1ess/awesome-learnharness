import { symlinkSync } from "node:fs";

export const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
export const fileSymlinkUnavailable = "This Windows account cannot create file symlinks";

export function tryFileSymlink(target: string, link: string): boolean {
	try {
		symlinkSync(target, link, "file");
		return true;
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) return false;
		throw error;
	}
}
