import { handleMcpAttachment, handleMcpClientOperation, handleMcpWriteRequest, importGraphNotes } from "@/src/server";

export async function POST(request: Request): Promise<Response> {
	return handleMcpWriteRequest(request, { handleMcpAttachment, handleMcpClientOperation, importGraphNotes });
}
