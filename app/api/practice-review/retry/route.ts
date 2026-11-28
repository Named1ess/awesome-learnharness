import { handlePracticeRetry } from "@/src/server";

export function POST(request: Request) {
	return handlePracticeRetry(request);
}
