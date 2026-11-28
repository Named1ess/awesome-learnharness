"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRightIcon, BookmarkIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { practiceProblemHref, type PracticeReviewItem } from "@/src/core";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { practiceOutcomeColors, practiceOutcomeLabels } from "@/components/practice-cards";

const selectStyle = "max-w-full truncate rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground focus-visible:outline-2";

function problemKey(item: PracticeReviewItem) {
	return practiceProblemHref(item.chatId, item.messageId, item.contentIndex);
}

async function responseError(response: Response, fallback: string) {
	const body = await response.json().catch(() => null);
	return new Error(typeof body?.error === "string" ? body.error : fallback);
}

export function PracticeReview({ initialSession = "" }: { initialSession?: string }) {
	const router = useRouter();
	const [items, setItems] = useState<PracticeReviewItem[] | null>(null);
	const [session, setSession] = useState(initialSession);
	const [outcome, setOutcome] = useState("");
	const [savedOnly, setSavedOnly] = useState(false);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState<{ key: string; action: "bookmark" | "retry" } | null>(null);
	const request = useRef<AbortController | null>(null);
	const mutation = useRef<AbortController | null>(null);
	const retryIds = useRef(new Map<string, string>());

	const refresh = useCallback(async () => {
		if (mutation.current) return;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setLoading(true);
		setError("");
		try {
			const response = await fetch("/api/practice-review", { cache: "no-store", signal: controller.signal });
			if (!response.ok) throw await responseError(response, "Could not load practice review.");
			const data = await response.json();
			if (!controller.signal.aborted) setItems(data.items);
		} catch (reason) {
			if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load practice review.");
		} finally {
			if (!controller.signal.aborted) setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
		return () => { request.current?.abort(); mutation.current?.abort(); };
	}, [refresh]);

	async function update(item: PracticeReviewItem, action: "bookmark" | "retry") {
		if (mutation.current || loading) return;
		const key = problemKey(item);
		const controller = new AbortController();
		mutation.current = controller;
		setPending({ key, action });
		setError("");
		try {
			const target = { chatId: item.chatId, messageId: item.messageId, contentIndex: item.contentIndex };
			if (action === "bookmark") {
				const bookmarked = !item.bookmarked;
				const response = await fetch("/api/practice-review/bookmark", {
					method: "PUT", headers: { "Content-Type": "application/json" }, signal: controller.signal,
					body: JSON.stringify({ ...target, bookmarked }),
				});
				if (!response.ok) throw await responseError(response, "Could not update the bookmark.");
				if (!controller.signal.aborted) setItems(previous => previous?.map(row =>
					problemKey(row) === key ? { ...row, bookmarked } : row) ?? null);
			} else {
				// A lost response can follow a successful creation. Repeat that request with the same ID.
				const requestId = retryIds.current.get(key) ?? crypto.randomUUID();
				retryIds.current.set(key, requestId);
				const response = await fetch("/api/practice-review/retry", {
					method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
					body: JSON.stringify({ ...target, requestId }),
				});
				if (!response.ok) throw await responseError(response, "Could not start the retry.");
				const result = await response.json();
				if (typeof result.id !== "string" || !result.id) throw new Error("Could not open the retry session.");
				if (!controller.signal.aborted) router.push(`/chat/${encodeURIComponent(result.id)}`);
			}
		} catch (reason) {
			if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not update practice review.");
		} finally {
			mutation.current = null;
			if (!controller.signal.aborted) setPending(null);
		}
	}

	const sessions = new Map(items?.map(item => [item.chatId, item.chatTitle]));
	const categories = [...new Set(items?.map(item => item.outcome))];
	const filtered = items?.filter(item =>
		(!session || session === item.chatId) && (!outcome || outcome === item.outcome) && (!savedOnly || item.bookmarked));
	const busy = loading || !!pending;
	const filtersActive = !!(session || outcome || savedOnly);

	return (
		<main className="flex h-full min-h-0 flex-col bg-background">
			<TopBar><h1 className="text-sm font-medium">Practice review</h1></TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto max-w-3xl space-y-5 px-5 py-7 sm:px-8">
					<div className="flex flex-wrap items-end gap-3">
						<label className="grid min-w-0 max-w-full gap-1 text-xs text-muted-foreground">
							Session
							<select className={selectStyle} value={session} onChange={event => setSession(event.target.value)}>
								<option value="">All sessions</option>
								{session && !sessions.has(session) && <option value={session}>Selected session</option>}
								{[...sessions].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
							</select>
						</label>
						<label className="grid gap-1 text-xs text-muted-foreground">
							Outcome
							<select className={selectStyle} value={outcome} onChange={event => setOutcome(event.target.value)}>
								<option value="">All outcomes</option>
								{categories.map(value => <option key={value} value={value}>{practiceOutcomeLabels[value] ?? value}</option>)}
							</select>
						</label>
						<label className="flex h-9 items-center gap-2 text-sm">
							<input type="checkbox" checked={savedOnly} onChange={event => setSavedOnly(event.target.checked)} /> Bookmarked
						</label>
						<Button size="sm" variant="ghost" className="ml-auto" onClick={() => void refresh()} disabled={busy}>
							<RefreshCwIcon className="size-3.5" /> Refresh
						</Button>
					</div>
					{error && <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</p>}
					{loading && <p role="status" className="text-sm text-muted-foreground">Loading practice review…</p>}
					{filtered?.length === 0 && (
						<div className="space-y-3 rounded-xl border border-dashed p-7 text-center">
							<p className="text-sm text-muted-foreground">{filtersActive ? "No problems match these filters." : "No practice problems to review yet."}</p>
							{filtersActive ? <Button variant="outline" size="sm" onClick={() => {
								setSession(""); setOutcome(""); setSavedOnly(false);
							}}>Clear filters</Button> : <Button asChild variant="outline" size="sm"><Link href="/chat/new?mode=practice">Start practice</Link></Button>}
						</div>
					)}
					{filtered && filtered.length > 0 && (
						<ul className="space-y-3" aria-label="Practice problems">
							{filtered.map(item => {
								const href = problemKey(item);
								const itemPending = pending?.key === href ? pending.action : null;
								const date = new Date(item.updatedAt);
								return <li key={href} className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">
									<div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
										<StatusBadge text={practiceOutcomeLabels[item.outcome] ?? item.outcome} color={practiceOutcomeColors[item.outcome]} />
										<span className="min-w-0 flex-1 truncate" title={item.chatTitle}>{item.chatTitle}</span>
										{item.updatedAt > 0 && Number.isFinite(date.getTime()) && <time dateTime={date.toISOString()}>{date.toLocaleDateString()}</time>}
									</div>
									<div className="lh-prose overflow-x-auto text-[15px]"><ToolContentResponse>{item.statement}</ToolContentResponse></div>
									{item.verdict && <div className="lh-prose mt-3 text-sm text-muted-foreground"><ToolContentResponse>{item.verdict}</ToolContentResponse></div>}
									{(item.rung || item.missClass) && <div className="mt-2 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
										{item.rung && <span>Hint level · {item.rung}</span>}{item.missClass && <span>Miss · {item.missClass}</span>}
									</div>}
									<div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
										<Button asChild size="sm" variant="ghost"><Link prefetch={false} href={href}>Original problem <ArrowUpRightIcon /></Link></Button>
										<Button size="sm" variant="ghost" aria-pressed={item.bookmarked} disabled={busy} onClick={() => void update(item, "bookmark")}>
											<BookmarkIcon className={item.bookmarked ? "fill-current" : ""} /> {itemPending === "bookmark" ? "Saving…" : item.bookmarked ? "Bookmarked" : "Bookmark"}
										</Button>
										{item.retryable ? <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={() => void update(item, "retry")}>
											<RotateCcwIcon /> {itemPending === "retry" ? "Starting…" : "Practice again"}
										</Button> : <span className="ml-auto text-xs text-muted-foreground">Retry unavailable</span>}
									</div>
								</li>;
							})}
						</ul>
					)}
				</div>
			</div>
		</main>
	);
}
