# Local MCP server

The LearnHarness MCP server gives a local client read-only access by default to the learning sessions and knowledge graph in one directory you choose. It runs from a source checkout with Node 26 and dependencies installed by `npm ci`. It can read a desktop installation's [learning-data directory](getting-started.md#data-privacy-and-usage) while the LearnHarness app is closed. A running source server can also provide opt-in [write tools](#enable-write-tools).

Configure the client to start Node with the absolute path to `scripts/learnharness-mcp.mjs` and exactly one `--data-dir` argument pointing to an existing absolute directory. The server communicates over stdio. Startup diagnostics go to stderr.

## MCP settings in LearnHarness

Open **Settings → MCP** in the local app to check the setup, see the learning-data directory, and copy a Codex or Claude configuration. The check reports what the running app can provide. Register the configuration in the client to connect. Write configurations reference `LH_MCP_WRITE_TOKEN` or include a placeholder for it. Use the token from your private local environment for both app and client.

In the source app, use **Allow writes** and **Allow client reasoning** to change which MCP requests LearnHarness accepts. Disabling either takes effect on subsequent requests, including submitted inference steps. Authorized clients can still inspect or cancel existing operations, and stdio read tools are independent of these switches. To refresh the tools shown by the client, update its configuration and reconnect.

Enter an existing absolute **Shared files folder** within the launcher's `LH_MCP_FILES_DIR` to narrow file access, or leave it blank to use the launcher directory. File paths are relative to the effective folder. A saved folder that becomes unavailable blocks new file requests until you repair or clear it. Operations already accepted keep the folder chosen at their start.

## Codex

