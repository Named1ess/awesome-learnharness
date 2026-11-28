import { handleVideoLessonCaptions } from "@/src/server";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
	return handleVideoLessonCaptions((await context.params).id);
}
