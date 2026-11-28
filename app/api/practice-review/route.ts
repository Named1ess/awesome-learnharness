import { getPluginHost, listPracticeReview, stores, type ProblemTypeResolver } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	let resolve: ProblemTypeResolver | undefined;
	try { resolve = (await getPluginHost()).resolveProblemType; } catch { /* unavailable plugins still have readable history */ }
	return Response.json({ items: listPracticeReview(stores.chatStore, resolve) });
}
