import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const profile = await mkdtemp(path.join(tmpdir(), "lh-native-video-"));
test.after(() => rm(profile, { recursive: true, force: true }));
process.env.LH_DATA_DIR = profile;
process.env.LH_STANDALONE_LESSONS = "1";

const { claimNextNativeVideoLessonTask, claimVideoLessonTask, completeVideoLessonTask, createVideoLesson,
	mutateVideoLesson, readVideoLesson, saveNativeVideoLessonCheckpoint } = await import("../src/server/video-lessons.ts");
const { runNextVideoLessonTask } = await import("../src/server/video-lesson-worker.ts");

test("the native worker resumes its own task and sends matched timestamps through the whole workflow", async () => {
	const lesson = createVideoLesson({ title: "配方法", problem: "x² + 4x − 5 = 0" });
	const task = lesson.tasks[0]!;
	assert.throws(() => claimVideoLessonTask(task.id, "external"), { status: 409 });
	const firstClaim = claimNextNativeVideoLessonTask()!;
	saveNativeVideoLessonCheckpoint(task.id, firstClaim.requestId, "projectId", "project-from-prior-run");
	assert.equal(claimNextNativeVideoLessonTask()?.requestId, firstClaim.requestId);
	assert.equal(claimNextNativeVideoLessonTask()?.saved.projectId, "project-from-prior-run");
	await assert.rejects(completeVideoLessonTask(task.id, firstClaim.requestId, { kind: "failure", message: "Wrong owner" }), { status: 409 });
	assert.ok(!JSON.stringify(readVideoLesson(lesson.id)).includes("project-from-prior-run"));

	const dependencies: Parameters<typeof runNextVideoLessonTask>[0] = {
		stageDirectory: () => profile,
		lessonOrigin: "http://localhost:3000",
		generate: async (_system, prompt) => {
			assert.match(prompt, /"timeMs":1400/);
			assert.match(prompt, /两边补四/);
			return "左右同时加四，等式仍成立。";
		},
		render: async ({ saved, checkpoint }) => {
			assert.equal(saved?.projectId, "project-from-prior-run");
			checkpoint("exportJobId", "job-1");
			return {
				kind: "video", projectId: "project-from-prior-run", versionId: "v1", durationMs: 2000, relativePath: "lesson.mp4",
				segments: [
					{ startMs: 0, endMs: 1000, label: "移项", narration: "先移项", onScreen: "x² + 4x = 5" },
					{ startMs: 1000, endMs: 2000, label: "配方", narration: "两边补四", onScreen: "(x + 2)² = 9" },
				],
			};
		},
		install: async (_id, root, file) => { assert.equal(root, profile); assert.equal(file, "lesson.mp4"); },
		saveNotion: async ({ question, lessonUrl }) => {
			assert.match(question.answer!, /两边|左右/);
			assert.equal(lessonUrl, `http://localhost:3000/lessons/${lesson.id}?t=1400`);
			return "https://app.notion.com/p/example";
		},
	};
	assert.equal(await runNextVideoLessonTask(dependencies), true);
	mutateVideoLesson(lesson.id, { action: "ask", versionId: "v1", timeMs: 1400, text: "什么意思？" });
	assert.equal(await runNextVideoLessonTask(dependencies), true);
	const answered = readVideoLesson(lesson.id)!;
	assert.equal(answered.questions[0]?.answer, "左右同时加四，等式仍成立。");
	mutateVideoLesson(lesson.id, { action: "save-notion", questionId: answered.questions[0]!.id });
	assert.equal(await runNextVideoLessonTask(dependencies), true);
	assert.equal(readVideoLesson(lesson.id)?.notionUrl, "https://app.notion.com/p/example");
	const taskCount = readVideoLesson(lesson.id)!.tasks.length;
	assert.equal(mutateVideoLesson(lesson.id, { action: "save-notion", questionId: answered.questions[0]!.id }).tasks.length, taskCount);
	assert.equal(await runNextVideoLessonTask(dependencies), false);
});

test("retry reopens a failed native task with the same remote checkpoints", async () => {
	const lesson = createVideoLesson({ title: "Retry", problem: "Solve x + 1 = 2" });
	const task = lesson.tasks[0]!;
	const publishedJob = "remote-job-1";
	const dependencies: Parameters<typeof runNextVideoLessonTask>[0] = {
		stageDirectory: () => profile,
		lessonOrigin: "http://localhost:3000",
		generate: async () => assert.fail("should not ask the model"),
		saveNotion: async () => assert.fail("should not save to Notion"),
		render: async ({ saved, checkpoint }) => {
			if (!saved?.exportJobId) checkpoint("exportJobId", publishedJob);
			else assert.equal(saved.exportJobId, publishedJob);
			throw new Error("Render unavailable.");
		},
	};
	await runNextVideoLessonTask(dependencies);
	assert.equal(readVideoLesson(lesson.id)?.tasks[0]?.status, "failed");
	const retry = mutateVideoLesson(lesson.id, { action: "retry", taskId: task.id });
	assert.equal(retry.tasks[0]?.status, "pending");
	assert.equal(retry.tasks[0]?.id, task.id);
	await runNextVideoLessonTask(dependencies);
	assert.equal(readVideoLesson(lesson.id)?.tasks[0]?.status, "failed");
});
