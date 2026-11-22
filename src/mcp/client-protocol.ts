import { z } from "zod";
import { parseChatInput } from "../core/input-events.ts";
import { parseSideAskInput, SIDE_QUESTION_MAX_CHARS, SIDE_QUOTES_MAX } from "../core/side-chat.ts";
import { attachFileArguments, importFileArguments } from "./write-protocol.ts";

export const MCP_CLIENT_HEADER = "x-learnharness-mcp-client";
export const MCP_CLIENT_REQUEST_BYTES = 256 * 1024;

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const nonblank = z.string().refine(value => value.trim().length > 0, "Expected nonblank text");
const offset = z.int().nonnegative().optional();
const listPage = { offset, limit: z.int().min(1).max(100).optional() };
const session = z.strictObject({ session_id: identifier });
const request = { request_id: identifier };
const operation = z.strictObject({ operation_id: identifier });
const step = operation.extend({ step_id: identifier });

function checkNativeInput(parse: (input: unknown) => unknown) {
	return (input: unknown, ctx: z.RefinementCtx) => {
		try { parse(input); }
		catch (error) {
			ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid native input" });
		}
	};
}

const occurrence = z.strictObject({
	messageId: identifier, contentIndex: z.int().nonnegative(), toolCallId: nonblank, toolName: nonblank,
});
const images = z.array(z.strictObject({
	type: z.literal("image"), mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]), data: nonblank,
})).optional();
const answerImages = z.strictObject({ answer: images, thinking: images, readingThinking: images }).optional();
const answerData = z.strictObject({
	values: z.array(z.string()).optional(),
	dontKnow: z.boolean().optional(),
	other: z.string().optional(),
	text: z.string().optional(),
	thinking: z.string().optional(),
	readingThinking: z.string().optional(),
	images: answerImages,
	confidence: z.number().min(0).max(100).optional(),
});

const chatInput = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("text"), text: z.string(), images }),
	z.strictObject({ type: z.literal("answer"), toolCallId: nonblank, answer: answerData, occurrence: occurrence.optional() }),
	z.strictObject({ type: z.literal("continue") }),
	z.strictObject({ type: z.literal("retry") }),
	z.strictObject({ type: z.literal("retry-question"), messageId: identifier, contentIndex: z.int().nonnegative(), toolCallId: nonblank }),
	z.strictObject({ type: z.literal("thinking"), problemCallId: nonblank, text: z.string(), images, occurrence: occurrence.optional() }),
	z.strictObject({ type: z.literal("next") }),
	z.strictObject({
		type: z.literal("plugin-question-answer"), questionId: nonblank, occurrence, answer: z.json(),
		thinking: z.string().optional(), readingThinking: z.string().optional(), images: answerImages,
	}),
	z.strictObject({
		type: z.literal("plugin-problem-submission"), problemId: nonblank, occurrence, submission: z.json(), thinking: z.string().optional(),
		images: z.strictObject({ submission: images, thinking: images }).optional(),
	}),
]).superRefine(checkNativeInput(parseChatInput));

const sideInput = z.strictObject({
	threadId: identifier.optional(),
	anchor: z.strictObject({ messageId: identifier, partId: nonblank, blockIndex: z.int().nonnegative(), blockText: nonblank }).optional(),
	text: z.string().max(SIDE_QUESTION_MAX_CHARS).optional(),
	quotes: z.array(z.string()).max(SIDE_QUOTES_MAX).optional(),
	quoteCitations: z.array(z.string()).max(SIDE_QUOTES_MAX).optional(),
	working: z.string().max(SIDE_QUESTION_MAX_CHARS).optional(),
	retry: z.boolean().optional(),
}).superRefine(checkNativeInput(parseSideAskInput));

const organizationAction = z.discriminatedUnion("action", [
	z.strictObject({ action: z.literal("create-folder"), name: nonblank, parentId: nonblank.nullable() }),
	z.strictObject({ action: z.literal("rename-folder"), id: nonblank, name: nonblank }),
	z.strictObject({ action: z.literal("rename-source"), id: nonblank, name: nonblank }),
	z.strictObject({ action: z.literal("move"), kind: z.enum(["source", "folder"]), id: nonblank, parentId: nonblank.nullable() }),
]);

const inferenceReply = z.strictObject({
	text: z.string().optional(),
	tool_calls: z.array(z.strictObject({ name: nonblank, arguments: z.record(z.string(), z.json()) })).optional(),
}).refine(reply => !!reply.text?.trim() || !!reply.tool_calls?.length, "Provide nonblank text or at least one tool call");

export const mcpClientToolInputs = {
	create_session: z.strictObject({ title: z.string().optional(), kind: z.enum(["teach", "practice"]), proposition_ids: z.array(nonblank).max(64).optional() }),
	get_session_state: session,
	submit_session_input: session.extend({ input: chatInput, ...request }),
	list_side_threads: session.extend(listPage),
	read_side_thread: session.extend({ thread_id: identifier, offset }),
	ask_follow_up: session.extend({ input: sideInput, ...request }),
	extract_session_graph: session.extend(request),
	list_graph_sources: z.strictObject(listPage),
	update_graph_sources: z.strictObject({ action: organizationAction }),
	import_file: importFileArguments.extend(request),
	attach_file: attachFileArguments.extend({ ...request, session_id: identifier }),
	get_operation: operation,
	read_inference_step: step.extend({ offset }),
	submit_inference_step: step.extend({ reply: inferenceReply }),
	cancel_operation: operation,
};

export const mcpClientOperationSchema = z.discriminatedUnion("operation", [
	mcpClientToolInputs.create_session.extend({ operation: z.literal("create_session") }),
	mcpClientToolInputs.get_session_state.extend({ operation: z.literal("get_session_state") }),
	mcpClientToolInputs.submit_session_input.extend({ operation: z.literal("submit_session_input") }),
	mcpClientToolInputs.list_side_threads.extend({ operation: z.literal("list_side_threads") }),
	mcpClientToolInputs.read_side_thread.extend({ operation: z.literal("read_side_thread") }),
	mcpClientToolInputs.ask_follow_up.extend({ operation: z.literal("ask_follow_up") }),
	mcpClientToolInputs.extract_session_graph.extend({ operation: z.literal("extract_session_graph") }),
	mcpClientToolInputs.list_graph_sources.extend({ operation: z.literal("list_graph_sources") }),
	mcpClientToolInputs.update_graph_sources.extend({ operation: z.literal("update_graph_sources") }),
	mcpClientToolInputs.import_file.extend({ operation: z.literal("import_file") }),
	mcpClientToolInputs.attach_file.extend({ operation: z.literal("attach_file") }),
	mcpClientToolInputs.get_operation.extend({ operation: z.literal("get_operation") }),
	mcpClientToolInputs.read_inference_step.extend({ operation: z.literal("read_inference_step") }),
	mcpClientToolInputs.submit_inference_step.extend({ operation: z.literal("submit_inference_step") }),
	mcpClientToolInputs.cancel_operation.extend({ operation: z.literal("cancel_operation") }),
]);

export type McpClientOperation = z.infer<typeof mcpClientOperationSchema>;
