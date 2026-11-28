import { randomBytes } from "node:crypto";
import { auth, exchangeAuthorization, refreshAuthorization, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { readNotionConnection, writeNotionConnection } from "./notion-mcp-store.ts";

const ISSUER = "https://mcp.notion.com";
export const NOTION_MCP_URL = new URL("/mcp", ISSUER);
const RESOURCE_METADATA = new URL("/.well-known/oauth-protected-resource/mcp", ISSUER);
const CALLBACK_PATH = "/api/mcp/notion/callback";
const FLOW_MS = 10 * 60 * 1000;
const NOTION_PATHS = new Set(["/mcp", "/register", "/token", "/.well-known/oauth-authorization-server", RESOURCE_METADATA.pathname]);

interface OAuthFlow {
	state: string;
	redirectUrl: string;
	deadline: number;
	registration?: OAuthClientInformationMixed;
	verifier?: string;
	discovery?: OAuthDiscoveryState;
	authorizationUrl?: string;
}

const globals = globalThis as typeof globalThis & {
	learnHarnessNotion?: { flow?: OAuthFlow; queue: Promise<void> };
};
const runtime = globals.learnHarnessNotion ??= { queue: Promise.resolve() };

export class NotionConnectionError extends Error {}

export const fetchNotionMcp: FetchLike = async (input, init) => {
	const url = new URL(input);
	if (url.origin !== ISSUER || url.username || url.password || !NOTION_PATHS.has(url.pathname)) {
		throw new NotionConnectionError("Notion advertised an unexpected server address.");
	}
	const timeout = AbortSignal.timeout(30000);
	return fetch(url, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
};

const authorizationServices = { read: readNotionConnection, write: writeNotionConnection, fetch: fetchNotionMcp };

function exclusive<T>(run: () => Promise<T>): Promise<T> {
	const next = runtime.queue.then(run);
	runtime.queue = next.then(() => {}, () => {});
	return next;
}

function matchesIssuer(value: string | undefined): boolean {
	return value === ISSUER || value === `${ISSUER}/`;
}

function provider(flow: OAuthFlow): OAuthClientProvider {
	return {
		redirectUrl: flow.redirectUrl,
		clientMetadata: {
			client_name: "LearnHarness", redirect_uris: [flow.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
			token_endpoint_auth_method: "none", scope: "default",
		},
		state: () => flow.state,
		clientInformation: () => flow.registration,
		saveClientInformation: information => { flow.registration = information; },
		tokens: () => undefined,
		saveTokens: () => {},
		redirectToAuthorization: url => {
			if (url.origin !== ISSUER || url.pathname !== "/authorize") throw new NotionConnectionError("Notion sent an unexpected authorization address.");
			flow.authorizationUrl = url.href;
		},
		saveCodeVerifier: value => { flow.verifier = value; },
		codeVerifier: () => {
			if (!flow.verifier) throw new NotionConnectionError("Notion sign-in expired. Start it again in LearnHarness.");
			return flow.verifier;
		},
		discoveryState: () => flow.discovery,
		saveDiscoveryState: discovery => {
			const metadata = discovery.authorizationServerMetadata;
			if (!matchesIssuer(discovery.authorizationServerUrl) || !matchesIssuer(metadata?.issuer) ||
				!metadata?.code_challenge_methods_supported?.includes("S256") || discovery.resourceMetadata?.resource !== NOTION_MCP_URL.href) {
				throw new NotionConnectionError("Could not verify Notion's OAuth configuration.");
			}
			flow.discovery = discovery;
		},
	};
}

function expiresAt(tokens: OAuthTokens): number | undefined {
	return tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
}

export function startNotionAuthorization(origin: string, services = authorizationServices): Promise<{ state: string; authorizationUrl: string }> {
	return exclusive(async () => {
		const existing = await services.read();
		const redirectUrl = new URL(CALLBACK_PATH, origin).href;
		const flow: OAuthFlow = {
			redirectUrl, state: randomBytes(32).toString("base64url"), deadline: Date.now() + FLOW_MS,
			registration: existing?.redirectUrl === redirectUrl ? existing.registration : undefined,
		};
		await auth(provider(flow), { serverUrl: NOTION_MCP_URL, resourceMetadataUrl: RESOURCE_METADATA, fetchFn: services.fetch });
		if (!flow.authorizationUrl || !flow.registration) throw new NotionConnectionError("Notion did not provide a sign-in link.");
		if (!existing?.tokens && flow.registration !== existing?.registration) {
			await services.write({ redirectUrl, registration: flow.registration });
		}
		runtime.flow = flow;
		return { state: flow.state, authorizationUrl: flow.authorizationUrl };
	});
}

export async function finishNotionAuthorization(origin: string, stateCookie: string | undefined, params: URLSearchParams, services = authorizationServices): Promise<void> {
	const flow = runtime.flow;
	if (!flow || flow.deadline < Date.now() || flow.redirectUrl !== new URL(CALLBACK_PATH, origin).href ||
		stateCookie !== flow.state || params.getAll("state").length !== 1 || params.get("state") !== flow.state) {
		throw new NotionConnectionError("Notion sign-in expired or was opened in another browser. Start it again in LearnHarness.");
	}
	runtime.flow = undefined;
	if (params.has("error")) throw new NotionConnectionError("Notion sign-in was declined or the workspace blocked the connection.");
	const code = params.get("code");
	if (!code || params.getAll("code").length !== 1 || params.getAll("iss").length !== 1 || !matchesIssuer(params.get("iss") ?? undefined)) {
		throw new NotionConnectionError("Notion did not return a verifiable sign-in response. Start it again in LearnHarness.");
	}
	await exclusive(async () => {
		if (!flow.registration || !flow.verifier) throw new NotionConnectionError("Notion sign-in expired. Start it again in LearnHarness.");
		const tokens = await exchangeAuthorization(ISSUER, {
			metadata: flow.discovery?.authorizationServerMetadata, clientInformation: flow.registration,
			authorizationCode: code, codeVerifier: flow.verifier, redirectUri: flow.redirectUrl,
			resource: NOTION_MCP_URL, fetchFn: services.fetch,
		});
		if (!tokens.refresh_token) throw new NotionConnectionError("Notion did not return a renewable connection.");
		await services.write({ redirectUrl: flow.redirectUrl, registration: flow.registration, tokens: { ...tokens, issuer: ISSUER }, expiresAt: expiresAt(tokens) });
	});
}

/** Serialize rotation across requests. A stale 401 from an old access token
 * cannot refresh a grant a second time after another request rotated it. */
export function notionAccessToken(rejectedToken?: string): Promise<string> {
	return exclusive(async () => {
		const connection = await readNotionConnection();
		const tokens = connection?.tokens;
		if (!connection || !tokens || !matchesIssuer(tokens.issuer) || !matchesIssuer(connection.registration.issuer)) {
			throw new NotionConnectionError("Connect Notion in Settings before saving a lesson.");
		}
		if (tokens.access_token !== rejectedToken && (!connection.expiresAt || connection.expiresAt > Date.now() + 5 * 60 * 1000)) {
			return tokens.access_token;
		}
		try {
			if (!tokens.refresh_token) throw new InvalidGrantError("Missing Notion refresh token.");
			const next = await refreshAuthorization(ISSUER, {
				clientInformation: connection.registration, refreshToken: tokens.refresh_token,
				resource: NOTION_MCP_URL, fetchFn: fetchNotionMcp,
			});
			await writeNotionConnection({ ...connection, tokens: { ...next, issuer: ISSUER }, expiresAt: expiresAt(next) });
			return next.access_token;
		} catch (error) {
			if (!(error instanceof InvalidGrantError)) throw new NotionConnectionError("Could not refresh the Notion connection. Try again in a moment.");
			await writeNotionConnection({ ...connection, tokens: undefined, expiresAt: undefined });
			throw new NotionConnectionError("The Notion connection expired. Reconnect it in Settings and retry the save.");
		}
	});
}
