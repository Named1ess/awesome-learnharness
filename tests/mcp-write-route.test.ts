import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { parseFilePaths, quoteFilePath } from "../src/core/file-paths.ts";
import { directoryLinkType } from "./helpers/filesystem-links.ts";

const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "lh-mcp-write-")));
const home = path.join(sandbox, "home");
await mkdir(home);
const locations = {
	HOME: home,
	USERPROFILE: home,
	LH_AUTH_FILE: path.join(sandbox, "files", "private.md"),
	LH_DATA_DIR: path.join(sandbox, "app data"),
};
const previous = Object.fromEntries(Object.keys(locations).map(key => [key, process.env[key]]));
Object.assign(process.env, locations);
test.after(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	await rm(sandbox, { recursive: true, force: true });
});

const { handleMcpWriteRequest } = await import("../src/server/mcp-write.ts");
const { MCP_PROFILE_HEADER, mcpWriteProfileProof } = await import("../src/mcp/write-protocol.ts");
const token = "ab".repeat(32);
const importInput = (file: string) => ({ operation: "import_file", path: file });
const attachInput = (file: string, message?: string) => ({ operation: "attach_file", session_id: "chat_existing", path: file, message });

async function fixture(t: TestContext) {
	const base = await mkdtemp(path.join(sandbox, "case-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const files = path.join(base, "documents");
	const profile = path.join(base, "profile");
	await mkdir(profile);
	const data = await realpath(profile);
	await mkdir(path.join(files, "week 1"), { recursive: true });
	const relative = "week 1/lesson.md";
	const document = path.join(files, relative);
	await writeFile(document, "isolated lesson fixture");
	const imports: { names: string[]; paths: FormDataEntryValue[]; text: string[] }[] = [];
	const attachments: { id: string; text: string }[] = [];
	const importResponse = Response.json({ results: [{ requestIndex: 0, filePath: relative, ok: true, outcome: "completed", stats: { nodes: 1 } }] });
	let attachmentResponse = new Response("internal", { status: 200 });
	const deps = {
		env: { LH_MCP_WRITE_TOKEN: token, LH_MCP_FILES_DIR: files } as Record<string, string | undefined>,
		dataDirectory: data,
		attachmentPolicy: () => ({ restricted: true, folders: [files] }),
		async importGraphNotes(upload: File[], paths: FormDataEntryValue[] = []) {
			imports.push({ names: upload.map(file => file.name), paths, text: await Promise.all(upload.map(file => file.text())) });
			return importResponse.clone();
		},
		async handleMcpAttachment(id: string, text: string) {
			attachments.push({ id, text });
			return attachmentResponse;
		},
	};
	const request = (body: unknown, headers: HeadersInit = {}, origin = "http://localhost:3000") => {
		const wireHeaders = new Headers({
			host: new URL(origin).host,
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
			[MCP_PROFILE_HEADER]: mcpWriteProfileProof(data, token),
		});
		new Headers(headers).forEach((value, key) => wireHeaders.set(key, value));
		return new Request(origin + "/api/mcp/write", { method: "POST", headers: wireHeaders, body: JSON.stringify(body) });
	};
	const send = (body: unknown, headers?: HeadersInit, origin?: string) =>
		handleMcpWriteRequest(request(body, headers, origin), deps);
	return { base, files, data, relative, document, imports, attachments, deps, send, request, setAttachmentResponse: (response: Response) => { attachmentResponse = response; } };
}

test("requires the exact source-app host, write token and runtime profile before dispatch", async t => {
	const f = await fixture(t);
	const body = importInput(f.relative);
	for (const host of ["localhost.localhost", "127.1", "127.0.0.2", "example.com", "localhost@127.0.0.1", "[0:0:0:0:0:0:0:1]"]) {
		assert.equal((await f.send(body, { host })).status, 403, host);
	}
	assert.equal((await f.send(body, { authorization: `Bearer ${"cd".repeat(32)}` })).status, 403);
	assert.equal((await f.send(body, { authorization: "" })).status, 403);
	const withoutHost = f.request(body);
	withoutHost.headers.delete("host");
	assert.equal((await handleMcpWriteRequest(withoutHost, f.deps)).status, 403);
	const otherProfile = path.join(f.base, "other profile");
	await mkdir(otherProfile);
	assert.equal((await f.send(body, { [MCP_PROFILE_HEADER]: mcpWriteProfileProof(otherProfile, token) })).status, 403);
	f.deps.env.LH_DESKTOP_SERVER = "1";
	assert.equal((await f.send(body)).status, 403);
	delete f.deps.env.LH_DESKTOP_SERVER;
	f.deps.env.LH_MCP_WRITE_TOKEN = token.toUpperCase();
	assert.equal((await f.send(body)).status, 403);
	assert.deepEqual(f.imports, []);
	assert.deepEqual(f.attachments, []);
});

test("requires an existing absolute files root and rejects a linked configured root", async t => {
	const f = await fixture(t);
	const request = () => f.request(importInput(f.relative));
	for (const configured of [undefined, "relative/path", path.join(f.base, "missing"), f.document]) {
		const deps = { ...f.deps, env: { ...f.deps.env, LH_MCP_FILES_DIR: configured } };
		assert.equal((await handleMcpWriteRequest(request(), deps)).status, 503);
	}
	const alias = path.join(f.base, "linked root");
	await symlink(f.files, alias, directoryLinkType);
	const linked = { ...f.deps, env: { ...f.deps.env, LH_MCP_FILES_DIR: alias } };
	assert.equal((await handleMcpWriteRequest(request(), linked)).status, 503);
	assert.deepEqual(f.imports, []);
});

test("recognizes the native attachment when learner text contains an unclosed backtick", async t => {
	const f = await fixture(t);
	const backtickFile = "notes`draft.md";
	await writeFile(path.join(f.files, backtickFile), "fixture");
	const message = "Explain the `operator";
	const examples = [[f.relative, f.document], [backtickFile, path.join(f.files, backtickFile)]] as const;
	for (const [relative, filename] of examples) {
		assert.equal((await f.send(attachInput(relative, message))).status, 200);
		const sent = f.attachments.at(-1)?.text ?? "";
		assert.ok(sent.includes(message));
		const files = parseFilePaths(sent).filter(part => part.kind === "path");
		assert.deepEqual(files.map(part => part.path), [await realpath(filename)]);
	}
});

test("validates strict bounded JSON before inspecting or dispatching files", async t => {
	const f = await fixture(t);
	for (const body of [
		{ ...importInput(f.relative), upload: "unexpected" },
		{ operation: "attach_file", session_id: "../invalid", path: f.relative },
		attachInput(f.relative, "x".repeat(3001)),
		importInput("x".repeat(1025)),
	]) assert.equal((await f.send(body)).status, 400);
	assert.equal((await f.send(importInput(f.relative), { "content-length": "16385" })).status, 413);
	assert.equal((await f.send({ ...importInput(f.relative), extra: "x".repeat(16 * 1024) })).status, 413);
	assert.deepEqual(f.imports, []);
	assert.deepEqual(f.attachments, []);
});

test("rejects traversal, alternate path spellings, junctions, hard links, and nonregular inputs", async t => {
	const f = await fixture(t);
	const outside = path.join(f.base, "outside");
	await mkdir(outside);
	const outsideFile = path.join(outside, "outside.md");
	await writeFile(outsideFile, "out of root");
	await symlink(outside, path.join(f.files, "linked"), directoryLinkType);
	await link(outsideFile, path.join(f.files, "hard.md"));
	await mkdir(path.join(f.files, "directory.md"));
	for (const file of [
		"../outside/outside.md", "/outside.md", "week 1//lesson.md", "week 1/./lesson.md",
		"week 1\\lesson.md", "week 1/lesson.md:stream", "linked/outside.md", "hard.md", "directory.md", "missing.md",
	]) assert.equal((await f.send(importInput(file))).status, 400, file);
	assert.deepEqual(f.imports, []);
	assert.deepEqual(f.attachments, []);
});

test("both operations refuse protected files and attachment honors current allowed folders", async t => {
	const f = await fixture(t);
	const privateFile = locations.LH_AUTH_FILE;
	await mkdir(path.dirname(privateFile));
	await writeFile(privateFile, "fixture credential");
	const protectedDeps = { ...f.deps, env: { ...f.deps.env, LH_MCP_FILES_DIR: path.dirname(privateFile) } };
	assert.equal((await handleMcpWriteRequest(f.request(importInput("private.md")), protectedDeps)).status, 400);
	assert.equal((await handleMcpWriteRequest(f.request(attachInput("private.md")), protectedDeps)).status, 400);
	const restrictedDeps = { ...f.deps, attachmentPolicy: () => ({ restricted: true, folders: [] }) };
	assert.equal((await handleMcpWriteRequest(f.request(attachInput(f.relative)), restrictedDeps)).status, 400);
	assert.equal((await handleMcpWriteRequest(f.request(importInput(f.relative)), restrictedDeps)).status, 200);
	assert.equal(f.imports.length, 1);
	assert.deepEqual(f.attachments, []);
});

test("validates import size and extension then delegates one File with relative provenance", async t => {
	const f = await fixture(t);
	const large = path.join(f.files, "large.pdf");
	await writeFile(large, "");
	await truncate(large, 25 * 1024 * 1024 + 1);
	await writeFile(path.join(f.files, "unknown.bin"), "fixture");
	assert.equal((await f.send(importInput("large.pdf"))).status, 413);
	assert.equal((await f.send(importInput("unknown.bin"))).status, 400);
	assert.deepEqual(f.imports, []);
	const result = await f.send(importInput(f.relative), {}, "http://127.0.0.1:3000");
	assert.equal(result.status, 200);
	assert.deepEqual(await result.json(), { results: [{ requestIndex: 0, filePath: f.relative, ok: true, outcome: "completed", stats: { nodes: 1 } }] });
	assert.deepEqual(f.imports, [{ names: ["lesson.md"], paths: [f.relative], text: ["isolated lesson fixture"] }]);
});

test("attaches a native path token with optional text and preserves native failure responses", async t => {
	const f = await fixture(t);
	const result = await f.send(attachInput(f.relative, "Use this as a reference"), {}, "http://[::1]:3000");
	assert.deepEqual(await result.json(), { session_id: "chat_existing", status: "accepted" });
	assert.deepEqual(f.attachments, [{ id: "chat_existing", text: `Use this as a reference\n${quoteFilePath(await realpath(f.document))}` }]);
	const conflict = Response.json({ error: "A turn is already running" }, { status: 409 });
	f.setAttachmentResponse(conflict);
	assert.equal(await f.send(attachInput(f.relative)), conflict);
	assert.equal(f.attachments[1]?.text, quoteFilePath(await realpath(f.document)));
	assert.deepEqual(f.imports, []);
});
