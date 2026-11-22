import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mcpClientOperationSchema, mcpClientToolInputs, type McpClientOperation } from "./client-protocol.ts";
import type { LearningReader } from "./learning-reader.ts";
import type { McpClientWriteClient, McpWriteClient } from "./write-client.ts";
import { attachFileArguments, importFileArguments, MCP_RESULT_LIMIT_BYTES } from "./write-protocol.ts";

const offsetArgument = z.int().nonnegative().default(0);
const listArguments = { offset: offsetArgument, limit: z.int().min(1).max(100).default(25) };
const annotations = { readOnlyHint: true, openWorldHint: false };
const clientInstructions = "LearnHarness owns the native learning workflow. Use get_operation to find steps for an operation whose status is needs_model_reply. Read every page of each offered step and concatenate the context strings as supplied, then submit that step's assistant text or tool calls. Continue until the operation settles. When the session has a pending question or practice problem, ask the learner for their input.";
const clientTools = {
	create_session: "Create a teaching or practice session. To include graph context, use proposition IDs from list_propositions.",
	get_session_state: "Read pending learner questions, active practice problems, and the latest_side_anchor for opening a follow-up thread.",
	submit_session_input: "Submit native learner input and start or resume a learning turn. Use a unique request_id per event and retain it for retries. Drive the returned operation with get_operation and the inference tools.",
	list_side_threads: "List the existing follow-up conversations for a learning session. Follow next_offset to read additional pages.",
	read_side_thread: "Read a follow-up conversation. Concatenate transcript strings across next_offset pages for its complete JSON message history.",
	ask_follow_up: "Ask a follow-up in a side thread or on a saved teaching passage. Use a unique request_id per event and retain it for retries. Drive the returned operation with get_operation and the inference tools.",
	extract_session_graph: "Extract knowledge from a saved session through the app's native extraction workflow. Use a unique request_id and retain it for retries. Drive the returned operation with get_operation and the inference tools.",
	list_graph_sources: "List the folders and source records associated with the learning-data graph. Follow next_offset to read additional pages.",
	update_graph_sources: "Create or rename a folder, rename a source, or move a folder or source. A null parentId means the root folder.",
	import_file: "Import a file from the configured MCP files directory into the knowledge graph. Use a unique request_id and retain it for retries. Drive the returned operation with get_operation and the inference tools.",
	attach_file: "Send a file reference and optional learner message in an existing session. Use a unique request_id and retain it for retries. Drive the returned operation with get_operation and the inference tools.",
	get_operation: "Read an operation's status and pending steps with their IDs and roles. A status of needs_model_reply means its steps can be read with read_inference_step.",
	read_inference_step: "Read one page of a pending inference step. Follow next_offset and concatenate the context strings to reconstruct the native transcript before submitting a reply.",
	submit_inference_step: "Supply assistant text and/or tool calls for one pending inference step. Use only the tools offered by that step and their declared arguments. Then use get_operation to check what the native workflow needs next.",
	cancel_operation: "Cancel an unfinished LearnHarness operation.",
} satisfies Record<McpClientOperation["operation"], string>;
const clientReadOnlyTools = new Set<McpClientOperation["operation"]>([
	"get_session_state", "list_side_threads", "read_side_thread", "list_graph_sources", "get_operation", "read_inference_step",
]);

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

export function createLearningMcpServer(reader: LearningReader, version: string, write?: McpWriteClient, clientWrite?: McpClientWriteClient): McpServer {
	const server = new McpServer({ name: "learnharness", version }, clientWrite ? { instructions: clientInstructions } : undefined);
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
	if (clientWrite) {
		for (const operation of Object.keys(clientTools) as Array<McpClientOperation["operation"]>) {
			server.registerTool(operation, {
				description: clientTools[operation],
				inputSchema: mcpClientToolInputs[operation],
				annotations: clientReadOnlyTools.has(operation) ? annotations : { readOnlyHint: false, openWorldHint: true },
			}, (args: object, { signal }: { signal: AbortSignal }) => clientWrite(mcpClientOperationSchema.parse({ ...args, operation }), signal));
		}
	} else if (write) {
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
