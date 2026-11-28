import { apiRequestRefusal, browserOnlyMode, subscriptionRequestOrigin } from "./desktop-access.ts";
import { NotionConnectionError, finishNotionAuthorization, startNotionAuthorization } from "./notion-mcp-oauth.ts";
import { hasNotionConnection } from "./notion-mcp-store.ts";

const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i;
const COOKIE = "lh_notion_oauth";
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

export function notionMcpRequestOrigin(request: Request, env: Record<string, string | undefined> = process.env, callback = false): string | undefined {
	const origin = subscriptionRequestOrigin(request);
	const host = request.headers.get("host") ?? new URL(request.url).host;
	if (!browserOnlyMode(env) || !origin || !LOOPBACK.test(host) || apiRequestRefusal(request, env)) return;
	if (callback) return origin;
	const supplied = request.headers.get("origin");
	if ((request.method !== "GET" || supplied !== null) && supplied !== origin) return;
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return;
	if (request.headers.get("x-learnharness-notion") !== "1") return;
	return origin;
}

function failure(message: string, status: number) {
	return Response.json({ error: message }, { status, headers: HEADERS });
}

function cookie(value: string, maxAge: number, origin: string) {
	return `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/api/mcp/notion/callback; HttpOnly; SameSite=Lax${origin.startsWith("https:") ? "; Secure" : ""}`;
}

export function notionMcpStatusResponse(request: Request): Response {
	if (!notionMcpRequestOrigin(request)) return failure("Notion settings are available in the local LearnHarness web app.", 403);
	return Response.json({ available: process.platform === "win32", connected: hasNotionConnection() }, { headers: HEADERS });
}

export async function notionMcpConnectResponse(request: Request): Promise<Response> {
	const origin = notionMcpRequestOrigin(request);
	if (!origin || process.platform !== "win32") return failure("Notion can be connected from the local LearnHarness web app on Windows.", 403);
	try {
		const started = await startNotionAuthorization(origin);
		return Response.json({ authorizationUrl: started.authorizationUrl }, { headers: { ...HEADERS, "Set-Cookie": cookie(started.state, 600, origin) } });
	} catch (error) {
		return failure(error instanceof NotionConnectionError ? error.message : "Could not start Notion sign-in. Check that the local server can reach Notion and try again.", 502);
	}
}

export async function notionMcpCallbackResponse(request: Request): Promise<Response> {
	const origin = notionMcpRequestOrigin(request, process.env, true);
	if (!origin || process.platform !== "win32") return failure("Open Notion sign-in from LearnHarness.", 403);
	const stateCookie = request.headers.get("cookie")?.split(/;\s*/).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
	let success = false;
	let message = "You can now save lessons to Notion from LearnHarness.";
	try {
		await finishNotionAuthorization(origin, stateCookie, new URL(request.url).searchParams);
		success = true;
	} catch (error) {
		message = error instanceof NotionConnectionError ? error.message : "Could not complete Notion sign-in. Start it again in LearnHarness.";
	}
	const heading = success ? "Notion connected" : "Notion sign-in incomplete";
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${heading}</title></head><body><main><h1>${heading}</h1><p>${message.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p><a href="/">Return to LearnHarness</a></main></body></html>`, {
		status: success ? 200 : 400,
		headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'", "Set-Cookie": cookie("", 0, origin) },
	});
}
