import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PATHS } from "../../config.ts";
import { createAddressCheckedAgent, safeFetch } from "../agent/tools/safe-fetch.ts";
import type { OutboundMcpServer, OutboundMcpTool } from "../core/outbound-mcp.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

export type { OutboundMcpServer, OutboundMcpTool } from "../core/outbound-mcp.ts";

const configFile = path.join(/* turbopackIgnore: true */ PATHS.data, "outbound-mcp.json");
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
const localAgent = createAddressCheckedAgent(address => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address));
const maxTools = 200;
const maxServers = 32;
const maxResponseBytes = 2 * 1024 * 1024;

export class OutboundMcpError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

function parseEndpoint(raw: string): URL | null {
	const url = URL.parse(raw);
	if (!url || url.username || url.password || url.search || url.hash) return null;
	return url.protocol === "https:" || (url.protocol === "http:" && loopback.has(url.hostname)) ? url : null;
}

export const outboundMcpServerInput = z.strictObject({
	name: z.string().trim().min(1).max(80),
	url: z.string().trim().max(2048).refine(url => parseEndpoint(url) !== null,
		"Enter an HTTPS or localhost URL with no credentials, query, or fragment."),
	token: z.string().trim().min(1).max(4096).regex(/^[A-Za-z\d._~+/-]+=*$/).optional(),
});

export const outboundMcpPermissions = z.array(z.string().min(1).max(128)).max(maxTools);

const record = outboundMcpServerInput.extend({ id: z.uuid(), allowedTools: outboundMcpPermissions });
const configuration = z.strictObject({ version: z.literal(1), servers: z.array(record).max(maxServers) });
type StoredServer = z.infer<typeof record>;

function readServers(): StoredServer[] {
	try {
		return configuration.parse(JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ configFile, "utf8"))).servers;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new OutboundMcpError(500, "Outbound MCP settings could not be read.");
	}
}

function writeServers(servers: StoredServer[]): void {
	fs.mkdirSync(/* turbopackIgnore: true */ PATHS.data, { recursive: true });
	writeFileAtomicSync(configFile, JSON.stringify({ version: 1, servers }), { mode: 0o600 });
}

function savedServer(servers: StoredServer[], id: string): StoredServer {
	const server = servers.find(row => row.id === id);
	if (!server) throw new OutboundMcpError(404, "MCP server not found.");
	return server;
}

function publicServer({ id, name, url, allowedTools, token }: StoredServer): OutboundMcpServer {
	return { id, name, url, allowedTools, tokenConfigured: token !== undefined };
}

export function listConfiguredMcpServers(): OutboundMcpServer[] {
	return readServers().map(publicServer);
}

function boundResponse(response: Response): Response {
	if (!response.body) return response;
	let bytes = 0;
	const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			bytes += chunk.byteLength;
			if (bytes > maxResponseBytes) controller.error(new Error("MCP response too large"));
			else controller.enqueue(chunk);
		},
	}));
	return new Response(body, { status: response.status, headers: response.headers, statusText: response.statusText });
}

async function withServer<T>(server: StoredServer, action: (client: Client, signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
	const endpoint = parseEndpoint(server.url);
	if (!endpoint) throw new OutboundMcpError(400, "Invalid outbound MCP endpoint.");
	const timeout = AbortSignal.timeout(30_000);
	const signal = caller ? AbortSignal.any([timeout, caller]) : timeout;
	const dispatcher = loopback.has(endpoint.hostname) ? localAgent : undefined;
	const client = new Client({ name: "LearnHarness", version: "1" });
	let closing: AbortSignal | undefined;
	const transport = new StreamableHTTPClientTransport(endpoint, {
		requestInit: server.token ? { headers: { authorization: `Bearer ${server.token}` } } : undefined,
		async fetch(target, init) {
			const url = new URL(target);
			if (url.href !== endpoint.href) throw new Error("MCP transport attempted to change its endpoint");
			const requestSignal = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : []), ...(closing ? [closing] : [])]);
			return boundResponse(await safeFetch(url.href, { ...init, signal: requestSignal, redirect: "error" }, dispatcher));
		},
	});
	try {
		signal.throwIfAborted();
		await client.connect(transport, { signal });
		return await action(client, signal);
	} catch (error) {
		if (caller?.aborted) caller.throwIfAborted();
		if (error instanceof OutboundMcpError) throw error;
		if (timeout.aborted) throw new OutboundMcpError(504, "The MCP server took too long to respond.");
		const code = (error as { code?: unknown })?.code;
		if (code === 401 || code === 403) throw new OutboundMcpError(502, "The MCP server rejected the connection credentials.");
		throw new OutboundMcpError(502, "Could not communicate with the configured MCP server.");
	} finally {
		if (transport.sessionId && !signal.aborted) {
			closing = AbortSignal.timeout(1_000);
			await transport.terminateSession().catch(() => undefined);
		}
		await client.close();
	}
}

