import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { VideoLesson, VideoLessonSummary, VideoLessonTask, VideoLessonTaskResult, VideoLessonVideo } from "../core/video-lessons.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { installLessonMedia, LessonMediaError } from "./lesson-media.ts";

const LESSON_ID = /^lesson_[a-f0-9]{32}$/;
const TASK_ID = /^(lesson_[a-f0-9]{32})_task_[a-f0-9]{32}$/;
const directory = path.join(/* turbopackIgnore: true */ PATHS.data, "video-lessons");
const newId = () => randomUUID().replaceAll("-", "");
const completionKind = { render: "video", answer: "answer", notion: "notion" } as const;
const completing = new Set<string>();

interface StoredTask extends VideoLessonTask {
	requestId?: string;
	receipt?: string;
	owner?: "native";
	checkpoints?: Partial<Record<VideoLessonCheckpoint, string>>;
}

export type VideoLessonCheckpoint = "projectId" | "workId" | "exportJobId";

type LessonRecord = Omit<VideoLesson, "tasks"> & { tasks: StoredTask[] };
type LessonChange =
	| { action: "ask"; versionId: string; timeMs: number; text: string }
	| { action: "save-notion"; questionId: string }
	| { action: "retry"; taskId: string };

export class VideoLessonError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

export function nativeVideoLessonsEnabled(): boolean {
	return process.env.LH_STANDALONE_LESSONS === "1";
}

function filename(id: string): string {
	return path.join(/* turbopackIgnore: true */ directory, `${id}.json`);
}

function read(id: string): LessonRecord | null {
	if (!LESSON_ID.test(id)) return null;
	const file = filename(id);
	const stat = fs.lstatSync(/* turbopackIgnore: true */ file, { throwIfNoEntry: false });
	if (!stat || !stat.isFile() || stat.nlink !== 1) return null;
	const lesson = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8")) as LessonRecord;
	return lesson.id === id ? lesson : null;
}

function publicTask({ id, lessonId, kind, status, questionId, error }: StoredTask): VideoLessonTask {
	return { id, lessonId, kind, status, ...(questionId ? { questionId } : {}), ...(error ? { error } : {}) };
}

function view(lesson: LessonRecord): VideoLesson {
	return { ...lesson, tasks: lesson.tasks.map(publicTask) };
}

function save(lesson: LessonRecord): VideoLesson {
	fs.mkdirSync(/* turbopackIgnore: true */ directory, { recursive: true });
	writeFileAtomicSync(filename(lesson.id), JSON.stringify(lesson));
	return view(lesson);
}

