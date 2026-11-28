"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "./controls";

const HEADERS = { "x-learnharness-notion": "1" };

export function NotionMcpSettings() {
	const [status, setStatus] = useState<{ available: boolean; connected: boolean }>();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		const controller = new AbortController();
		void fetch("/api/mcp/notion", { cache: "no-store", headers: HEADERS, signal: controller.signal }).then(async response => {
			if (response.status === 403) { setStatus({ available: false, connected: false }); return; }
			if (!response.ok) throw new Error("Notion status is unavailable.");
			const data = await response.json();
			if (typeof data.available !== "boolean" || typeof data.connected !== "boolean") throw new Error("Notion status is unavailable.");
			setStatus(data);
		}).catch(() => { if (!controller.signal.aborted) setError("Could not check the Notion connection."); });
		return () => controller.abort();
	}, []);

	async function connect() {
		if (pending) return;
		setPending(true);
		setError("");
		try {
			const response = await fetch("/api/mcp/notion/connect", { method: "POST", headers: HEADERS });
			const data = await response.json();
			if (!response.ok || typeof data.authorizationUrl !== "string") throw new Error(data.error ?? "Could not start Notion sign-in.");
			const url = new URL(data.authorizationUrl);
			if (url.origin !== "https://mcp.notion.com" || url.pathname !== "/authorize") throw new Error("Notion sign-in address is unavailable.");
			window.location.assign(url.href);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not start Notion sign-in.");
			setPending(false);
		}
	}

	return <SettingsGroup label="Notion">
		<SettingsRow label="Notion workspace" hint={status?.available === false ? "Available in the local LearnHarness web app on Windows." : "Save lesson questions and answers in your private Notion pages."}>
			{status?.available && <Button type="button" size="xs" variant="outline" onClick={() => void connect()} disabled={pending}>
				{pending ? "Opening Notion…" : status.connected ? "Reconnect Notion" : "Connect Notion"}
			</Button>}
		</SettingsRow>
		{status?.connected && <p className="text-xs text-muted-foreground" role="status">Connected to Notion</p>}
		{error && <p className="text-xs text-error" role="alert">{error}</p>}
	</SettingsGroup>;
}
