import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { HostDialog } from "../components/host-dialog.tsx";
import { InteractionLayersProvider, useInteractionLayers, type CloseOutcome, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { SettingsDialogProvider, useSettingsDialog } from "../components/settings/settings-dialog.tsx";
import { installModalDom } from "./modal-dom.ts";

let root: Root | undefined;
let restore: (() => void) | undefined;
const originalFetch = globalThis.fetch;
const byTest = (id: string) => {
	const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	assert(element, `missing ${id}`);
	return element;
};

function fixture(mcpFetch?: (init?: RequestInit) => Promise<Response>) {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	const globals = { React, window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
	const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModal = installModalDom(dom);
	const textarea = dom.window.HTMLTextAreaElement.prototype;
	const originalDefaultValue = Object.getOwnPropertyDescriptor(textarea, "defaultValue");
	Object.defineProperty(textarea, "defaultValue", { configurable: true, get() { return this.textContent; }, set(text) { this.textContent = text; } });
	restore = () => {
		if (originalDefaultValue) Object.defineProperty(textarea, "defaultValue", originalDefaultValue);
		else Reflect.deleteProperty(textarea, "defaultValue");
		restoreModal();
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	let settingsReads = 0;
	globalThis.fetch = async (input, init) => {
		if (String(input) === "/api/mcp/settings" && mcpFetch) return mcpFetch(init);
		if (String(input) === "/api/settings") {
			settingsReads++;
			return Response.json({ settings: { version: 1 } });
		}
		if (String(input) === "/api/keys") return Response.json({ keys: [], providers: [] });
		if (String(input) === "/api/settings/prompts") return Response.json({ prober: [], teacher: [], practice: [] });
		if (String(input) === "/api/models") return Response.json({ models: [], slots: {}, providers: [] });
		if (String(input) === "/api/search") return Response.json({ available: false });
		return Response.json({});
	};
	let controller!: InteractionLayersController;
	let settings!: ReturnType<typeof useSettingsDialog>;
	let setChildren!: React.Dispatch<React.SetStateAction<string[]>>;
	let outcome: CloseOutcome = "closed";
	const closeCalls: string[] = [];
	function Harness() {
		controller = useInteractionLayers();
		settings = useSettingsDialog();
		const [children, changeChildren] = useState<string[]>([]);
		setChildren = changeChildren;
		return <>{children.map(id => <HostDialog key={id} open layerId={id} aria-label={id}
			onClose={() => {
				closeCalls.push(id);
				if (outcome === "closed") changeChildren(previous => previous.filter(child => child !== id));
				return outcome;
			}}><h2>{id}</h2><input data-testid={`${id}-draft`} defaultValue="child draft" /></HostDialog>)}</>;
	}
	root = createRoot(document.querySelector("#root")!);
	return {
		controller: () => controller,
		closeCalls,
		settingsReads: () => settingsReads,
		outcome(next: CloseOutcome) { outcome = next; },
		async mount() {
			await act(async () => root!.render(<InteractionLayersProvider><SettingsDialogProvider><Harness /></SettingsDialogProvider></InteractionLayersProvider>));
		},
		async open(section = "appearance", row?: string) { await act(async () => settings.open(section, row)); },
		async child(id: string) { await act(async () => setChildren(previous => [...previous, id])); },
		async disposeChildren() { await act(async () => setChildren([])); },
		async escape() {
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key: "Escape" });
			await act(async () => { controller.captureKeyDown(event as unknown as KeyboardEvent); document.dispatchEvent(event); });
			return event;
		},
	};
}

afterEach(async () => {
	await act(async () => root?.unmount()); root = undefined;
	await new Promise(resolve => setTimeout(resolve, 5));
	restore?.(); restore = undefined; globalThis.fetch = originalFetch;
});

it("MCP shows the saved setup and updates manual snippets only after a successful save", async () => {
	const writes: unknown[] = [];
	const status = { sourceMode: true, tokenConfigured: true, filesDirectory: "C:/Shared MCP", filesAvailable: true,
		dataDirectory: "C:/Learning Data", nodeCommand: "C:/Program Files/nodejs/node.exe", scriptPath: "C:/LearnHarness/scripts/learnharness-mcp.mjs", appUrl: "http://localhost:3000" };
	let settings = { allowWrites: true, allowClientReasoning: true, filesDirectory: null as string | null };
	let reads = 0;
	const f = fixture(async init => {
		if (init?.method === "PUT") {
			settings = JSON.parse(String(init.body)) as typeof settings;
			writes.push(settings);
		} else reads++;
		return Response.json({ settings, status });
	});
	await f.mount(); await f.open("mcp");
	assert.equal(byTest("settings-nav-mcp").getAttribute("aria-current"), "true");
	assert.match(byTest("section-mcp").textContent ?? "", /C:\/Learning Data/);
	assert.match((byTest("mcp-snippet") as HTMLTextAreaElement).value, /--client-reasoning/);
	const reasoning = byTest("toggle-allow-client-reasoning");
	assert.equal(reasoning.getAttribute("aria-checked"), "true");
	await act(async () => reasoning.click());
	assert.equal(reasoning.getAttribute("aria-checked"), "false");
	assert.match((byTest("mcp-snippet") as HTMLTextAreaElement).value, /--client-reasoning/);
	await act(async () => byTest("mcp-save").closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
	assert.deepEqual(writes, [{ allowWrites: true, allowClientReasoning: false, filesDirectory: null }]);
	let snippet = (byTest("mcp-snippet") as HTMLTextAreaElement).value;
	assert.doesNotMatch(snippet, /--client-reasoning/);
	assert.match(snippet, /env_vars = \["LH_MCP_WRITE_TOKEN"\]/);
	await act(async () => byTest("mcp-client-claude").click());
	snippet = (byTest("mcp-snippet") as HTMLTextAreaElement).value;
	const claude = JSON.parse(snippet);
	assert.deepEqual(claude.mcpServers.learnharness.args, [status.scriptPath, "--data-dir", status.dataDirectory, "--app-url", status.appUrl]);
	assert.equal(claude.mcpServers.learnharness.command, status.nodeCommand);
	assert.equal(claude.mcpServers.learnharness.env.LH_MCP_WRITE_TOKEN, "YOUR_LOCAL_MCP_WRITE_TOKEN");
	await act(async () => byTest("mcp-check-setup").click());
	assert.equal(reads, 2);
});

it("reopening the MCP tab waits for an earlier save and reads the committed policy", async () => {
	const release = Promise.withResolvers<void>();
	const status = { sourceMode: true, tokenConfigured: true, filesDirectory: "C:/MCP", filesAvailable: true,
		dataDirectory: "C:/Data", nodeCommand: "node", scriptPath: "C:/LearnHarness/scripts/learnharness-mcp.mjs", appUrl: "http://localhost:3000" };
	let settings = { allowWrites: true, allowClientReasoning: true, filesDirectory: null };
	let reads = 0;
	const f = fixture(async init => {
		if (init?.method === "PUT") {
			await release.promise;
			settings = JSON.parse(String(init.body)) as typeof settings;
		} else reads++;
		return Response.json({ settings, status });
	});
	await f.mount(); await f.open("mcp");
	await act(async () => byTest("toggle-allow-writes").click());
	try {
		await act(async () => byTest("mcp-save").closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
		assert.equal(byTest("mcp-save").textContent, "Saving…");
		await f.open("graph"); await f.open("mcp");
		assert.equal(byTest("mcp-check-setup").textContent, "Checking…");
		assert.equal(reads, 1);
	} finally {
		await act(async () => release.resolve());
	}
	assert.equal(reads, 2);
	assert.equal(byTest("toggle-allow-writes").getAttribute("aria-checked"), "false");
	assert.doesNotMatch((byTest("mcp-snippet") as HTMLTextAreaElement).value, /--app-url|--client-reasoning|LH_MCP_WRITE_TOKEN/);
});

it("MCP offers read-only client configuration on an unsupported host", async () => {
	const f = fixture(async () => Response.json({ settings: { allowWrites: true, allowClientReasoning: true, filesDirectory: null },
		status: { sourceMode: false, tokenConfigured: false, filesDirectory: null, filesAvailable: false,
			dataDirectory: "C:/Data", nodeCommand: "node", scriptPath: null, appUrl: null } }));
	await f.mount(); await f.open("mcp");
	assert.match(byTest("section-mcp").textContent ?? "", /Read only on this host/);
	assert.equal(byTest("toggle-allow-writes").hasAttribute("disabled"), true);
	assert.equal(byTest("toggle-allow-client-reasoning").hasAttribute("disabled"), true);
	assert.equal(byTest("mcp-files-directory").hasAttribute("disabled"), true);
	const snippet = (byTest("mcp-snippet") as HTMLTextAreaElement).value;
	assert.match(snippet, /\/path\/to\/LearnHarness\/scripts\/learnharness-mcp\.mjs/);
	assert.doesNotMatch(snippet, /--app-url|--client-reasoning|LH_MCP_WRITE_TOKEN/);
});

it("Settings remains painted, mounted and stateful beneath a child; one Escape restores only Settings", async () => {
	const f = fixture(); await f.mount(); await f.open();
	const frame = byTest("settings-dialog"), content = byTest("settings-content");
	const modal = frame.closest<HTMLElement>("[data-interaction-layer]")!;
	const invoker = byTest("settings-nav-appearance");
	await act(async () => invoker.focus()); content.scrollTop = 47;
	await f.child("child");
	assert.equal(frame.isConnected, true); assert.equal(frame.hidden, false);
	assert.notEqual(frame.style.display, "none"); assert.equal(modal.hasAttribute("inert"), true);
	assert.equal(content.scrollTop, 47); assert.equal(f.settingsReads(), 1);
	assert.equal(document.activeElement?.getAttribute("data-testid"), "child-draft");
	const event = await f.escape();
	assert.equal(event.defaultPrevented, true); assert.deepEqual(f.closeCalls, ["child"]);
	assert.ok(byTest("settings-dialog") === frame); assert.equal(modal.hasAttribute("inert"), false);
	assert.equal(content.scrollTop, 47); assert.equal(f.settingsReads(), 1);
	await new Promise(resolve => setTimeout(resolve, 5));
	assert.ok(document.activeElement === invoker, `focus returned to ${document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName}`);
	await f.escape(); assert.equal(document.querySelector('[data-testid="settings-dialog"]'), null);
});

for (const outcome of ["blocked", "handled-without-close", "pending"] as const) {
	it(`return-to Settings stops at ${outcome} without retargeting or queued navigation`, async () => {
		const f = fixture(); await f.mount(); await f.open(); await f.child("guarded"); f.outcome(outcome);
		const frame = byTest("settings-dialog");
		await f.open("agent");
		assert.deepEqual(f.closeCalls, ["guarded"]);
		assert.equal(byTest("settings-nav-appearance").getAttribute("aria-current"), "true");
		assert.equal(byTest("settings-nav-agent").getAttribute("aria-current"), "false");
		assert.ok(byTest("settings-dialog") === frame);
		await f.disposeChildren();
		assert.equal(byTest("settings-nav-appearance").getAttribute("aria-current"), "true", "later cancellation completion must not trigger queued navigation");
		await f.open("agent");
		assert.equal(byTest("settings-nav-agent").getAttribute("aria-current"), "true");
		assert.equal(f.settingsReads(), 1);
	});
}

it("return-to closes each intervening layer once, top down, then retargets the same Settings instance", async () => {
	const f = fixture(); await f.mount(); await f.open();
	const frame = byTest("settings-dialog");
	await f.child("lower"); await f.child("upper"); await f.open("graph");
	assert.deepEqual(f.closeCalls, ["upper", "lower"]);
	assert.equal(document.querySelectorAll('[data-testid="settings-dialog"]').length, 1);
	assert.ok(byTest("settings-dialog") === frame);
	assert.equal(byTest("settings-nav-graph").getAttribute("aria-current"), "true");
	assert.equal(f.settingsReads(), 1);
	assert.equal(f.controller().getSnapshot().length, 1);
});

it("fresh Settings opens above an existing dialog and is not destroyed by unloading that dialog", async () => {
	const f = fixture(); await f.mount(); await f.child("plugin-origin");
	const origin = byTest("plugin-origin-draft");
	await f.open();
	const frame = byTest("settings-dialog");
	assert.equal(origin.isConnected, true);
	assert.equal(origin.closest("[data-interaction-layer]")?.hasAttribute("inert"), true);
	assert.ok(f.controller().getActiveModal()?.rootRef.current === frame.closest("[data-interaction-layer]"));
	await f.disposeChildren();
	assert.ok(byTest("settings-dialog") === frame); assert.equal(f.controller().getSnapshot().length, 1);
	assert.deepEqual(f.closeCalls, [], "external unload is not a domain close request");
});

it("same-instance Settings retarget synchronously invalidates an older pending opening intent", async () => {
	const f = fixture(); await f.mount(); await f.open();
	const intent = f.controller().beginOpening(byTest("settings-nav-appearance"));
	assert.equal(f.controller().isOpeningCurrent(intent), true);
	await f.open();
	assert.equal(f.controller().isOpeningCurrent(intent), false);
	assert.equal(f.settingsReads(), 1);
});
