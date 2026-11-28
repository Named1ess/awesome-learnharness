import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("concurrent Notion refresh requests persist and reuse a single rotated grant", { skip: process.platform !== "win32" }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "lh-notion-refresh-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const savedDataDir = process.env.LH_DATA_DIR;
	process.env.LH_DATA_DIR = directory;
	t.after(() => {
		if (savedDataDir === undefined) delete process.env.LH_DATA_DIR;
		else process.env.LH_DATA_DIR = savedDataDir;
	});
	const issuer = "https://mcp.notion.com";
	const { readNotionConnection, writeNotionConnection } = await import("../src/server/notion-mcp-store.ts");
	const { notionAccessToken } = await import("../src/server/notion-mcp-oauth.ts");
	await writeNotionConnection({
		redirectUrl: "http://localhost:3000/api/mcp/notion/callback",
		registration: { client_id: "example-client", issuer },
		tokens: { access_token: "expired-access", refresh_token: "original-refresh", token_type: "bearer", issuer },
		expiresAt: Date.now() - 1000,
	});
	let refreshes = 0;
	t.mock.method(globalThis, "fetch", async (input: string | URL, options?: RequestInit) => {
		assert.equal(String(input), `${issuer}/token`);
		assert.equal(options?.method, "POST");
		const body = new URLSearchParams(String(options?.body));
		assert.equal(body.get("client_id"), "example-client");
		assert.equal(body.get("grant_type"), "refresh_token");
		assert.equal(body.get("refresh_token"), "original-refresh");
		assert.equal(body.get("resource"), `${issuer}/mcp`);
		refreshes++;
		return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", token_type: "bearer", expires_in: 3600 });
	});
	assert.deepEqual(await Promise.all([notionAccessToken(), notionAccessToken("expired-access")]), ["rotated-access", "rotated-access"]);
	assert.equal(refreshes, 1);
	assert.equal((await readNotionConnection())?.tokens?.refresh_token, "rotated-refresh");
});
