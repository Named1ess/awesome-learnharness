import { parseArgs } from "node:util";
import { LearningReader } from "../src/mcp/learning-reader.ts";
import { createLearningMcpServer, LearningStdioTransport } from "../src/mcp/server.ts";
import { createMcpWriteClient } from "../src/mcp/write-client.ts";
import manifest from "../package.json" with { type: "json" };

try {
	const { values } = parseArgs({ options: {
		"data-dir": { type: "string", multiple: true },
		"app-url": { type: "string", multiple: true },
	} });
	const directories = values["data-dir"] ?? [];
	const origins = values["app-url"] ?? [];
	if (directories.length !== 1 || !directories[0] || origins.length > 1 || origins[0] === "") {
		throw new Error('Usage: node scripts/learnharness-mcp.mjs --data-dir "<absolute learning-data directory>" [--app-url "<loopback HTTP origin>"]');
	}
	const reader = new LearningReader(directories[0]);
	const writeClient = origins[0] === undefined ? undefined : createMcpWriteClient(origins[0], directories[0], process.env.LH_MCP_WRITE_TOKEN);
	await createLearningMcpServer(reader, manifest.version, writeClient).connect(new LearningStdioTransport());
} catch (error) {
	console.error(`LearnHarness MCP: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
