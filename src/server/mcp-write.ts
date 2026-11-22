import { timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BYTES, UNSUPPORTED_TYPE_MESSAGE } from "../../lib/notes-import-limits.ts";
import { PATHS } from "../../config.ts";
import { resolvePolicy, type FileAccessPolicy } from "../agent/tools/file-access.ts";
import { resolveSourcePath } from "../agent/tools/fs-shared.ts";
import { parseFilePaths, quoteFilePath } from "../core/file-paths.ts";
import { isMcpWriteToken, MCP_PROFILE_HEADER, mcpWriteOperationSchema, mcpWriteProfileProof } from "../mcp/write-protocol.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { browserOnlyMode } from "./desktop-access.ts";
import { fileAccessPolicy } from "./file-access.ts";

const MAX_BODY_BYTES = 16 * 1024;
const LOOPBACK_AUTHORITY = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i;
const INVALID_PATH_CHARACTER = /[\\:\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const WINDOWS_DEVICE = /^(?:CON(?:IN\$|OUT\$)?|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i;
const OPEN_FILE_POLICY = { restricted: false, folders: [], unavailable: [] };
const FILE_REFUSAL = "The document is unavailable or outside the approved file access.";

interface McpWriteDependencies {
	importGraphNotes(files: File[], paths: FormDataEntryValue[]): Promise<Response>;
	handleMcpAttachment(sessionId: string, text: string): Promise<Response>;
	env?: Record<string, string | undefined>;
	dataDirectory?: string;
	attachmentPolicy?: () => FileAccessPolicy;
}

class InvalidDocument extends Error {}
class DocumentTooLarge extends Error {}

function errorResponse(message: string, status: number): Response {
	return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function matchesHex(supplied: string | null, expected: string): boolean {
	return isMcpWriteToken(supplied) && timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}

function isRelativeFile(relative: string): boolean {
	if (INVALID_PATH_CHARACTER.test(relative)) return false;
	return relative.split("/").every(segment => segment !== "" && segment !== "." && segment !== ".." &&
		(process.platform !== "win32" || (!/[<>"|?*]|[. ]$/.test(segment) && !WINDOWS_DEVICE.test(segment))));
}

async function filesRoot(configured: string | undefined): Promise<string | null> {
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

function isSingleLinkFile(stat: Stats): boolean {
	return stat.isFile() && stat.nlink === 1;
}

/** Walk every submitted component before opening any file. The app guard then
 * applies the normal named/canonical sensitive denials and the chosen policy. */
async function checkedFile(root: string, relative: string, policy: ReturnType<typeof resolvePolicy>): Promise<{ filename: string; stat: Stats }> {
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

async function readDocument(file: { filename: string; stat: Stats }): Promise<Uint8Array<ArrayBuffer>> {
	const handle = await open(/* turbopackIgnore: true */ file.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await handle.stat();
		if (!isSingleLinkFile(stat) || stat.dev !== file.stat.dev || stat.ino !== file.stat.ino) throw new InvalidDocument();
		if (stat.size > MAX_IMPORT_BYTES) throw new DocumentTooLarge();
		const bytes = new Uint8Array(stat.size);
		let total = 0;
		while (total < bytes.length) {
			const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		const after = await handle.stat();
		if (after.size > MAX_IMPORT_BYTES) throw new DocumentTooLarge();
		if (!isSingleLinkFile(after) || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || total !== bytes.length) {
			throw new InvalidDocument();
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

function attachmentMessage(reference: string, message?: string): string {
	if (!message) return reference;
	const text = `${message}\n${reference}`;
	const lastPart = parseFilePaths(text).at(-1);
	// An unclosed code span can consume the attachment's opening delimiter.
	return lastPart?.kind === "path" && lastPart.start === message.length + 1 ? text : `${reference}\n${message}`;
}

export async function handleMcpWriteRequest(request: Request, deps: McpWriteDependencies): Promise<Response> {
	const env = deps.env ?? process.env;
	const token = env.LH_MCP_WRITE_TOKEN;
	const authorization = request.headers.get("authorization");
	const authority = request.headers.get("host");
	if (!browserOnlyMode(env) || !authority || !LOOPBACK_AUTHORITY.test(authority) || !isMcpWriteToken(token) ||
		!authorization?.startsWith("Bearer ") || !matchesHex(authorization.slice(7), token)) {
		return errorResponse("MCP write access is unavailable or unauthorized.", 403);
	}
	let proof: string;
	try { proof = mcpWriteProfileProof(deps.dataDirectory ?? PATHS.data, token); }
	catch { return errorResponse("The running LearnHarness profile does not match the MCP request.", 403); }
	if (!matchesHex(request.headers.get(MCP_PROFILE_HEADER), proof)) {
		return errorResponse("The running LearnHarness profile does not match the MCP request.", 403);
	}

	let body: unknown;
	try { body = await readBoundedJson(request, MAX_BODY_BYTES); }
	catch (error) {
		return error instanceof CustomBodyLimitError
			? errorResponse("MCP write request exceeds the 16 KiB limit.", 413)
			: errorResponse("Invalid MCP write JSON.", 400);
	}
	const parsed = mcpWriteOperationSchema.safeParse(body);
	if (!parsed.success || !isRelativeFile(parsed.data.path)) return errorResponse("Invalid MCP write operation or relative file path.", 400);
	const operation = parsed.data;
	const importing = operation.operation === "import_file";
	if (importing && !IMPORT_EXTENSIONS.test(operation.path)) return errorResponse(UNSUPPORTED_TYPE_MESSAGE, 400);
	const root = await filesRoot(env.LH_MCP_FILES_DIR);
	if (!root) return errorResponse("The MCP files directory is not configured or cannot be accessed.", 503);

	let file: { filename: string; stat: Stats };
	try {
		const policy = importing ? OPEN_FILE_POLICY : resolvePolicy((deps.attachmentPolicy ?? fileAccessPolicy)());
		file = await checkedFile(root, operation.path, policy);
	} catch {
		return errorResponse(FILE_REFUSAL, 400);
	}

	if (operation.operation === "import_file") {
		let upload: File;
		try {
			const bytes = await readDocument(file);
			upload = new File([bytes], path.posix.basename(operation.path));
		} catch (error) {
			return error instanceof DocumentTooLarge
				? errorResponse("Too big. Max 25 MB.", 413)
				: errorResponse(FILE_REFUSAL, 400);
		}
		return deps.importGraphNotes([upload], [operation.path]);
	}

	let reference: string;
	try { reference = quoteFilePath(file.filename); }
	catch { return errorResponse(FILE_REFUSAL, 400); }
	const result = await deps.handleMcpAttachment(operation.session_id, attachmentMessage(reference, operation.message));
	if (!result.ok) return result;
	return Response.json({ session_id: operation.session_id, status: "accepted" });
}
