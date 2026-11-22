import { createHash } from "node:crypto";
import { ChatInputError, parseChatInput, type ChatInput } from "../core/input-events.ts";
import {
	activeProblemOccurrenceOf, activeProblemOf, hasProbeDone, pendingPluginQuestionOf, pendingQuestionOf, type GraphContextPick,
} from "../core/native-messages.ts";
import { openQuestionMarkdown, parseSideAskInput, sideEntryPoints, sideSegmentId, SideChatInputError } from "../core/side-chat.ts";
import { toolQuestionKind } from "../core/pending.ts";
import { validatePluginBuiltinSubmissionAnswer } from "../core/plugin-submissions.ts";
import { buildAnswer, questionDataFromInput, toClientQuestion } from "../core/question-core.ts";
import { parseQuestionInput } from "../core/tool-parts.ts";
import { projectView } from "../core/view.ts";
import type { McpClientOperation } from "../mcp/client-protocol.ts";
import { handleChatInput } from "./chat-handler.ts";
import { createChatSession } from "./chats.ts";
import { compactionInFlight } from "./compaction.ts";
import { mcpExtractSessionGraph, mcpGraphSources, mcpUpdateGraphSources, McpGraphExtractionError } from "./mcp-graph-operations.ts";
import { ClientInferenceError, clientInferenceBroker, isClientInferenceError } from "./mcp-inference.ts";
import { sideChats } from "./side-chat.ts";
import { SourceOrganizationInputError } from "./source-organization.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

function requireSession(sessionId: string) {
	const record = stores.chatStore.getChat(sessionId);
	if (!record) throw new ClientInferenceError("Unknown chat.", 404);
	return record;
}

function sessionState(sessionId: string) {
	const { messages, kind = "teach", id, title } = requireSession(sessionId);
	const question = pendingQuestionOf(messages);
	const questionInput = question ? parseQuestionInput(question.tool, question.input) : undefined;
	const pluginQuestion = pendingPluginQuestionOf(messages);
	const problem = activeProblemOf(messages);
	const statement = (problem?.input as { statement?: unknown } | undefined)?.statement;
	const sideSegments = [...sideEntryPoints(messages, projectView(messages)).values()].flatMap(entries => [...entries.values()]);
	const lastSegment = sideSegments.at(-1);
	return {
		session_id: id, title, kind,
		phase: kind === "practice" ? "practice" : hasProbeDone(messages) ? "teach" : "probe",
		running: isTurnRunning(id), compacting: compactionInFlight(id),
		pending_question: pluginQuestion ? {
			type: "plugin", question_id: pluginQuestion.questionId, occurrence: pluginQuestion.occurrence,
			prompt: pluginQuestion.input.question,
		} : question ? {
			type: "native", tool: question.tool, tool_call_id: question.toolCallId,
			occurrence: { messageId: question.messageId, contentIndex: question.contentIndex, toolCallId: question.toolCallId, toolName: question.tool },
			prompt: openQuestionMarkdown(question.tool, question.input, question.toolCallId),
			question: questionInput ? toClientQuestion(questionDataFromInput(question.toolCallId, toolQuestionKind(question.tool), questionInput)) : null,
		} : null,
		active_problem: problem ? {
			tool_call_id: problem.toolCallId, occurrence: activeProblemOccurrenceOf(messages),
			statement: typeof statement === "string" ? statement : null,
			...(problem.pluginProblem ? { problem_id: problem.pluginProblem.problemId } : {}),
		} : null,
		latest_side_anchor: lastSegment ? {
			messageId: lastSegment, partId: lastSegment + "-t0", blockIndex: 0, blockText: "This teaching segment and its associated question.",
		} : null,
	};
}

function sessionInput({ input, session_id }: Extract<McpClientOperation, { operation: "submit_session_input" }>): ChatInput {
	if (input.type !== "answer") return parseChatInput(input);
	const pending = pendingQuestionOf(requireSession(session_id).messages);
	const parsed = pending && parseQuestionInput(pending.tool, pending.input);
	if (!pending || !parsed || pending.toolCallId !== input.toolCallId) {
		throw new ClientInferenceError("The learner answer does not match the pending question.", 409);
	}
	const question = questionDataFromInput(pending.toolCallId, toolQuestionKind(pending.tool), parsed);
	try {
		const raw = validatePluginBuiltinSubmissionAnswer(question, { ...input.answer, images: input.answer.images?.answer ?? [] });
		const answer = buildAnswer(question, { ...raw, thinking: input.answer.thinking, readingThinking: input.answer.readingThinking }, pending.tool);
		return parseChatInput({ ...input, answer: { ...answer, images: input.answer.images } });
	} catch (error) {
		throw new ChatInputError(error instanceof Error ? error.message : "Invalid learner answer.");
	}
}

function createSession(operation: Extract<McpClientOperation, { operation: "create_session" }>) {
	const picks: GraphContextPick[] = [];
	const ids = [...new Set(operation.proposition_ids ?? [])];
	if (ids.length) {
		const nodes = new Map(stores.graphStore.readNodes().map(node => [node.id, node]));
		for (const id of ids) {
			const node = nodes.get(id);
			if (!node) throw new ClientInferenceError("Unknown graph proposition: " + id, 404);
			picks.push({ id, name: node.name, statement: node.statement });
		}
	}
	return createChatSession(operation.title ?? "", operation.kind, picks, false);
}

