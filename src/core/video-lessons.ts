export interface VideoLessonSegment {
	startMs: number;
	endMs: number;
	label: string;
	narration: string;
	onScreen: string;
}

export interface VideoLessonVideo {
	projectId: string;
	versionId: string;
	durationMs: number;
	segments: VideoLessonSegment[];
}

export interface VideoLessonQuestion {
	id: string;
	versionId: string;
	timeMs: number;
	text: string;
	answer?: string;
}

export interface VideoLessonTask {
	id: string;
	lessonId: string;
	kind: "render" | "answer" | "notion";
	status: "pending" | "claimed" | "completed" | "failed";
	questionId?: string;
	error?: string;
}

export interface VideoLessonSummary {
	id: string;
	title: string;
	createdAt: string;
	hasVideo: boolean;
}

export interface VideoLesson {
	id: string;
	title: string;
	problem: string;
	createdAt: string;
	video?: VideoLessonVideo;
	questions: VideoLessonQuestion[];
	tasks: VideoLessonTask[];
	notionUrl?: string;
}

export type VideoLessonTaskResult =
	| (VideoLessonVideo & { kind: "video"; relativePath: string })
	| { kind: "answer"; answer: string }
	| { kind: "notion"; url: string }
	| { kind: "failure"; message: string };
