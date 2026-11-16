// Image providers other than Codex.
//
// Codex is an agent: it reads the repository itself. These providers are
// plain image APIs, so the plugin reads the project's README and manifest and
// puts a short summary into the prompt instead.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSupportedImage } from "./image";

export const PROVIDER_IDS = ["codex", "openai", "gemini", "command"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  codex: "Codex CLI",
  openai: "OpenAI Images API",
  gemini: "Google Gemini API",
  command: "Custom command",
};

export interface GeneratedImage {
  bytes: Buffer;
  summary: string;
}

export interface ImageRequest {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}

// ---- project context ---------------------------------------------------------

const CONTEXT_FILES = [
  "README.md",
  "readme.md",
  "README",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
];

/**
 * Keep only prose: the image model needs the project's subject, not its
 * commands, tables, paths or URLs (which can also name internal hosts).
 */
function cleanMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split("\n")
    .filter((line) => !/^\s*\|/.test(line) && !/^\s*[-=]{3,}\s*$/.test(line))
    .join("\n")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ")
    .replace(/\b[A-Z][A-Z0-9_]{3,}\b/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_]{2,}/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.;:)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\n\s*\n(\s*\n)+/g, "\n\n")
    .trim();
}

/** The title plus lines that still read as sentences once code is gone. */
function proseExcerpt(text: string, maxChars: number): string {
  const lines = cleanMarkdown(text).split("\n");
  const kept: string[] = [];
  let length = 0;
  lines.forEach((raw, index) => {
    const line = raw.replace(/^[-*]\s*/, "").trim();
    const words = line.match(/[\p{L}][\p{L}'-]+/gu)?.length ?? 0;
    const dangling = /[(:,]\s*$|\(\s*[,.;]|:\s*[.,]/.test(line);
    if (!line || (index > 0 && (words < 5 || dangling))) return;
    if (length + line.length > maxChars) return;
    kept.push(line);
    length += line.length + 1;
  });
  return kept.join("\n");
}

function manifestSummary(name: string, text: string): string {
  if (name === "package.json") {
    try {
      const pkg = JSON.parse(text) as { name?: string; description?: string; keywords?: string[] };
      return [pkg.name, pkg.description, pkg.keywords?.join(", ")].filter(Boolean).join(" — ");
    } catch {
      return "";
    }
  }
  const description = /^\s*description\s*=\s*"([^"]*)"/m.exec(text)?.[1];
  return description ?? "";
}

/** A short, plain-text description of the project for an image prompt. */
export async function readProjectContext(cwd: string | null, maxChars = 1800): Promise<string> {
  if (!cwd) return "";
  const parts: string[] = [];
  let readmeTaken = false;
  let agentNotesTaken = false;
  for (const name of CONTEXT_FILES) {
    const text = await readFile(join(cwd, name), "utf8").catch(() => null);
    if (!text) continue;
    if (/^readme/i.test(name)) {
      if (readmeTaken) continue;
      readmeTaken = true;
      parts.push(proseExcerpt(text, 900));
    } else if (name === "AGENTS.md" || name === "CLAUDE.md") {
      // Agent notes describe the project when there is no README; keep one.
      if (agentNotesTaken) continue;
      agentNotesTaken = true;
      parts.push(proseExcerpt(text, readmeTaken ? 300 : 700));
    } else {
      const summary = manifestSummary(name, text);
      if (summary) parts.push(summary);
    }
  }
  return parts.join("\n\n").slice(0, maxChars);
}

// ---- HTTP helpers --------------------------------------------------------------

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, timeout]) }).catch(
    (error: unknown) => {
      if (signal.aborted) throw new Error("Generation cancelled");
      if (timeout.aborted) throw new Error(`No answer within ${Math.round(timeoutMs / 1000)}s`);
      throw new Error(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as { error?: { message?: string } | string };
      message = typeof body.error === "string" ? body.error : (body.error?.message ?? message);
    } catch {
      // keep raw text
    }
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The provider returned something that is not JSON.");
  }
}

