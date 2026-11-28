"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { McpSettings, McpSetup } from "@/src/core";
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSegmentedControl, Toggle } from "./controls";
import { OutboundMcpSettings } from "./outbound-mcp";
import { NotionMcpSettings } from "./notion-mcp";

const CLIENTS = [
	{ value: "codex", label: "Codex" },
	{ value: "claude", label: "Claude Desktop" },
] as const;
type McpClient = typeof CLIENTS[number]["value"];

const nullableString = (value: unknown) => value === null || typeof value === "string";

function isMcpSetup(value: unknown): value is McpSetup {
	if (typeof value !== "object" || value === null) return false;
	const { settings, settingsError, status } = value as Partial<McpSetup>;
	return Boolean(settings && typeof settings.allowWrites === "boolean" &&
		typeof settings.allowClientReasoning === "boolean" && nullableString(settings.filesDirectory) &&
		(settingsError === undefined || typeof settingsError === "string") &&
		status && typeof status.sourceMode === "boolean" && typeof status.tokenConfigured === "boolean" &&
		nullableString(status.filesDirectory) && typeof status.filesAvailable === "boolean" &&
		typeof status.dataDirectory === "string" && typeof status.nodeCommand === "string" &&
		nullableString(status.scriptPath) && nullableString(status.appUrl));
}

async function fetchSetup(init?: RequestInit): Promise<McpSetup> {
	const response = await fetch("/api/mcp/settings", { cache: "no-store", ...init });
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const error = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : null;
		throw new Error(error ?? "Could not load or save MCP settings.");
	}
	if (!isMcpSetup(body)) throw new Error("The app returned an invalid MCP setup response.");
	return body;
}

// A save belongs to the local app even if its settings tab closes. A newly
// mounted tab must wait for that write before reading the saved settings.
let pendingWrite: Promise<McpSetup> | null = null;

function canGenerateWriteConfig({ settings, status, settingsError }: McpSetup): boolean {
	return !settingsError && settings.allowWrites && status.sourceMode && status.tokenConfigured && Boolean(status.appUrl);
}

function clientConfig(setup: McpSetup, client: McpClient): string {
	const { settings, status } = setup;
	const args = [status.scriptPath ?? "/path/to/LearnHarness/scripts/learnharness-mcp.mjs", "--data-dir", status.dataDirectory];
	const writes = canGenerateWriteConfig(setup);
	if (writes) {
		args.push("--app-url", status.appUrl!);
		if (settings.allowClientReasoning) args.push("--client-reasoning");
	}
	if (client === "claude") {
		return JSON.stringify({ mcpServers: { learnharness: {
			command: status.nodeCommand, args,
			...(writes ? { env: { LH_MCP_WRITE_TOKEN: "YOUR_LOCAL_MCP_WRITE_TOKEN" } } : {}),
		} } }, null, 2);
	}
	return [
		"[mcp_servers.learnharness]",
		`command = ${JSON.stringify(status.nodeCommand)}`,
		"args = [" + args.map(arg => JSON.stringify(arg)).join(", ") + "]",
		...(writes ? ['env_vars = ["LH_MCP_WRITE_TOKEN"]'] : []),
	].join("\n");
}

function writeStatus(setup: McpSetup): string {
	const { settings, status } = setup;
	if (!status.sourceMode) return "Read only on this host";
	if (setup.settingsError) return "MCP settings need repair";
	if (!settings.allowWrites) return "Off";
	if (!status.tokenConfigured) return "Launcher token required";
	if (!status.appUrl) return "Open LearnHarness on localhost to configure writes";
	return "Ready";
}

