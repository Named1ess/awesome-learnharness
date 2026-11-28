"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeftIcon, ArrowUpRightIcon, ClipboardIcon, FilmIcon, MessageCircleQuestionIcon } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import { HostMarkdown } from "@/components/host-markdown";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { VideoLesson, VideoLessonTask } from "@/src/core";
import { lessonAction, lessonRequest } from "./lesson-request";

type AnswerDraft = { timeMs: number; versionId: string; text: string };
type LessonResponse = { lesson: VideoLesson; execution?: "native" | "mcp" };

const taskName: Record<VideoLessonTask["kind"], string> = { render: "Video", answer: "Answer", notion: "Notion save" };

function isActive(task: VideoLessonTask) {
	return task.status === "pending" || task.status === "claimed";
}

function timestamp(timeMs: number) {
	const seconds = Math.floor(timeMs / 1000);
	const parts = [Math.floor(seconds / 60), seconds % 60];
	return parts.map(part => String(part).padStart(2, "0")).join(":");
}

function boundedTime(timeMs: number, durationMs: number) {
	return Math.min(Math.max(0, Number.isFinite(timeMs) ? Math.round(timeMs) : 0), durationMs);
}

export function LessonWatch({ lessonId, initialTimeMs = 0 }: { lessonId: string; initialTimeMs?: number }) {
	const endpoint = `/api/lessons/${encodeURIComponent(lessonId)}`;
	const [lesson, setLesson] = useState<VideoLesson | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [timeMs, setTimeMs] = useState(initialTimeMs);
	const [draft, setDraft] = useState<AnswerDraft | null>(null);
	const [clipboardStatus, setClipboardStatus] = useState<string | null>(null);
	const [native, setNative] = useState(false);
	const player = useRef<HTMLVideoElement | null>(null);
	const requestGeneration = useRef(0);
	const hasWork = lesson?.tasks.some(isActive) ?? false;

	useEffect(() => {
		if (busy) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const generation = requestGeneration.current;
		async function refresh() {
			try {
				const { lesson, execution } = await lessonRequest<LessonResponse>(endpoint, { signal: controller.signal });
				if (controller.signal.aborted || generation !== requestGeneration.current) return;
				setLesson(lesson);
				setNative(execution === "native");
				setLoadError(null);
			} catch (error) {
				if (controller.signal.aborted || generation !== requestGeneration.current) return;
				setLoadError(error instanceof Error ? error.message : "Could not load the video lesson.");
			}
			if (hasWork && !controller.signal.aborted) timer = setTimeout(() => void refresh(), 1500);
		}
		void refresh();
		return () => { controller.abort(); clearTimeout(timer); };
	}, [busy, endpoint, hasWork]);

	async function change(body: object): Promise<boolean> {
		if (busy) return false;
		requestGeneration.current++;
		setBusy(true);
		setActionError(null);
		try {
			const { lesson, execution } = await lessonRequest<LessonResponse>(endpoint, lessonAction(body));
			setLesson(lesson);
			if (execution) setNative(execution === "native");
			return true;
		} catch (error) {
			setActionError(error instanceof Error ? error.message : "Could not update the video lesson.");
			return false;
		} finally {
			setBusy(false);
		}
	}

	const video = lesson?.video;
	const segment = timeMs === video?.durationMs ? video.segments.at(-1) : video?.segments.find(item => item.startMs <= timeMs && timeMs < item.endMs);
	const activeTasks = lesson?.tasks.filter(isActive) ?? [];
	const failedTasks = lesson?.tasks.filter((task, index, tasks) => task.status === "failed" && !tasks.slice(index + 1).some(
		later => later.kind === task.kind && (task.kind !== "answer" || later.questionId === task.questionId),
	)) ?? [];
	const instruction = `Process the pending tasks for video lesson ${lessonId} through LearnHarness MCP.`;

	function seek(positionMs: number) {
		if (!player.current || !video) return;
		const position = boundedTime(positionMs, video.durationMs);
		player.current.currentTime = position / 1000;
		setTimeMs(position);
	}

	function readPosition() {
		if (!player.current || !video) return;
		setTimeMs(boundedTime(player.current.currentTime * 1000, video.durationMs));
	}

	function askAtMoment() {
		if (!player.current || !video) return;
		const position = boundedTime(player.current.currentTime * 1000, video.durationMs);
		player.current.pause();
		setTimeMs(position);
		setDraft({ timeMs: position, versionId: video.versionId, text: draft?.text ?? "" });
	}

	async function ask(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!draft?.text.trim()) return;
		if (await change({ action: "ask", ...draft, text: draft.text.trim() })) setDraft(null);
	}

	async function copyInstruction() {
		try {
			await navigator.clipboard.writeText(instruction);
			setClipboardStatus("Copied.");
		} catch {
			setClipboardStatus("Select and copy the instruction.");
		}
	}

	return (
		<div className="flex h-dvh min-h-0 flex-col">
			<TopBar>
				<Button variant="ghost" size="icon-sm" asChild><Link href="/lessons" aria-label="Back to video lessons"><ArrowLeftIcon aria-hidden="true" /></Link></Button>
				<h1 className="min-w-0 truncate font-title text-3xl tracking-tight">{lesson?.title ?? "Video lesson"}</h1>
			</TopBar>
			{!lesson ? (
				<div className="p-6">{loadError ? <p role="alert" className="text-sm text-destructive">{loadError}</p> : <BrailleSpinner label="Loading video lesson" />}</div>
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(19rem,23rem)] lg:overflow-hidden">
					<main className="min-h-0 min-w-0 px-4 py-6 md:px-8 lg:overflow-y-auto">
						<div className="mx-auto max-w-[60rem] space-y-5">
							<section aria-label="Problem" className="space-y-2 rounded-lg border border-border px-4 py-3">
								<h2 className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">Problem</h2>
								<div className="font-prose text-sm"><HostMarkdown text={lesson.problem} /></div>
							</section>
							{video ? (
								<section aria-label="Video playback" className="space-y-3">
									<video key={video.versionId} ref={player} src={`${endpoint}/media`} controls playsInline preload="metadata" aria-label="Video explanation"
										className="aspect-video w-full rounded-lg bg-black" onLoadedMetadata={() => seek(initialTimeMs)} onTimeUpdate={readPosition} onPause={readPosition} onSeeked={readPosition}>
										<track kind="captions" src={`${endpoint}/captions`} label="Captions" />
									</video>
									<div className="flex flex-wrap items-center justify-between gap-2">
										<p className="font-ui text-xs text-muted-foreground">{timestamp(timeMs)}{segment && <span className="ml-2">{segment.label}</span>}</p>
										<Button type="button" size="sm" data-testid="lesson-ask" onClick={askAtMoment}><MessageCircleQuestionIcon aria-hidden="true" />Ask at this moment</Button>
									</div>
									{segment && <p className="font-prose text-sm text-muted-foreground">{segment.narration}</p>}
								</section>
							) : <p className="flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground"><FilmIcon className="size-4" aria-hidden="true" />The explanation video will appear here after rendering.</p>}
							{(activeTasks.length > 0 || failedTasks.length > 0 || loadError) && <section aria-label="Task status" className="space-y-3 rounded-lg border border-border px-4 py-3">
								{loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
								{activeTasks.length > 0 && <>
									<ul role="status" className="space-y-1 text-sm text-muted-foreground">
										{activeTasks.map(task => <li key={task.id}>{taskName[task.kind]} {task.status === "claimed" ? "in progress" : native ? "queued" : "waiting for Codex"}</li>)}
									</ul>
									{!native && activeTasks.some(task => task.status === "pending") && <div className="flex flex-wrap items-center gap-2">
										<p className="min-w-0 flex-1 break-words font-prose text-sm">{instruction}</p>
										<Button type="button" variant="outline" size="sm" onClick={() => void copyInstruction()}><ClipboardIcon aria-hidden="true" />Copy instruction</Button>
										{clipboardStatus && <span role="status" className="text-xs text-muted-foreground">{clipboardStatus}</span>}
									</div>}
								</>}
								{failedTasks.map(task => <div key={task.id} className="flex items-start justify-between gap-2">
									<p role="alert" className="min-w-0 break-words text-sm text-destructive">{task.error || `${taskName[task.kind]} failed.`}</p>
									<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void change({ action: "retry", taskId: task.id })}>Retry</Button>
								</div>)}
							</section>}
						</div>
					</main>
					<aside aria-label="Video questions" className="min-h-0 min-w-0 border-t border-border px-4 py-5 lg:overflow-y-auto lg:border-l lg:border-t-0">
						<div className="flex flex-col gap-4">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<h2 className="font-title text-xl tracking-tight">Video questions</h2>
								{lesson.notionUrl && <a href={lesson.notionUrl} target="_blank" rel="noreferrer" data-testid="lesson-notion-link" className="inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline">Open in Notion <ArrowUpRightIcon className="size-3" aria-hidden="true" /></a>}
							</div>
							{lesson.questions.length === 0 && !draft && <p className="text-sm text-muted-foreground">Pause the video or choose a moment to ask about.</p>}
							{lesson.questions.map(question => (
								<article key={question.id} className="min-w-0 space-y-2 border-b border-border pb-3 font-prose text-sm">
									<Button type="button" variant="secondary" size="xs" disabled={question.versionId !== video?.versionId} onClick={() => seek(question.timeMs)}
										className="font-ui" data-testid={`lesson-replay-${question.id}`} aria-label={`Replay at ${timestamp(question.timeMs)}`}>{timestamp(question.timeMs)}</Button>
									<p className="font-medium whitespace-pre-wrap [overflow-wrap:anywhere]">{question.text}</p>
									{question.answer ? <>
										<HostMarkdown text={question.answer} />
										<Button type="button" variant="outline" size="sm" data-testid={`lesson-save-${question.id}`} disabled={busy || activeTasks.some(task => task.kind === "notion")}
											onClick={() => void change({ action: "save-notion", questionId: question.id })}>Save to Notion</Button>
									</> : <p className="text-muted-foreground">{failedTasks.some(task => task.kind === "answer" && task.questionId === question.id) ? "Answer failed. Retry the task above." : "Waiting for the answer."}</p>}
								</article>
							))}
							{draft && <form className="space-y-2" onSubmit={event => void ask(event)}>
								<label className="block space-y-1.5 text-sm">
									<span className="font-medium">Question at {timestamp(draft.timeMs)}</span>
									<Textarea name="question" autoFocus required maxLength={3000} value={draft.text} className="font-prose" onInput={event => setDraft({ ...draft, text: event.currentTarget.value })} />
								</label>
								<Button type="submit" size="sm" disabled={busy || !draft.text.trim()}>Queue question</Button>
								<Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
							</form>}
							{actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
						</div>
					</aside>
				</div>
			)}
		</div>
	);
}
