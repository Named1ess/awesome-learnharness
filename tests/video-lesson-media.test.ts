import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const work = await mkdtemp(path.join(tmpdir(), "lh-lesson-media-"));
after(() => rm(work, { recursive: true, force: true }));
process.env.LH_DATA_DIR = path.join(work, "profile");
const share = path.join(work, "shared files");
await mkdir(path.join(share, "lesson files"), { recursive: true });

const { installLessonMedia, serveLessonMedia } = await import("../src/server/lesson-media.ts");
const lessonId = "lesson_0123456789abcdef0123456789abcdef";
const unmanagedId = "lesson_123456789abcdef0123456789abcdef0";
const video = Buffer.from("\u0000\u0000\u0000\u0010ftypisom0000sample video payload");
const sharePath = "lesson files/lesson.mp4";
const readLesson = (id: string) => id === lessonId ? { video: {} } : null;

function request(method = "GET", range?: string): Request {
	return new Request(`http://localhost/api/lessons/${lessonId}/media`, {
		method,
		headers: range === undefined ? {} : { Range: range },
	});
}

test("installs an MP4 from the approved folder and snapshots immutable profile bytes", async () => {
	await writeFile(path.join(share, sharePath), video);
	await installLessonMedia(lessonId, share, sharePath);
	await installLessonMedia(lessonId, share, sharePath);
	const saved = path.join(process.env.LH_DATA_DIR!, "video-lesson-media", `${lessonId}.mp4`);
	assert.deepEqual(await readFile(saved), video);
	await writeFile(path.join(share, sharePath), Buffer.concat([video.subarray(0, -1), Buffer.from("!")]));
	await assert.rejects(installLessonMedia(lessonId, share, sharePath));
	assert.deepEqual(await readFile(saved), video);
});

test("rejects invalid names, traversal, aliases, linked files and false MP4s", async () => {
	const outside = path.join(work, "outside");
	await mkdir(outside);
	await writeFile(path.join(outside, "lesson.mp4"), video);
	await symlink(outside, path.join(share, "escape"), process.platform === "win32" ? "junction" : "dir");
	await link(path.join(outside, "lesson.mp4"), path.join(share, "linked.mp4"));
	await writeFile(path.join(share, "fake.mp4"), "plain text");
	for (const source of ["../outside/lesson.mp4", "lesson files\\lesson.mp4", "lesson.mp4:alt", "escape/lesson.mp4", "linked.mp4", "fake.mp4"]) {
		await assert.rejects(installLessonMedia(unmanagedId, share, source), source);
	}
	await assert.rejects(installLessonMedia("../../outside", share, sharePath));
});

test("serves published media as full and seekable HTTP responses", async () => {
	await writeFile(path.join(share, sharePath), video);
	await installLessonMedia(lessonId, share, sharePath);
	const full = await serveLessonMedia(request(), lessonId, readLesson);
	assert.equal(full.status, 200);
	assert.equal(full.headers.get("Content-Type"), "video/mp4");
	assert.equal(full.headers.get("Content-Length"), String(video.length));
	assert.equal(full.headers.get("Accept-Ranges"), "bytes");
	assert.deepEqual(Buffer.from(await full.arrayBuffer()), video);

	const chunk = await serveLessonMedia(request("GET", "bytes=4-7"), lessonId, readLesson);
	assert.equal(chunk.status, 206);
	assert.equal(chunk.headers.get("Content-Range"), `bytes 4-7/${video.length}`);
	assert.equal(chunk.headers.get("Content-Length"), "4");
	assert.equal(await chunk.text(), "ftyp");

	const tail = await serveLessonMedia(request("GET", "bytes=-7"), lessonId, readLesson);
	assert.equal(tail.status, 206);
	assert.equal(await tail.text(), "payload");
	const rest = await serveLessonMedia(request("GET", "bytes=16-"), lessonId, readLesson);
	assert.equal(rest.status, 206);
	assert.equal(await rest.text(), "sample video payload");
	const head = await serveLessonMedia(request("HEAD"), lessonId, readLesson);
	assert.equal(head.status, 200);
	assert.equal(head.body, null);
	assert.equal(head.headers.get("Content-Length"), String(video.length));
	const invalid = await serveLessonMedia(request("GET", "bytes=999-"), lessonId, readLesson);
	assert.equal(invalid.status, 416);
	assert.equal(invalid.headers.get("Content-Range"), `bytes */${video.length}`);

	assert.equal((await serveLessonMedia(request(), lessonId, () => ({ video: null }))).status, 404);
	assert.equal((await serveLessonMedia(request(), unmanagedId, readLesson)).status, 404);
});
