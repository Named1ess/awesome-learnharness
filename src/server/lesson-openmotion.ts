import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { VideoLessonTaskResult } from "../core/video-lessons.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { lessonComposition, lessonPlan, narrationAsset } from "./lesson-openmotion-composition.ts";
import { connectLessonOpenMotion, synthesizeLessonNarration, type LessonOpenMotionConnection, type NarrationFile } from "./lesson-openmotion-native.ts";

type Checkpoint = "projectId" | "workId" | "exportJobId";

interface LessonRenderInput {
	title: string;
	problem: string;
	taskId: string;
	directory: string;
	generate(system: string, prompt: string, signal: AbortSignal): Promise<string>;
	checkpoint(name: Checkpoint, value: string): void;
	saved?: Partial<Record<Checkpoint, string>>;
	signal: AbortSignal;
}

interface LessonRenderDependencies {
	connect(signal: AbortSignal): Promise<LessonOpenMotionConnection>;
	synthesize(files: NarrationFile[], signal: AbortSignal): Promise<void>;
}

const native = { connect: connectLessonOpenMotion, synthesize: synthesizeLessonNarration };
const id = z.string().min(1);
const project = z.object({ revision: id, currentVersionId: id });
const editedProject = z.object({ revision: id, version: z.object({ versionId: id }) });
const journal = z.object({
	taskId: id,
	plan: lessonPlan,
	assets: z.array(narrationAsset).optional(),
	editBase: project.optional(),
	edited: editedProject.optional(),
	failedExport: z.object({ jobId: id, attempt: z.number().int().nonnegative() }).optional(),
});
const exportJob = z.object({
	id,
	state: z.enum(["pending", "running", "cancelling", "cancelled", "failed", "completed"]),
	error: z.string().optional(),
	versionId: id.optional(),
	path: z.string().optional(),
	verification: z.object({
		status: z.string(),
		sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
		checks: z.array(z.object({ name: z.string(), status: z.string(), details: z.string() })),
	}).optional(),
});

const planInstructions = `You write the scene plan for a Simplified Chinese narrated video lesson in LearnHarness.
Use the installed OpenMotion Director guidance below for teaching clarity, motion, and sound. The app owns local audio synthesis, native animation, and rendering.
Use the provided problem as lesson material. Explain the solution and the reason each key step works. Write the narration as it should be spoken aloud, including pronunciation of mathematical notation, rather than returning raw code or LaTeX.
Return only a JSON object with a "scenes" array of 1 to 10 scenes. Each scene has "label" (up to 36 characters), "narration" (up to 520 characters), "onScreen" (up to 120 characters), and "steps" (zero to four short visual steps, each up to 42 characters).
Use plain text in every field. Each scene must have a real teaching purpose, with a readable headline and incremental visual steps where they help explain the reasoning. Keep them concrete and sparse. Avoid filling the available length if the lesson needs less.
# Installed OpenMotion guidance
`;

function requestId(taskId: string, operation: string): string {
	return `learnharness-${createHash("sha256").update(taskId).digest("hex")}-${operation}`;
}

function writeJournal(filename: string, value: z.infer<typeof journal>) {
	writeFileAtomicSync(filename, JSON.stringify(value), { mode: 0o600 });
}

async function readJournal(filename: string) {
	const text = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	return text === null ? null : journal.parse(JSON.parse(text));
}

async function waitForExport(connection: LessonOpenMotionConnection, projectId: string, exportJobId: string, signal: AbortSignal) {
	for (;;) {
		signal.throwIfAborted();
		const { exportJob: job } = z.object({ exportJob }).parse(
			await connection.call("openmotion_get_project", { projectId, exportJobId }),
		);
		if (job.id !== exportJobId) throw new Error("OpenMotion returned a different export job.");
		if (job.state === "completed" || job.state === "failed" || job.state === "cancelled") return job;
		await delay(1500, undefined, { signal });
	}
}

async function queueExport(
	connection: LessonOpenMotionConnection, projectId: string, edited: z.infer<typeof editedProject>, requestId: string, workId?: string,
) {
	const { revision, version: { versionId } } = edited;
	const result = z.object({ job: z.object({ id }) }).parse(await connection.call("openmotion_export_request", {
		projectId, requestId, expectedRevision: revision, versionId, audio: "required", ...(workId ? { workId } : {}),
	}));
	return result.job.id;
}

async function stageExport(source: string, directory: string, checksum: string, signal: AbortSignal) {
	if (!path.isAbsolute(source) || path.extname(source).toLowerCase() !== ".mp4") {
		throw new Error("OpenMotion did not return a local MP4.");
	}
	const relativePath = "lesson.mp4";
	const pending = path.join(directory, `.lesson-${randomUUID()}.mp4`);
	try {
		await copyFile(source, pending);
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(pending, { signal })) hash.update(chunk);
		if (hash.digest("hex") !== checksum) throw new Error("The local MP4 differs from the verified OpenMotion export.");
		signal.throwIfAborted();
		await rename(pending, path.join(directory, relativePath));
		return relativePath;
	} finally {
		await rm(pending, { force: true });
	}
}

