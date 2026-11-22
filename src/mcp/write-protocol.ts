import { createHmac } from "node:crypto";
import { realpathSync } from "node:fs";
import { z } from "zod";

export const MCP_WRITE_PATH = "/api/mcp/write";
export const MCP_PROFILE_HEADER = "x-learnharness-mcp-profile";
export const MCP_RESULT_LIMIT_BYTES = 128 * 1024;

export const importFileArguments = z.strictObject({ path: z.string().min(1).max(1024) });
export const attachFileArguments = importFileArguments.extend({
	session_id: z.string().regex(/^[A-Za-z0-9_-]+$/),
	message: z.string().max(3000).optional(),
});

export const mcpWriteOperationSchema = z.discriminatedUnion("operation", [
	importFileArguments.extend({ operation: z.literal("import_file") }),
	attachFileArguments.extend({ operation: z.literal("attach_file") }),
]);

export type McpWriteOperation = z.infer<typeof mcpWriteOperationSchema>;

export function isMcpWriteToken(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function mcpWriteProfileProof(dataDirectory: string, token: string): string {
	const canonical = realpathSync.native(dataDirectory);
	return createHmac("sha256", token).update("learnharness-mcp-write-v1\0").update(canonical).digest("hex");
}
