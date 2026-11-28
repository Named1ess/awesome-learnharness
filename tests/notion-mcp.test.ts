import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveNotionLessonWith } from "../src/server/notion-mcp.ts";
import { notionMcpRequestOrigin } from "../src/server/notion-mcp-http.ts";
import { finishNotionAuthorization, startNotionAuthorization } from "../src/server/notion-mcp-oauth.ts";
import { windowsNotionCredentialProtection, type NotionConnection } from "../src/server/notion-mcp-store.ts";

const pageUrl = "https://www.notion.so/Page-36cc9b1778d44f28ab9d5b9c8e1c5bbb";
const input = {
	title: "Powers of two",
	problem: "Why does doubling give exponential growth?",
	question: { id: "q", versionId: "v", timeMs: 62000, text: "What is two squared?", answer: "Four." },
	lessonUrl: "http://localhost:3000/video-lessons/powers",
	operationId: "operation-1",
	signal: new AbortController().signal,
};

test("the Notion connection requires same-origin loopback controls while OAuth callbacks can navigate from Notion", () => {
	const env = {};
	const local = "http://localhost:3000";
	const control = (origin: string, host = "localhost:3000") => new Request(`${local}/api/mcp/notion/connect`, {
		method: "POST", headers: { host, origin, "sec-fetch-site": "same-origin", "x-learnharness-notion": "1" },
	});
	assert.equal(notionMcpRequestOrigin(control(local), env), local);
	assert.equal(notionMcpRequestOrigin(control("http://attacker.test"), env), undefined);
	assert.equal(notionMcpRequestOrigin(control(local, "attacker.test"), env), undefined);
	const callback = new Request(`${local}/api/mcp/notion/callback`, {
		headers: { host: "localhost:3000", "sec-fetch-site": "cross-site" },
	});
	assert.equal(notionMcpRequestOrigin(callback, env, true), local);
	assert.equal(notionMcpRequestOrigin(callback, { LH_DESKTOP_SERVER: "1" }, true), undefined);
});

test("Windows credential protection round-trips data without storing plaintext", { skip: process.platform !== "win32" }, async () => {
	const input = "test-secret-that-must-not-be-in-the-ciphertext";
	const protectedData = await windowsNotionCredentialProtection("Protect", input);
	assert.ok(!protectedData.includes(input));
	assert.equal(await windowsNotionCredentialProtection("Unprotect", protectedData), input);
});

