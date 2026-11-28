import { notionMcpStatusResponse } from "@/src/server";

export const runtime = "nodejs";

export function GET(request: Request) { return notionMcpStatusResponse(request); }
