/** Multipart transport for the application's knowledge-graph importer. */
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data.ts";
import { MAX_IMPORT_BODY_BYTES } from "@/lib/notes-import-limits.ts";
import { importGraphNotes } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	let form: FormData;
	try {
		form = await readBoundedFormData(request, MAX_IMPORT_BODY_BYTES);
	} catch (err) {
		const oversized = err instanceof FormBodyLimitError;
		return Response.json({ results: [], error: oversized
			? "Import request is too large. Select fewer files."
			: "Could not read the upload. It may be incomplete; please select the files again." }, { status: oversized ? 413 : 400 });
	}
	const files = form.getAll("files").filter((f): f is File => f instanceof File);
	return importGraphNotes(files, form.getAll("paths"));
}
