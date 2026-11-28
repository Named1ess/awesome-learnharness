import { notionMcpCallbackResponse } from "@/src/server";

export const runtime = "nodejs";

export function GET(request: Request) { return notionMcpCallbackResponse(request); }
