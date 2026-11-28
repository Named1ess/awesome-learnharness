import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream, lstatSync, renameSync, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PATHS } from "../../config.ts";
import { resolvePolicy } from "../agent/tools/file-access.ts";
import { checkedFile, isRelativeFile, isSingleLinkFile } from "./mcp-shared-file.ts";
import { readVideoLesson } from "./video-lessons.ts";

const LESSON_ID = /^lesson_[a-f0-9]{32}$/;
const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const VIDEO_HEADER_BYTES = 12;
const MEDIA_READ_POLICY = resolvePolicy({ restricted: false, folders: [] });

export class LessonMediaError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

async function mediaDirectory(create: boolean): Promise<string> {
	if (create) await mkdir(/* turbopackIgnore: true */ PATHS.data, { recursive: true });
	const profile = await realpath(/* turbopackIgnore: true */ PATHS.data);
	const directory = path.join(/* turbopackIgnore: true */ profile, "video-lesson-media");
	if (create) await mkdir(/* turbopackIgnore: true */ directory, { recursive: true });
	const stat = await lstat(/* turbopackIgnore: true */ directory);
	const resolved = await realpath(/* turbopackIgnore: true */ directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, resolved) !== "") throw new Error("Invalid lesson-media directory.");
	return directory;
}

function stableFile(before: Stats, after: Stats): boolean {
	return isSingleLinkFile(after) && before.dev === after.dev && before.ino === after.ino &&
		before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function openVideo(filename: string, expected: Stats): Promise<FileHandle> {
	const file = await open(/* turbopackIgnore: true */ filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await file.stat();
		if (stat.size > MAX_MEDIA_BYTES) throw new LessonMediaError(413, "Lesson videos can be up to 256 MiB.");
		if (!stableFile(expected, stat) || stat.size < VIDEO_HEADER_BYTES) throw new LessonMediaError(400, "The video must be a regular MP4 file.");
		const header = Buffer.alloc(VIDEO_HEADER_BYTES);
		const { bytesRead } = await file.read(header, 0, header.length, 0);
		const firstBoxSize = header.readUInt32BE(0);
		if (bytesRead !== header.length || header.toString("ascii", 4, 8) !== "ftyp" || firstBoxSize < VIDEO_HEADER_BYTES || firstBoxSize > stat.size) {
			throw new LessonMediaError(400, "Invalid lesson MP4 header.");
		}
		return file;
	} catch (error) {
		await file.close();
		throw error;
	}
}

async function digest(stream: Readable): Promise<string> {
	const hash = createHash("sha256");
	for await (const bytes of stream) hash.update(bytes);
	return hash.digest("hex");
}

/** Snapshot a scoped OpenMotion export into this profile. Each lesson ID owns
 * one immutable video. A replay with the same file is safe after a lost reply. */
export async function installLessonMedia(lessonId: string, root: string, relativePath: string): Promise<void> {
	if (!LESSON_ID.test(lessonId) || !path.isAbsolute(root) || !isRelativeFile(relativePath) || !/\.mp4$/i.test(relativePath)) {
		throw new LessonMediaError(400, "Expected a lesson ID and an MP4 path relative to the approved shared folder.");
	}
	const directory = await mediaDirectory(true);
	const destination = path.join(/* turbopackIgnore: true */ directory, `${lessonId}.mp4`);
	const temporary = path.join(/* turbopackIgnore: true */ directory, `.video-${randomUUID()}.tmp`);
	let source: Awaited<ReturnType<typeof checkedFile>>;
	let input: FileHandle;
	try {
		source = await checkedFile(root, relativePath, MEDIA_READ_POLICY);
		input = await openVideo(source.filename, source.stat);
	} catch (error) {
		if (error instanceof LessonMediaError) throw error;
		throw new LessonMediaError(400, "The lesson video is unavailable or outside the approved shared folder.");
	}
	try {
		await pipeline(
			input.createReadStream({ autoClose: false, start: 0, end: source.stat.size - 1 }),
			createWriteStream(/* turbopackIgnore: true */ temporary, { flags: "wx", mode: 0o600 }),
		);
		if (!stableFile(source.stat, await input.stat()) || (await lstat(/* turbopackIgnore: true */ temporary)).size !== source.stat.size) {
			throw new LessonMediaError(409, "The lesson video changed while it was being copied.");
		}
		// There is no asynchronous gap between the existence check and publish.
		// In the local app process, readers see a completed snapshot or no file.
		const existing = lstatSync(/* turbopackIgnore: true */ destination, { throwIfNoEntry: false });
		if (!existing) {
			renameSync(/* turbopackIgnore: true */ temporary, /* turbopackIgnore: true */ destination);
			return;
		}
		if (existing.size !== source.stat.size || !isSingleLinkFile(existing)) throw new LessonMediaError(409, "This lesson already owns a different video.");
		const current = await openVideo(destination, existing);
		const [prior, next] = await Promise.all([
			digest(current.createReadStream({ start: 0, end: existing.size - 1 })),
			digest(createReadStream(/* turbopackIgnore: true */ temporary)),
		]);
		if (prior !== next) throw new LessonMediaError(409, "This lesson already owns a different video.");
	} finally {
		await input.close();
		await rm(/* turbopackIgnore: true */ temporary, { force: true });
	}
}

function parseRange(header: string, size: number): { start: number; end: number } | undefined {
	const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
	if (!match || (!match[1] && !match[2])) return;
	const first = match[1];
	const last = match[2];
	const end = last ? Number(last) : size - 1;
	if (!first) return end > 0 ? { start: Math.max(0, size - end), end: size - 1 } : undefined;
	const start = Number(first);
	if (start >= size || end < start) return;
	return { start, end: Math.min(end, size - 1) };
}

type ReadLessonForMedia = (id: string) => { video?: unknown } | null;

/** Serve only an asset attached to a lesson in this profile. The browser never
 * supplies a filesystem path, and range responses allow seeking in long videos. */
export async function serveLessonMedia(request: Request, lessonId: string, readLesson: ReadLessonForMedia = readVideoLesson): Promise<Response> {
	const headers = new Headers({
		"Accept-Ranges": "bytes",
		"Cache-Control": "private, no-store",
		"Cross-Origin-Resource-Policy": "same-origin",
		"X-Content-Type-Options": "nosniff",
	});
	if (!LESSON_ID.test(lessonId) || !readLesson(lessonId)?.video) return new Response(null, { status: 404, headers });
	let file: FileHandle;
	let size: number;
	try {
		const directory = await mediaDirectory(false);
		const source = await checkedFile(directory, `${lessonId}.mp4`, MEDIA_READ_POLICY);
		file = await openVideo(source.filename, source.stat);
		size = source.stat.size;
	} catch {
		return new Response(null, { status: 404, headers });
	}
	const range = request.method === "GET" ? request.headers.get("Range") : null;
	const selection = range ? parseRange(range, size) : { start: 0, end: size - 1 };
	if (!selection) {
		await file.close();
		headers.set("Content-Range", `bytes */${size}`);
		return new Response(null, { status: 416, headers });
	}
	const { start, end } = selection;
	headers.set("Content-Type", "video/mp4");
	headers.set("Content-Length", String(end - start + 1));
	if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
	if (request.method === "HEAD") {
		await file.close();
		return new Response(null, { headers });
	}
	const stream = file.createReadStream({ start, end });
	const body = Readable.toWeb(stream, {
		strategy: { highWaterMark: stream.readableHighWaterMark, size: chunk => (chunk as Buffer).byteLength },
	});
	// Node and DOM declarations describe the same WHATWG stream differently.
	return new Response(body as unknown as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
}
