// bb-plugin-backdrop — per-project wallpapers behind every thread.
//
// An image provider (Codex, OpenAI, Gemini, or a custom command) draws a
// seamless monochrome pattern from the project's own context; image.ts turns it into a transparent ink mask stored in the
// plugin's SQLite; app.tsx draws it behind the thread pane, tinted with the
// theme's foreground colour so it works in light and dark mode.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { generateWithCodex, resolveCodex } from "./codex";
import { isSupportedImage, toInkMask, toPng } from "./image";
import {
  PROVIDER_IDS,
  PROVIDER_LABELS,
  generateWithCommand,
  generateWithGemini,
  generateWithOpenAi,
  readProjectContext,
  type GeneratedImage,
  type ProviderId,
} from "./providers";

const TINTS = ["foreground", "primary", "muted"] as const;

const appearanceSchema = z.object({
  enabled: z.boolean(),
  opacityLight: z.number().min(0).max(0.5),
  opacityDark: z.number().min(0).max(0.5),
  /** CSS pixels per tile edge. */
  scale: z.number().int().min(64).max(2048),
  tint: z.enum(TINTS),
});
export type Appearance = z.infer<typeof appearanceSchema>;

const jobSchema = z.object({
  status: z.enum(["running", "failed"]),
  startedAt: z.number(),
  message: z.string(),
});
export type Job = z.infer<typeof jobSchema>;

const backgroundSchema = z.object({
  projectId: z.string(),
  version: z.number(),
  prompt: z.string(),
  summary: z.string(),
  width: z.number(),
  height: z.number(),
  coverage: z.number(),
  createdAt: z.number(),
  /** Which provider drew it; "" for imports and images from before 0.2. */
  provider: z.string(),
  imageUrl: z.string(),
  originalUrl: z.string(),
  appearance: appearanceSchema,
});
export type Background = z.infer<typeof backgroundSchema>;

const projectStateSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  background: backgroundSchema.nullable(),
  job: jobSchema.nullable(),
});
export type ProjectState = z.infer<typeof projectStateSchema>;

const projectIdSchema = z.string().regex(/^proj_[A-Za-z0-9_]+$/);
const providerIdSchema = z.enum(PROVIDER_IDS);