function allLessons(): LessonRecord[] {
	let names: string[];
	try { names = fs.readdirSync(/* turbopackIgnore: true */ directory); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return names.filter(name => name.endsWith(".json")).map(name => read(name.slice(0, -5)))
		.filter((lesson): lesson is LessonRecord => lesson !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function requireLesson(id: string): LessonRecord {
	const lesson = read(id);
	if (!lesson) throw new VideoLessonError(404, "Video lesson not found.");
	return lesson;
}

function requireTask(taskId: string) {
	const id = TASK_ID.exec(taskId)?.[1];
	const lesson = id ? read(id) : null;
	const task = lesson?.tasks.find(row => row.id === taskId);
	if (!lesson || !task) throw new VideoLessonError(404, "Lesson task not found.");
	return { lesson, task };
}

function enqueue(lesson: LessonRecord, kind: VideoLessonTask["kind"], questionId?: string) {
	lesson.tasks.push({ id: `${lesson.id}_task_${newId()}`, lessonId: lesson.id, kind, status: "pending", ...(questionId ? { questionId } : {}) });
}

function isActive(task: StoredTask) { return task.status === "pending" || task.status === "claimed"; }

function reopenNativeTask(task: StoredTask) {
	task.status = "pending";
	delete task.error;
	delete task.receipt;
}

export function createVideoLesson(input: { title: string; problem: string }): VideoLesson {
	const { title, problem } = input;
	const lesson: LessonRecord = { id: `lesson_${newId()}`, title, problem, createdAt: new Date().toISOString(), questions: [], tasks: [] };
	enqueue(lesson, "render");
	return save(lesson);
}

export function readVideoLesson(id: string): VideoLesson | null {
	const lesson = read(id);
	return lesson ? view(lesson) : null;
}

export function listVideoLessons(): { lessons: VideoLessonSummary[] } {
	return { lessons: allLessons().map(({ id, title, createdAt, video }) => ({ id, title, createdAt, hasVideo: !!video })) };
}

export function mutateVideoLesson(id: string, change: LessonChange): VideoLesson {
	const lesson = requireLesson(id);
	switch (change.action) {
		case "ask": {
			if (!lesson.video || lesson.video.versionId !== change.versionId) throw new VideoLessonError(409, "Refresh this lesson before asking about its video.");
			if (!Number.isInteger(change.timeMs) || change.timeMs < 0 || change.timeMs > lesson.video.durationMs) {
				throw new VideoLessonError(400, "Choose a time within the video.");
			}
			const id = `question_${newId()}`;
			lesson.questions.push({ id, versionId: change.versionId, timeMs: change.timeMs, text: change.text });
			enqueue(lesson, "answer", id);
			break;
		}
		case "save-notion": {
			const question = lesson.questions.find(row => row.id === change.questionId);
			if (!question?.answer) throw new VideoLessonError(409, "Choose an answered question to save to Notion.");
			const pending = lesson.tasks.find(task => task.kind === "notion" && isActive(task));
			if (pending) {
				if (pending.questionId === question.id) return view(lesson);
				throw new VideoLessonError(409, "Wait for the current Notion save to finish.");
			}
			const prior = nativeVideoLessonsEnabled() ? lesson.tasks.findLast(task =>
				task.kind === "notion" && task.owner === "native" && task.questionId === question.id) : undefined;
			if (prior?.status === "completed") return view(lesson);
			if (prior?.status === "failed") reopenNativeTask(prior);
			else enqueue(lesson, "notion", question.id);
			break;
		}
		case "retry": {
			const failed = lesson.tasks.find(task => task.id === change.taskId && task.status === "failed");
			if (!failed) throw new VideoLessonError(409, "Only a failed task can be retried.");
			const later = lesson.tasks.slice(lesson.tasks.indexOf(failed) + 1);
			if (later.some(task => task.kind === failed.kind && (task.kind !== "answer" || task.questionId === failed.questionId))) {
				return view(lesson);
			}
			if (failed.owner === "native" && nativeVideoLessonsEnabled()) {
				reopenNativeTask(failed);
			} else {
				enqueue(lesson, failed.kind, failed.questionId);
			}
			break;
		}
	}
	return save(lesson);
}

export function listVideoLessonTasks(lessonId?: string): { tasks: VideoLessonTask[] } {
	const lessons = lessonId ? [requireLesson(lessonId)] : allLessons().reverse();
	return { tasks: lessons.flatMap(lesson => lesson.tasks.filter(task => task.status === "pending")).slice(0, 20).map(publicTask) };
}

export function claimVideoLessonTask(taskId: string, requestId: string) {
	const { lesson, task } = requireTask(taskId);
	if (task.owner === "native" || (nativeVideoLessonsEnabled() && task.status === "pending")) {
		throw new VideoLessonError(409, "LearnHarness is configured to run this lesson task locally.");
	}
	if (task.status === "pending") {
		task.status = "claimed";
		task.requestId = requestId;
		save(lesson);
	} else if (task.requestId !== requestId || task.status !== "claimed") {
		throw new VideoLessonError(409, "This task is already claimed or finished.");
	}
	return taskContext(lesson, task);
}

/** Only the single app worker can reuse its durable claims after a restart. */
export function claimNextNativeVideoLessonTask() {
	if (!nativeVideoLessonsEnabled()) return;
	for (const lesson of allLessons().reverse()) {
		const task = lesson.tasks.find(candidate => candidate.status === "pending" ||
			(candidate.status === "claimed" && candidate.owner === "native"));
		if (!task) continue;
		if (task.status === "pending") {
			task.owner = "native";
			task.status = "claimed";
			task.requestId ??= randomUUID();
			save(lesson);
		}
		if (!task.requestId) throw new VideoLessonError(500, "The saved native claim is incomplete.");
		return { ...taskContext(lesson, task), requestId: task.requestId, saved: task.checkpoints ?? {} };
	}
}

export function saveNativeVideoLessonCheckpoint(taskId: string, requestId: string, name: VideoLessonCheckpoint, value: string) {
	const { lesson, task } = requireTask(taskId);
	if (task.owner !== "native" || task.status !== "claimed" || task.requestId !== requestId) {
		throw new VideoLessonError(409, "The local task claim is no longer active.");
	}
	task.checkpoints = { ...task.checkpoints, [name]: value };
	save(lesson);
}

function taskContext(lesson: LessonRecord, task: StoredTask) {
	const { id, title, problem, video, notionUrl } = lesson;
	const question = lesson.questions.find(row => row.id === task.questionId);
	const segment = question && video?.segments.find(row => row.startMs <= question.timeMs &&
		(question.timeMs < row.endMs || (question.timeMs === video.durationMs && row.endMs === video.durationMs)));
	return { task: publicTask(task), lesson: { id, title, problem, ...(video ? { video } : {}), ...(notionUrl ? { notionUrl } : {}) },
		...(question ? { question } : {}), ...(segment ? { segment } : {}) };
}

function videoMetadata(result: Extract<VideoLessonTaskResult, { kind: "video" }>): VideoLessonVideo {
	const { projectId, versionId, durationMs, segments } = result;
	if (!Number.isSafeInteger(durationMs) || durationMs > 30 * 60 * 1000) throw new VideoLessonError(400, "Video lessons may be at most 30 minutes long.");
	if (Buffer.byteLength(JSON.stringify(segments)) > 24 * 1024) throw new VideoLessonError(413, "The lesson timeline is too large.");
	let end = 0;
	for (const segment of segments) {
		if (segment.startMs !== end || !Number.isSafeInteger(segment.endMs) || segment.endMs <= end) {
			throw new VideoLessonError(400, "Video segments must cover the timeline in order, without gaps or overlaps.");
		}
		end = segment.endMs;
	}
	if (!end || end !== durationMs) throw new VideoLessonError(400, "The finished segment must end at the video duration.");
	return { projectId, versionId, durationMs, segments };
}

function notionPage(rawUrl: string): string {
	const url = URL.parse(rawUrl);
	if (!url || url.protocol !== "https:" || url.username || url.password || url.port ||
		!(url.hostname === "app.notion.com" || url.hostname === "notion.so" || url.hostname.endsWith(".notion.so") ||
			url.hostname === "notion.site" || url.hostname.endsWith(".notion.site"))) {
		throw new VideoLessonError(400, "Use the HTTPS URL of the saved Notion page.");
	}
	return url.toString();
}

export async function completeVideoLessonTask(
	taskId: string, requestId: string, result: VideoLessonTaskResult, filesDirectory?: string, install = installLessonMedia,
): Promise<VideoLessonTask> {
	return completeOwnedTask(taskId, requestId, result, filesDirectory, install);
}

export async function completeNativeVideoLessonTask(
	taskId: string, requestId: string, result: VideoLessonTaskResult, filesDirectory?: string, install = installLessonMedia,
): Promise<VideoLessonTask> {
	return completeOwnedTask(taskId, requestId, result, filesDirectory, install, "native");
}

async function completeOwnedTask(
	taskId: string, requestId: string, result: VideoLessonTaskResult, filesDirectory: string | undefined,
	install: typeof installLessonMedia, owner?: "native",
): Promise<VideoLessonTask> {
	const receipt = createHash("sha256").update(JSON.stringify(result)).digest("hex");
	const initial = requireTask(taskId);
	if (initial.task.owner !== owner) throw new VideoLessonError(409, "This task belongs to another executor.");
	if (initial.task.requestId === requestId && initial.task.receipt === receipt) return publicTask(initial.task);
	if (initial.task.status !== "claimed" || initial.task.requestId !== requestId) throw new VideoLessonError(409, "Complete this task with the request ID used to claim it.");
	if (result.kind !== "failure" && result.kind !== completionKind[initial.task.kind]) throw new VideoLessonError(409, "Result does not match the kind of lesson task.");
	if (completing.has(taskId)) throw new VideoLessonError(409, "This lesson task is finishing. Check its saved status before retrying.");
	if (result.kind !== "video") return saveTaskResult(taskId, requestId, receipt, result);
	const video = videoMetadata(result);
	if (!filesDirectory) throw new VideoLessonError(503, "Set an accessible MCP shared files folder to import the MP4.");
	completing.add(taskId);
	try {
		await install(initial.lesson.id, filesDirectory, result.relativePath);
		return saveTaskResult(taskId, requestId, receipt, result, video);
	} catch (error) {
		if (error instanceof LessonMediaError) throw new VideoLessonError(error.status, error.message);
		throw error;
	} finally {
		completing.delete(taskId);
	}
}

function saveTaskResult(taskId: string, requestId: string, receipt: string, result: VideoLessonTaskResult, video?: VideoLessonVideo): VideoLessonTask {
	// Keep any browser writes that landed while a video was copied.
	const { lesson, task } = requireTask(taskId);
	if (task.receipt === receipt) return publicTask(task);
	if (task.status !== "claimed" || task.requestId !== requestId) throw new VideoLessonError(409, "This lesson task has already finished.");
	if (video) lesson.video = video;
	if (result.kind === "answer") {
		const question = lesson.questions.find(row => row.id === task.questionId);
		if (!question) throw new VideoLessonError(409, "The original video question is unavailable.");
		question.answer = result.answer;
	}
	if (result.kind === "notion") lesson.notionUrl = notionPage(result.url);
	if (result.kind === "failure") task.error = result.message;
	task.status = result.kind === "failure" ? "failed" : "completed";
	task.receipt = receipt;
	save(lesson);
	return publicTask(task);
}

function captionTime(milliseconds: number): string {
	return new Date(milliseconds).toISOString().slice(11, 23);
}

export function renderVideoLessonCaptions(id: string): string {
	const video = requireLesson(id).video;
	if (!video) throw new VideoLessonError(404, "This video lesson has no captions yet.");
	return "WEBVTT\n\n" + video.segments.map(({ startMs, endMs, narration }) => {
		const text = narration.replace(/[\r\n]+/g, " ").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
		return `${captionTime(startMs)} --> ${captionTime(endMs)}\n${text}\n`;
	}).join("\n");
}
