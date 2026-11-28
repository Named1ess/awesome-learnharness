"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { OutboundMcpServer, OutboundMcpTool } from "@/src/core";
import { SettingsGroup } from "./controls";

const endpoint = "/api/mcp/outbound";
const inputClass = "w-full rounded-sm border border-border bg-background px-2 py-1.5 text-xs disabled:opacity-50";

async function send<T>(signal: AbortSignal, body?: object): Promise<T> {
	const response = await fetch(endpoint, body ? {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
	} : { cache: "no-store", signal });
	const result = await response.json().catch(() => null);
	if (!response.ok || !result) throw new Error(typeof result?.error === "string" ? result.error : "Could not access outbound MCP settings.");
	return result;
}

export function OutboundMcpSettings() {
	const formId = useId();
	const request = useRef<AbortController | null>(null);
	const [servers, setServers] = useState<OutboundMcpServer[]>([]);
	const [tools, setTools] = useState<Record<string, OutboundMcpTool[]>>({});
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	async function run(work: (signal: AbortSignal) => Promise<void>) {
		if (request.current) return;
		const controller = new AbortController();
		request.current = controller;
		setBusy(true);
		setError("");
		setNotice("");
		try { await work(controller.signal); }
		catch (failure) {
			if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not access outbound MCP settings.");
		} finally {
			if (request.current === controller) request.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	useEffect(() => {
		void run(async signal => {
			const result = await send<{ servers: OutboundMcpServer[] }>(signal);
			if (!signal.aborted) setServers(Array.isArray(result.servers) ? result.servers : []);
		});
		return () => {
			request.current?.abort();
			request.current = null;
		};
	}, []);

	function add(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		void run(async signal => {
			const result = await send<{ server: OutboundMcpServer; tools: OutboundMcpTool[] }>(signal,
				{ action: "add", name, url, ...(token.trim() ? { token: token.trim() } : {}) });
			if (signal.aborted) return;
			setServers(current => current.some(server => server.id === result.server.id)
				? current.map(server => server.id === result.server.id ? result.server : server)
				: [...current, result.server]);
			setTools(current => ({ ...current, [result.server.id]: result.tools }));
			setName("");
			setUrl("");
			setToken("");
			setNotice("MCP server added.");
		});
	}

	function check(id: string) {
		void run(async signal => {
			const result = await send<{ tools: OutboundMcpTool[] }>(signal, { action: "check", id });
			if (signal.aborted) return;
			setTools(current => ({ ...current, [id]: result.tools }));
			setNotice("Connection verified.");
		});
	}

	function allow(server: OutboundMcpServer, name: string, checked: boolean) {
		void run(async signal => {
			const allowedTools = checked ? [...server.allowedTools, name] : server.allowedTools.filter(tool => tool !== name);
			const result = await send<{ server: OutboundMcpServer }>(signal, { action: "permissions", id: server.id, allowedTools });
			if (signal.aborted) return;
			setServers(current => current.map(item => item.id === server.id ? result.server : item));
			setNotice(checked ? "Tool enabled." : "Tool disabled.");
		});
	}

	function remove(id: string) {
		void run(async signal => {
			await send(signal, { action: "remove", id });
			if (signal.aborted) return;
			setServers(current => current.filter(server => server.id !== id));
			setTools(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
			setNotice("MCP server removed.");
		});
	}

	return <SettingsGroup label="Outbound servers" testid="mcp-outbound">
		<p className="text-xs text-muted-foreground">Connect a Streamable HTTP server and choose the tools LearnHarness may call.</p>
		{servers.map(server => {
			const discovered = tools[server.id];
			const toolsByName = new Map(discovered?.map(tool => [tool.name, tool]));
			const names = new Set([...toolsByName.keys(), ...server.allowedTools]);
			return <div key={server.id} className="space-y-2 rounded-sm border border-border p-3">
				<div className="flex flex-wrap items-start justify-between gap-2">
					<div className="min-w-0">
						<p className="text-sm font-medium">{server.name}</p>
						<p className="break-all font-mono text-xs text-muted-foreground">{server.url}</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => check(server.id)}>Check tools</Button>
						<Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => remove(server.id)}>Remove</Button>
					</div>
				</div>
				{names.size === 0 && <p className="text-xs text-muted-foreground">
					{discovered ? "This server returned no tools." : "No tools enabled. Check the server to see its tools."}
				</p>}
				{names.size > 0 && <fieldset disabled={busy} className="space-y-2 border-t border-border pt-2">
					<legend className="sr-only">Tools for {server.name}</legend>
					{[...names].map(name => {
						const tool = toolsByName.get(name);
						return <label key={name} className="flex cursor-pointer items-start gap-2 text-xs">
							<input type="checkbox" className="mt-0.5" checked={server.allowedTools.includes(name)}
								onChange={event => allow(server, name, event.currentTarget.checked)} />
							<span className="min-w-0">
								<code className="break-all">{name}</code>
								{tool && <span className="ml-2 text-muted-foreground">{tool.readOnlyHint ? "Read-only (reported)" : "May change data"}</span>}
								{tool?.description && <span className="mt-0.5 block break-words text-muted-foreground">{tool.description}</span>}
							</span>
						</label>;
					})}
				</fieldset>}
			</div>;
		})}
		<form onSubmit={add} className="space-y-2">
			<div className="grid gap-2 sm:grid-cols-2">
				<div>
					<label htmlFor={`${formId}-name`} className="mb-1 block text-xs">Server name</label>
					<input id={`${formId}-name`} className={inputClass} maxLength={80} required value={name}
						onChange={event => setName(event.currentTarget.value)} disabled={busy} />
				</div>
				<div>
					<label htmlFor={`${formId}-token`} className="mb-1 block text-xs">Bearer token (optional)</label>
					<input id={`${formId}-token`} className={inputClass} type="password" autoComplete="off" maxLength={4096}
						value={token} onChange={event => setToken(event.currentTarget.value)} disabled={busy} />
				</div>
			</div>
			<label htmlFor={`${formId}-url`} className="block text-xs">Server URL</label>
			<input id={`${formId}-url`} className={inputClass} type="url" autoComplete="off" maxLength={2048} required value={url}
				onChange={event => setUrl(event.currentTarget.value)} disabled={busy} placeholder="https://example.com/mcp" />
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs text-muted-foreground">HTTPS or localhost</span>
				<Button type="submit" variant="outline" size="xs" disabled={busy || !name.trim() || !url.trim()}>Connect and add</Button>
			</div>
		</form>
		{busy && <p role="status" className="text-xs text-muted-foreground">Updating outbound MCP settings…</p>}
		{notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
		{error && <p role="alert" className="text-xs text-error">{error}</p>}
	</SettingsGroup>;
}
