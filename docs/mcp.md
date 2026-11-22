# Local MCP server

The LearnHarness MCP server gives a local client read-only access by default to the learning sessions and knowledge graph in one directory you choose. It runs from a source checkout with Node 26 and dependencies installed by `npm ci`. It can read a desktop installation's [learning-data directory](getting-started.md#data-privacy-and-usage) while the LearnHarness app is closed. A running source server can also provide opt-in [write tools](#enable-write-tools).

Configure the client to start Node with the absolute path to `scripts/learnharness-mcp.mjs` and exactly one `--data-dir` argument pointing to an existing absolute directory. The server communicates over stdio. Startup diagnostics go to stderr.

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

The MCP data directory must match the running app's data directory. The app validates each path relative to `LH_MCP_FILES_DIR`. Graph imports open the file and read its contents. Attachments send a native file reference in the learner's message. Use forward slashes in relative paths, such as `course notes/lecture.pdf`.

| Tool | Inputs | Result |
| --- | --- | --- |
| `import_file` | `path` | Imports one text, Markdown or PDF file through the app's existing graph extraction, up to 25 MiB. Returns the app's per-file outcome and any extraction statistics or notices. |
| `attach_file` | `session_id`, `path`, optional `message` | Sends a learner message containing the file reference to an existing session and starts the Agent. Acceptance confirms the turn started. Use `read_session` to see its reply after it settles. |

Attachments follow the app's file access settings and keep the file at its original location. Busy sessions, compaction, and pending questions or practice problems can return a conflict. Both write tools can invoke the app's configured models and incur provider costs. A graph import can commit partial results. A client timeout, lost connection, or server error can leave the outcome unknown. Check the app before retrying.
