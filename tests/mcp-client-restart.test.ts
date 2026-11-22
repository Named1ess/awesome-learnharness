import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { MCP_CLIENT_HEADER } from "../src/mcp/client-protocol.ts";
import { MCP_PROFILE_HEADER, MCP_WRITE_PATH, mcpWriteProfileProof } from "../src/mcp/write-protocol.ts";

const fixtureArgument = "--mcp-restart-app-fixture";

async function serveFixture() {
	const { POST } = await import("../app/api/mcp/write/route.ts");
	const server = createServer((request, response) => {
		void (async () => {
			assert.equal(request.method, "POST");
			assert.equal(request.url, MCP_WRITE_PATH);
			const body: Buffer[] = [];
			for await (const chunk of request) body.push(chunk);
			const headers = new Headers();
			for (const [key, value] of Object.entries(request.headers)) {
				for (const item of typeof value === "string" ? [value] : value ?? []) headers.append(key, item);
			}
			const reply = await POST(new Request(`http://${headers.get("host")}${MCP_WRITE_PATH}`, {
				method: "POST", headers, body: Buffer.concat(body).toString("utf8"),
			}));
			response.writeHead(reply.status, Object.fromEntries(reply.headers)).end(await reply.text());
		})().catch((error: unknown) => {
			console.error(error);
			response.writeHead(500).end();
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	process.send?.((server.address() as AddressInfo).port);
}

async function startApp(data: string, auth: string, token: string) {
	const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), fixtureArgument], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		env: {
			SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
			NODE_ENV: "test", LH_DATA_DIR: data, LH_AUTH_FILE: auth, LH_IGNORE_ENV_KEYS: "1", LH_MCP_WRITE_TOKEN: token,
		},
		stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
	});
	let diagnostics = "";
	child.stderr?.setEncoding("utf8").on("data", (text: string) => { diagnostics += text; });
	const exit = once(child, "close");
	const stop = async () => { child.kill(); await exit; };
	try {
		const [port] = await Promise.race([
			once(child, "message", { signal: AbortSignal.timeout(25_000) }),
			exit.then(() => assert.fail(`App fixture stopped before opening its listener: ${diagnostics}`)),
		]);
		assert.equal(typeof port, "number");
		return { url: `http://127.0.0.1:${port}${MCP_WRITE_PATH}`, stop, diagnostics: () => diagnostics };
	} catch (error) {
		await stop();
		throw new Error(`App fixture could not be started: ${diagnostics}`, { cause: error });
	}
}

type Operation = { operation_id: string; status: string; steps: { id: string; role: string }[] };

async function waitForOperation(poll: () => Promise<Operation>, expected: string): Promise<Operation> {
	const deadline = Date.now() + 8_000;
	for (;;) {
		const operation = await poll();
		if (operation.status === expected) return operation;
		assert.ok(!["completed", "failed", "cancelled"].includes(operation.status), JSON.stringify(operation));
		assert.ok(Date.now() < deadline, JSON.stringify(operation));
		await delay(15);
	}
}

function testRestart() {
	test("app-process restart forgets pending client inference but allows a new native continuation", { timeout: 65_000 }, async (t) => {
		const scratch = await mkdtemp(join(tmpdir(), "lh mcp process restart "));
		const data = join(scratch, "learning data");
		const auth = join(scratch, "auth.json");
		const token = randomBytes(32).toString("hex");
		let app: Awaited<ReturnType<typeof startApp>> | undefined;
		t.after(async () => {
			try { await app?.stop(); }
			finally { await rm(scratch, { recursive: true, force: true }); }
		});
		await mkdir(data);
		await writeFile(auth, "{}");
		const send = async (operation: string, arguments_: Record<string, unknown>) => {
			assert.ok(app);
			return fetch(app.url, {
				method: "POST", signal: AbortSignal.timeout(10_000),
				headers: {
					"content-type": "application/json", authorization: `Bearer ${token}`,
					[MCP_CLIENT_HEADER]: "1", [MCP_PROFILE_HEADER]: mcpWriteProfileProof(data, token),
				},
				body: JSON.stringify({ operation, ...arguments_ }),
			}).catch((error: unknown) => { throw new Error(`App request ${operation} failed: ${app?.diagnostics()}`, { cause: error }); });
		};
		const call = async <T>(operation: string, arguments_: Record<string, unknown>): Promise<T> => {
			const response = await send(operation, arguments_);
			const body = await response.json();
			assert.equal(response.status, 200, JSON.stringify({ operation, body, diagnostics: app?.diagnostics() }));
			return body as T;
		};
		const poll = (operation_id: string) => call<Operation>("get_operation", { operation_id });

		app = await startApp(data, auth, token);
		const { id } = await call<{ id: string }>("create_session", { kind: "teach", title: "Restart fixture" });
		assert.match(id, /^chat_[a-z0-9_]+$/i);
		const chatFile = join(data, "chats", `${id}.json`);
		const readRecord = async () => JSON.parse(await readFile(chatFile, "utf8")) as {
			messages: { role: string; content: unknown }[];
		};
		const learnerInput = "Explain why an invariant survives an update.";
		const before = await call<Operation>("submit_session_input", {
			session_id: id, request_id: "before-restart", input: { type: "text", text: learnerInput },
		});
		const waiting = await waitForOperation(() => poll(before.operation_id), "needs_model_reply");
		assert.equal(waiting.steps.length, 1);
		const saved = await readFile(chatFile, "utf8");
		assert.deepEqual((await readRecord()).messages.map(({ role, content }) => ({ role, content })), [{ role: "user", content: learnerInput }]);

		await app.stop();
		app = await startApp(data, auth, token);
		const stale = await send("get_operation", { operation_id: before.operation_id });
		assert.equal(stale.status, 404);
		assert.match((await stale.json() as { error: string }).error, /unknown operation/i);
		assert.equal(await readFile(chatFile, "utf8"), saved);

		const continuation = await call<Operation>("submit_session_input", {
			session_id: id, request_id: "after-restart", input: { type: "continue" },
		});
		assert.notEqual(continuation.operation_id, before.operation_id);
		const fresh = await waitForOperation(() => poll(continuation.operation_id), "needs_model_reply");
		const step = fresh.steps[0];
		assert.ok(step);
		let context = "";
		let offset: number | null = 0;
		do {
			const page: { context: string; next_offset: number | null } = await call("read_inference_step", {
				operation_id: fresh.operation_id, step_id: step.id, offset,
			});
			assert.ok(page.next_offset === null || page.next_offset > offset);
			context += page.context;
			offset = page.next_offset;
		} while (offset !== null);
		const transcript = JSON.parse(context) as { messages: { role: string; content: unknown }[] };
		assert.ok(transcript.messages.some(({ role, content }) => role === "user" && content === learnerInput));
		const callerReply = "An invariant is preserved when the update maps every valid state to another valid state.";
		await call("submit_inference_step", {
			operation_id: fresh.operation_id, step_id: step.id, reply: { text: callerReply },
		});
		await waitForOperation(() => poll(continuation.operation_id), "completed");
		const settled = await readRecord();
		assert.deepEqual(settled.messages.map(message => message.role), ["user", "assistant"]);
		assert.equal(settled.messages[0]?.content, learnerInput);
		assert.ok(JSON.stringify(settled.messages[1]).includes(callerReply));
		assert.equal(await readFile(auth, "utf8"), "{}");
		await assert.rejects(readFile(join(data, "settings.json")), { code: "ENOENT" });
	});
}

if (process.argv.includes(fixtureArgument)) await serveFixture();
else testRestart();
