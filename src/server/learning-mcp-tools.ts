import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { callConfiguredMcpTool, listConfiguredMcpServers, listConfiguredMcpTools } from "./outbound-mcp.ts";
import { isNotionMcpConnected, readNotionMcpTool } from "./notion-mcp.ts";

const discoverInput = Type.Object({ serverId: Type.String({ minLength: 1, maxLength: 100 }) });
const callInput = Type.Object({
	serverId: Type.String({ minLength: 1, maxLength: 100 }),
	toolName: Type.String({ minLength: 1, maxLength: 128 }),
	argumentsJson: Type.String({ maxLength: 16_384, description: "One JSON object with exactly the requested tool's arguments." }),
});
const notionInput = Type.Object({
	action: Type.Union([Type.Literal("search"), Type.Literal("fetch")]),
	value: Type.String({ minLength: 1, maxLength: 2000, description: "Search query, or exact Notion page URL/ID for fetch." }),
});

function dataResult(result: CallToolResult) {
	if (result.isError) throw new Error("The external MCP tool reported an error.");
	return { content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent ?? result.content).slice(0, 24_000) }], details: {} };
}

export function learningMcpTools(): AgentTool<any>[] {
	const servers = listConfiguredMcpServers().filter(server => server.allowedTools.length);
	const tools: AgentTool<any>[] = [];
	if (servers.length) {
		const discover: AgentTool<typeof discoverInput> = {
			name: "discover_mcp_tools",
			label: "Find connected MCP tools",
			description: "Look up enabled tools and argument schemas when the learner asks to use an external source. Available server IDs and labels: "
				+ JSON.stringify(servers.map(({ id, name }) => ({ id, name }))).slice(0, 3000),
			parameters: discoverInput,
			async execute(_callId, { serverId }, signal) {
				const server = servers.find(row => row.id === serverId);
				if (!server) throw new Error("Choose an enabled MCP server.");
				const available = await listConfiguredMcpTools(serverId, signal);
				const catalog = available.filter(tool => server.allowedTools.includes(tool.name));
				return { content: [{ type: "text", text: JSON.stringify(catalog).slice(0, 24_000) }], details: {} };
			},
		};
		const call: AgentTool<typeof callInput> = {
			name: "call_mcp_tool",
			label: "Use connected MCP tool",
			description: "Call a tool enabled in the learner's MCP settings. Discover its schema first and send only data needed for the learner's request.",
			parameters: callInput,
			async execute(_callId, { serverId, toolName, argumentsJson }, signal) {
				const args: unknown = JSON.parse(argumentsJson);
				if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Provide tool arguments as a JSON object.");
				return dataResult(await callConfiguredMcpTool(serverId, toolName, args as Record<string, unknown>, signal));
			},
		};
		tools.push(discover, call);
	}
	if (isNotionMcpConnected()) {
		const notion: AgentTool<typeof notionInput> = {
			name: "read_notion",
			label: "Read connected Notion",
			description: "Search or fetch from the learner's connected Notion workspace when asked to use it. Use the returned page URL for references.",
			parameters: notionInput,
			async execute(_callId, { action, value }, signal) {
				return dataResult(await (action === "search"
					? readNotionMcpTool("notion-search", { query: value }, signal)
					: readNotionMcpTool("notion-fetch", { id: value }, signal)));
			},
		};
		tools.push(notion);
	}
	return tools;
}
