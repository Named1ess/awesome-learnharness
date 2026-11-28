import { serveLessonMedia } from "@/src/server";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return serveLessonMedia(request, id);
}

export const HEAD = GET;
