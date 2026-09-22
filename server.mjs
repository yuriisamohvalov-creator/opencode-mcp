#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const MAX_TEXT_CHARS = 12_000;
const MAX_TAIL_CHARS = 4_000;

function truncate(value, max = MAX_TEXT_CHARS) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]`;
}

function tail(value, max = MAX_TAIL_CHARS) {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  return `...[tail truncated]\n${s.slice(-max)}`;
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function runOpenCode(input) {
  const args = ["run", "--format", "json", "--auto"];
  if (input.standalone) args.push("--standalone");
  if (input.agent) args.push("--agent", input.agent);
  if (input.model) args.push("--model", input.model);
  if (input.sessionId) args.push("--session", input.sessionId);
  else if (input.continueSession) args.push("--continue");
  args.push(input.task);

  return await new Promise((resolve) => {
    const child = spawn("/home/ysamohvalov/.opencode/bin/opencode", args, {
      cwd: input.cwd,
      // opencode v2 resolves the active project via $PWD, not the process's
      // real cwd — without this override spawn() reports "Agent not found"
      // for any project-local agent, since PWD stays at the parent's value.
      env: { ...process.env, PWD: input.cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutOverflow = false;
    let killedByTimeout = false;
    let sessionID = null;
    const textParts = [];
    let lastStepFinish = null;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5_000).unref();
    }, input.timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      if (stdout.length < 5_000_000) stdout += s;
      else stdoutOverflow = true;

      for (const line of s.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (event.sessionID) sessionID = event.sessionID;
          if (event.type === "text" && event.part?.text) textParts.push(event.part.text);
          if (event.type === "step_finish") lastStepFinish = event.part ?? null;
        } catch {
          // Ignore non-JSON lines. Logs usually go to stderr.
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderr = (stderr + s).slice(-1_000_000);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error: `Failed to spawn opencode: ${error.message}`,
        args,
        cwd: input.cwd,
      });
    });

    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      const text = truncate(textParts.join("\n").trim());
      const diffStat = await git(input.cwd, ["diff", "--stat"]);
      const statusShort = await git(input.cwd, ["status", "--short"]);

      resolve({
        ok: !killedByTimeout && code === 0,
        killedByTimeout,
        exitCode: code,
        signal,
        sessionID,
        args,
        cwd: input.cwd,
        stdoutOverflow,
        text: text || (lastStepFinish ? JSON.stringify(lastStepFinish, null, 2) : ""),
        stepFinish: lastStepFinish,
        diffStat,
        statusShort,
        stderrTail: tail(stderr),
      });
    });
  });
}

const server = new McpServer({
  name: "opencode-v2-mcp",
  version: "0.1.0",
});

server.tool(
  "opencode_execute",
  "Execute one bounded coding task through OpenCode v2 and return a compact JSON report with diff/test context.",
  {
    task: z.string().min(10).describe("Bounded coding task with goal, constraints, files, acceptance criteria, and verification command."),
    cwd: z.string().describe("Absolute working directory/repository root."),
    agent: z.string().default("claude-worker").describe("OpenCode v2 agent name, e.g. claude-worker or build."),
    model: z.string().optional().describe("Optional OpenCode provider/model, e.g. openai/gpt-5.5."),
    standalone: z.boolean().default(false).describe("Use OpenCode private standalone server for this run. Default false uses normal v2 service behavior."),
    timeoutMs: z.number().int().min(1000).max(3600000).default(900000).describe("Internal OpenCode timeout; must be below Claude MCP per-server timeout."),
    sessionId: z.string().optional().describe("Continue a specific OpenCode session instead of starting a new one."),
    continueSession: z.boolean().default(false).describe("Continue last OpenCode session; ignored when sessionId is set."),
  },
  async (input) => {
    const result = await runOpenCode(input);
    return {
      isError: !result.ok,
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
