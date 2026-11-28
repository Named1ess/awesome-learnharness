"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { FilmIcon } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { VideoLesson, VideoLessonSummary } from "@/src/core";
import { lessonAction, lessonRequest } from "./lesson-request";

export function LessonLibrary() {
	const router = useRouter();
	const [lessons, setLessons] = useState<VideoLessonSummary[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [title, setTitle] = useState("");
	const [problem, setProblem] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		void lessonRequest<{ lessons: VideoLessonSummary[] }>("/api/lessons", { signal: controller.signal }).then(
			({ lessons }) => { if (!controller.signal.aborted) setLessons(lessons); },
			(error: unknown) => { if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Could not load video lessons."); },
		);
		return () => controller.abort();
	}, []);

	async function create(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (saving || !title.trim() || !problem.trim()) return;
		setSaving(true);
		setSaveError(null);
		try {
			const { lesson } = await lessonRequest<{ lesson: VideoLesson }>("/api/lessons", lessonAction({ title: title.trim(), problem: problem.trim() }));
			router.push(`/lessons/${encodeURIComponent(lesson.id)}`);
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : "Could not create the video lesson.");
			setSaving(false);
		}
	}

	return (
		<div className="flex h-dvh min-h-0 flex-col">
			<TopBar><h1 className="truncate font-title text-3xl tracking-tight">Video lessons</h1></TopBar>
			<main className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto grid max-w-[68rem] gap-8 px-4 py-6 md:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
					<section aria-label="New video lesson" className="min-w-0 space-y-4">
						<h2 className="font-title text-2xl tracking-tight">New video lesson</h2>
						<form className="space-y-4" onSubmit={event => void create(event)}>
							<label className="block space-y-1.5 text-sm font-medium">
								<span>Title</span>
								<Input name="title" required maxLength={160} value={title} onChange={event => setTitle(event.currentTarget.value)} />
							</label>
							<label className="block space-y-1.5 text-sm font-medium">
								<span>Problem</span>
								<Textarea name="problem" required maxLength={8000} rows={5} className="min-h-28 font-prose" value={problem} onChange={event => setProblem(event.currentTarget.value)} />
							</label>
							{saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
							<Button type="submit" disabled={saving || !title.trim() || !problem.trim()}><FilmIcon className="size-4" aria-hidden="true" />{saving ? "Creating…" : "Create video task"}</Button>
						</form>
					</section>
					<section aria-label="Saved video lessons" className="min-w-0 space-y-4">
						<h2 className="font-title text-2xl tracking-tight">Saved lessons</h2>
						{loadError ? <p role="alert" className="text-sm text-destructive">{loadError}</p> : lessons === null ? <BrailleSpinner label="Loading lessons" /> : lessons.length === 0 ? (
							<p className="text-sm text-muted-foreground">Your video lessons will appear here.</p>
						) : (
							<ul className="divide-y divide-border rounded-lg border border-border">
								{lessons.map(lesson => (
									<li key={lesson.id}>
										<Link href={`/lessons/${encodeURIComponent(lesson.id)}`} className="flex items-center gap-3 px-3 py-3 hover:bg-accent/50">
											<FilmIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
											<span className="min-w-0 flex-1 truncate font-prose font-medium">{lesson.title}</span>
											<span className="shrink-0 font-ui text-xs text-muted-foreground">{lesson.hasVideo ? "Ready" : "Video pending"}</span>
										</Link>
									</li>
								))}
							</ul>
						)}
					</section>
				</div>
			</main>
		</div>
	);
}
