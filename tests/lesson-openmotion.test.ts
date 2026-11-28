import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { renderOpenMotionLesson } from "../src/server/lesson-openmotion.ts";

const plan = { scenes: [
	{ label: "观察", narration: "先观察。", onScreen: "比较 <两种> 情形", steps: ["第一种", "第二种"] },
	{ label: "结论", narration: "再得出结论。", onScreen: "两种情形有相同结果", steps: [] },
] };

async function fixture(t: TestContext) {
	const directory = await mkdtemp(path.join(tmpdir(), "lh-openmotion-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = path.join(directory, "export.mp4");
	const bytes = Buffer.from("verified export bytes");
	await writeFile(file, bytes);
	const checkpoints: Partial<Record<"projectId" | "workId" | "exportJobId", string>> = {};
	const requests: Array<{ name: string; args: Record<string, unknown> }> = [];
	let guideRead = false;
	let generationCount = 0;
	let synthesisCount = 0;
	let verificationStatus = "passed";
	let exportCount = 0;
	let jobState = "completed";
	const deps = {
		async connect() {
			return {
				async readGuide() {
					guideRead = true;
					return "Installed OpenMotion Director workflow";
				},
				async call(name: string, args: Record<string, unknown>) {
					requests.push({ name, args });
					switch (name) {
						case "openmotion_create_project": return { projectId: "pinned-project" };
						case "openmotion_open_preview": return { inlineWork: { id: "pinned-work" } };
						case "openmotion_import_assets": return { items: [
							{ itemId: "speech-1", status: "completed", path: "assets/imported/one.wav", duration: 0.5 },
							{ itemId: "speech-2", status: "completed", path: "assets/imported/two.wav", duration: 1 },
						] };
						case "openmotion_edit_project": return { revision: "edited-revision", version: { versionId: "edited-version" } };
						case "openmotion_export_request": {
							exportCount += 1;
							return { job: { id: exportCount === 1 ? "pinned-export" : "replacement-export" } };
						}
						case "openmotion_get_project": return args.exportJobId ? { exportJob: {
							id: args.exportJobId,
							state: jobState,
							versionId: "edited-version",
							path: file,
							verification: {
								status: verificationStatus,
								sha256: createHash("sha256").update(bytes).digest("hex"),
								checks: [{ name: "duration", status: "passed", details: "actual=2s; expected=2s; tolerance=0.1s; container=2.021s" }],
							},
						} } : { revision: "assets-revision", currentVersionId: "assets-version" };
						default: throw new Error(`Unexpected call ${name}`);
					}
				},
				async close() {},
			};
		},
		async synthesize() { synthesisCount += 1; },
	};
	const input = {
		title: "比较",
		problem: "怎样比较？",
		taskId: "task_local_openmotion_fixture",
		directory,
		generate: async (system: string) => {
			assert.match(system, /Installed OpenMotion Director workflow/);
			assert.equal(guideRead, true);
			generationCount += 1;
			return JSON.stringify(plan);
		},
		checkpoint: (name: keyof typeof checkpoints, value: string) => { checkpoints[name] = value; },
		signal: new AbortController().signal,
	};
	return { input, deps, checkpoints, requests, bytes,
		failVerification() { verificationStatus = "failed"; },
		setJobState(value: string) { jobState = value; },
		counts() { return { generationCount, synthesisCount }; },
	};
}

test("renders a measured, escaped and verified local lesson", async t => {
	const { input, deps, checkpoints, requests, bytes } = await fixture(t);
	const result = await renderOpenMotionLesson(input, deps);
	assert.deepEqual(checkpoints, { projectId: "pinned-project", workId: "pinned-work", exportJobId: "pinned-export" });
	assert.equal(result.versionId, "edited-version");
	assert.equal(result.durationMs, 2021);
	assert.deepEqual(result.segments.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 750], [750, 2021]]);
	assert.deepEqual(await readFile(path.join(input.directory, result.relativePath)), bytes);
	const edit = requests.find(({ name }) => name === "openmotion_edit_project")!.args;
	assert.equal(edit.expectedVersionId, "assets-version");
	const files = edit.files as { path: string; content: string }[];
	assert.match(files[0]!.content, /data-composition-src="compositions\/scene-1\.html"/);
	assert.match(files.find(file => file.path === "compositions/scene-1.html")!.content, /比较 &lt;两种&gt; 情形/);
	assert.match(files[0]!.content, /<audio[^>]+assets\/imported\/one\.wav/);
	assert.equal(requests.find(({ name }) => name === "openmotion_export_request")!.args.audio, "required");
});

test("resumes a recorded export without regenerating, reauthoring or rerendering", async t => {
	const { input, deps, checkpoints, requests, counts } = await fixture(t);
	const controller = new AbortController();
	await assert.rejects(renderOpenMotionLesson({
		...input,
		signal: controller.signal,
		checkpoint(name, value) {
			input.checkpoint(name, value);
			if (name === "exportJobId") controller.abort();
		},
	}, deps), { name: "AbortError" });
	const before = requests.length;
	const video = await renderOpenMotionLesson({ ...input, saved: checkpoints }, deps);
	assert.equal(video.projectId, "pinned-project");
	assert.deepEqual(requests.slice(before).map(({ name }) => name), ["openmotion_get_project"]);
	assert.deepEqual(counts(), { generationCount: 1, synthesisCount: 1 });
});

test("rejects an export that failed verification and leaves staging empty of final media", async t => {
	const { input, deps, failVerification } = await fixture(t);
	failVerification();
	await assert.rejects(renderOpenMotionLesson(input, deps), /did not pass OpenMotion verification/);
	await assert.rejects(readFile(path.join(input.directory, "lesson.mp4")), { code: "ENOENT" });
});

test("a terminal export failure allows a fresh export of the exact authored version", async t => {
	const { input, deps, checkpoints, requests, setJobState, counts } = await fixture(t);
	setJobState("failed");
	await assert.rejects(renderOpenMotionLesson(input, deps), /OpenMotion export failed/);
	assert.equal(checkpoints.exportJobId, "pinned-export");

	setJobState("completed");
	const video = await renderOpenMotionLesson({ ...input, saved: checkpoints }, deps);
	assert.equal(checkpoints.exportJobId, "replacement-export");
	assert.equal(video.versionId, "edited-version");
	assert.deepEqual(counts(), { generationCount: 1, synthesisCount: 1 });
	const exports = requests.filter(call => call.name === "openmotion_export_request").map(call => call.args);
	assert.equal(exports.length, 2);
	assert.notEqual(exports[0]!.requestId, exports[1]!.requestId);
	assert.equal(exports[1]!.versionId, exports[0]!.versionId);
});
