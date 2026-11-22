import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, it } from "node:test";
import { sanitizeUserSettings } from "../src/core/settings.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mcp-settings-"));
const priorDataDirectory = process.env.LH_DATA_DIR;
process.env.LH_DATA_DIR = path.join(root, "data");
const { SETTINGS_FILE } = await import("../config.ts");
const store = await import("../src/store/settings.ts");
const defaults = { allowWrites: true, allowClientReasoning: true, filesDirectory: null };
const blocked = { allowWrites: false, allowClientReasoning: false, filesDirectory: null };
const changed = { allowWrites: true, allowClientReasoning: false, filesDirectory: path.join(root, "教材 space") };

function seed(raw: string) {
	fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, raw);
}

afterEach(() => fs.rmSync(SETTINGS_FILE, { force: true }));
after(() => {
	if (priorDataDirectory === undefined) delete process.env.LH_DATA_DIR;
	else process.env.LH_DATA_DIR = priorDataDirectory;
	fs.rmSync(root, { recursive: true, force: true });
});

it("does not expose unsupported fields when sanitizing a persisted MCP policy", () => {
	assert.deepEqual(sanitizeUserSettings({ version: 1, mcp: { ...defaults, token: "synthetic-token" } }), {
		version: 1,
		mcp: blocked,
	});
});

it("validates only the complete nonsecret MCP settings shape without consulting the filesystem", async () => {
	const { parseMcpSettings } = await import("../src/core/mcp-settings.ts");
	assert.deepEqual(parseMcpSettings(defaults), { ok: true, settings: defaults });
	assert.deepEqual(parseMcpSettings(changed), { ok: true, settings: changed });
	for (const value of [
		null,
		[],
		{},
		{ allowWrites: true, filesDirectory: null },
		{ ...defaults, allowWrites: "true" },
		{ ...defaults, allowClientReasoning: 1 },
		{ ...defaults, filesDirectory: undefined },
		{ ...defaults, filesDirectory: "   " },
		{ ...defaults, filesDirectory: "a\u0000b" },
		{ ...defaults, filesDirectory: "a\nb" },
		{ ...defaults, LH_MCP_WRITE_TOKEN: "synthetic-token" },
	]) {
		const result = parseMcpSettings(value);
		assert.equal(result.ok, false);
		assert.doesNotMatch(JSON.stringify(result), /synthetic-token/);
	}
});

it("preserves compatibility for a genuinely absent settings file or section", () => {
	assert.deepEqual(store.readMcpSettings(), { settings: defaults });
	assert.equal(store.readSettings(), null);
	store.writeSettings({ version: 1, general: { autoUpdate: false }, mcp: blocked });
	assert.deepEqual(store.readMcpSettings(), { settings: defaults });
	assert.equal(store.readSettings()?.mcp, undefined);
});

it("updates MCP alone and keeps its latest value through unrelated writes with a stale record", () => {
	seed(JSON.stringify({ version: 7, future: { keep: true }, general: { autoUpdate: false }, mcp: defaults }));
	const stale = store.readSettings();
	assert.ok(stale);
	assert.deepEqual(store.writeMcpSettings(changed), changed);
	assert.deepEqual(store.readSettings(), { ...stale, mcp: changed });

	store.writeSettings({ ...stale, general: { autoUpdate: true } });
	assert.deepEqual(store.readMcpSettings(), { settings: changed });
	assert.deepEqual(store.readSettings(), { ...stale, general: { autoUpdate: true }, mcp: changed });
});

it("blocks malformed stored values and unrelated writes persist a safe policy", () => {
	for (const raw of [
		"broken JSON synthetic-token",
		"null",
		"[]",
		JSON.stringify({ version: 1, mcp: null }),
		JSON.stringify({ version: 1, mcp: { ...defaults, token: "synthetic-token" } }),
	]) {
		seed(raw);
		const result = store.readMcpSettings();
		assert.deepEqual(result.settings, blocked);
		assert.match(result.error ?? "", /MCP settings.*blocked/i);
		assert.doesNotMatch(JSON.stringify(result), /synthetic-token/);

		store.writeSettings({ version: 1, general: { autoUpdate: false }, mcp: defaults });
		assert.deepEqual(store.readMcpSettings(), { settings: blocked });
		assert.doesNotMatch(fs.readFileSync(SETTINGS_FILE, "utf8"), /synthetic-token/);
	}
});

it("blocks an unreadable existing file without mistaking it for first boot", (t) => {
	seed(JSON.stringify({ version: 1 }));
	const original = fs.readFileSync;
	t.mock.method(fs, "readFileSync", (...args: unknown[]) => {
		if (args[0] === SETTINGS_FILE) throw Object.assign(new Error("synthetic-token"), { code: "EACCES" });
		return Reflect.apply(original, fs, args);
	});
	const result = store.readMcpSettings();
	assert.deepEqual(result.settings, blocked);
	assert.match(result.error ?? "", /MCP settings.*blocked/i);
	assert.doesNotMatch(JSON.stringify(result), /synthetic-token/);
});

it("allows dedicated valid repair without reopening other corrupt access configuration", () => {
	seed("broken JSON");
	assert.throws(() => store.writeMcpSettings({ ...defaults, token: "synthetic-token" } as typeof defaults));
	assert.equal(fs.readFileSync(SETTINGS_FILE, "utf8"), "broken JSON");
	assert.deepEqual(store.writeMcpSettings(defaults), defaults);
	assert.deepEqual(store.readMcpSettings(), { settings: defaults });
	assert.deepEqual(store.readFileAccessSettings(), { ok: true, settings: { restricted: true, folders: [] } });
});
