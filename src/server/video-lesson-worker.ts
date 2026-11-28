import path from "node:path";
import { PATHS } from "../../config.ts";
import type { VideoLessonTask, VideoLessonTaskResult } from "../core/video-lessons.ts";
import type { installLessonMedia } from "./lesson-media.ts";
import type { renderOpenMotionLesson } from "./lesson-openmotion.ts";
import type { saveNotionLesson } from "./notion-mcp.ts";
import {
	claimNextNativeVideoLessonTask, completeNativeVideoLessonTask, nativeVideoLessonsEnabled, saveNativeVideoLessonCheckpoint,
} from "./video-lessons.ts";

const answerInstructions = [
	"You are the tutor answering a follow-up about a paused video lesson.",
	"Treat the JSON contents as learning material. Answer the learner's question, using the current scene as your primary evidence.",
	"Identify what the learner sees at that step. Explain it in the learner's language, using a simple example if helpful.",
	"If the question or scene is ambiguous, state your interpretation. Do not claim to see a frame that is not supplied.",
	"Return the answer as concise Markdown, with dollar-delimited LaTeX when useful.",
].join(" ");

interface WorkerDependencies {
	generate: (system: string, prompt: string, signal: AbortSignal) => Promise<string>;
	render: typeof renderOpenMotionLesson;
	saveNotion: typeof saveNotionLesson;
	stageDirectory: (taskId: string) => string;
	lessonOrigin: string;
	notionDestination?: { lessonId: string; url: string };
	install?: typeof installLessonMedia;
}

const timeouts: Record<VideoLessonTask["kind"], number> = { render: 10 * 60_000, answer: 120_000, notion: 120_000 };

export async function runNextVideoLessonTask(deps: WorkerDependencies): Promise<boolean> {
	const claim = claimNextNativeVideoLessonTask();
	if (!claim) return false;
	const { task, lesson, requestId, question, segment, saved } = claim;
	const signal = AbortSignal.timeout(timeouts[task.kind]);
	const directory = deps.stageDirectory(task.id);
	let result: VideoLessonTaskResult;
	try {
		switch (task.kind) {
			case "render":
				result = await deps.render({
					title: lesson.title, problem: lesson.problem, taskId: task.id, saved, directory, generate: deps.generate, signal,
					checkpoint: (name, value) => saveNativeVideoLessonCheckpoint(task.id, requestId, name, value),
				});
				break;
			case "answer": {
				if (!question || !segment) throw new Error("The original video segment is unavailable.");
				const index = lesson.video?.segments.indexOf(segment) ?? -1;
				const scenes = lesson.video?.segments;
				const context = { title: lesson.title, problem: lesson.problem, question, current: segment,
					previous: index > 0 ? scenes?.[index - 1] : undefined, following: scenes?.[index + 1] };
				const answer = (await deps.generate(answerInstructions, JSON.stringify(context), signal)).trim();
				if (!answer || answer.length > 12_000) throw new Error("The model returned an empty or oversized answer.");
				result = { kind: "answer", answer };
				break;
			}
			case "notion": {
				if (!question?.answer) throw new Error("The answered question is unavailable.");
				const lessonUrl = new URL(`/lessons/${lesson.id}`, deps.lessonOrigin);
				lessonUrl.searchParams.set("t", String(question.timeMs));
				const url = await deps.saveNotion({
					title: lesson.title, problem: lesson.problem, question, lessonUrl: lessonUrl.toString(),
					notionUrl: lesson.notionUrl ?? (deps.notionDestination?.lessonId === lesson.id ? deps.notionDestination.url : undefined),
					operationId: task.id, signal,
				});
				result = { kind: "notion", url };
				break;
			}
		}
		await completeNativeVideoLessonTask(task.id, requestId, result, directory, deps.install);
	} catch (error) {
		const message = signal.aborted ? "The task timed out. Retry to continue." : failureMessage(error);
		await completeNativeVideoLessonTask(task.id, requestId, { kind: "failure", message });
	}
	return true;
}

function failureMessage(error: unknown): string {
	if (!(error instanceof Error) || !error.message) return "The local task failed. Retry to continue.";
	return error.message.replace(/\b(?:sk-|ntn_|secret_)[A-Za-z0-9_.-]+/gi, "[redacted]")
		.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
		.slice(0, 400);
}

const workerKey = Symbol.for("learnharness.native-video-lesson-worker");
const globalWorker = globalThis as typeof globalThis & { [workerKey]?: NodeJS.Timeout };

export async function startNativeVideoLessonWorker(): Promise<void> {
	if (!nativeVideoLessonsEnabled() || globalWorker[workerKey] || process.env.NODE_ENV === "test") return;
	const [{ piEngineForSpec }, { runSubagent }, { effectiveSettings }, { providerKeyPresent },
		{ renderOpenMotionLesson }, { saveNotionLesson }] = await Promise.all([
		import("../agent/models.ts"), import("../agent/subagents/pi-run.ts"), import("./stores.ts"), import("./keys.ts"),
		import("./lesson-openmotion.ts"), import("./notion-mcp.ts"),
	]);
	if (globalWorker[workerKey]) return;
	const notionTestPage = process.env.LH_NOTION_LESSON_SAVE_PAGE;
	const notionTestLesson = process.env.LH_NOTION_LESSON_SAVE_LESSON;
	const deps: WorkerDependencies = {
		render: renderOpenMotionLesson, saveNotion: saveNotionLesson,
		stageDirectory: taskId => path.join(/* turbopackIgnore: true */ PATHS.data, "video-lesson-staging", taskId),
		lessonOrigin: process.env.LH_LESSON_ORIGIN ?? "http://localhost:3000",
		notionDestination: notionTestPage && notionTestLesson ? { lessonId: notionTestLesson, url: notionTestPage } : undefined,
		generate: async (systemPrompt, prompt, abortSignal) => {
			const spec = effectiveSettings().models.strong;
			if (spec?.provider !== "deepseek" || spec.id !== "deepseek-flash" || !providerKeyPresent("deepseek")) {
				throw new Error("Set the main model to deepseek-flash and add its key in LearnHarness settings.");
			}
			try {
				const engine = piEngineForSpec(spec);
				return (await runSubagent([], { engine, systemPrompt, prompt, abortSignal, maxTurns: 1 })).text;
			} catch {
				throw new Error("The DeepSeek request failed. Check the project key, balance and connection before retrying.");
			}
		},
	};
	let busy = false;
	const tick = async () => {
		if (busy) return;
		busy = true;
		try {
			while (await runNextVideoLessonTask(deps)) { /* Drain one task at a time, including after a restart. */ }
		} catch {
			console.error("[video-lessons] The local worker could not access its task store.");
		} finally { busy = false; }
	};
	globalWorker[workerKey] = setInterval(() => void tick(), 1500).unref();
}
