import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface OutboundMcpServer {
	id: string;
	name: string;
	url: string;
	tokenConfigured: boolean;
	allowedTools: string[];
}

export interface OutboundMcpTool {
	name: string;
	description?: string;
	readOnlyHint: boolean;
	inputSchema?: Tool["inputSchema"];
}
