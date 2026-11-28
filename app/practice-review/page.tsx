import { PracticeReview } from "@/components/practice-review";

export default async function PracticeReviewPage({ searchParams }: {
	searchParams: Promise<{ session?: string | string[] }>;
}) {
	const { session } = await searchParams;
	const initialSession = typeof session === "string" ? session : "";
	return <PracticeReview key={initialSession} initialSession={initialSession} />;
}