const providerStatusSchema = z.object({
  id: providerIdSchema,
  label: z.string(),
  ready: z.boolean(),
  /** Why it is not ready, or what it will use. */
  detail: z.string(),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const rpcContract = defineRpcContract({
  /** The background for whatever the current route shows. */
  resolve: {
    input: z.object({
      projectId: z.string().nullable(),
      threadId: z.string().nullable(),
    }),
    output: z.object({
      projectId: z.string().nullable(),
      background: backgroundSchema.nullable(),
    }),
  },
  list: {
    input: z.null(),
    output: z.object({ projects: z.array(projectStateSchema) }),
  },
  providers: {
    input: z.null(),
    output: z.object({ defaultProvider: providerIdSchema, providers: z.array(providerStatusSchema) }),
  },
  generate: {
    input: z.object({
      projectId: projectIdSchema,
      hint: z.string().max(2000).optional(),
      mirror: z.boolean().optional(),
      provider: providerIdSchema.optional(),
    }),
    output: z.object({ started: z.boolean() }),
  },
  cancel: {
    input: z.object({ projectId: projectIdSchema }),
    output: z.object({ cancelled: z.boolean() }),
  },
  setAppearance: {
    input: z.object({
      projectId: projectIdSchema,
      appearance: appearanceSchema.partial(),
    }),
    output: appearanceSchema,
  },
  remove: {
    input: z.object({ projectId: projectIdSchema }),
    output: z.object({ removed: z.boolean() }),
  },
});

/** Realtime channel; payload `{ projectId }`. */
export const CHANGED = "changed";

const STYLE_RULES = [
  "a SEAMLESS TILEABLE square pattern: the left edge must continue into the right edge and the top into the bottom, with no motif cut off unevenly",
  "strictly monochrome: pure black line art on a pure flat white background",
  "thin, even stroke weight; no fills, no shading, no gradients, no grey tones, no texture noise",
  "small motifs evenly spaced with generous white space (roughly 70-85% of the area should stay empty white)",
  "no text, no letters, no numbers, no logos, no border, no frame",
  "calm and quiet: it will be shown at about 5% opacity as a wallpaper behind a dense code and chat UI",
];

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    provider: {
      type: "select",
      label: "Image provider",
      description: "Who draws new backgrounds. You can also pick one per generation.",
      options: [...PROVIDER_IDS],
      experimental_optionLabels: PROVIDER_LABELS,
      default: "codex",
    },
    codexPath: {
      type: "string",
      label: "Codex executable",
      description: "Name or absolute path of the Codex CLI used to generate images.",
      default: "codex",
    },
    codexModel: {
      type: "string",
      label: "Codex model",
      description: "Optional model override for the generation run (blank uses your Codex default).",
      default: "",
    },
    openaiApiKey: {
      type: "string",
      label: "OpenAI API key",
      description: "For the OpenAI provider. Falls back to the OPENAI_API_KEY environment variable.",
      secret: true,
    },
    openaiModel: {
      type: "string",
      label: "OpenAI image model",
      default: "gpt-image-2",
    },
    openaiBaseUrl: {
      type: "string",
      label: "OpenAI base URL",
      description: "Change only for an OpenAI-compatible endpoint (Azure, a proxy, a local server).",
      default: "https://api.openai.com/v1",
    },
    geminiApiKey: {
      type: "string",
      label: "Gemini API key",
      description: "For the Gemini provider. Falls back to GEMINI_API_KEY or GOOGLE_API_KEY.",
      secret: true,
    },
    geminiModel: {
      type: "string",
      label: "Gemini image model",
      default: "gemini-3.1-flash-image",
    },
    geminiBaseUrl: {
      type: "string",
      label: "Gemini base URL",
      default: "https://generativelanguage.googleapis.com",
    },
    imageCommand: {
      type: "string",
      label: "Custom image command",
      description:
        "For the custom command provider. Runs in /bin/sh in the project folder; read the prompt from $BACKDROP_PROMPT and write a PNG or JPEG to $BACKDROP_OUTPUT.",
      experimental_multiline: true,
      default: "",
    },
    houseStyle: {
      type: "string",
      label: "House style",
      description: "Extra style direction added to every prompt, e.g. 'isometric', 'hand-drawn ink', 'geometric'.",
      experimental_multiline: true,
      default: "",
    },
    tileSize: {
      type: "number",
      label: "Stored tile size (px)",
      experimental_schema: z.number().int().min(128).max(1536),
      default: 768,
    },
    timeoutSeconds: {
      type: "number",
      label: "Generation timeout (seconds)",
      experimental_schema: z.number().int().min(60).max(1800),
      default: 600,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS backgrounds (
      project_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      summary TEXT NOT NULL,
      original BLOB NOT NULL,
      mask BLOB NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      coverage REAL NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `ALTER TABLE backgrounds ADD COLUMN provider TEXT NOT NULL DEFAULT ''`,
  ]);

  interface Row {
    project_id: string;
    version: number;
    prompt: string;
    summary: string;
    width: number;
    height: number;
    coverage: number;
    created_at: number;
    provider: string;
  }
  const selectMeta = db.prepare<[string], Row>(
    `SELECT project_id, version, prompt, summary, width, height, coverage, created_at, provider
       FROM backgrounds WHERE project_id = ?`,
  );
  const selectAllMeta = db.prepare<[], Row>(
    `SELECT project_id, version, prompt, summary, width, height, coverage, created_at, provider FROM backgrounds`,
  );
  const selectMask = db.prepare<[string], { mask: Buffer; version: number }>(
    `SELECT mask, version FROM backgrounds WHERE project_id = ?`,
  );
  const selectOriginal = db.prepare<[string], { original: Buffer; version: number }>(
    `SELECT original, version FROM backgrounds WHERE project_id = ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO backgrounds (project_id, version, prompt, summary, original, mask, width, height, coverage, created_at, provider)
     VALUES (@project_id, @version, @prompt, @summary, @original, @mask, @width, @height, @coverage, @created_at, @provider)
     ON CONFLICT(project_id) DO UPDATE SET
       version = excluded.version, prompt = excluded.prompt, summary = excluded.summary,
       original = excluded.original, mask = excluded.mask, width = excluded.width,
       height = excluded.height, coverage = excluded.coverage, created_at = excluded.created_at,
       provider = excluded.provider`,
  );
  const deleteRow = db.prepare(`DELETE FROM backgrounds WHERE project_id = ?`);

  const DEFAULT_APPEARANCE: Appearance = {
    enabled: true,
    opacityLight: 0.06,
    opacityDark: 0.08,
    scale: 384,
    tint: "foreground",
  };
  async function readAppearance(projectId: string): Promise<Appearance> {
    const stored = await bb.storage.kv.get<Partial<Appearance>>(`appearance:${projectId}`);
    const parsed = appearanceSchema.safeParse({ ...DEFAULT_APPEARANCE, ...stored });
    return parsed.success ? parsed.data : DEFAULT_APPEARANCE;
  }

  const base = `/api/v1/plugins/${bb.pluginId}/http`;
  async function toBackground(row: Row): Promise<Background> {
    const v = `${row.version}`;
    return {
      projectId: row.project_id,
      version: row.version,
      prompt: row.prompt,
      summary: row.summary,
      width: row.width,
      height: row.height,
      coverage: row.coverage,
      createdAt: row.created_at,
      provider: row.provider,
      imageUrl: `${base}/mask?project=${encodeURIComponent(row.project_id)}&v=${v}`,
      originalUrl: `${base}/original?project=${encodeURIComponent(row.project_id)}&v=${v}`,
      appearance: await readAppearance(row.project_id),
    };
  }
  async function getBackground(projectId: string): Promise<Background | null> {
    const row = selectMeta.get(projectId);
    return row ? toBackground(row) : null;
  }

  const notify = (projectId: string) => bb.realtime.publish(CHANGED, { projectId });

  // ---- generation jobs ----------------------------------------------------
  const jobs = new Map<string, Job & { controller: AbortController }>();
  const failures = new Map<string, Job>();

  function jobFor(projectId: string): Job | null {
    const running = jobs.get(projectId);
    if (running) {
      const { controller: _c, ...job } = running;
      return job;
    }
    return failures.get(projectId) ?? null;
  }

  function styleLines(houseStyle: string, hint: string | undefined): string[] {
    const lines = STYLE_RULES.map((rule) => `- ${rule}`);
    if (houseStyle.trim()) lines.push(`- house style: ${houseStyle.trim()}`);
    if (hint?.trim()) lines.push("", `Direction from the user (takes priority over your own motif choice): ${hint.trim()}`);
    return lines;
  }

  /** Codex is an agent with shell access: it reads the repository itself. */
  async function buildAgentPrompt(projectName: string, cwd: string | null, hint: string | undefined): Promise<string> {
    const { houseStyle } = await settings.get();
    const lines = [
      `You are designing a subtle wallpaper for the software project "${projectName}".`,
      cwd
        ? "First skim this repository to understand what it is about: read the README and the package manifest or AGENTS.md if present (at most 4 short file reads, do not explore further)."
        : "There is no local checkout; work from the project name and any notes below.",
      "Pick 3-6 simple, recognisable motifs that capture the project's subject or domain (not generic code symbols unless the project is about code).",
      "Then use your image generation tool to create exactly ONE square image with these requirements:",
      ...styleLines(houseStyle, hint),
    ];
    if (!cwd) lines.push("", "No repository is available; do not run commands.");
    lines.push(
      "",
      "Do not create, edit or delete any files. When the image is done, reply with one short sentence naming the motifs.",
    );
    return lines.join("\n");
  }

  /** Image APIs cannot read files, so the project summary goes into the prompt. */
  async function buildImagePrompt(projectName: string, cwd: string | null, hint: string | undefined): Promise<string> {
    const { houseStyle } = await settings.get();
    const context = await readProjectContext(cwd);
    const lines = [
      `A subtle repeating wallpaper pattern for a software project called "${projectName}".`,
      context
        ? `What the project is about (from its README and manifest):\n"""\n${context}\n"""`
        : "Infer the theme from the project name.",
      "Use 3-6 simple, recognisable motifs that capture the project's subject or domain (not generic code symbols unless the project is about code).",
      "Requirements:",
      ...styleLines(houseStyle, hint),
    ];
    return lines.join("\n");
  }

  async function projectInfo(projectId: string): Promise<{ name: string; cwd: string | null }> {
    const project = await bb.sdk.projects.get({ projectId });
    const sources = (project.sources ?? []) as Array<{
      type?: string;
      path?: string | null;
      isDefault?: boolean;
    }>;
    const local = [...sources]
      .sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false))
      .find((source) => source.path && existsSync(source.path));
    return { name: project.name, cwd: local?.path ?? null };
  }

  // ---- providers -----------------------------------------------------------------
  type Settings = Awaited<ReturnType<typeof settings.get>>;
  const openAiKey = (values: Settings) => (values.openaiApiKey as string | undefined)?.trim() || process.env.OPENAI_API_KEY || "";
  const geminiKey = (values: Settings) =>
    (values.geminiApiKey as string | undefined)?.trim() || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

  async function providerStatuses(): Promise<ProviderStatus[]> {
    const values = await settings.get();
    return PROVIDER_IDS.map((id): ProviderStatus => {
      const label = PROVIDER_LABELS[id];
      switch (id) {
        case "codex": {
          const path = resolveCodex(values.codexPath);
          const ready = path.includes("/") && existsSync(path);
          return { id, label, ready, detail: ready ? path : "Codex CLI not found; set the Codex executable path." };
        }
        case "openai":
          return openAiKey(values)
            ? { id, label, ready: true, detail: values.openaiModel }
            : { id, label, ready: false, detail: "Add an OpenAI API key in settings or OPENAI_API_KEY." };
        case "gemini":
          return geminiKey(values)
            ? { id, label, ready: true, detail: values.geminiModel }
            : { id, label, ready: false, detail: "Add a Gemini API key in settings or GEMINI_API_KEY." };
        case "command":
          return values.imageCommand.trim()
            ? { id, label, ready: true, detail: values.imageCommand.trim().split("\n")[0]!.slice(0, 80) }
            : { id, label, ready: false, detail: "Set the custom image command in settings." };
      }
    });
  }

  async function defaultProvider(): Promise<ProviderId> {
    const { provider } = await settings.get();
    return providerIdSchema.safeParse(provider).success ? (provider as ProviderId) : "codex";
  }

  async function drawImage(
    provider: ProviderId,
    project: { name: string; cwd: string | null },
    hint: string | undefined,
    signal: AbortSignal,
    set: (message: string) => void,
  ): Promise<GeneratedImage> {
    const values = await settings.get();
    const timeoutMs = values.timeoutSeconds * 1000;
    const cwd = project.cwd ?? tmpdir();
    if (provider === "codex") {
      set(`Codex is studying ${project.name}…`);
      const result = await generateWithCodex({
        codexPath: values.codexPath,
        model: values.codexModel,
        cwd,
        prompt: await buildAgentPrompt(project.name, project.cwd, hint),
        timeoutMs,
        signal,
        onProgress: (line) => set(line),
      });
      return { bytes: result.png, summary: result.summary };
    }
    const prompt = await buildImagePrompt(project.name, project.cwd, hint);
    const request = { prompt, cwd, timeoutMs, signal };
    switch (provider) {
      case "openai": {
        const apiKey = openAiKey(values);
        if (!apiKey) throw new Error("No OpenAI API key. Add one in Backdrop settings or set OPENAI_API_KEY.");
        set(`OpenAI ${values.openaiModel} is drawing…`);
        return generateWithOpenAi({ apiKey, model: values.openaiModel, baseUrl: values.openaiBaseUrl }, request);
      }
      case "gemini": {
        const apiKey = geminiKey(values);
        if (!apiKey) throw new Error("No Gemini API key. Add one in Backdrop settings or set GEMINI_API_KEY.");
        set(`Gemini ${values.geminiModel} is drawing…`);
        return generateWithGemini({ apiKey, model: values.geminiModel, baseUrl: values.geminiBaseUrl }, request);
      }
      case "command": {
        if (!values.imageCommand.trim()) throw new Error("Set the custom image command in Backdrop settings first.");
        set("Running your image command…");
        return generateWithCommand(values.imageCommand, request);
      }
    }
  }

  function describeSummary(provider: ProviderId, summary: string): string {
    if (summary.trim()) return summary.trim().slice(0, 500);
    return `Drawn by ${PROVIDER_LABELS[provider]}.`;
  }

  async function runGeneration(
    projectId: string,
    hint: string | undefined,
    mirror: boolean,
    provider: ProviderId,
    controller: AbortController,
  ): Promise<void> {
    const set = (message: string) => {
      const job = jobs.get(projectId);
      if (job && job.controller === controller) {
        job.message = message.slice(0, 300);
        notify(projectId);
      }
    };
    try {
      const project = await projectInfo(projectId);
      const result = await drawImage(provider, project, hint, controller.signal, set);
      const { tileSize } = await settings.get();
      set("Making the image transparent…");
      const mask = toInkMask(result.bytes, { size: tileSize, mirror, invert: false });
      if (mask.coverage < 0.002) throw new Error("The generated image came out blank.");
      const previous = selectMeta.get(projectId);
      upsert.run({
        project_id: projectId,
        version: (previous?.version ?? 0) + 1,
        prompt: hint?.trim() ?? "",
        summary: describeSummary(provider, result.summary),
        original: toPng(result.bytes),
        mask: mask.png,
        width: mask.width,
        height: mask.height,
        coverage: mask.coverage,
        created_at: Date.now(),
        provider,
      });
      failures.delete(projectId);
      bb.log.info(`generated background for ${projectId} with ${provider} (${mask.width}x${mask.height})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bb.log.warn(`generation failed for ${projectId} with ${provider}: ${message}`);
      failures.set(projectId, { status: "failed", startedAt: Date.now(), message });
    } finally {
      if (jobs.get(projectId)?.controller === controller) jobs.delete(projectId);
      notify(projectId);
    }
  }

  async function startGeneration(
    projectId: string,
    hint?: string,
    mirror = false,
    provider?: ProviderId,
  ): Promise<boolean> {
    if (jobs.has(projectId)) return false;
    const chosen = provider ?? (await defaultProvider());
    if (jobs.has(projectId)) return false;
    const controller = new AbortController();
    jobs.set(projectId, {
      status: "running",
      startedAt: Date.now(),
      message: `Starting ${PROVIDER_LABELS[chosen]}…`,
      controller,
    });
    failures.delete(projectId);
    notify(projectId);
    void runGeneration(projectId, hint, mirror, chosen, controller);
    return true;
  }

  /** Waits for a running job; used by the CLI so agents get a final answer. */
  async function waitFor(projectId: string, signal?: AbortSignal): Promise<void> {
    while (jobs.has(projectId) && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  bb.onDispose(() => {
    for (const job of jobs.values()) job.controller.abort();
  });

  // ---- image routes --------------------------------------------------------
  const pngResponse = (bytes: Buffer) =>
    new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "image/png",
        // Versioned URLs: a new generation changes ?v=, so cache hard.
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  bb.http.route("GET", "/mask", (c) => {
    const id = c.req.query("project") ?? "";
    const row = projectIdSchema.safeParse(id).success ? selectMask.get(id) : undefined;
    return row ? pngResponse(row.mask) : new Response("not found", { status: 404 });
  });
  bb.http.route("GET", "/original", (c) => {
    const id = c.req.query("project") ?? "";
    const row = projectIdSchema.safeParse(id).success ? selectOriginal.get(id) : undefined;
    return row ? pngResponse(row.original) : new Response("not found", { status: 404 });
  });

  // ---- RPC -------------------------------------------------------------------
  const threadProject = new Map<string, string>();
  async function projectForThread(threadId: string): Promise<string | null> {
    const cached = threadProject.get(threadId);
    if (cached) return cached;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      const projectId = (thread as { projectId?: string }).projectId ?? null;
      if (projectId) threadProject.set(threadId, projectId);
      return projectId;
    } catch {
      return null;
    }
  }

  async function listStates(): Promise<ProjectState[]> {
    const projects = (await bb.sdk.projects.list({ includePersonal: true })) as Array<{
      id: string;
      name: string;
    }>;
    const rows = new Map(selectAllMeta.all().map((row) => [row.project_id, row]));
    return Promise.all(
      projects.map(async (project) => {
        const row = rows.get(project.id);
        return {
          projectId: project.id,
          projectName: project.name,
          background: row ? await toBackground(row) : null,
          job: jobFor(project.id),
        };
      }),
    );
  }

  bb.rpc.register(rpcContract, {
    async resolve({ projectId, threadId }) {
      const id = projectId ?? (threadId ? await projectForThread(threadId) : null);
      return { projectId: id, background: id ? await getBackground(id) : null };
    },
    async list() {
      return { projects: await listStates() };
    },
    async providers() {
      return { defaultProvider: await defaultProvider(), providers: await providerStatuses() };
    },
    async generate({ projectId, hint, mirror, provider }) {
      return { started: await startGeneration(projectId, hint, mirror ?? false, provider) };
    },
    cancel({ projectId }) {
      const job = jobs.get(projectId);
      job?.controller.abort();
      return { cancelled: job !== undefined };
    },
    async setAppearance({ projectId, appearance }) {
      const next = appearanceSchema.parse({ ...(await readAppearance(projectId)), ...appearance });
      await bb.storage.kv.set(`appearance:${projectId}`, next);
      notify(projectId);
      return next;
    },
    async remove({ projectId }) {
      const removed = deleteRow.run(projectId).changes > 0;
      await bb.storage.kv.delete(`appearance:${projectId}`);
      failures.delete(projectId);
      notify(projectId);
      return { removed };
    },
  });

  // ---- CLI -------------------------------------------------------------------
  const usage = [
    "Usage:",
    "  bb backdrop list [--json]",
    "  bb backdrop show [--project <id>] [--json]",
    "  bb backdrop generate [--project <id>] [--provider codex|openai|gemini|command] [--hint <text>] [--mirror] [--no-wait] [--json]",
    "  bb backdrop providers [--json]",
    "  bb backdrop import <png-path> [--project <id>] [--invert] [--mirror] [--json]",
    "  bb backdrop set [--project <id>] [--opacity-light N] [--opacity-dark N] [--scale PX] [--tint foreground|primary|muted] [--on|--off]",
    "  bb backdrop remove [--project <id>]",
    "",
    "--project defaults to the current thread's project.",
  ].join("\n");

  function parseFlags(argv: string[]) {
    const flags = new Map<string, string | true>();
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (!arg.startsWith("--")) {
        positional.push(arg);
        continue;
      }
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") &&
        ["project", "hint", "opacity-light", "opacity-dark", "scale", "tint", "provider"].includes(arg.slice(2))) {
        flags.set(arg.slice(2), argv[++i]!);
      } else {
        flags.set(arg.slice(2), true);
      }
    }
    return { flags, positional };
  }

  const describe = (state: { projectId: string; background: Background | null; job: Job | null }) => {
    const parts = [state.projectId];
    if (state.background) {
      const a = state.background.appearance;
      parts.push(
        `v${state.background.version} ${a.enabled ? "on" : "off"}`,
        `opacity ${a.opacityLight}/${a.opacityDark}`,
        `scale ${a.scale}px`,
        `tint ${a.tint}`,
        state.background.provider ? `via ${state.background.provider}` : "",
        state.background.summary ? `— ${state.background.summary}` : "",
      );
    } else parts.push("no background");
    if (state.job) parts.push(`[${state.job.status}: ${state.job.message}]`);
    return parts.filter(Boolean).join("  ");
  };

  bb.cli.register({
    name: bb.pluginId,
    summary: "Generate and manage per-project thread backgrounds",
    commands: [
      { name: "list", summary: "List projects and their backgrounds", usage: "bb backdrop list [--json]" },
      { name: "show", summary: "Show one project's background", usage: "bb backdrop show [--project <id>] [--json]" },
      {
        name: "generate",
        summary: "Generate a background from the project's context (Codex, OpenAI, Gemini, or a custom command)",
        usage: "bb backdrop generate [--project <id>] [--provider codex|openai|gemini|command] [--hint <text>] [--mirror] [--no-wait] [--json]",
      },
      {
        name: "providers",
        summary: "Show which image providers are ready and which is the default",
        usage: "bb backdrop providers [--json]",
      },
      {
        name: "import",
        summary: "Use an existing black-on-white PNG as the background",
        usage: "bb backdrop import <png-path> [--project <id>] [--invert] [--mirror] [--json]",
      },
      {
        name: "set",
        summary: "Change opacity, scale, tint, or turn the background on/off",
        usage: "bb backdrop set [--project <id>] [--opacity-light N] [--opacity-dark N] [--scale PX] [--tint foreground|primary|muted] [--on|--off]",
      },
      { name: "remove", summary: "Delete a project's background", usage: "bb backdrop remove [--project <id>]" },
    ],
    async run(argv, context) {
      const { flags, positional } = parseFlags(argv);
      const json = flags.has("json");
      const [command, ...rest] = positional;
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });

      async function targetProject(): Promise<string | null> {
        const flag = flags.get("project");
        if (typeof flag === "string") return flag;
        if (context?.projectId) return context.projectId;
        if (context?.threadId) return projectForThread(context.threadId);
        return null;
      }

      switch (command) {
        case undefined:
        case "help":
          return { exitCode: 0, stdout: usage };
        case "providers": {
          const [statuses, chosen] = await Promise.all([providerStatuses(), defaultProvider()]);
          return reply(
            { defaultProvider: chosen, providers: statuses },
            statuses
              .map((p) => `${p.id === chosen ? "*" : " "} ${p.id.padEnd(8)} ${p.ready ? "ready  " : "not set"}  ${p.detail}`)
              .join("\n"),
          );
        }
        case "list": {
          const states = await listStates();
          return reply(
            states,
            states.map((s) => `${s.projectName.padEnd(24)} ${describe(s)}`).join("\n"),
          );
        }
      }

      const projectId = await targetProject();
      if (!projectId || !projectIdSchema.safeParse(projectId).success) {
        return fail("No project. Pass --project <proj_id> (see `bb backdrop list`).");
      }

      switch (command) {
        case "show": {
          const state = { projectId, background: await getBackground(projectId), job: jobFor(projectId) };
          return reply(state, describe(state));
        }
        case "generate": {
          const hint = typeof flags.get("hint") === "string" ? (flags.get("hint") as string) : undefined;
          const providerFlag = flags.get("provider");
          let provider: ProviderId | undefined;
          if (typeof providerFlag === "string") {
            const parsed = providerIdSchema.safeParse(providerFlag);
            if (!parsed.success) return fail(`Unknown provider "${providerFlag}". Use one of: ${PROVIDER_IDS.join(", ")}.`);
            provider = parsed.data;
          }
          const started = await startGeneration(projectId, hint, flags.has("mirror"), provider);
          if (flags.has("no-wait")) {
            return reply({ started }, started ? "Generation started." : "A generation is already running.");
          }
          await waitFor(projectId, context?.signal);
          const state = { projectId, background: await getBackground(projectId), job: jobFor(projectId) };
          if (state.job?.status === "failed") return fail(`Generation failed: ${state.job.message}`);
          return reply(state, describe(state));
        }
        case "import": {
          const path = rest[0];
          if (!path) return fail(usage);
          const bytes = await readFile(path).catch(() => null);
          if (!bytes || !isSupportedImage(bytes)) return fail(`${path} is not a readable PNG or JPEG.`);
          const { tileSize } = await settings.get();
          const mask = toInkMask(bytes, {
            size: tileSize,
            mirror: flags.has("mirror"),
            invert: flags.has("invert"),
          });
          const previous = selectMeta.get(projectId);
          upsert.run({
            project_id: projectId,
            version: (previous?.version ?? 0) + 1,
            prompt: "",
            summary: `Imported from ${path}`.slice(0, 500),
            original: toPng(bytes),
            mask: mask.png,
            width: mask.width,
            height: mask.height,
            coverage: mask.coverage,
            created_at: Date.now(),
            provider: "",
          });
          notify(projectId);
          const state = { projectId, background: await getBackground(projectId), job: null };
          return reply(state, describe(state));
        }
        case "set": {
          const patch: Partial<Appearance> = {};
          const num = (key: string) => {
            const value = flags.get(key);
            return typeof value === "string" ? Number(value) : undefined;
          };
          if (num("opacity-light") !== undefined) patch.opacityLight = num("opacity-light");
          if (num("opacity-dark") !== undefined) patch.opacityDark = num("opacity-dark");
          if (num("scale") !== undefined) patch.scale = Math.round(num("scale")!);
          const tint = flags.get("tint");
          if (typeof tint === "string") patch.tint = tint as Appearance["tint"];
          if (flags.has("on")) patch.enabled = true;
          if (flags.has("off")) patch.enabled = false;
          const parsed = appearanceSchema.safeParse({ ...(await readAppearance(projectId)), ...patch });
          if (!parsed.success) return fail(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
          await bb.storage.kv.set(`appearance:${projectId}`, parsed.data);
          notify(projectId);
          return reply(parsed.data, `Updated ${projectId}.`);
        }
        case "remove": {
          const removed = deleteRow.run(projectId).changes > 0;
          await bb.storage.kv.delete(`appearance:${projectId}`);
          notify(projectId);
          return reply({ removed }, removed ? `Removed background for ${projectId}.` : "Nothing to remove.");
        }
      }
      return fail(usage);
    },
  });
}
