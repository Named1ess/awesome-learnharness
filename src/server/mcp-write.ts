import { timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { IMPORT_EXTENSIONS, MAX_IMPORT_BYTES, UNSUPPORTED_TYPE_MESSAGE } from "../../lib/notes-import-limits.ts";
import { PATHS } from "../../config.ts";
import { resolvePolicy, type FileAccessPolicy } from "../agent/tools/file-access.ts";
import { parseFilePaths, quoteFilePath } from "../core/file-paths.ts";
import { isMcpWriteToken, MCP_PROFILE_HEADER, mcpWriteOperationSchema, mcpWriteProfileProof, type McpWriteOperation } from "../mcp/write-protocol.ts";
import { MCP_CLIENT_HEADER, MCP_CLIENT_REQUEST_BYTES, mcpClientOperationSchema, type McpClientOperation } from "../mcp/client-protocol.ts";
import { readMcpSettings } from "../store/settings.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { browserOnlyMode } from "./desktop-access.ts";
import { fileAccessPolicy } from "./file-access.ts";
import { MCP_LOOPBACK_AUTHORITY, resolveMcpFilesDirectory } from "./mcp-settings.ts";
import { checkedFile, InvalidDocument, isRelativeFile, isSingleLinkFile } from "./mcp-shared-file.ts";

const MAX_BODY_BYTES = 16 * 1024;
const OPEN_FILE_POLICY = { restricted: false, folders: [], unavailable: [] };
const FILE_REFUSAL = "The document is unavailable or outside the approved file access.";
const MCP_WRITES_DISABLED = "MCP writes are disabled in LearnHarness Settings.";
const CLIENT_OBSERVATION_OPERATIONS: ReadonlySet<McpClientOperation["operation"]> = new Set([
	"get_session_state", "list_side_threads", "read_side_thread", "list_graph_sources", "get_operation", "cancel_operation", "list_lesson_tasks",
]);

interface McpWriteDependencies {
	importGraphNotes(files: File[], paths: FormDataEntryValue[]): Promise<Response>;
	handleMcpAttachment(sessionId: string, text: string): Promise<Response>;
	handleMcpClientOperation?(operation: McpClientOperation, fileOperation: () => Promise<Response>, filesDirectory?: string): Promise<Response>;
	env?: Record<string, string | undefined>;
	dataDirectory?: string;
	attachmentPolicy?: () => FileAccessPolicy;
}

class DocumentTooLarge extends Error {}

function errorResponse(message: string, status: number): Response {
	return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function matchesHex(supplied: string | null, expected: string): boolean {
	return isMcpWriteToken(supplied) && timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
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
	if (!browserOnlyMode(env) || !authority || !MCP_LOOPBACK_AUTHORITY.test(authority) || !isMcpWriteToken(token) ||
		!authorization?.startsWith("Bearer ") || !matchesHex(authorization.slice(7), token)) {
		return errorResponse("MCP write access is unavailable or unauthorized.", 403);
	}
	let proof: string;
	try { proof = mcpWriteProfileProof(deps.dataDirectory ?? PATHS.data, token); }
	catch { return errorResponse("The running LearnHarness profile does not match the MCP request.", 403); }
	if (!matchesHex(request.headers.get(MCP_PROFILE_HEADER), proof)) {
		return errorResponse("The running LearnHarness profile does not match the MCP request.", 403);
	}

	const clientReasoning = request.headers.get(MCP_CLIENT_HEADER) === "1";
	let body: unknown;
	try { body = await readBoundedJson(request, clientReasoning ? MCP_CLIENT_REQUEST_BYTES : MAX_BODY_BYTES); }
	catch (error) {
		return error instanceof CustomBodyLimitError
			? errorResponse(clientReasoning ? "MCP client request exceeds the 256 KiB limit." : "MCP write request exceeds the 16 KiB limit.", 413)
			: errorResponse("Invalid MCP write JSON.", 400);
	}
	const { settings, error: settingsError } = readMcpSettings();
	if (clientReasoning) {
		if (!deps.handleMcpClientOperation) return errorResponse("Client-driven inference is unavailable.", 503);
		const client = mcpClientOperationSchema.safeParse(body);
		if (!client.success) return errorResponse("Invalid MCP client operation.", 400);
		const operation = client.data;
		// Leave authenticated reads and cancellation available to connected clients.
		// The gates still cover both new work and inference steps for existing work.
		if (!CLIENT_OBSERVATION_OPERATIONS.has(operation.operation)) {
			if (!settings.allowWrites) return errorResponse(settingsError ?? MCP_WRITES_DISABLED, 403);
			if (!settings.allowClientReasoning) return errorResponse("MCP client reasoning is disabled in LearnHarness Settings.", 403);
		}
		const root = "request_id" in operation ? await resolveMcpFilesDirectory(env.LH_MCP_FILES_DIR, settings.filesDirectory) : null;
		return deps.handleMcpClientOperation(operation, () => operation.operation === "import_file" || operation.operation === "attach_file"
			? executeFileOperation(operation, deps, root)
			: Promise.resolve(errorResponse("This operation does not take a file.", 400)), root ?? undefined);
	}
	const parsed = mcpWriteOperationSchema.safeParse(body);
	if (!parsed.success) return errorResponse("Invalid MCP write operation or relative file path.", 400);
	if (!settings.allowWrites) return errorResponse(settingsError ?? MCP_WRITES_DISABLED, 403);
	const root = await resolveMcpFilesDirectory(env.LH_MCP_FILES_DIR, settings.filesDirectory);
	return executeFileOperation(parsed.data, deps, root);
}

async function executeFileOperation(operation: McpWriteOperation, deps: McpWriteDependencies, root: string | null): Promise<Response> {
	if (!isRelativeFile(operation.path)) return errorResponse("Invalid MCP write operation or relative file path.", 400);
	const importing = operation.operation === "import_file";
	if (importing && !IMPORT_EXTENSIONS.test(operation.path)) return errorResponse(UNSUPPORTED_TYPE_MESSAGE, 400);
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
