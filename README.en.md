# opencode-v2-mcp

*[Русская версия](README.md)*

[![npm (npmjs.org)](https://img.shields.io/npm/v/opencode2-mcp?label=npmjs.org&color=cb3837)](https://www.npmjs.com/package/opencode2-mcp)
[![GitHub Packages](https://img.shields.io/badge/GitHub%20Packages-%40yuriisamohvalov--creator%2Fopencode--v2--mcp-24292e?logo=github)](https://github.com/yuriisamohvalov-creator/opencode-mcp/pkgs/npm/opencode-v2-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An MCP server that lets **Claude Code, Codex CLI, Cursor-agent** (or any
other MCP client) delegate bounded coding tasks to a local
[OpenCode](https://opencode.ai) **v2.x** instance. It exposes a single
tool — `opencode_execute` — which runs `opencode run --format json`, parses
the NDJSON stream, and returns a compact report: response text,
`git diff --stat`, `git status --short`, exit code, and `sessionID`.

The server is built on the standard `@modelcontextprotocol/sdk` (stdio
transport) — it is not tied to any specific client and works identically
with any MCP-compatible host, no code changes needed. Connectivity with
Claude Code, Codex CLI, and Cursor-agent has been verified live (see
sections below).

Based on the reference implementation from a community guide,
"Claude Code Desktop → OpenCode v2 as a code-writing subagent," and
patched with three fixes without which the wrapper does not work against
a real `opencode v2.0.12` install (details in "Known ecosystem bugs"
below).

The full development history, diagnostics, and comparison against other
community MCP wrappers (all of which fail against `opencode v2.x` for
various reasons) live in `second-brain/opencode-subagent-mcp.md` (a
personal note, not published).

## Requirements

- **OpenCode v2.x**, installed and available on `PATH` (`opencode --version`
  should print `2.x`).
- Node.js 18+.
- A configured provider/model in OpenCode (`opencode auth login`,
  `opencode auth list`).
- The project where `opencode_execute` will run must contain an
  `opencode.json` with a **JSON `agent` block** (see below — markdown
  agent files `.opencode/agent/*.md` hang indefinitely on this version).

## Installation

### Option 1 — from npm (npmjs.org, recommended)

Published as [`opencode2-mcp`](https://www.npmjs.com/package/opencode2-mcp)
— fully public, installs with no authentication:

```bash
npm install -g opencode2-mcp
```

### Option 2 — from source

```bash
git clone git@github.com:yuriisamohvalov-creator/opencode-mcp.git ~/tools/opencode-mcp
cd ~/tools/opencode-mcp
npm install
```

### Option 3 — from GitHub Packages

The same package is also mirrored on GitHub Packages as
[`@yuriisamohvalov-creator/opencode-v2-mcp`](https://github.com/yuriisamohvalov-creator/opencode-mcp/pkgs/npm/opencode-v2-mcp).
**Note:** unlike npmjs.org, GitHub Packages requires authentication even
for public packages — you'll need a `.npmrc` with the scoped registry and
a GitHub token with `read:packages` scope:

```bash
# ~/.npmrc or project-local
echo "@yuriisamohvalov-creator:registry=https://npm.pkg.github.com" >> ~/.npmrc
npm login --registry=https://npm.pkg.github.com --scope=@yuriisamohvalov-creator

npm install -g @yuriisamohvalov-creator/opencode-v2-mcp
```

## Connecting to Claude Code

```bash
NODE_BIN="$(which node)"
claude mcp add --scope user opencode-v2 -- "$NODE_BIN" "$HOME/tools/opencode-mcp/server.mjs"
```

If outbound network access (cloud model providers) needs to go through a
proxy, pass it as environment variables at registration time — they are
inherited by the spawned `opencode` child process:

```bash
claude mcp add --scope user opencode-v2 \
  -e HTTPS_PROXY=http://127.0.0.1:10808 -e HTTP_PROXY=http://127.0.0.1:10808 \
  -- "$NODE_BIN" "$HOME/tools/opencode-mcp/server.mjs"
```

Check:

```bash
claude mcp get opencode-v2
# Status: ✔ Connected
```

After starting a new Claude Code session (or restarting the current one),
the tool is available as `mcp__opencode-v2__opencode_execute`.

## Connecting to Codex CLI

```bash
NODE_BIN="$(which node)"
codex mcp add opencode-v2 \
  --env HTTPS_PROXY=http://127.0.0.1:10808 --env HTTP_PROXY=http://127.0.0.1:10808 \
  -- "$NODE_BIN" "$HOME/tools/opencode-mcp/server.mjs"
codex mcp list   # should show opencode-v2 as enabled
```

**Important:** by default Codex blocks MCP tool calls behind its approval
policy even when `approval` is set to `never` — this is a Codex quirk, not
a wrapper issue. Run with `--approve-for-me` (a safe mode routed through
the `workspace-write` sandbox, not
`--dangerously-bypass-approvals-and-sandbox`):

```bash
codex exec --approve-for-me "Use the opencode-v2 MCP tool opencode_execute with cwd=/path/to/project, agent=claude-worker, task='...'"
```

If you run `codex exec` outside a git repository, add
`--skip-git-repo-check` as well.

## Connecting to Cursor-agent

Cursor has no CLI command to add an MCP server — edit the config file
directly: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in a
specific project. The format is identical to Claude Code/Codex:

```json
{
  "mcpServers": {
    "opencode-v2": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/opencode-mcp/server.mjs"],
      "env": {
        "HTTPS_PROXY": "http://127.0.0.1:10808",
        "HTTP_PROXY": "http://127.0.0.1:10808"
      }
    }
  }
}
```

After editing the file, the server needs explicit approval:

```bash
cursor-agent mcp list             # should show opencode-v2
cursor-agent mcp enable opencode-v2
```

Non-interactive usage:

```bash
cursor-agent -p --output-format json --force \
  "Use the opencode-v2 MCP tool opencode_execute with cwd=/path/to/project, agent=claude-worker, task='...'"
```

The first call after adding the server is usually noticeably slower than
subsequent ones (cold start of the cursor session — observed ~20s vs the
usual 6–10s for a direct `opencode` CLI call).

## Project configuration — JSON agent only

In the root of the project where `opencode_execute` will run, create
`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "claude-worker": {
      "description": "Implements a bounded coding task delegated by Claude Code",
      "mode": "primary",
      "prompt": "You are an implementation worker. Work only inside the current project. Make the smallest coherent change. Run relevant tests. Never commit, push, or delete broad paths. End with a concise summary."
    }
  }
}
```

**Do not use markdown agent files** (`.opencode/agent/<name>.md`) — on the
installed `opencode v2.0.12` they cause `opencode run` to hang
indefinitely without a single line of output, reproduced repeatedly with
different frontmatter content. A JSON agent defined in `opencode.json`
works reliably.

## Using the tool

```jsonc
{
  "task": "Add a slugify() helper in src/lib/slug.ts with tests. Acceptance: kebab-case, trims whitespace. Verify with `npm test -- slug`.",
  "cwd": "/absolute/path/to/project",
  "agent": "claude-worker",
  "model": "openai/gpt-5.5",       // optional, provider/model
  "timeoutMs": 900000               // optional, defaults to 15 minutes
}
```

Response:

```jsonc
{
  "ok": true,
  "exitCode": 0,
  "sessionID": "ses_...",
  "toolCalls": 2,
  "toolsUsed": ["write", "shell"],
  "text": "...model's final answer...",
  "diffStat": "...git diff --stat...",
  "statusShort": "...git status --short..."
}
```

## Guard: runs without any tool calls

`opencode run` exits with code `0` even when the model cannot call
tools and merely **describes** the work in plain text (small local Ollama
models do this): nothing is written, yet the answer looks like a
success. The wrapper therefore counts completed `tool_use` events and
returns `ok: false` when there are none:

```jsonc
{
  "ok": false,
  "reason": "no_tool_calls",
  "warning": "OpenCode finished without a single completed tool call: ...",
  "exitCode": 0,
  "toolCalls": 0,
  "toolsUsed": []
}
```

- The response always carries `toolCalls` (number of completed calls) and
  `toolsUsed` (unique tool names, e.g. `["write", "shell"]`).
- If OpenCode emits `error` events (for example `provider.quota:
  credit_balance_exhausted`), their messages are exposed in `errors` —
  it does not affect `ok`, but spares you digging for the cause behind an
  empty `text`.
- The `allowNoTools: true` parameter disables the check — only for pure
  text answers. Do not set it for code-changing tasks.
- The check catches exactly "zero calls". If the model called `read` but
  wrote nothing, `ok` stays `true` — look at `statusShort` and
  `toolsUsed`.

**The model matters.** Use a model with working tool calling: set `model`
in `opencode.json` (top-level key) or pass the `model` parameter per call.
With a model that cannot call tools the task will not be done, but it is
now visible immediately instead of after checking the disk.

## Known ecosystem bugs, fixed in this wrapper

The reference implementation this is based on did not work out of the box
against `opencode v2.0.12`. Three root causes and their fixes:

1. **Missing `--auto` flag.** Without it, `opencode` cannot approve
   edit/shell permissions non-interactively — added unconditionally in
   `runOpenCode()`.
2. **`spawn("opencode", ...)` without an absolute path.** GUI applications
   (including Claude Code Desktop) don't always inherit the user's `PATH`
   where `opencode` is installed — switched to an absolute path to the
   binary. **Check and adjust the path in `server.mjs`**
   (`spawn("/home/USER/.opencode/bin/opencode", ...)`) for your own
   install — `which opencode` will tell you the right path.
3. **`opencode v2` resolves the active project via the `$PWD` environment
   variable, not the process's real `cwd`.** Node's
   `child_process.spawn()` correctly changes the OS-level `cwd` of the
   child process, but does NOT update `PWD` in its `env` — without an
   explicit `env: { ...process.env, PWD: input.cwd }`, `opencode` fails
   to find the agent defined in `opencode.json` and errors with
   `"Agent not found"`. This isn't specific to this wrapper — the bug
   applies to any Node/Bun wrapper around `opencode run` that uses
   `spawn()` with a `cwd`.

## Limitations

- One task = one `opencode run` invocation, no parallelism within a
  single tool call.
- The tool does not validate OpenCode's `permission` configuration
  itself — if the agent denies a needed command, `opencode run` exits
  without changes and with empty `text`; check `stderrTail`/`exitCode`
  in the response.
- Does not replace review: the caller must independently check
  `diffStat`/`statusShort` and test results, not trust the `ok` field
  alone.

## Related packages

The same synchronous pattern (one blocking MCP tool, no separate
check/kill) is also applied to the other three steps of the delegation
chain:

- [`codex-cli-sync-mcp`](https://github.com/yuriisamohvalov-creator/codex-mcp) —
  the same kind of wrapper around Codex CLI (`codex exec`).
- [`cline-sync-mcp`](https://github.com/yuriisamohvalov-creator/cline-mcp) —
  the same kind of wrapper around Cline CLI (`cline`).
- [`cursor-agent-sync-mcp`](https://github.com/yuriisamohvalov-creator/cursor-mcp) —
  the same kind of wrapper around the Cursor-agent CLI (`cursor-agent -p`).

## License

[MIT](LICENSE)
