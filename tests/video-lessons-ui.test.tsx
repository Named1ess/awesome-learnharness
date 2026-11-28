import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import type { VideoLesson } from "../src/core/video-lessons.ts";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

const fixture: VideoLesson = {
	id: "lesson-fixture",
	title: "Completing the square",
	problem: "Solve x² + 4x − 5 = 0",
	createdAt: "2026-11-28T12:00:00.000Z",
	video: {
		projectId: "project-fixture",
		versionId: "version-first",
		durationMs: 10000,
		segments: [{ startMs: 0, endMs: 10000, label: "Complete the square", narration: "Add four", onScreen: "(x + 2)²" }],
	},
	questions: [],
	tasks: [],
};

test("a video follow-up retains the captured timestamp through a later seek and saves the answer explicitly", async () => {
	const { window, document } = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	Object.assign(globalThis, { window, self: window, document, Element: window.Element, HTMLElement: window.HTMLElement, Event: window.Event });
	const { createRoot } = await import("react-dom/client");
	const { LessonWatch } = await import("../components/lessons/lesson-watch.tsx");
	const host = document.querySelector("#root")!;
	const root = createRoot(host);
	const originalFetch = globalThis.fetch;
	const changes: unknown[] = [];
	let lesson = fixture;
	globalThis.fetch = async (input, init) => {
		assert.equal(input, "/api/lessons/lesson-fixture");
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			changes.push(body);
			if (body.action === "ask") {
				lesson = { ...lesson, questions: [{ id: "question-fixture", timeMs: body.timeMs, versionId: body.versionId, text: body.text, answer: "Half of 4 is 2, and 2² = 4." }] };
			} else if (body.action === "save-notion") {
				lesson = { ...lesson, notionUrl: "https://www.notion.so/review-fixture" };
			}
		}
		return Response.json({ lesson });
	};
	const fire = (element: Element, type: string) => act(async () => { element.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true })); });
	try {
		await act(async () => { root.render(<LessonWatch lessonId={fixture.id} initialTimeMs={1250} />); });
		const video = host.querySelector<HTMLVideoElement>("video")!;
		let pauses = 0;
		Object.defineProperties(video, {
			currentTime: { configurable: true, writable: true, value: 0 },
			pause: { configurable: true, value: () => { pauses++; } },
		});
		await fire(video, "loadedmetadata");
		assert.equal(video.currentTime, 1.25);
		assert.equal(video.querySelector("track")?.getAttribute("src"), "/api/lessons/lesson-fixture/captions");

		await fire(host.querySelector('[data-testid="lesson-ask"]')!, "click");
		assert.equal(pauses, 1);
		video.currentTime = 8.75;
		await fire(video, "seeked");
		const composer = host.querySelector("textarea")!;
		composer.value = "Why add four?";
		await fire(composer, "input");
		await fire(composer.closest("form")!, "submit");
		assert.deepEqual(changes, [{ action: "ask", versionId: "version-first", timeMs: 1250, text: "Why add four?" }]);
		assert.match(host.querySelector("aside")?.textContent ?? "", /Half of 4 is 2/);

		await fire(host.querySelector('[data-testid="lesson-replay-question-fixture"]')!, "click");
		assert.equal(video.currentTime, 1.25);
		await fire(host.querySelector('[data-testid="lesson-save-question-fixture"]')!, "click");
		assert.deepEqual(changes.at(-1), { action: "save-notion", questionId: "question-fixture" });
		assert.equal(host.querySelector('[data-testid="lesson-notion-link"]')?.getAttribute("href"), "https://www.notion.so/review-fixture");
	} finally {
		await act(async () => { root.unmount(); });
		globalThis.fetch = originalFetch;
	}
});