function discoverTools(server: StoredServer, caller?: AbortSignal): Promise<OutboundMcpTool[]> {
	return withServer(server, async (client, signal) => {
		const tools = new Map<string, OutboundMcpTool>();
		const cursors = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await client.listTools(cursor === undefined ? undefined : { cursor }, { signal });
			for (const tool of page.tools) {
				if (tool.name.length > 128 || !tool.name.trim() || (server.token && tool.name.includes(server.token))) continue;
				const description = server.token && tool.description?.includes(server.token) ? undefined : tool.description?.slice(0, 400);
				const schema = JSON.stringify(tool.inputSchema);
				const inputSchema = Buffer.byteLength(schema) <= 12 * 1024 && !(server.token && schema.includes(server.token)) ? tool.inputSchema : undefined;
				tools.set(tool.name, { name: tool.name, description, inputSchema, readOnlyHint: tool.annotations?.readOnlyHint === true });
				if (tools.size > maxTools) throw new OutboundMcpError(502, "The MCP server returned too many tools.");
			}
			cursor = page.nextCursor;
			if (cursor !== undefined) {
				if (cursors.size >= maxTools || cursors.has(cursor)) throw new OutboundMcpError(502, "The MCP server returned invalid tool pages.");
				cursors.add(cursor);
			}
		} while (cursor !== undefined);
		return [...tools.values()];
	}, caller);
}

export function listConfiguredMcpTools(id: string, signal?: AbortSignal): Promise<OutboundMcpTool[]> {
	return discoverTools(savedServer(readServers(), id), signal);
}

export async function addConfiguredMcpServer(input: z.infer<typeof outboundMcpServerInput>, signal?: AbortSignal) {
	const parsed = outboundMcpServerInput.parse(input);
	const candidate = { ...parsed, id: randomUUID(), url: parseEndpoint(parsed.url)!.href, allowedTools: [] };
	if (parsed.token && (parsed.name.includes(parsed.token) || candidate.url.includes(parsed.token))) {
		throw new OutboundMcpError(400, "Put credentials only in the bearer token field.");
	}
	const tools = await discoverTools(candidate, signal);
	signal?.throwIfAborted();
	const servers = readServers();
	const existing = servers.find(server => server.name === candidate.name && server.url === candidate.url && server.token === candidate.token);
	if (existing) return { server: publicServer(existing), tools };
	if (servers.length >= maxServers) throw new OutboundMcpError(409, "Remove a saved MCP server before adding another.");
	writeServers([...servers, candidate]);
	return { server: publicServer(candidate), tools };
}

export function setConfiguredMcpToolPermissions(id: string, allowedTools: string[]): OutboundMcpServer {
	const servers = readServers();
	const server = savedServer(servers, id);
	const { token } = server;
	if (token && allowedTools.some(name => name.includes(token))) {
		throw new OutboundMcpError(400, "Put credentials only in the bearer token field.");
	}
	server.allowedTools = [...new Set(outboundMcpPermissions.parse(allowedTools))];
	writeServers(servers);
	return publicServer(server);
}

export function removeConfiguredMcpServer(id: string): void {
	const servers = readServers();
	if (servers.some(server => server.id === id)) writeServers(servers.filter(server => server.id !== id));
}

export async function callConfiguredMcpTool(id: string, toolName: string, args: Record<string, unknown>, caller?: AbortSignal): Promise<CallToolResult> {
	const server = savedServer(readServers(), id);
	const checkPermission = (current: StoredServer) => {
		if (!current.allowedTools.includes(toolName) || current.url !== server.url || current.token !== server.token) {
			throw new OutboundMcpError(403, "This tool is not enabled for the configured MCP server.");
		}
	};
	checkPermission(server);
	return withServer(server, async (client, signal) => {
		checkPermission(savedServer(readServers(), id));
		const result = CallToolResultSchema.parse(await client.callTool({ name: toolName, arguments: args }, CallToolResultSchema, { signal }));
		if (server.token && JSON.stringify(result).includes(server.token)) {
			throw new OutboundMcpError(502, "The MCP server included its credentials in the tool response.");
		}
		return result;
	}, caller);
}