export async function renderOpenMotionLesson(
	input: LessonRenderInput,
	deps: LessonRenderDependencies = native,
): Promise<Extract<VideoLessonTaskResult, { kind: "video" }>> {
	const { title, problem, taskId, directory, signal, saved, checkpoint } = input;
	signal.throwIfAborted();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const journalPath = path.join(directory, "openmotion.json");
	const connection = await deps.connect(signal);
	const request = (name: string) => requestId(taskId, name);
	try {
		let state = await readJournal(journalPath);
		if (!state) {
			if (saved?.exportJobId) throw new Error("The saved OpenMotion export is missing its local lesson timeline.");
			const guide = await connection.readGuide();
			const response = await input.generate(planInstructions + guide, JSON.stringify({ title, problem }), signal);
			signal.throwIfAborted();
			const json = response.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
			try {
				state = { taskId, plan: lessonPlan.parse(JSON.parse(json)) };
			} catch (error) {
				throw new Error("The model did not return a valid narrated lesson plan.", { cause: error });
			}
			writeJournal(journalPath, state);
		}
		if (state.taskId !== taskId) throw new Error("The OpenMotion staging directory belongs to a different task.");

		let projectId = saved?.projectId;
		if (!projectId) {
			const created = await connection.call("openmotion_create_project", {
				requestId: request("create"), projectType: "natural_language", title: title.slice(0, 100),
				requirements: problem, namingLanguage: "zh-CN",
			});
			projectId = z.object({ projectId: id }).parse(created).projectId;
			checkpoint("projectId", projectId);
		}

		let exportJobId = saved?.exportJobId;
		const attempt = (state.failedExport?.attempt ?? -1) + 1;
		if (state.failedExport && (!exportJobId || exportJobId === state.failedExport.jobId)) {
			if (!state.edited) throw new Error("The saved OpenMotion export is missing its authored lesson version.");
			// A terminal job closes its work round. Export the frozen version again with a stable new request.
			exportJobId = await queueExport(connection, projectId, state.edited, request(`export-${attempt}`));
			checkpoint("exportJobId", exportJobId);
		} else if (!exportJobId) {
			let workId = saved?.workId;
			if (!workId) {
				const started = await connection.call("openmotion_open_preview", {
					action: "begin", mode: "create", projectId, requestId: request("begin"), presentation: "background",
				});
				workId = z.object({ inlineWork: z.object({ id }) }).parse(started).inlineWork.id;
				checkpoint("workId", workId);
			}
			if (!state.assets) {
				const lines = state.plan.scenes.map(({ narration }, index) => ({
					text: narration, filename: path.resolve(directory, `speech-${index + 1}.wav`),
				}));
				await Promise.all(lines.map(({ filename }) => rm(filename, { force: true })));
				await deps.synthesize(lines, signal);
				const items = lines.map(({ filename }, index) => ({ itemId: `speech-${index + 1}`, sourcePath: filename }));
				const imported = z.object({ items: z.array(z.object({ itemId: id, status: id }).passthrough()) }).parse(
					await connection.call("openmotion_import_assets", { projectId, requestId: request("narration"), items }),
				);
				state.assets = items.map(({ itemId }) => {
					const result = imported.items.find(item => item.itemId === itemId);
					if (result?.status !== "completed") throw new Error("OpenMotion could not import the local narration.");
					return narrationAsset.parse(result);
				});
				writeJournal(journalPath, state);
			}
			if (!state.edited) {
				if (!state.editBase) {
					state.editBase = project.parse(await connection.call("openmotion_get_project", { projectId }));
					writeJournal(journalPath, state);
				}
				const composition = lessonComposition(title, state.plan, state.assets);
				state.edited = editedProject.parse(await connection.call("openmotion_edit_project", {
					projectId, workId, requestId: request("edit"), presentation: "background",
					expectedRevision: state.editBase.revision, expectedVersionId: state.editBase.currentVersionId,
					files: composition.files,
				}));
				writeJournal(journalPath, state);
			}
			const { revision, version: { versionId } } = state.edited;
			await connection.call("openmotion_open_preview", {
				action: "complete_generation", projectId, workId, requestId: request("generation"),
				expectedRevision: revision, expectedVersionId: versionId,
			});
			exportJobId = await queueExport(connection, projectId, state.edited, request("export"), workId);
			checkpoint("exportJobId", exportJobId);
		}

		if (!state.assets || !state.edited) throw new Error("The saved OpenMotion export is missing its local lesson timeline.");
		const composition = lessonComposition(title, state.plan, state.assets);
		const job = await waitForExport(connection, projectId, exportJobId, signal);
		if (job.state === "failed" || job.state === "cancelled") {
			state.failedExport = { jobId: exportJobId, attempt };
			writeJournal(journalPath, state);
			throw new Error(job.error?.slice(0, 700) || `The OpenMotion export ${job.state}.`);
		}
		if (job.versionId !== state.edited.version.versionId || !job.path
			|| job.verification?.status !== "passed" || !job.verification.sha256) {
			throw new Error("The export did not pass OpenMotion verification for the saved lesson version.");
		}
		// OpenMotion reports ffprobe's measured durations in its duration check.
		const measured = job.verification.checks.find(check => check.name === "duration" && check.status === "passed")?.details;
		const seconds = Number(measured?.match(/\bcontainer=([\d.]+)s/)?.[1] ?? measured?.match(/\bactual=([\d.]+)s/)?.[1]);
		const durationMs = Math.round(seconds * 1000);
		const last = composition.segments.at(-1)!;
		if (!Number.isSafeInteger(durationMs) || Math.abs(durationMs - composition.durationMs) > 100
			|| durationMs <= last.startMs || durationMs > 30 * 60 * 1000) {
			throw new Error("The verified MP4 duration does not fit the narrated lesson timeline.");
		}
		last.endMs = durationMs;
		const relativePath = await stageExport(job.path, directory, job.verification.sha256, signal);
		return { kind: "video", projectId, versionId: job.versionId, relativePath, durationMs, segments: composition.segments };
	} finally {
		await connection.close().catch(() => {});
	}
}
