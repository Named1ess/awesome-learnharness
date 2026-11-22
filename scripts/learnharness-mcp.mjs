import { parseArgs } from "node:util";
import { LearningReader } from "../src/mcp/learning-reader.ts";
import { createLearningMcpServer, LearningStdioTransport } from "../src/mcp/server.ts";
import { createMcpWriteClient } from "../src/mcp/write-client.ts";
import manifest from "../package.json" with { type: "json" };

try {
	const { values } = parseArgs({ options: {
		"data-dir": { type: "string", multiple: true },
		"app-url": { type: "string", multiple: true },
		"client-reasoning": { type: "boolean" },
	} });
	const directories = values["data-dir"] ?? [];
	const origins = values["app-url"] ?? [];
	const clientReasoning = values["client-reasoning"];
	if (directories.length !== 1 || !directories[0] || origins.length > 1 || origins[0] === "") {
		throw new Error('Usage: node scripts/learnharness-mcp.mjs --data-dir "<absolute learning-data directory>" [--app-url "<loopback HTTP origin>" [--client-reasoning]]');
	}
	if (clientReasoning && !origins[0]) throw new Error("--client-reasoning requires --app-url.");
	const reader = new LearningReader(directories[0]);
	const appUrl = origins[0];
	const token = process.env.LH_MCP_WRITE_TOKEN;
	const writeClient = appUrl && !clientReasoning ? createMcpWriteClient(appUrl, directories[0], token) : undefined;
	const reasoningClient = appUrl && clientReasoning ? createMcpWriteClient(appUrl, directories[0], token, { clientReasoning: true }) : undefined;
	await createLearningMcpServer(reader, manifest.version, writeClient, reasoningClient).connect(new LearningStdioTransport());
} catch (error) {
	console.error(`LearnHarness MCP: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
