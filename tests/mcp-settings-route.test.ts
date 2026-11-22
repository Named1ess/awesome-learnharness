import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { directoryLinkType } from "./helpers/filesystem-links.ts";

const temp = await realpath(await mkdtemp(path.join(tmpdir(), "lh-mcp-settings-")));
test.after(() => rm(temp, { recursive: true, force: true }));
const profile = path.join(temp, "data");
const shared = path.join(temp, "shared files");
const course = path.join(shared, "course");
const unshared = path.join(temp, "outside");
await Promise.all([mkdir(profile), mkdir(course, { recursive: true }), mkdir(unshared)]);
await Promise.all([writeFile(path.join(course, "lesson.md"), "lesson"), writeFile(path.join(shared, "other.md"), "other")]);
process.env.LH_DATA_DIR = profile;
const { handleMcpSettingsRequest } = await import("../src/server/mcp-settings.ts");
const { handleMcpWriteRequest } = await import("../src/server/mcp-write.ts");
const { MCP_PROFILE_HEADER, mcpWriteProfileProof } = await import("../src/mcp/write-protocol.ts");
const { MCP_CLIENT_HEADER } = await import("../src/mcp/client-protocol.ts");

const token = "af".repeat(32);
const env = { LH_MCP_WRITE_TOKEN: token, LH_MCP_FILES_DIR: shared };
const origin = "http://localhost:3000";
const defaults = { allowWrites: true, allowClientReasoning: true, filesDirectory: null };

function request(method: "GET" | "PUT", body?: unknown, headers?: HeadersInit) {
	const merged = new Headers({ host: "localhost:3000", "content-type": "application/json" });
	if (method === "PUT") merged.set("origin", origin);
	new Headers(headers).forEach((value, key) => merged.set(key, value));
	return new Request(`${origin}/api/mcp/settings`, { method, headers: merged, body: JSON.stringify(body) });
}

test("setup reports only non-secret local prerequisites and refuses other origins and hosts", async () => {
	const response = await handleMcpSettingsRequest(request("GET"), env);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	const raw = await response.text();
	assert.ok(!raw.includes(token));
	const { settings, status } = JSON.parse(raw);
	assert.deepEqual(settings, defaults);
	assert.deepEqual({ ...status, scriptPath: undefined }, {
		sourceMode: true, tokenConfigured: true, filesDirectory: shared, filesAvailable: true,
		dataDirectory: profile, nodeCommand: process.execPath, scriptPath: undefined, appUrl: origin,
	});
	assert.equal(path.basename(status.scriptPath), "learnharness-mcp.mjs");
	const desktopEnv = { ...env, LH_DESKTOP_API_SECRET: "d".repeat(64), LH_DESKTOP_SERVER: "1" };
	assert.equal((await handleMcpSettingsRequest(request("GET"), desktopEnv)).status, 403);
	const trusted = { "x-learnharness-desktop": desktopEnv.LH_DESKTOP_API_SECRET };
	const desktop = await handleMcpSettingsRequest(request("GET", undefined, trusted), desktopEnv);
	assert.equal((await desktop.json()).status.sourceMode, false);
	assert.equal((await handleMcpSettingsRequest(request("PUT", defaults, trusted), desktopEnv)).status, 403);
	const outsideRequests: HeadersInit[] = [
		{ host: "192.0.2.1:3000" }, { origin: "https://other.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" },
	];
	for (const headers of outsideRequests) {
		assert.equal((await handleMcpSettingsRequest(request("GET", undefined, headers), env)).status, 403);
		assert.equal((await handleMcpSettingsRequest(request("PUT", defaults, headers), env)).status, 403);
	}
	const withoutOrigin = request("PUT", defaults);
	withoutOrigin.headers.delete("origin");
	assert.equal((await handleMcpSettingsRequest(withoutOrigin, env)).status, 403);
});

