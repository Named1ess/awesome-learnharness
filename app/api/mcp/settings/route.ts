import { handleMcpSettingsRequest } from "@/src/server";

export function GET(request: Request) {
	return handleMcpSettingsRequest(request);
}

export function PUT(request: Request) {
	return handleMcpSettingsRequest(request);
}
