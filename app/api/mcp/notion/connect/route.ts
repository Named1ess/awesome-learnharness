import { notionMcpConnectResponse } from "@/src/server";

export const runtime = "nodejs";

export function POST(request: Request) { return notionMcpConnectResponse(request); }
