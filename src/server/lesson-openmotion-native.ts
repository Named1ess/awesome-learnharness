import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface LessonOpenMotionConnection {
	call(name: string, args: Record<string, unknown>): Promise<unknown>;
	readGuide(): Promise<string>;
	close(): Promise<void>;
}

export interface NarrationFile {
	text: string;
	filename: string;
}

const requiredTools = [
	"openmotion_create_project", "openmotion_get_project", "openmotion_open_preview",
	"openmotion_import_assets", "openmotion_edit_project", "openmotion_export_request",
];

const resources = [
	"openmotion://workflow/director/start",
	"openmotion://workflow/director/actions",
	"openmotion://workflow/production/native",
	"openmotion://engine/SKILL.md",
];

export async function connectLessonOpenMotion(signal: AbortSignal): Promise<LessonOpenMotionConnection> {
	const root = process.env.LOCALAPPDATA;
	if (process.platform !== "win32" || !root) throw new Error("Local video lessons require the Windows OpenMotion runtime.");
	const launcher = path.join(root, "openmotion", "runtime", "run-mcp.mjs");
	await access(launcher).catch(() => { throw new Error("The local OpenMotion runtime is unavailable."); });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [launcher],
		env: {
			OPENMOTION_TELEMETRY: "0",
			...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
		},
		stderr: "ignore",
	});
	const client = new Client({ name: "LearnHarness", version: "0.7.0" });
	const options = { signal, timeout: 60_000 };
	try {
		await client.connect(transport, options);
		const { tools } = await client.listTools({}, options);
		if (client.getServerVersion()?.name !== "openmotion" || requiredTools.some(name => !tools.some(tool => tool.name === name))) {
			throw new Error("The local OpenMotion runtime does not provide the video lesson tools.");
		}
		return {
			async call(name, args) {
				const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 600_000 });
				if (result.isError === true) {
					const structured = result.structuredContent as { error?: { message?: string } } | undefined;
					const message = structured?.error?.message;
					throw new Error(message ? `OpenMotion ${name} failed: ${message.slice(0, 700)}` : `OpenMotion ${name} failed.`);
				}
				return result.structuredContent;
			},
			async readGuide() {
				const guides = await Promise.all(resources.map(async uri => {
					const { contents } = await client.readResource({ uri }, options);
					const document = contents.find(row => row.uri === uri && "text" in row);
					if (!document || !("text" in document)) throw new Error("OpenMotion did not return its installed authoring guide.");
					const raw = document.text;
					const guide = document.mimeType === "application/json" ? (JSON.parse(raw) as { content?: unknown }).content : raw;
					if (typeof guide !== "string" || !guide.trim()) throw new Error("OpenMotion returned an empty authoring guide.");
					return guide;
				}));
				return guides.join("\n\n");
			},
			close: () => client.close(),
		};
	} catch (error) {
		await client.close().catch(() => {});
		throw error;
	}
}

// Pass learner text and file paths as UTF-8 JSON over stdin, outside PowerShell source.
const speechScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$utf8 = [System.Text.UTF8Encoding]::new($false)
$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)
$lines = ConvertFrom-Json -InputObject $reader.ReadToEnd()
$speech = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $voice = $speech.GetInstalledVoices() | Where-Object {
    $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'zh-CN'
  } | Select-Object -First 1
  if (!$voice) { throw 'Install a Simplified Chinese desktop speech voice in Windows.' }
  $speech.SelectVoice($voice.VoiceInfo.Name)
  foreach ($line in $lines) {
    $speech.SetOutputToWaveFile($line.filename)
    $speech.Speak([string]$line.text)
    $speech.SetOutputToNull()
  }
} finally { $speech.Dispose(); $reader.Dispose() }
`;

export function synthesizeLessonNarration(files: NarrationFile[], signal: AbortSignal): Promise<void> {
	const systemRoot = process.env.SystemRoot;
	if (process.platform !== "win32" || !systemRoot) throw new Error("Local narration requires Windows speech synthesis.");
	const command = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const encoded = Buffer.from(speechScript, "utf16le").toString("base64");
	return new Promise((resolve, reject) => {
		const child = execFile(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
			{ windowsHide: true, signal, timeout: 180_000 }, (error, _stdout, stderr) => {
				if (!error) return resolve();
				if (signal.aborted) return reject(signal.reason);
				const message = stderr.includes("Install a Simplified Chinese desktop speech voice")
					? "Install a Simplified Chinese desktop speech voice in Windows."
					: "Windows could not synthesize the local lesson narration.";
				reject(new Error(message, { cause: error }));
			});
		child.stdin?.on("error", () => {});
		child.stdin?.end(JSON.stringify(files), "utf8");
	});
}