test("shared path selection narrows the launcher's root and validates before persisting", async () => {
	const junction = path.join(shared, "external link");
	await symlink(unshared, junction, directoryLinkType);
	for (const filesDirectory of ["course", unshared, junction, path.join(shared, "not found"), path.join(course, "lesson.md")]) {
		const response = await handleMcpSettingsRequest(request("PUT", { ...defaults, filesDirectory }), env);
		assert.equal(response.status, 400, filesDirectory);
	}
	assert.equal((await handleMcpSettingsRequest(request("PUT", { ...defaults, token }), env)).status, 400);
	assert.equal((await handleMcpSettingsRequest(request("PUT", defaults, { "content-length": "50000" }), env)).status, 413);
	assert.equal((await handleMcpSettingsRequest(request("PUT", { ...defaults, filesDirectory: course }), { LH_MCP_WRITE_TOKEN: token })).status, 400);
	const save = await handleMcpSettingsRequest(request("PUT", { ...defaults, filesDirectory: course }), env);
	assert.equal(save.status, 200);
	assert.equal((await save.json()).status.filesDirectory, course);

	const sent: string[] = [];
	const deps = {
		env,
		async importGraphNotes([file]: File[]) { assert.ok(file); sent.push(await file.text()); return Response.json({}); },
		async handleMcpAttachment() { throw new Error("unexpected attachment"); },
	};
	assert.equal((await handleMcpWriteRequest(writeRequest({ operation: "import_file", path: "lesson.md" }), deps)).status, 200);
	assert.equal((await handleMcpWriteRequest(writeRequest({ operation: "import_file", path: "other.md" }), deps)).status, 400);
	assert.deepEqual(sent, ["lesson"]);
	const stale = await handleMcpSettingsRequest(request("GET"), { ...env, LH_MCP_FILES_DIR: unshared });
	assert.equal((await stale.json()).status.filesAvailable, false);
	assert.equal((await handleMcpWriteRequest(writeRequest({ operation: "import_file", path: "lesson.md" }), {
		...deps, env: { ...env, LH_MCP_FILES_DIR: unshared },
	})).status, 503);
	assert.equal((await handleMcpSettingsRequest(request("PUT", defaults), env)).status, 200);
});

function writeRequest(body: unknown, client = false) {
	return new Request(`${origin}/api/mcp/write`, { method: "POST", headers: {
		host: "localhost:3000", authorization: `Bearer ${token}`,
		[MCP_PROFILE_HEADER]: mcpWriteProfileProof(profile, token), ...(client ? { [MCP_CLIENT_HEADER]: "1" } : {}),
	}, body: JSON.stringify(body) });
}

test("saved write and client reasoning switches enforce live requests while allowing operation lookup and cancellation", async () => {
	const deps = {
		env,
		async importGraphNotes() { return Response.json({}); },
		async handleMcpAttachment() { throw new Error("unexpected attachment"); },
		async handleMcpClientOperation() { return Response.json({}); },
	};
	const regular = () => handleMcpWriteRequest(writeRequest({ operation: "import_file", path: "other.md" }), deps);
	const create = () => handleMcpWriteRequest(writeRequest({ operation: "create_session", kind: "teach", title: "Lesson" }, true), deps);
	const operation = (name: string) => handleMcpWriteRequest(writeRequest({ operation: name, operation_id: "missing_op" }, true), deps);
	const submitStep = () => handleMcpWriteRequest(writeRequest({
		operation: "submit_inference_step", operation_id: "missing_op", step_id: "step_1", reply: { text: "lesson" },
	}, true), deps);
	assert.equal((await handleMcpSettingsRequest(request("PUT", { ...defaults, allowClientReasoning: false }), env)).status, 200);
	assert.equal((await regular()).status, 200);
	assert.equal((await create()).status, 403);
	assert.equal((await submitStep()).status, 403);
	assert.equal((await operation("get_operation")).status, 200);
	assert.equal((await operation("cancel_operation")).status, 200);
	assert.equal((await handleMcpSettingsRequest(request("PUT", { ...defaults, allowWrites: false }), env)).status, 200);
	assert.equal((await regular()).status, 403);
	assert.equal((await create()).status, 403);
	assert.equal((await submitStep()).status, 403);
	assert.equal((await operation("get_operation")).status, 200);
	assert.equal((await handleMcpSettingsRequest(request("PUT", defaults), env)).status, 200);
	assert.equal((await create()).status, 200);
	assert.equal((await submitStep()).status, 200);
});