function decodeBase64Image(data: string, provider: string): Buffer {
  const bytes = Buffer.from(data, "base64");
  if (!isSupportedImage(bytes)) throw new Error(`${provider} returned an image that is not PNG or JPEG.`);
  return bytes;
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

// ---- OpenAI Images API -------------------------------------------------------------

export interface OpenAiOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export async function generateWithOpenAi(options: OpenAiOptions, request: ImageRequest): Promise<GeneratedImage> {
  const body = (await fetchJson(
    `${trimSlash(options.baseUrl)}/images/generations`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ model: options.model, prompt: request.prompt, size: "1024x1024", n: 1 }),
    },
    request.timeoutMs,
    request.signal,
  )) as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
  const first = body.data?.[0];
  if (first?.b64_json) {
    return { bytes: decodeBase64Image(first.b64_json, "OpenAI"), summary: first.revised_prompt?.slice(0, 300) ?? "" };
  }
  if (first?.url) {
    const response = await fetch(first.url, { signal: request.signal });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!isSupportedImage(bytes)) throw new Error("OpenAI returned an image that is not PNG or JPEG.");
    return { bytes, summary: first.revised_prompt?.slice(0, 300) ?? "" };
  }
  throw new Error("OpenAI returned no image.");
}

// ---- Google Gemini API -----------------------------------------------------------

export interface GeminiOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export async function generateWithGemini(options: GeminiOptions, request: ImageRequest): Promise<GeneratedImage> {
  const body = (await fetchJson(
    `${trimSlash(options.baseUrl)}/v1beta/models/${encodeURIComponent(options.model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1" } },
      }),
    },
    request.timeoutMs,
    request.signal,
  )) as {
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> };
    }>;
    promptFeedback?: { blockReason?: string };
  };
  if (body.promptFeedback?.blockReason) throw new Error(`Gemini blocked the prompt: ${body.promptFeedback.blockReason}`);
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find((part) => part.inlineData?.data);
  const text = parts.map((part) => part.text ?? "").join(" ").trim();
  if (!image?.inlineData?.data) {
    const reason = body.candidates?.[0]?.finishReason;
    throw new Error(`Gemini returned no image${reason ? ` (${reason})` : ""}${text ? `: ${text.slice(0, 200)}` : ""}.`);
  }
  return { bytes: decodeBase64Image(image.inlineData.data, "Gemini"), summary: text.slice(0, 300) };
}

// ---- custom command ------------------------------------------------------------------

/**
 * Runs `command` through /bin/sh in the project directory. The prompt and the
 * output path arrive as environment variables, never spliced into the
 * command text, so a prompt cannot inject shell syntax:
 *   BACKDROP_PROMPT, BACKDROP_OUTPUT (write a PNG or JPEG here),
 *   BACKDROP_PROJECT_DIR.
 * Whatever the command prints last on stdout becomes the summary.
 */
export async function generateWithCommand(command: string, request: ImageRequest): Promise<GeneratedImage> {
  const dir = await mkdtemp(join(tmpdir(), "backdrop-"));
  const output = join(dir, "image.png");
  try {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        BACKDROP_PROMPT: request.prompt,
        BACKDROP_OUTPUT: output,
        BACKDROP_PROJECT_DIR: request.cwd,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout = (stdout + chunk).slice(-4000)));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`The command did not finish within ${Math.round(request.timeoutMs / 1000)}s`));
      }, request.timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(new Error("Generation cancelled"));
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`Could not run the command: ${error.message}`));
      });
      child.on("close", (exit) => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        resolve(exit);
      });
    });
    if (code !== 0) {
      const tail = (stderr || stdout).trim().split("\n").slice(-3).join(" ");
      throw new Error(`The command exited with ${code}${tail ? `: ${tail}` : ""}`);
    }
    const bytes = await readFile(output).catch(() => null);
    if (!bytes) throw new Error("The command finished but wrote no image to $BACKDROP_OUTPUT.");
    if (!isSupportedImage(bytes)) throw new Error("The command's image is not PNG or JPEG.");
    const summary = stdout.trim().split("\n").at(-1)?.slice(0, 300) ?? "";
    return { bytes, summary };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
