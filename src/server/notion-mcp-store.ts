import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { OAuthClientInformationSchema, OAuthTokensSchema, type OAuthClientInformationMixed, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { PATHS } from "../../config.ts";

export interface NotionConnection {
	redirectUrl: string;
	registration: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	expiresAt?: number;
}

const credentialFile = path.join(/* turbopackIgnore: true */ PATHS.data, "notion-mcp.dpapi");

export function hasNotionConnection(): boolean {
	if (process.platform !== "win32") return false;
	try { return readFileSync(/* turbopackIgnore: true */ credentialFile, "utf8").startsWith("connected\n"); }
	catch { return false; }
}

/** Windows DPAPI runs with this server's Windows user. Neither command-line
 * arguments nor temporary files contain the plaintext supplied over stdin. */
export async function windowsNotionCredentialProtection(operation: "Protect" | "Unprotect", value: string): Promise<string> {
	if (process.platform !== "win32") throw new Error("Notion credential storage requires Windows.");
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName System.Security",
		"$inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())",
		`$outputBytes = [Security.Cryptography.ProtectedData]::${operation}($inputBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
		"[Console]::Out.Write([Convert]::ToBase64String($outputBytes))",
	].join("\n");
	const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
	const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return new Promise((resolve, reject) => {
		const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
			stdio: ["pipe", "pipe", "ignore"], windowsHide: true, signal: AbortSignal.timeout(15000),
		});
		let output = "";
		const failed = () => reject(new Error("Windows could not access the protected Notion credentials."));
		child.stdout.setEncoding("ascii");
		child.stdout.on("data", (chunk: string) => { output += chunk; });
		child.once("error", failed);
		child.stdin.once("error", failed);
		child.once("close", code => {
			if (code !== 0 || !output || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) return failed();
			resolve(operation === "Protect" ? output : Buffer.from(output, "base64").toString("utf8"));
		});
		child.stdin.end(operation === "Protect" ? Buffer.from(value, "utf8").toString("base64") : value);
	});
}

export async function readNotionConnection(): Promise<NotionConnection | undefined> {
	let encrypted: string;
	try { encrypted = await readFile(/* turbopackIgnore: true */ credentialFile, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	const separator = encrypted.indexOf("\n");
	if (separator === -1) throw new Error("Stored Notion connection is invalid.");
	const value = JSON.parse(await windowsNotionCredentialProtection("Unprotect", encrypted.slice(separator + 1)));
	if (typeof value?.redirectUrl !== "string") throw new Error("Stored Notion connection is invalid.");
	return {
		redirectUrl: value.redirectUrl,
		registration: OAuthClientInformationSchema.passthrough().parse(value.registration),
		tokens: value.tokens === undefined ? undefined : OAuthTokensSchema.parse(value.tokens),
		expiresAt: typeof value.expiresAt === "number" ? value.expiresAt : undefined,
	};
}

export async function writeNotionConnection(connection: NotionConnection): Promise<void> {
	const encrypted = await windowsNotionCredentialProtection("Protect", JSON.stringify(connection));
	await atomicNotionWrite(credentialFile, `${connection.tokens ? "connected" : "registered"}\n${encrypted}`);
}

export async function atomicNotionWrite(file: string, content: string): Promise<void> {
	await mkdir(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(/* turbopackIgnore: true */ temp, content, { flag: "wx", mode: 0o600, flush: true });
		await rename(/* turbopackIgnore: true */ temp, /* turbopackIgnore: true */ file);
	} finally { await rm(/* turbopackIgnore: true */ temp, { force: true }); }
}
