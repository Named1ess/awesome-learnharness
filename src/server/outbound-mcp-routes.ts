import { z } from "zod";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { apiRequestRefusal, subscriptionRequestOrigin } from "./desktop-access.ts";
import { MCP_LOOPBACK_AUTHORITY } from "./mcp-settings.ts";
import {
	addConfiguredMcpServer, listConfiguredMcpServers, listConfiguredMcpTools, OutboundMcpError,
	outboundMcpPermissions, outboundMcpServerInput, removeConfiguredMcpServer, setConfiguredMcpToolPermissions,
} from "./outbound-mcp.ts";

const actions = z.discriminatedUnion("action", [
	outboundMcpServerInput.extend({ action: z.literal("add") }),
	z.strictObject({ action: z.literal("check"), id: z.uuid() }),
	z.strictObject({ action: z.literal("remove"), id: z.uuid() }),
	z.strictObject({ action: z.literal("permissions"), id: z.uuid(), allowedTools: outboundMcpPermissions }),
]);

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleOutboundMcpRequest(request: Request, env: Record<string, string | undefined> = process.env): Promise<Response> {
	const origin = subscriptionRequestOrigin(request);
	const host = request.headers.get("host") ?? new URL(request.url).host;
	const requestOrigin = request.headers.get("origin");
	const site = request.headers.get("sec-fetch-site");
	if (apiRequestRefusal(request, env) || !origin || !MCP_LOOPBACK_AUTHORITY.test(host) ||
		((request.method !== "GET" || requestOrigin !== null) && requestOrigin !== origin) ||
		(site !== null && site !== "same-origin" && site !== "none")) {
		return json({ error: "Outbound MCP settings are available in the local LearnHarness app." }, 403);
	}
	try {
		if (request.method === "GET") return json({ servers: listConfiguredMcpServers() });
		const action = actions.safeParse(await readBoundedJson(request, 32 * 1024));
		if (!action.success) return json({ error: "Enter a valid MCP connection or tool selection. Use an HTTPS or localhost URL without credentials, a query, or a fragment." }, 400);
		switch (action.data.action) {
			case "add": {
				const { name, url, token } = action.data;
				return json(await addConfiguredMcpServer({ name, url, token }, request.signal));
			}
			case "check": return json({ tools: await listConfiguredMcpTools(action.data.id, request.signal) });
			case "permissions": return json({ server: setConfiguredMcpToolPermissions(action.data.id, action.data.allowedTools) });
			case "remove": {
				removeConfiguredMcpServer(action.data.id);
				return json({ removed: true });
			}
		}
	} catch (error) {
		if (error instanceof OutboundMcpError) return json({ error: error.message }, error.status);
		if (error instanceof CustomBodyLimitError) return json({ error: "The outbound MCP request is too large." }, 413);
		if (error instanceof SyntaxError) return json({ error: "Invalid outbound MCP request." }, 400);
		return json({ error: "Could not update outbound MCP settings." }, 500);
	}
}
