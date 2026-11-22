import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fetch as directFetch } from "undici";
import { z } from "zod";
import { createAddressCheckedAgent } from "../agent/tools/safe-fetch.ts";
import { readBoundedJson } from "../server/custom-provider-body.ts";
import { MCP_CLIENT_HEADER, MCP_CLIENT_REQUEST_BYTES, type McpClientOperation } from "./client-protocol.ts";
import { isMcpWriteToken, MCP_PROFILE_HEADER, MCP_RESULT_LIMIT_BYTES, MCP_WRITE_PATH, mcpWriteProfileProof, type McpWriteOperation } from "./write-protocol.ts";

const loopbackOrigin = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/i;
const loopbackDispatcher = createAddressCheckedAgent(address =>
	address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127."));
const unknownOutcome = "The operation outcome is unknown. Check the app before retrying.";
const importResult = z.object({ results: z.tuple([z.looseObject({
	filePath: z.string(), ok: z.boolean(), outcome: z.enum(["completed", "failed", "partial", "aborted", "busy"]),
})]) });
const attachmentResult = z.object({ session_id: z.string(), status: z.literal("accepted") });
const appError = z.looseObject({ error: z.string() });

export type McpWriteClient = (operation: McpWriteOperation, signal: AbortSignal) => Promise<CallToolResult>;
export type McpClientWriteClient = (operation: McpClientOperation, signal: AbortSignal) => Promise<CallToolResult>;

function appEndpoint(origin: string): URL {
	const url = URL.parse(origin);
	if (!url || origin !== origin.trim() || !loopbackOrigin.test(origin)) {
		throw new Error("--app-url must be a loopback HTTP origin with no credentials, path, query, or fragment.");
	}
	return new URL(MCP_WRITE_PATH, url.origin);
}

function reply(data: unknown, isError: boolean): CallToolResult {
	const result: CallToolResult = { content: [{ type: "text", text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) };
	if (Buffer.byteLength(JSON.stringify(result)) <= MCP_RESULT_LIMIT_BYTES) return result;
	return { isError: true, content: [{ type: "text", text: `The LearnHarness reply exceeds the MCP result limit. ${unknownOutcome}` }] };
}

export function createMcpWriteClient(origin: string, dataDirectory: string, token: string | undefined): McpWriteClient;
export function createMcpWriteClient(origin: string, dataDirectory: string, token: string | undefined, options: { clientReasoning: true }): McpClientWriteClient;
export function createMcpWriteClient(origin: string, dataDirectory: string, token: string | undefined, options?: { clientReasoning: true }): McpWriteClient | McpClientWriteClient {
	const endpoint = appEndpoint(origin);
	if (!isMcpWriteToken(token)) throw new Error("--app-url requires LH_MCP_WRITE_TOKEN with 64 lowercase hexadecimal characters.");
	const headers = {
		"content-type": "application/json",
		authorization: `Bearer ${token}`,
		[MCP_PROFILE_HEADER]: mcpWriteProfileProof(dataDirectory, token),
		...(options?.clientReasoning ? { [MCP_CLIENT_HEADER]: "1" } : {}),
	};
	return async (operation: McpWriteOperation | McpClientOperation, signal: AbortSignal) => {
		const payload = JSON.stringify(operation);
		if (options?.clientReasoning && Buffer.byteLength(payload) > MCP_CLIENT_REQUEST_BYTES) {
			return reply({ error: "The LearnHarness client reasoning request exceeds the 256 KiB limit." }, true);
		}
		try {
			const response = await directFetch(endpoint, {
				method: "POST", headers, body: payload, signal, redirect: "error", dispatcher: loopbackDispatcher,
			});
			const body = await readBoundedJson(response as unknown as Response, MCP_RESULT_LIMIT_BYTES);
			if (!response.ok) {
				const error = appError.safeParse(body);
				if (error.success) return reply(response.status >= 500 ? { ...error.data, notice: unknownOutcome } : error.data, true);
			} else if (options?.clientReasoning) {
				if (typeof body === "object" && body !== null && !Array.isArray(body)) return reply(body, false);
			} else if (operation.operation === "import_file") {
				const imported = importResult.safeParse(body);
				if (imported.success && imported.data.results[0].filePath === operation.path) {
					return reply(imported.data, !imported.data.results[0].ok);
				}
			} else if (operation.operation === "attach_file") {
				const attached = attachmentResult.safeParse(body);
				if (attached.success && attached.data.session_id === operation.session_id) return reply(attached.data, false);
			}
		} catch {
			// The app may have accepted the operation before the connection failed.
		}
		return reply({ error: `Could not confirm the LearnHarness response. ${unknownOutcome}` }, true);
	};
}
