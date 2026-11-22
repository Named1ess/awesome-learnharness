import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

test("MCP source organization reuses the native model-free directory", async t => {
	const data = mkdtempSync(join(tmpdir(), "lh-mcp-sources-"));
	t.after(() => rmSync(data, { recursive: true, force: true }));
	const auth = join(data, "auth.json");
	writeFileSync(auth, "{}");
	Object.assign(process.env, { LH_DATA_DIR: data, LH_AUTH_FILE: auth });
	const { mcpGraphSources, mcpUpdateGraphSources } = await import("../src/server/mcp-graph-operations.ts");
	const { stores } = await import("../src/server/stores.ts");

	const chat = stores.chatStore.createChat("Original");
	const notePath = join(data, "private", "Reference.md");
	stores.graphStore.upsertSource({ id: "src_mcp_fixture", filePath: notePath, importedAt: "2026-11-23T00:00:00.000Z" });
	const folder = mcpUpdateGraphSources({ action: "create-folder", name: "Work", parentId: null });
	assert.ok(folder.createdFolderId);
	mcpUpdateGraphSources({ action: "move", kind: "source", id: chat.id, parentId: folder.createdFolderId });
	mcpUpdateGraphSources({ action: "rename-source", id: chat.id, name: "Updated" });
	assert.equal(stores.chatStore.getChat(chat.id)?.title, "Updated");
	assert.throws(() => mcpUpdateGraphSources({ action: "delete-folder", id: folder.createdFolderId }), /supported/i);

	const first = mcpGraphSources(0, 2);
	assert.equal(first.items.length, 2);
	assert.equal(first.next_offset, 2);
	const last = mcpGraphSources(2, 2);
	assert.equal(last.next_offset, null);
	const items = [...first.items, ...last.items];
	assert.equal(items.find(item => item.id === chat.id)?.parentId, folder.createdFolderId);
	assert.equal(items.find(item => item.id === chat.id)?.label, "Updated");
	assert.equal(items.find(item => item.id === "src_mcp_fixture")?.label, "Reference");
	assert.ok(!JSON.stringify(items).includes(notePath));

	await t.test("oversized source labels fit bounded pages without losing entries", () => {
		const label = "Z" + "🙂\"\\\u0000".repeat(30_000);
		const longChat = stores.chatStore.createChat(label);
		const longFolder = mcpUpdateGraphSources({ action: "create-folder", name: label, parentId: null });
		const additional = Array.from({ length: 18 }, () => stores.chatStore.createChat(label.slice(0, 2500)).id);
		const wanted = [longChat.id, longFolder.createdFolderId!, ...additional];
		const found: string[] = [];
		let offset: number | null = 0;
		do {
			const page = mcpGraphSources(offset, 100);
			assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 32 * 1024);
			assert.ok(page.next_offset === null || page.next_offset === offset + page.items.length && page.next_offset > offset);
			if (offset === 0) assert.notEqual(page.next_offset, null);
			for (const item of page.items) {
				if (!wanted.includes(item.id)) continue;
				assert.ok(typeof item.label === "string" && item.label.endsWith("…"));
				assert.doesNotMatch(item.label, /[\uD800-\uDBFF]…$/u);
				found.push(item.id);
			}
			offset = page.next_offset;
		} while (offset !== null);
		assert.deepEqual(found.toSorted(), wanted.toSorted());
		assert.equal(stores.chatStore.getChat(longChat.id)?.title, label);
		assert.equal(stores.sourceOrganizationStore.read().folders.find(folder => folder.id === longFolder.createdFolderId)?.name, label);
	});

	await t.test("native import and session coverage use caller inference without model settings or an API key", async () => {
		const { mcpExtractSessionGraph } = await import("../src/server/mcp-graph-operations.ts");
		const { runWithClientInference } = await import("../src/server/mcp-inference.ts");
		const { importGraphNotes } = await import("../src/server/notes-import.ts");
		const messageId = "msg_mcp_source";
		stores.chatStore.saveMessages(chat.id, [
			{ ...fauxAssistantMessage([fauxText("A fixture lesson about anchors.")]), id: messageId },
		]);

		const roles: string[] = [];
		let sessionExtraction = false;
		const client = {
			signal: new AbortController().signal,
			track<T>(work: Promise<T>): Promise<T> { return work; },
			engine(role: string) {
				assert.ok(role === "extractor" || role === "auditor");
				roles.push(role);
				const faux = createFauxCore({});
				const call = role === "extractor"
					? fauxToolCall("submit_findings", {
						propositions: [{
							id: "p1", name: sessionExtraction ? "Anchored lesson" : "Imported note",
							statement: "A fixture proposition.", aliases: [],
							...(sessionExtraction ? { messageId } : {}),
						}],
						chains: [],
					})
					: fauxToolCall("submit_review", { links: [] });
				faux.setResponses([() => fauxAssistantMessage([call], { stopReason: "toolUse" })]);
				return { model: faux.getModel(), streamFn: faux.streamSimple };
			},
		};
		assert.equal(stores.settingsStore.readSettings(), null);
		const response = await runWithClientInference(client, () => importGraphNotes([new File(["Scoped notes."], "Scoped.md")]));
		assert.deepEqual(await response.json(), { results: [{
			filePath: "Scoped.md", requestIndex: 0, outcome: "completed", ok: true, stats: { nodes: 1, chains: 0 },
		}] });
		sessionExtraction = true;
		assert.deepEqual(await runWithClientInference(client, () => mcpExtractSessionGraph(chat.id)), { nodes: 1, chains: 0 });
		assert.deepEqual(roles, ["extractor", "auditor", "extractor", "auditor"]);
		assert.equal(stores.graphStore.readCoverage().filter(row => row.chatId === chat.id).length, 1);
		assert.deepEqual(stores.graphStore.readNodes().find(node => node.name === "Anchored lesson")?.provenance, [{ chatId: chat.id, messageId }]);
	});
});
