import { handleMcpAttachment, handleMcpWriteRequest, importGraphNotes } from "@/src/server";

export async function POST(request: Request): Promise<Response> {
	return handleMcpWriteRequest(request, { handleMcpAttachment, importGraphNotes });
}
