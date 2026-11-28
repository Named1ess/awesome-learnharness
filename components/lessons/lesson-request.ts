export async function lessonRequest<Result>(url: string, init?: RequestInit): Promise<Result> {
	const response = await fetch(url, { cache: "no-store", ...init });
	const body = await response.json() as Result & { error?: string };
	if (!response.ok) throw new Error(body.error ?? "Could not load the video lesson.");
	return body;
}

export function lessonAction(body: object): RequestInit {
	return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