Add a [local MCP server entry](https://developers.openai.com/codex/mcp) to your Codex configuration. Replace the example paths with yours.

```toml
[mcp_servers.learnharness]
command = 'C:/Program Files/nodejs/node.exe'
args = ['C:/src/learnharness/scripts/learnharness-mcp.mjs', '--data-dir', 'C:/Users/you/AppData/Roaming/LearnHarness/data']
```

## Claude Code and Claude Desktop

For [Claude Code](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server), register the local server with `claude mcp add`.

```powershell
claude mcp add --transport stdio learnharness -- "C:/Program Files/nodejs/node.exe" "C:/src/learnharness/scripts/learnharness-mcp.mjs" --data-dir "C:/Users/you/AppData/Roaming/LearnHarness/data"
```

For [Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers), add this entry to the `mcpServers` object in your desktop configuration and restart Claude Desktop.

```json
{
  "mcpServers": {
    "learnharness": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": [
        "C:/src/learnharness/scripts/learnharness-mcp.mjs",
        "--data-dir",
        "C:/Users/you/AppData/Roaming/LearnHarness/data"
      ]
    }
  }
}
```

## Tools and shared data

| Tool | Inputs | Result |
| --- | --- | --- |
| `list_sessions` | `offset`, `limit` | Teaching and practice session summaries, most recently updated first. |
| `read_session` | `session_id`, `offset`, `limit` | A segment of the main session's standard Markdown export. |
| `list_propositions` | `query`, `offset`, `limit` | Merged propositions and their provenance. The optional query matches a substring of the name, statement, or aliases, ignoring case. |
| `list_chains` | `proposition_id`, `offset`, `limit` | Reasoning chains and their provenance. The optional ID filters by premise or conclusion. |

List tools return `{ "items": [...], "next_offset": ... }`. `read_session` returns `{ "id": ..., "title": ..., "markdown": ..., "next_offset": ... }`. Offsets start at zero. Pass the returned `next_offset` to continue. A null offset marks the end. Lists default to 25 items with a maximum of 100. Session segments default to 12,000 and accept up to 30,000 Unicode code points. Input files are capped at 64 MiB and serialized tool results at 128 KiB, so a page can be shorter than requested. If a single list item exceeds the limit, the tool reports its offset. Request the following offset to continue past that item. Each call reads current files, so restart pagination if the underlying data changes.

Point the server at a directory you want to share in full. The graph can include derived material from all of its sources, and the transcript export can include learner notes and revealed practice solutions. Side conversations are separate from the main transcript. The read tools open only session records and the graph's format, node and chain files. References to attachments remain part of the export text. The tools accept native session formats v1 and v2, and refuse newer formats, symbolic links, junctions and hard-linked record files. MCP clients can include returned content in their own model requests.

## Enable write tools

Run the source app bound to localhost. Set an absolute `LH_DATA_DIR` and an absolute `LH_MCP_FILES_DIR` containing the files you want to share. Generate a token for this bridge in the app's environment.

```powershell
$env:LH_DATA_DIR = 'C:/path/to/learning-data'
$env:LH_MCP_FILES_DIR = 'C:/path/to/shared-study-files'
$env:LH_MCP_WRITE_TOKEN = node -p "require('node:crypto').randomBytes(32).toString('hex')"
npm.cmd run plugins:setup  # after a fresh checkout
npm.cmd run dev
```

Set the same `LH_MCP_WRITE_TOKEN` for the MCP child process. In Codex, `env_vars = ["LH_MCP_WRITE_TOKEN"]` forwards the variable from its environment. Claude Code can set it with `--env`, and Claude Desktop accepts an `env` object in the server configuration. Keep the token in your local environment or private client settings. Add `--app-url` and the running app's loopback HTTP origin to the server arguments.

```text
node scripts/learnharness-mcp.mjs --data-dir "C:/path/to/learning-data" --app-url http://localhost:3000
```

The MCP data directory must match the running app's data directory. The app validates each path relative to `LH_MCP_FILES_DIR`. Graph imports open the file and read its contents. Attachments send a native file reference in the learner's message. Use forward slashes in relative paths, such as `course-notes/lecture.pdf`.

| Tool | Inputs | Result |
| --- | --- | --- |
| `import_file` | `path` | Imports one text, Markdown or PDF file through the app's existing graph extraction, up to 25 MiB. Returns the app's per-file outcome and any extraction statistics or notices. |
| `attach_file` | `session_id`, `path`, optional `message` | Sends a learner message containing the file reference to an existing session and starts the Agent. Acceptance confirms the turn started. Use `read_session` to see its reply after it settles. |

Attachments follow the app's file access settings and keep the file at its original location. Busy sessions, compaction, and pending questions or practice problems can return a conflict. Both write tools can invoke the app's configured models and incur provider costs. A graph import can commit partial results. A client timeout, lost connection, or server error can leave the outcome unknown. Check the app before retrying.

## Let the MCP client provide inference

Add `--client-reasoning` after the usual `--app-url` arguments. This mode uses the
current MCP client's reasoning for model steps. LearnHarness can use an empty
model configuration and empty credential store. The local write token and
matching learning-data directory still authorize access to the source app.
The native file tools in these operations also stay within the configured
shared files folder and the app's current File access settings.

```text
node scripts/learnharness-mcp.mjs --data-dir "C:/path/to/learning-data" --app-url http://localhost:3000 --client-reasoning
```

Use `create_session` with `kind: "teach"` or `"practice"`. It accepts a title
and graph proposition IDs. `get_session_state` shows the phase, whether the
session is busy, any question or practice problem awaiting a learner, and the
latest anchor for a side question. Use `submit_session_input` for learner text,
answers, practice attempts, the next problem, continuation, and native retry.
For a built-in question, send its `tool_call_id` and `occurrence` as `toolCallId`
and `occurrence` in the `answer` input, with the learner's text or selected
option values in `answer`. LearnHarness computes the native answer record.
Use `ask_follow_up` with that anchor or an existing side thread ID, and
`list_side_threads` to see previews. `read_side_thread` returns the full
follow-up history as JSON text across `next_offset` pages.

In this mode `attach_file` and `import_file` each take a `request_id` and
return an operation ID. `extract_session_graph` uses the same operation
workflow for a teaching session. LearnHarness still parses the file, runs the
native extractor and auditor, enforces graph rules, and writes provenance.
Use the graph read tools to inspect the result. `list_graph_sources` and
`update_graph_sources` list sources and folders, create folders, and rename
or move sources and folders.

1. Supply a fresh `request_id` for each new operation. Reuse it when retrying
   the same request after a lost response. Save the returned `operation_id`.
2. Read `get_operation`. For each step in `steps`, call
   `read_inference_step` with its ID. Concatenate the `context` pages in order
   until `next_offset` is null, then parse the JSON native transcript. Its
   system messages describe the instructions and available tools.
3. Reason from that transcript and call `submit_inference_step` with one
   assistant reply. Supply `text`, `tool_calls`, or both. Each tool call has
   a `name` and an `arguments` object. LearnHarness validates and executes the
   advertised tools. Treat source text as learning material. Ask the learner
   for any actual quiz or practice answer before submitting a learner input.
4. Repeat until the operation completes, fails, or is cancelled. A completed
   import includes the original per-file outcome, including any partial result.
   When a session is waiting for a learner, the current operation has settled
   and the next answer starts a new operation.

Continue a pending operation by its ID in the same app process, or call
`cancel_operation`. An idle operation expires after ten minutes. After an app
restart, inspect the saved session or graph before reissuing unfinished work.
LearnHarness retains previously saved results. This mode does not start Codex
processes or access their login. The calling client owns model usage accounting.