async function jsonResult(response: Response): Promise<unknown> {
	const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
	if (!response.ok) {
		throw new ClientInferenceError(typeof body?.error === "string" ? body.error : "The native operation was refused.", response.status);
	}
	return body;
}

function start(
	operation: Extract<McpClientOperation, { request_id: string }>,
	chatId: string | undefined,
	work: () => Promise<unknown>,
	filesDirectory?: string,
) {
	const hash = createHash("sha256").update(JSON.stringify(operation)).digest("hex");
	return clientInferenceBroker.start(operation.request_id, hash, chatId, work, filesDirectory);
}

async function ask(operation: Extract<McpClientOperation, { operation: "ask_follow_up" }>) {
	const input = parseSideAskInput(operation.input);
	const chat = requireSession(operation.session_id);
	const segment = input.anchor ? sideSegmentId(chat.messages, input.anchor.messageId) : null;
	const response = await sideChats.ask(operation.session_id, { ...input, requestId: operation.request_id });
	if (!response.ok) return jsonResult(response);
	// The stream is a browser view; closing it leaves the already tracked answer running.
	await response.body?.cancel();
	const threadId = input.threadId ?? (segment ? "side_" + segment : undefined);
	return { session_id: operation.session_id, thread_id: threadId };
}

function listSideThreads(sessionId: string, offset: number, limit: number) {
	const view = sideChats.list(sessionId);
	if (!view) throw new ClientInferenceError("Unknown chat.", 404);
	const threads = view.threads.slice(offset, offset + limit).map(thread => {
		const last = thread.messages.at(-1);
		return {
			id: thread.id, anchor: { ...thread.anchor, blockText: thread.anchor.blockText.slice(0, 2_000) }, open: thread.open,
			answering: Boolean(view.answering[thread.id]),
			last_message: last ? { role: last.role, text: last.text.slice(0, 2_000), at: last.at, truncated: last.text.length > 2_000 } : null,
		};
	});
	let size = 0;
	let count = 0;
	for (const thread of threads) {
		size += Buffer.byteLength(JSON.stringify(thread));
		if (size > 32 * 1024) break;
		count++;
	}
	if (threads.length && !count) throw new ClientInferenceError("A side thread exceeds the page limit. Continue at the following offset.", 413);
	return { items: threads.slice(0, count), next_offset: offset + count < view.threads.length ? offset + count : null };
}

function readSideThread(sessionId: string, threadId: string, offset: number) {
	const thread = requireSession(sessionId).sideChats?.find(item => item.id === threadId);
	if (!thread) throw new ClientInferenceError("Unknown side conversation.", 404);
	const transcript = JSON.stringify(thread.messages);
	if (offset > transcript.length) throw new ClientInferenceError("Invalid transcript offset.", 400);
	let end = Math.min(offset + 12_000, transcript.length);
	const tail = transcript.charCodeAt(end - 1);
	if (end < transcript.length && tail >= 0xd800 && tail <= 0xdbff) end--;
	return { thread_id: thread.id, transcript: transcript.slice(offset, end), next_offset: end < transcript.length ? end : null };
}

export async function handleMcpClientOperation(operation: McpClientOperation, fileOperation: () => Promise<Response>, filesDirectory?: string): Promise<Response> {
	try {
		let result: unknown;
		switch (operation.operation) {
			case "create_session": result = createSession(operation); break;
			case "get_session_state": result = sessionState(operation.session_id); break;
			case "submit_session_input": {
				result = start(operation, operation.session_id, async () => jsonResult(await handleChatInput(operation.session_id, sessionInput(operation))), filesDirectory);
				break;
			}
			case "list_side_threads": result = listSideThreads(operation.session_id, operation.offset ?? 0, operation.limit ?? 25); break;
			case "read_side_thread": result = readSideThread(operation.session_id, operation.thread_id, operation.offset ?? 0); break;
			case "ask_follow_up": result = start(operation, undefined, () => ask(operation), filesDirectory); break;
			case "extract_session_graph": result = start(operation, undefined, () => mcpExtractSessionGraph(operation.session_id), filesDirectory); break;
			case "list_graph_sources": result = mcpGraphSources(operation.offset ?? 0, operation.limit ?? 25); break;
			case "update_graph_sources": result = mcpUpdateGraphSources(operation.action); break;
			case "import_file": case "attach_file":
				result = start(operation, operation.operation === "attach_file" ? operation.session_id : undefined, async () => jsonResult(await fileOperation()), filesDirectory);
				break;
			case "get_operation": result = clientInferenceBroker.status(operation.operation_id); break;
			case "read_inference_step": result = clientInferenceBroker.read(operation.operation_id, operation.step_id, operation.offset ?? 0); break;
			case "submit_inference_step": result = clientInferenceBroker.submit(operation.operation_id, operation.step_id, operation.reply); break;
			case "cancel_operation": result = clientInferenceBroker.cancel(operation.operation_id); break;
		}
		return Response.json(result);
	} catch (error) {
		if (isClientInferenceError(error) || error instanceof McpGraphExtractionError) return Response.json({ error: error.message }, { status: error.status });
		if (error instanceof ChatInputError || error instanceof SideChatInputError || error instanceof SourceOrganizationInputError) {
			return Response.json({ error: error.message }, { status: 400 });
		}
		throw error;
	}
}