test("Notion OAuth registers a localhost redirect and exchanges its code with the original verifier once", async () => {
	const browser = "http://localhost:3000";
	const redirect = `${browser}/api/mcp/notion/callback`;
	const issuer = "https://mcp.notion.com";
	const resource = `${issuer}/mcp`;
	let connection: NotionConnection | undefined;
	let challenge: string | null;
	let exchanges = 0;
	const services = {
		read: async () => connection,
		write: async (value: NotionConnection) => { connection = value; },
		fetch: async (input: string | URL, init?: RequestInit) => {
			const url = new URL(input);
			assert.equal(url.origin, issuer);
			switch (url.pathname) {
				case "/.well-known/oauth-protected-resource/mcp": return Response.json({ resource, authorization_servers: [issuer], scopes_supported: ["default"] });
				case "/.well-known/oauth-authorization-server": return Response.json({
					issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
					registration_endpoint: `${issuer}/register`, response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
				});
				case "/register": {
					const metadata = JSON.parse(String(init?.body));
					assert.deepEqual(metadata.redirect_uris, [redirect]);
					return Response.json({ ...metadata, client_id: "test-client" });
				}
				case "/token": {
					exchanges++;
					const body = new URLSearchParams(String(init?.body));
					assert.equal(body.get("redirect_uri"), redirect);
					assert.equal(body.get("resource"), resource);
					assert.equal(body.get("client_id"), "test-client");
					assert.equal(body.get("code"), "test-code");
					assert.equal(createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url"), challenge);
					return Response.json({ access_token: "example-bearer", token_type: "bearer", refresh_token: "example-refresh", expires_in: 7200 });
				}
				default: throw new Error(`Unexpected mock Notion endpoint ${url.pathname}`);
			}
		},
	};
	const { authorizationUrl, state } = await startNotionAuthorization(browser, services);
	const authorize = new URL(authorizationUrl);
	assert.equal(authorize.pathname, "/authorize");
	assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
	assert.equal(authorize.searchParams.get("resource"), resource);
	challenge = authorize.searchParams.get("code_challenge");
	assert.ok(challenge);
	const callback = new URLSearchParams({ code: "test-code", state, iss: issuer });
	await assert.rejects(finishNotionAuthorization(browser, "wrong-cookie", callback, services), /expired|another browser/);
	await finishNotionAuthorization(browser, state, callback, services);
	assert.equal(connection?.tokens?.access_token, "example-bearer");
	await assert.rejects(finishNotionAuthorization(browser, state, callback, services), /expired|another browser/);
	assert.equal(exchanges, 1);
});

test("a lost create response recovers the private draft without creating a second page", async t => {
	const directory = await mkdtemp(join(tmpdir(), "lh-notion-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let content = "";
	let writes = 0;
	const call = async (name: string, args: Record<string, unknown>) => {
		if (name === "notion-create-pages") {
			writes++;
			assert.equal(args.parent, undefined);
			const [page] = args.pages as { properties: { title: string }; content: string }[];
			assert.ok(page);
			assert.equal(page.properties.title, input.title);
			content = page.content;
			assert.match(content, /01:02/);
			assert.match(content, /Four\./);
			throw new Error("Remote connection closed after the write");
		}
		if (name === "notion-list-private-pages") return { results: [{ title: input.title, type: "page", url: pageUrl }] };
		assert.equal(name, "notion-fetch");
		assert.equal(args.id, pageUrl);
		return { text: content };
	};
	await assert.rejects(saveNotionLessonWith(input, directory, call));
	assert.equal(await saveNotionLessonWith(input, directory, call), pageUrl);
	assert.equal(await saveNotionLessonWith(input, directory, call), pageUrl);
	assert.equal(writes, 1);
});

test("an unresolved create is never repeated following an ambiguous response", async t => {
	const directory = await mkdtemp(join(tmpdir(), "lh-notion-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let writes = 0;
	const call = async (name: string) => {
		if (name === "notion-list-private-pages") return { results: [] };
		writes++;
		throw new Error("Remote connection closed after the write");
	};
	await assert.rejects(saveNotionLessonWith(input, directory, call));
	await assert.rejects(saveNotionLessonWith(input, directory, call), /check.*Notion/i);
	assert.equal(writes, 1);
});

test("saving to an existing page appends the lesson once using its current content as a match", async t => {
	const directory = await mkdtemp(join(tmpdir(), "lh-notion-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let content = "# Existing note\n\nKeep these prior notes.\n\n## 下次怎么检查";
	const existingUrl = "https://app.notion.com/p/36cc9b1778d44f28ab9d5b9c8e1c5bbb?pvs=204";
	let writes = 0;
	const call = async (name: string, args: Record<string, unknown>) => {
		if (name === "notion-fetch") return { text: `<content>\n${content}\n</content>` };
		assert.equal(name, "notion-update-page");
		assert.equal(args.command, "update_content");
		const [update] = args.content_updates as { old_str: string; new_str: string }[];
		assert.ok(update);
		assert.equal(args.page_id, "36cc9b1778d44f28ab9d5b9c8e1c5bbb");
		assert.equal(update.old_str, "## 下次怎么检查");
		content = content.replace(update.old_str, update.new_str);
		writes++;
		throw new Error("Remote connection closed after the write");
	};
	await assert.rejects(saveNotionLessonWith({ ...input, notionUrl: existingUrl }, directory, call));
	assert.equal(await saveNotionLessonWith({ ...input, notionUrl: existingUrl }, directory, call), existingUrl);
	assert.match(content, /^# Existing note\n\nKeep these prior notes\./);
	assert.match(content, /What is two squared\?/);
	assert.equal(writes, 1);
});
