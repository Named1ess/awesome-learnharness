import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const profile = await mkdtemp(path.join(tmpdir(), "lh-video-lessons-"));
test.after(() => rm(profile, { recursive: true, force: true }));
process.env.LH_DATA_DIR = profile;
const {
	claimVideoLessonTask, completeVideoLessonTask, createVideoLesson, listVideoLessonTasks,
	listVideoLessons, mutateVideoLesson, readVideoLesson, renderVideoLessonCaptions,
} = await import("../src/server/video-lessons.ts");

const example = { title: "配方法", problem: "用配方法解 x² + 4x − 5 = 0" };
const segments = [
	{ startMs: 0, endMs: 1000, label: "移项", narration: "先把常数项移到右边。", onScreen: "x² + 4x = 5" },
	{ startMs: 1000, endMs: 3000, label: "配方", narration: "等式两边都加四。", onScreen: "(x + 2)² = 9" },
];

test("the browser owns a durable render request and the same claim can be retried", async () => {
	const lesson = createVideoLesson(example);
	assert.deepEqual(listVideoLessons().lessons.find(row => row.id === lesson.id), {
		id: lesson.id, title: lesson.title, createdAt: lesson.createdAt, hasVideo: false,
	});
	const [task] = listVideoLessonTasks(lesson.id).tasks;
	assert.ok(task);
	assert.equal(task.kind, "render");
	assert.deepEqual(readVideoLesson(lesson.id)?.tasks, [task]);
	const claimed = claimVideoLessonTask(task.id, "render-1");
	assert.deepEqual(claimed.lesson, { id: lesson.id, ...example });
	assert.deepEqual(claimVideoLessonTask(task.id, "render-1"), claimed);
	assert.throws(() => claimVideoLessonTask(task.id, "other-claim"), { status: 409 });
	await assert.rejects(completeVideoLessonTask(task.id, "other-claim", { kind: "failure", message: "No" }), { status: 409 });
	await assert.rejects(completeVideoLessonTask(task.id, "render-1", { kind: "answer", answer: "Wrong kind" }), { status: 409 });
	const failure = { kind: "failure", message: "Render interrupted" } as const;
	const failed = await completeVideoLessonTask(task.id, "render-1", failure);
	assert.equal(failed.status, "failed");
	assert.deepEqual(await completeVideoLessonTask(task.id, "render-1", failure), failed);
	const retried = mutateVideoLesson(lesson.id, { action: "retry", taskId: task.id });
	assert.equal(retried.tasks.at(-1)?.status, "pending");
	assert.notEqual(retried.tasks.at(-1)?.id, task.id);
});

test("same text at different times is bound to distinct segments, with a selected Notion export", async () => {
	const lesson = createVideoLesson(example);
	const renderTask = lesson.tasks[0]!;
	claimVideoLessonTask(renderTask.id, "render-test");
	const video = { kind: "video", projectId: "project", versionId: "version-1", durationMs: 3000, segments, relativePath: "sample.mp4" } as const;
	await assert.rejects(completeVideoLessonTask(renderTask.id, "render-test", { ...video, segments: [segments[1]!] }, profile, async () => {}), { status: 400 });
	const installs: string[] = [];
	await completeVideoLessonTask(renderTask.id, "render-test", video, profile, async (id, root, relativePath) => {
		assert.equal(id, lesson.id);
		assert.equal(root, profile);
		installs.push(relativePath);
	});
	await completeVideoLessonTask(renderTask.id, "render-test", video, profile, async () => { assert.fail("idempotent receipt must skip copying media"); });
	assert.deepEqual(installs, ["sample.mp4"]);
	assert.match(renderVideoLessonCaptions(lesson.id), /00:00:01.000 --> 00:00:03.000\n等式两边都加四/);
	assert.throws(() => mutateVideoLesson(lesson.id, { action: "ask", versionId: "old", timeMs: 1000, text: "为什么？" }), { status: 409 });
	assert.throws(() => mutateVideoLesson(lesson.id, { action: "ask", versionId: "version-1", timeMs: 4000, text: "为什么？" }), { status: 400 });
	const questions = [500, 1000].map(timeMs => {
		const queued = mutateVideoLesson(lesson.id, { action: "ask", versionId: "version-1", timeMs, text: "为什么？" });
		return { question: queued.questions.at(-1)!, task: queued.tasks.at(-1)! };
	});
	assert.deepEqual(questions.map(({ task }, index) => claimVideoLessonTask(task.id, `q-${index}`).segment?.label), ["移项", "配方"]);
	assert.throws(() => mutateVideoLesson(lesson.id, { action: "save-notion", questionId: questions[0]!.question.id }), { status: 409 });
	for (const [index, { task }] of questions.entries()) {
		await completeVideoLessonTask(task.id, `q-${index}`, { kind: "answer", answer: `对应视频步骤 ${index + 1}` });
	}
	const q = questions[1]!.question;
	const task = mutateVideoLesson(lesson.id, { action: "save-notion", questionId: q.id }).tasks.at(-1)!;
	assert.equal(mutateVideoLesson(lesson.id, { action: "save-notion", questionId: q.id }).tasks.at(-1)?.id, task.id);
	const exported = claimVideoLessonTask(task.id, "notion-1");
	assert.equal(exported.question?.answer, "对应视频步骤 2");
	assert.equal(exported.question?.timeMs, 1000);
	await assert.rejects(completeVideoLessonTask(task.id, "notion-1", { kind: "notion", url: "https://notion.so.other.example/unsafe" }), { status: 400 });
	await assert.rejects(completeVideoLessonTask(task.id, "notion-1", { kind: "notion", url: "https://app.notion.com.other.example/unsafe" }), { status: 400 });
	const notionUrl = "https://app.notion.com/p/18f28c91f07c4ad5bb09336cdd424b60?pvs=204";
	await completeVideoLessonTask(task.id, "notion-1", { kind: "notion", url: notionUrl });
	const next = mutateVideoLesson(lesson.id, { action: "save-notion", questionId: q.id }).tasks.at(-1)!;
	assert.equal(claimVideoLessonTask(next.id, "notion-2").lesson.notionUrl, notionUrl);
	assert.ok(!JSON.stringify(readVideoLesson(lesson.id)).includes("render-test"));
});
