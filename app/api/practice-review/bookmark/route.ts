import { putPracticeBookmark, stores } from "@/src/server";

export function PUT(request: Request) {
	return putPracticeBookmark(request, stores.chatStore);
}
