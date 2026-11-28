import { z } from "zod";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { createVideoLesson, listVideoLessons, mutateVideoLesson, nativeVideoLessonsEnabled, readVideoLesson, renderVideoLessonCaptions, VideoLessonError } from "./video-lessons.ts";

const noStore = { "Cache-Control": "no-store" };
const creation = z.strictObject({ title: z.string().trim().min(1).max(160), problem: z.string().trim().min(1).max(8000) });
const action = z.discriminatedUnion("action", [
	z.strictObject({ action: z.literal("ask"), versionId: z.string().min(1).max(128), timeMs: z.int().min(0), text: z.string().trim().min(1).max(3000) }),
	z.strictObject({ action: z.literal("save-notion"), questionId: z.string().regex(/^question_[a-f0-9]{32}$/) }),
	z.strictObject({ action: z.literal("retry"), taskId: z.string().regex(/^lesson_[a-f0-9]{32}_task_[a-f0-9]{32}$/) }),
]);

function errorResponse(error: unknown): Response {
	if (error instanceof VideoLessonError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
	if (error instanceof CustomBodyLimitError) return Response.json({ error: "The lesson request is too large." }, { status: 413, headers: noStore });
	if (error instanceof SyntaxError) return Response.json({ error: "Invalid lesson request JSON." }, { status: 400, headers: noStore });
	return Response.json({ error: "Could not access this video lesson." }, { status: 500, headers: noStore });
}

export async function handleVideoLessons(request: Request, id?: string): Promise<Response> {
	try {
		const execution = nativeVideoLessonsEnabled() ? "native" : "mcp";
		if (request.method === "GET") {
			if (!id) return Response.json(listVideoLessons(), { headers: noStore });
			const lesson = readVideoLesson(id);
			if (!lesson) throw new VideoLessonError(404, "Video lesson not found.");
			return Response.json({ lesson, execution }, { headers: noStore });
		}
		const body = await readBoundedJson(request, 64 * 1024);
		if (id) {
			const parsed = action.safeParse(body);
			if (!parsed.success) throw new VideoLessonError(400, "Invalid lesson action, video position, or question.");
			return Response.json({ lesson: mutateVideoLesson(id, parsed.data), execution }, { headers: noStore });
		}
		const parsed = creation.safeParse(body);
		if (!parsed.success) throw new VideoLessonError(400, "Enter a title and the original problem within their length limits.");
		return Response.json({ lesson: createVideoLesson(parsed.data) }, { status: 201, headers: noStore });
	} catch (error) {
		return errorResponse(error);
	}
}

export function handleVideoLessonCaptions(id: string): Response {
	try {
		return new Response(renderVideoLessonCaptions(id), { headers: { ...noStore, "Content-Type": "text/vtt; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
	} catch (error) {
		return errorResponse(error);
	}
}
