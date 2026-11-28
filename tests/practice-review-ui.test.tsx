import React from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PracticeReview } from "../components/practice-review.tsx";
import { practiceProblemHref, type PracticeReviewItem } from "../src/core/index.ts";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";

(globalThis as Record<string, unknown>).React = React;

const original: PracticeReviewItem = {
	chatId: "math", chatTitle: "Vectors", messageId: "pose1", contentIndex: 2,
	statement: "Find the projection.", outcome: "solvedWithHints", verdict: "Check the sign.",
	rung: "R2", missClass: "execution", updatedAt: 1, bookmarked: false, retryable: true,
};

it("reviews the selected session, bookmarks the original occurrence and retries an ambiguous creation with its original request ID", async () => {
	const bookmarks: unknown[] = [];
	const retries: Array<Record<string, unknown>> = [];
	const pushed: string[] = [];
	const router = { bfcacheId: "review", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, prefetch() {}, replace() {},
		push(url: string) { pushed.push(url); } };
	const ui = await mountPluginChrome({ activate() {} }, (
		<AppRouterContext.Provider value={router}><PracticeReview initialSession="math" /></AppRouterContext.Provider>
	), { fetch: async (input, init) => {
		const url = String(input);
		if (url.endsWith("/bookmark")) {
			assert.equal(init?.method, "PUT");
			bookmarks.push(JSON.parse(String(init.body)));
			return Response.json({ ok: true });
		}
		if (url.endsWith("/retry")) {
			assert.equal(init?.method, "POST");
			retries.push(JSON.parse(String(init.body)));
			if (retries.length === 1) throw new Error("Connection interrupted");
			return Response.json({ id: "new-attempt" });
		}
		assert.equal(url, "/api/practice-review");
		return Response.json({ items: [original, { ...original, chatId: "other", chatTitle: "Geometry", statement: "Second question." }] });
	} });
	try {
		const byLabel = (label: string) => {
			const button = [...ui.document.querySelectorAll("button")].find(el => el.textContent?.trim() === label);
			assert.ok(button, `expected ${label}`);
			return button;
		};
		const row = ui.document.querySelector("li");
		assert.equal(ui.document.querySelectorAll("li").length, 1);
		assert.match(row!.textContent!, /Solved with hints.*Find the projection.*Check the sign/s);
		assert.equal(row!.querySelector("a")?.getAttribute("href"), practiceProblemHref("math", "pose1", 2));
		await ui.click(byLabel("Bookmark"));
		assert.deepEqual(bookmarks, [{ chatId: "math", messageId: "pose1", contentIndex: 2, bookmarked: true }]);
		assert.equal(byLabel("Bookmarked").getAttribute("aria-pressed"), "true");
		await ui.click(byLabel("Practice again"));
		assert.equal(ui.document.querySelector('[role="alert"]')?.textContent, "Connection interrupted");
		await ui.click(byLabel("Practice again"));
		assert.ok(retries[0]?.requestId);
		assert.deepEqual(retries[0], retries[1]);
		assert.deepEqual(pushed, ["/chat/new-attempt"]);
	} finally {
		await ui.close();
	}
});

it("allows a failed library read to be refreshed into the empty state", async () => {
	let reads = 0;
	const ui = await mountPluginChrome({ activate() {} }, <PracticeReview />, {
		fetch: async () => ++reads === 1 ? Response.json({ error: "Read interrupted" }, { status: 503 }) : Response.json({ items: [] }),
	});
	try {
		assert.equal(ui.document.querySelector('[role="alert"]')?.textContent, "Read interrupted");
		const refresh = [...ui.document.querySelectorAll("button")].find(button => button.textContent?.trim() === "Refresh");
		assert.ok(refresh);
		await ui.click(refresh);
		assert.equal(ui.document.querySelector('[role="alert"]'), null);
		assert.match(ui.document.body.textContent!, /No practice problems to review yet/);
		assert.equal(ui.document.querySelector("main a")?.getAttribute("href"), "/chat/new?mode=practice");
	} finally {
		await ui.close();
	}
});
