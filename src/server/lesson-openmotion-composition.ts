import { z } from "zod";
import type { VideoLessonSegment } from "../core/video-lessons.ts";

const scene = z.object({
	label: z.string().trim().min(1).max(36),
	narration: z.string().trim().min(1).max(520),
	onScreen: z.string().trim().min(1).max(120),
	steps: z.array(z.string().trim().min(1).max(42)).max(4),
});

export const lessonPlan = z.object({ scenes: z.array(scene).min(1).max(10) });
export type LessonPlan = z.infer<typeof lessonPlan>;

export const narrationAsset = z.object({
	path: z.string().regex(/^assets\/imported\/[a-zA-Z0-9._-]+$/),
	duration: z.number().positive().max(60 * 30),
});
export type NarrationAsset = z.infer<typeof narrationAsset>;

const fps = 24;
const quietFrames = 6;
const seconds = (frames: number) => (frames / fps).toFixed(9);
const milliseconds = (frames: number) => Math.round(frames * 1000 / fps);

function html(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function lessonComposition(title: string, plan: LessonPlan, assets: NarrationAsset[]) {
	let frame = 0;
	const segments: VideoLessonSegment[] = [];
	const scenes: Array<{ path: string; content: string }> = [];
	const clips = plan.scenes.map(({ label, onScreen, narration, steps }, index) => {
		const asset = assets[index];
		if (!asset) throw new Error("A scene is missing its measured local narration.");
		const { path, duration } = asset;
		const audioFrames = Math.ceil(duration * fps);
		const sceneFrames = Math.max(fps / 2, audioFrames + quietFrames);
		const startMs = milliseconds(frame);
		const endMs = milliseconds(frame + sceneFrames);
		segments.push({ startMs, endMs, label, narration, onScreen: [onScreen, ...steps].join("\n") });
		const sceneId = `scene-${index + 1}`;
		const when = seconds(frame);
		const reveal = steps.map((step, stepIndex) =>
			`<li data-hf-id="${sceneId}-step-${stepIndex}">${html(step)}</li>`).join("");
		const scenePath = `compositions/${sceneId}.html`;
		const durationSeconds = seconds(sceneFrames);
		scenes.push({ path: scenePath, content: `<template>
<section id="${sceneId}-content" class="scene" data-hf-id="${sceneId}-content" data-composition-id="${sceneId}" data-width="1280" data-height="720" data-duration="${durationSeconds}">
	<header data-hf-id="${sceneId}-header">${html(title)}</header>
	<p class="label" data-hf-id="${sceneId}-label">${html(label)}</p>
	<h1 data-hf-id="${sceneId}-headline" style="--text-length: ${onScreen.length}">${html(onScreen)}</h1>
	${steps.length ? `<ol data-hf-id="${sceneId}-steps">${reveal}</ol>` : ""}
</section>
<script>
const timeline = gsap.timeline({ paused: true });
timeline.fromTo("#${sceneId}-content h1", { opacity: .42, y: 14 }, { opacity: 1, y: 0, duration: .35 }, 0);
${steps.length ? `timeline.fromTo("#${sceneId}-content li", { opacity: .34, x: -12 }, { opacity: 1, x: 0, duration: .25, stagger: ${Math.min(0.36, (sceneFrames / fps - 0.35) / steps.length)} }, 0);` : ""}
window.__timelines = window.__timelines || {};
window.__timelines["${sceneId}"] = timeline;
</script>
</template>` });
		frame += sceneFrames;
		return `<div id="${sceneId}" class="clip" data-hf-id="${sceneId}" data-composition-id="${sceneId}" data-composition-src="${scenePath}" data-start="${when}" data-duration="${durationSeconds}" data-track-index="1" data-width="1280" data-height="720"></div>
<audio id="audio-${index}" class="clip" data-hf-id="audio-${index}" src="${html(path)}" data-start="${when}" data-duration="${seconds(audioFrames)}" data-track-index="2" data-volume="1"></audio>`;
	});
	if (milliseconds(frame) > 30 * 60 * 1000 || Buffer.byteLength(JSON.stringify(segments)) > 24 * 1024) {
		throw new Error("The generated lesson exceeds LearnHarness's video or timeline limit.");
	}

	const content = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${html(title)}</title>
<script src="assets/gsap.min.js"></script>
<style>
@font-face { font-family: "Microsoft YaHei"; src: local("Microsoft YaHei"); }
* { box-sizing: border-box; }
body { margin: 0; color: #f6f1e7; font-family: "Microsoft YaHei", sans-serif; }
#lesson { width: 1280px; height: 720px; position: relative; overflow: hidden; background: #111b2e; }
.scene { position: absolute; width: 100%; height: 100%; inset: 0; padding: 56px 94px; background: linear-gradient(152deg, #111b2e, #1f3346); }
header { color: #b3c7d8; font-size: 24px; line-height: 1.4; padding-bottom: 22px; border-bottom: 1px solid #446077; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.label { margin: 40px 0 16px; color: #f4c376; font-size: 25px; }
h1 { margin: 0; max-width: 1092px; line-height: 1.26; font-size: clamp(30px, calc(64px - 0.4px * var(--text-length, 0)), 54px); font-weight: 700; overflow-wrap: anywhere; }
ol { margin: 34px 0 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 15px; list-style: none; }
li { font-size: 24px; line-height: 1.3; margin: 0; padding: 13px 21px; border-left: 3px solid #f4c376; background: #1a2b40; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main id="lesson" data-hf-id="lesson" data-composition-id="lesson" data-start="0" data-duration="${seconds(frame)}" data-width="1280" data-height="720" data-fps="${fps}">
${clips.join("\n")}
</main>
<script>
window.__timelines = window.__timelines || {};
window.__timelines.lesson = gsap.timeline({ paused: true });
</script>
</body>
</html>`;
	return { durationMs: milliseconds(frame), segments, files: [{ path: "index.html", content }, ...scenes] };
}
