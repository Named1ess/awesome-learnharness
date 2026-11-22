import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { LearningReader } from "./learning-reader.ts";
import type { McpWriteClient } from "./write-client.ts";
import { attachFileArguments, importFileArguments, MCP_RESULT_LIMIT_BYTES } from "./write-protocol.ts";

const offsetArgument = z.int().nonnegative().default(0);
const listArguments = { offset: offsetArgument, limit: z.int().min(1).max(100).default(25) };
const annotations = { readOnlyHint: true, openWorldHint: false };

function resultFits(result: unknown): boolean {
	return Buffer.byteLength(JSON.stringify(result), "utf8") <= MCP_RESULT_LIMIT_BYTES;
}

export class LearningStdioTransport extends StdioServerTransport {
	override send(message: JSONRPCMessage): Promise<void> {
		// SDK-generated tool errors do not pass through the page builder.
		if ("result" in message && !resultFits(message.result)) {
			return super.send({ ...message, result: {
				isError: true,
				content: [{ type: "text", text: "The MCP response exceeds the 128 KiB result limit." }],
			} });
		}
		return super.send(message);
	}
}

function boundedPage<T>(
	items: readonly T[],
	offset: number,
	hasMore: boolean,
	serialize: (items: readonly T[], nextOffset: number | null) => unknown,
): CallToolResult {
	let count = items.length;
	for (;;) {
		const nextOffset = hasMore || count < items.length ? offset + count : null;
		const text = JSON.stringify(serialize(items.slice(0, count), nextOffset));
		const result: CallToolResult = { content: [{ type: "text", text }] };
		if (resultFits(result)) return result;
		if (count <= 1) throw new Error(`The result item at offset ${offset} exceeds the 128 KiB response limit.`);
		count = Math.floor(count / 2);
	}
}

function listPage<T>(items: readonly T[], offset: number, limit: number): CallToolResult {
	return boundedPage(items.slice(offset, offset + limit), offset, offset + limit < items.length,
		(page, nextOffset) => ({ items: page, next_offset: nextOffset }));
}

function transcriptPage(session: { id: string; title: string; markdown: string }, offset: number, limit: number): CallToolResult {
	const characters: string[] = [];
	let position = 0;
	for (const character of session.markdown) {
		if (position++ < offset) continue;
		characters.push(character);
		if (characters.length > limit) break;
	}
	return boundedPage(characters.slice(0, limit), offset, characters.length > limit,
		(page, nextOffset) => ({ id: session.id, title: session.title, markdown: page.join(""), next_offset: nextOffset }));
}

function byId(left: { id: string }, right: { id: string }): number {
	if (left.id === right.id) return 0;
	return left.id < right.id ? -1 : 1;
}

export function createLearningMcpServer(reader: LearningReader, version: string, write?: McpWriteClient): McpServer {
	const server = new McpServer({ name: "learnharness", version });
	server.registerTool("list_sessions", {
		description: "List teaching and practice sessions from the configured learning-data directory, most recently updated first.",
		inputSchema: z.strictObject(listArguments),
		annotations,
	}, async ({ offset, limit }) => listPage(await reader.listSessions(), offset, limit));

	server.registerTool("read_session", {
		description: "Read a session's main transcript as Markdown. Offsets and limits count Unicode code points.",
		inputSchema: z.strictObject({ session_id: z.string().min(1), offset: offsetArgument, limit: z.int().min(1).max(30_000).default(12_000) }),
		annotations,
	}, async ({ session_id, offset, limit }) => transcriptPage(await reader.readSession(session_id), offset, limit));

	server.registerTool("list_propositions", {
		description: "List merged knowledge graph propositions with provenance. An optional query matches names, statements, or aliases as a case-insensitive substring.",
		inputSchema: z.strictObject({ ...listArguments, query: z.string().optional() }),
		annotations,
	}, async ({ query, offset, limit }) => {
		const { nodes } = await reader.readGraph();
		const search = query?.trim().toLowerCase();
		const matches = search ? nodes.filter(({ name, statement, aliases }) =>
			[name, statement, ...aliases].some((text) => text.toLowerCase().includes(search))) : nodes;
		return listPage(matches.toSorted(byId), offset, limit);
	});

	server.registerTool("list_chains", {
		description: "List knowledge graph reasoning chains with provenance. An optional proposition ID matches a premise or the conclusion.",
		inputSchema: z.strictObject({ ...listArguments, proposition_id: z.string().min(1).optional() }),
		annotations,
	}, async ({ proposition_id, offset, limit }) => {
		const { chains } = await reader.readGraph();
		const matches = proposition_id ? chains.filter(({ premises, conclusion }) =>
			conclusion === proposition_id || premises.includes(proposition_id)) : chains;
		return listPage(matches.toSorted(byId), offset, limit);
	});
	if (write) {
		server.registerTool("import_file", {
			description: "Import one file from the app's configured MCP files directory into the knowledge graph. This can call models and change the graph.",
			inputSchema: importFileArguments,
			annotations: { readOnlyHint: false, openWorldHint: true },
		}, (args, { signal }) => write({ operation: "import_file", ...args }, signal));
		server.registerTool("attach_file", {
			description: "Send a file reference and optional learner message in an existing session. This starts an Agent turn. A successful result confirms acceptance.",
			inputSchema: attachFileArguments,
			annotations: { readOnlyHint: false, openWorldHint: true },
		}, (args, { signal }) => write({ operation: "attach_file", ...args }, signal));
	}
	return server;
}
