import { handleVideoLessons } from "@/src/server";

export function GET(request: Request) { return handleVideoLessons(request); }
export function POST(request: Request) { return handleVideoLessons(request); }