export function McpSection() {
	const folderId = useId();
	const folderHintId = useId();
	const configId = useId();
	const [setup, setSetup] = useState<McpSetup | null>(null);
	const [edits, setEdits] = useState<Partial<McpSettings>>({});
	const [client, setClient] = useState<McpClient>("codex");
	const [action, setAction] = useState<"checking" | "saving" | null>("checking");
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
	const read = useRef<AbortController | null>(null);
	const mounted = useRef(false);

	const check = useCallback(async () => {
		read.current?.abort();
		const request = new AbortController();
		read.current = request;
		setAction("checking");
		setError(null);
		setSaved(false);
		setCopyFeedback(null);
		try {
			await pendingWrite?.catch(() => undefined);
			if (request.signal.aborted) return;
			const next = await fetchSetup({ signal: request.signal });
			if (!request.signal.aborted) setSetup(next);
		} catch (failure) {
			if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not check MCP setup.");
		} finally {
			if (!request.signal.aborted) setAction(null);
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void check();
		return () => {
			mounted.current = false;
			read.current?.abort();
		};
	}, [check]);

	const draft = setup ? { ...setup.settings, ...edits } : null;
	const disabled = action !== null || !setup?.status.sourceMode;

	function edit(next: Partial<McpSettings>) {
		setEdits(current => ({ ...current, ...next }));
		setSaved(false);
		setError(null);
	}

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!draft || disabled || pendingWrite) return;
		setAction("saving");
		setError(null);
		setSaved(false);
		setCopyFeedback(null);
		const write = fetchSetup({
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...draft, filesDirectory: draft.filesDirectory?.trim() || null }),
		});
		pendingWrite = write;
		try {
			const next = await write;
			if (!mounted.current) return;
			setSetup(next);
			setEdits({});
			setSaved(true);
		} catch (failure) {
			if (mounted.current) setError(failure instanceof Error ? failure.message : "Could not save MCP settings.");
		} finally {
			if (pendingWrite === write) pendingWrite = null;
			if (mounted.current) setAction(null);
		}
	}

	const snippet = setup ? clientConfig(setup, client) : "";
	async function copyConfig() {
		try {
			await navigator.clipboard.writeText(snippet);
			if (mounted.current) setCopyFeedback("Configuration copied.");
		} catch {
			if (mounted.current) setCopyFeedback("Could not copy automatically. Select the configuration text to copy it.");
		}
	}

	return <SettingsSection title="MCP" testid="section-mcp">
		<SettingsGroup label="Connection">
			<SettingsRow label="App-side setup" hint="Checks this LearnHarness instance. Configure and connect your MCP client separately.">
				<Button type="button" size="xs" variant="outline" data-testid="mcp-check-setup" disabled={action !== null} onClick={() => void check()}>
					{action === "checking" ? "Checking…" : "Check setup"}
				</Button>
			</SettingsRow>
			{setup && <>
				<SettingsRow label="Data directory"><span className="break-all text-right text-xs text-muted-foreground">{setup.status.dataDirectory}</span></SettingsRow>
				<SettingsRow label="Write bridge"><span className="max-w-xs text-right text-xs text-muted-foreground">{writeStatus(setup)}</span></SettingsRow>
				<SettingsRow label="Effective shared folder"
					hint={setup.status.filesDirectory && !setup.status.filesAvailable ? "This folder is unavailable." : undefined}>
					<span className="break-all text-right text-xs text-muted-foreground">{setup.status.filesDirectory ?? "Not configured"}</span>
				</SettingsRow>
			</>}
			{error && <p role="alert" className="text-xs text-error">{error}</p>}
			{setup?.settingsError && <p role="alert" className="text-xs text-error">{setup.settingsError}</p>}
		</SettingsGroup>
		{setup && draft && <>
			<SettingsGroup label="Access">
				<form onSubmit={save}>
					<SettingsRow label="Allow writes" hint="Allow authorized MCP clients to change this learning profile."
						dimmed={disabled}>
						<Toggle label="Allow writes" disabled={disabled} checked={draft.allowWrites}
							onChange={allowWrites => edit({ allowWrites })} />
					</SettingsRow>
					<SettingsRow label="Allow client reasoning" hint="Let an MCP client provide model responses to LearnHarness workflows."
						dimmed={disabled}>
						<Toggle label="Allow client reasoning" disabled={disabled}
							checked={draft.allowClientReasoning} onChange={allowClientReasoning => edit({ allowClientReasoning })} />
					</SettingsRow>
					<div className="mt-2 flex flex-col gap-1">
						<label htmlFor={folderId} className="font-prose text-(length:--lh-prose-size)">Shared files folder</label>
						<input id={folderId} data-testid="mcp-files-directory" type="text" aria-describedby={folderHintId}
							autoComplete="off" spellCheck={false} disabled={disabled} value={draft.filesDirectory ?? ""}
							onChange={event => edit({ filesDirectory: event.currentTarget.value })}
							className="w-full rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-xs disabled:opacity-50" />
						<p id={folderHintId} className="text-xs text-muted-foreground">
							Enter an absolute path within the launcher-approved folder. Leave this blank to use the launcher folder.
						</p>
					</div>
					<div className="mt-3 flex items-center justify-end gap-2">
						{saved && <span role="status" className="text-xs text-muted-foreground">Settings saved.</span>}
						<Button type="submit" size="xs" variant="outline" data-testid="mcp-save" disabled={disabled || (!setup.settingsError && !Object.keys(edits).length)}>
							{action === "saving" ? "Saving…" : "Save"}
						</Button>
					</div>
				</form>
			</SettingsGroup>
			<SettingsGroup label="Client configuration">
				<p className="text-xs text-muted-foreground">Add this example to your client configuration, then reconnect the client to refresh its tools.</p>
				{!setup.status.scriptPath && <p className="text-xs text-muted-foreground">Replace the example script path with one from a LearnHarness source checkout.</p>}
				{canGenerateWriteConfig(setup) && <p className="text-xs text-muted-foreground">
					Use the launcher’s <code>LH_MCP_WRITE_TOKEN</code> value in your client’s local environment or private configuration.
				</p>}
				<div className="flex flex-wrap items-center justify-between gap-2">
					<SettingsSegmentedControl label="MCP client" options={CLIENTS} value={client} testidPrefix="mcp-client"
						onChange={next => { setClient(next); setCopyFeedback(null); }} />
					<Button type="button" variant="outline" size="xs" data-testid="mcp-copy" onClick={() => void copyConfig()}>Copy configuration</Button>
				</div>
				<label htmlFor={configId} className="sr-only">Manual MCP configuration</label>
				<textarea id={configId} readOnly rows={client === "claude" ? 9 : 4} wrap="off" data-testid="mcp-snippet" value={snippet}
					className="w-full resize-y rounded-sm border border-border bg-background p-2 font-mono text-xs leading-relaxed" />
				{copyFeedback && <p role="status" className="text-xs text-muted-foreground">{copyFeedback}</p>}
			</SettingsGroup>
		</>}
		<OutboundMcpSettings />
		<NotionMcpSettings />
	</SettingsSection>;
}
