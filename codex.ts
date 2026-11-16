// Runs `codex exec` with its image generation tool and returns the PNG it made.
//
// Codex saves generated images under $CODEX_HOME/generated_images/<thread-id>/.
// We read the thread id from the --json event stream, so concurrent runs never
// pick up each other's files.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPng } from "./image";

export interface CodexImageRequest {
  codexPath: string;
  model: string;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}

export interface CodexImageResult {
  png: Buffer;
  /** Codex's last message: usually a one-line description of the motif. */
  summary: string;
  threadId: string | null;
}

const FALLBACK_DIRS = [
  join(homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

/** Resolve "codex" to an absolute path; the bb server's PATH is often minimal. */
export function resolveCodex(configured: string): string {
  if (configured.includes("/")) return configured;
  for (const dir of [...(process.env.PATH ?? "").split(":"), ...FALLBACK_DIRS]) {
    if (dir && existsSync(join(dir, configured))) return join(dir, configured);
  }
  return configured;
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

async function newestPng(dir: string, since: number): Promise<string | null> {
  let best: { path: string; mtime: number } | null = null;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".png")) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs < since) continue;
    if (!best || info.mtimeMs > best.mtime) best = { path, mtime: info.mtimeMs };
  }
  return best?.path ?? null;
}

export async function generateWithCodex(
  request: CodexImageRequest,
): Promise<CodexImageResult> {
  const startedAt = Date.now() - 1000;
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--enable",
    "image_generation",
  ];
  if (request.model.trim()) args.push("--model", request.model.trim());
  args.push(request.prompt);

  const child = spawn(resolveCodex(request.codexPath), args, {
    cwd: request.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: [process.env.PATH, ...FALLBACK_DIRS].filter(Boolean).join(":"),
    },
  });

  let threadId: string | null = null;
  let summary = "";
  let stderr = "";
  let buffer = "";
  const failures: string[] = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("{")) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          thread_id?: string;
          item?: { type?: string; text?: string; message?: string; command?: string };
          error?: { message?: string };
          message?: string;
        };
        if (event.type === "thread.started" && event.thread_id) {
          threadId = event.thread_id;
        } else if (event.type === "item.completed" && event.item) {
          if (event.item.type === "agent_message" && event.item.text) {
            summary = event.item.text.trim();
            request.onProgress?.(summary);
          } else if (event.item.type === "command_execution" && event.item.command) {
            request.onProgress?.(`ran ${event.item.command.slice(0, 120)}`);
          }
        } else if (event.type === "turn.failed" || event.type === "error") {
          failures.push(event.error?.message ?? event.message ?? "Codex turn failed");
        }
      } catch {
        // Not an event line; ignore.
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Codex did not finish within ${Math.round(request.timeoutMs / 1000)}s`));
    }, request.timeoutMs);
    const onAbort = () => {
      child.kill("SIGTERM");
      clearTimeout(timer);
      reject(new Error("Generation cancelled"));
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Could not start Codex (${error.message}). Set the Codex path in Backdrop settings.`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve(code);
    });
  });

  const root = join(codexHome(), "generated_images");
  let imagePath = threadId ? await newestPng(join(root, threadId), startedAt) : null;
  if (!imagePath) {
    // Older Codex builds may not key the folder by thread id.
    const dirs = await readdir(root).catch(() => [] as string[]);
    for (const dir of dirs) {
      const candidate = await newestPng(join(root, dir), startedAt);
      if (!candidate) continue;
      const [a, b] = await Promise.all([
        stat(candidate),
        imagePath ? stat(imagePath) : Promise.resolve(null),
      ]);
      if (!b || a.mtimeMs > b.mtimeMs) imagePath = candidate;
    }
  }
  if (!imagePath) {
    const reason =
      failures.at(-1) ??
      (exitCode !== 0 ? stderr.trim().split("\n").slice(-3).join(" ") : "") ??
      "";
    throw new Error(
      `Codex finished without generating an image${reason ? `: ${reason}` : ""}. ${summary}`.trim(),
    );
  }
  const png = await readFile(imagePath);
  if (!isPng(png)) throw new Error(`Codex image is not a PNG: ${imagePath}`);
  return { png, summary, threadId };
}
