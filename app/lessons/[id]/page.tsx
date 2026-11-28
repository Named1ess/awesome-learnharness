import { LessonWatch } from "@/components/lessons/lesson-watch";
import { notFound } from "next/navigation";

export default async function LessonPage({ params, searchParams }: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ t?: string | string[] }>;
}) {
	const [{ id }, { t }] = await Promise.all([params, searchParams]);
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) notFound();
	const initialTimeMs = typeof t === "string" && /^\d{1,15}$/.test(t) ? Number(t) : 0;
	return <LessonWatch key={id} lessonId={id} initialTimeMs={initialTimeMs} />;
}
