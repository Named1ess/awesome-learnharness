import { handleOutboundMcpRequest } from "@/src/server";

export function GET(request: Request) {
	return handleOutboundMcpRequest(request);
}

export function POST(request: Request) {
	return handleOutboundMcpRequest(request);
}
