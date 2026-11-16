// bb-plugin-backdrop — frontend.
//
// 1. BackdropLayer (app overlay, renders nothing): follows the current route's
//    project and writes one <style> that paints the project's pattern behind
//    the main pane, the area every thread and subthread shows in. The pattern
//    is a CSS mask filled with a theme colour, so it follows light/dark mode.
// 2. A settings section listing every project with generate/tune controls.
// 3. A "Background" entry in every thread's menu.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS,
  experimental_useCodeTheme,
  experimental_usePluginId,
  useBbContext,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Appearance, Background, ProjectState, ProviderStatus, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const TINT_VAR: Record<Appearance["tint"], string> = {
  foreground: "var(--foreground)",
  primary: "var(--primary)",
  muted: "var(--muted-foreground)",
};

/** The CSS that paints a background behind `selector`. */
function backdropCss(selector: string, background: Background, dark: boolean): string {
  const a = background.appearance;
  const url = JSON.stringify(background.imageUrl);
  const size = `${a.scale}px ${Math.round((a.scale * background.height) / background.width)}px`;
  const opacity = dark ? a.opacityDark : a.opacityLight;
  return `
${selector} { isolation: isolate; }
${selector}::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-color: ${TINT_VAR[a.tint]};
  opacity: ${opacity};
  -webkit-mask-image: url(${url});
  mask-image: url(${url});
  -webkit-mask-repeat: repeat;
  mask-repeat: repeat;
  -webkit-mask-size: ${size};
  mask-size: ${size};
  -webkit-mask-position: 0 0;
  mask-position: 0 0;
}`;
}

/** Plugin-owned glyphs are namespaced by plugin id; a renamed fork keeps working. */
function useGlyph(): (name: string) => string {
  const pluginId = experimental_usePluginId();
  return useCallback((name: string) => `${pluginId}/${name}`, [pluginId]);
}

type ProviderId = ProviderStatus["id"];

function useProviders() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ defaultProvider: ProviderId; providers: ProviderStatus[] } | null>(null);
  const refetch = useCallback(() => {
    rpc.call("providers").then(setState, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  return { state, refetch };
}

function useDarkMode(): boolean {
  return experimental_useCodeTheme().mode === "dark";
}

function BackdropLayer() {
  const { projectId, threadId } = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const pluginId = experimental_usePluginId();
  const dark = useDarkMode();
  const connection = useRealtimeConnectionState();
  const [resolved, setResolved] = useState<{ projectId: string | null; background: Background | null }>({
    projectId: null,
    background: null,
  });

  const refetch = useCallback(() => {
    if (!projectId && !threadId) {
      setResolved({ projectId: null, background: null });
      return;
    }
    rpc.call("resolve", { projectId, threadId }).then(setResolved, () => undefined);
  }, [rpc, projectId, threadId]);

  useEffect(refetch, [refetch]);
  useEffect(() => {
    if (connection === "connected") refetch();
  }, [connection, refetch]);
  useRealtime("changed", (payload) => {
    const changed = (payload as { projectId?: string } | null)?.projectId;
    if (!changed || changed === resolved.projectId || !resolved.projectId) refetch();
  });

  const background = resolved.background;
  useEffect(() => {
    if (!background || !background.appearance.enabled) return;
    const style = document.createElement("style");
    style.dataset.bbPlugin = pluginId;
    style.textContent = backdropCss('main[data-sidebar="inset"]', background, dark);
    document.head.appendChild(style);
    return () => style.remove();
  }, [background, dark, pluginId]);

  return null;
}

// ---- data hook shared by settings and the thread menu ---------------------

function useProjectStates() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<ProjectState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("list").then(
      (result) => {
        setProjects(result.projects);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("changed", refetch);
  return { rpc, projects, error, refetch };
}

// ---- settings section -----------------------------------------------------

function Preview({ background, dark, className }: { background: Background; dark: boolean; className?: string }) {
  const a = background.appearance;
  const style: CSSProperties = {
    backgroundColor: TINT_VAR[a.tint],
    WebkitMaskImage: `url(${JSON.stringify(background.imageUrl)})`,
    maskImage: `url(${JSON.stringify(background.imageUrl)})`,
    WebkitMaskRepeat: "repeat",
    maskRepeat: "repeat",
    WebkitMaskSize: `${a.scale / 2}px auto`,
    maskSize: `${a.scale / 2}px auto`,
    // Previews are shown stronger than the live wallpaper so you can see them.
    opacity: Math.min(1, (dark ? a.opacityDark : a.opacityLight) * 5),
  };
  return (
    <div className={cn("relative overflow-hidden rounded-md border border-border bg-background", className)}>
      <div className="absolute inset-0" style={style} />
    </div>
  );
}

function Range({
  label,
  value,
  min,
  max,
  step,
  format,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="w-24 shrink-0">{label}</span>
      <input
        type="range"
        className="h-1 min-w-0 flex-1 accent-[var(--primary)]"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={() => onCommit(draft)}
        onKeyUp={() => onCommit(draft)}
      />
      <span className="w-12 shrink-0 text-right tabular-nums text-foreground">{format(draft)}</span>
    </label>
  );
}

function elapsed(since: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function ProjectRow({
  state,
  dark,
  current,
  provider,
  providerLabels,
}: {
  state: ProjectState;
  dark: boolean;
  current: boolean;
  provider: ProviderId | null;
  providerLabels: Map<string, string>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const glyph = useGlyph();
  const [hint, setHint] = useState("");
  const [mirror, setMirror] = useState(false);
  const [, tick] = useState(0);
  const running = state.job?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const background = state.background;
  const appearance = background?.appearance;
  const set = (patch: Partial<Appearance>) => {
    rpc
      .call("setAppearance", { projectId: state.projectId, appearance: patch })
      .catch((cause: unknown) => toast.error(String(cause)));
  };
  const generate = () => {
    rpc
      // bb's RPC client refuses `undefined` values, so leave unset fields out.
      .call("generate", {
        projectId: state.projectId,
        mirror,
        ...(hint.trim() ? { hint: hint.trim() } : {}),
        ...(provider ? { provider } : {}),
      })
      .then(
        ({ started }) => {
          if (!started) toast.message("A generation is already running for this project.");
        },
        (cause: unknown) => toast.error(String(cause)),
      );
  };

  return (
    <li className="flex gap-4 py-4">
      {background ? (
        <Preview background={background} dark={dark} className="size-28 shrink-0" />
      ) : (
        <div className="flex size-28 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground">
          <Icon name={glyph("image")} className="size-5" />
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{state.projectName}</span>
          {current ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              current
            </span>
          ) : null}
          {background && !appearance?.enabled ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              off
            </span>
          ) : null}
        </div>
        {background?.summary ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {background.summary}
            {background.provider ? (
              <span className="text-muted-foreground/70">
                {" "}
                · {providerLabels.get(background.provider) ?? background.provider}
              </span>
            ) : null}
          </p>
        ) : null}

        {running ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon name="Loading" className="size-3.5 animate-spin" />
            <span className="min-w-0 flex-1 truncate">
              {state.job?.message} · {elapsed(state.job!.startedAt)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void rpc.call("cancel", { projectId: state.projectId })}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 min-w-48 flex-1 text-xs"
              value={hint}
              onChange={(event) => setHint(event.target.value)}
              placeholder="Optional direction, e.g. 'constellations', 'botanical'"
              aria-label={`Direction for ${state.projectName}`}
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
              Force seamless
            </label>
            <Button size="sm" onClick={generate}>
              <Icon name={glyph("sparkles")} className="size-3.5" />
              {background ? "Regenerate" : "Generate"}
            </Button>
          </div>
        )}
        {state.job?.status === "failed" ? (
          <p role="alert" className="text-xs text-destructive">
            {state.job.message}
          </p>
        ) : null}

        {background && appearance ? (
          <div className="space-y-1.5 pt-1">
            <Range
              label="Day opacity"
              value={appearance.opacityLight}
              min={0}
              max={0.3}
              step={0.005}
              format={(v) => `${Math.round(v * 1000) / 10}%`}
              onCommit={(v) => set({ opacityLight: v })}
            />
            <Range
              label="Night opacity"
              value={appearance.opacityDark}
              min={0}
              max={0.3}
              step={0.005}
              format={(v) => `${Math.round(v * 1000) / 10}%`}
              onCommit={(v) => set({ opacityDark: v })}
            />
            <Range
              label="Pattern size"
              value={appearance.scale}
              min={128}
              max={1200}
              step={16}
              format={(v) => `${v}px`}
              onCommit={(v) => set({ scale: v })}
            />
            <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-muted-foreground">
              <span className="w-24 shrink-0">Tint</span>
              {(["foreground", "muted", "primary"] as const).map((tint) => (
                <label key={tint} className="flex items-center gap-1">
                  <input
                    type="radio"
                    name={`tint-${state.projectId}`}
                    checked={appearance.tint === tint}
                    onChange={() => set({ tint })}
                  />
                  {tint === "foreground" ? "Text" : tint === "muted" ? "Muted" : "Accent"}
                </label>
              ))}
              <span className="flex-1" />
              <Button variant="ghost" size="sm" onClick={() => set({ enabled: !appearance.enabled })}>
                <Icon name={glyph(appearance.enabled ? "eye-off" : "eye")} className="size-3.5" />
                {appearance.enabled ? "Hide" : "Show"}
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <a href={background.originalUrl} target="_blank" rel="noreferrer">
                  <Icon name={glyph("external")} className="size-3.5" />
                  Original
                </a>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => void rpc.call("remove", { projectId: state.projectId })}
              >
                <Icon name="Trash2" className="size-3.5" />
                Remove
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function ProviderPicker({
  providers,
  value,
  onChange,
}: {
  providers: ProviderStatus[];
  value: ProviderId;
  onChange: (id: ProviderId) => void;
}) {
  const current = providers.find((p) => p.id === value);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <label htmlFor="backdrop-provider" className="text-muted-foreground">
        Draw new backgrounds with
      </label>
      <select
        id="backdrop-provider"
        className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
        value={value}
        onChange={(event) => onChange(event.target.value as ProviderId)}
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
            {p.ready ? "" : " (not set up)"}
          </option>
        ))}
      </select>
      {current ? (
        <span className={cn("min-w-0 flex-1 truncate text-xs", current.ready ? "text-muted-foreground" : "text-destructive")}>
          {current.detail}
        </span>
      ) : null}
    </div>
  );
}

function SettingsSection() {
  const { projects, error } = useProjectStates();
  const dark = useDarkMode();
  const { projectId } = useBbContext();
  const { state: providerState, refetch: refetchProviders } = useProviders();
  const [picked, setPicked] = useState<ProviderId | null>(null);
  const provider = picked ?? providerState?.defaultProvider ?? null;
  const providerLabels = useMemo(
    () => new Map((providerState?.providers ?? []).map((p) => [p.id as string, p.label])),
    [providerState],
  );
  // Settings saved above this section (API keys, command) change readiness.
  useEffect(() => {
    const onFocus = () => refetchProviders();
    window.addEventListener("focus", onFocus);
    const timer = setInterval(refetchProviders, 5000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [refetchProviders]);
  const sorted = useMemo(
    () =>
      projects
        ? [...projects].sort(
            (a, b) =>
              Number(b.background !== null || b.job !== null) - Number(a.background !== null || a.job !== null) ||
              a.projectName.localeCompare(b.projectName),
          )
        : null,
    [projects],
  );
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Each project gets a seamless monochrome pattern drawn from its README and manifest. The pattern is stored
        as a transparent mask and painted behind every thread in that project using the theme's text colour, so it
        works in day and night themes. Agents can do the same with <code>bb backdrop generate</code>.
      </p>
      {providerState && provider ? (
        <ProviderPicker providers={providerState.providers} value={provider} onChange={setPicked} />
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {sorted === null ? (
        <Empty>Loading projects…</Empty>
      ) : sorted.length === 0 ? (
        <Empty>No projects yet.</Empty>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card px-4">
          {sorted.map((state) => (
            <ProjectRow
              key={state.projectId}
              state={state}
              dark={dark}
              current={state.projectId === projectId}
              provider={provider}
              providerLabels={providerLabels}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- thread menu ----------------------------------------------------------

interface MenuData {
  states: Map<string, ProjectState>;
  glyph: (name: string) => string;
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>;
}

function useMenuData(): MenuData {
  const { projects, rpc } = useProjectStates();
  const glyph = useGlyph();
  return useMemo(
    () => ({ states: new Map((projects ?? []).map((p) => [p.projectId, p])), rpc, glyph }),
    [projects, rpc, glyph],
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "backdrop-layer", component: BackdropLayer });

  app.slots.settingsSection({
    id: "projects",
    title: "Project backgrounds",
    component: SettingsSection,
  });

  app.slots.experimental_threadAction<MenuData>({
    id: "background",
    title: "Project background",
    icon: "backdrop/image",
    group: experimental_THREAD_ACTION_GROUPS.settings,
    order: 50,
    useData: () => useMenuData(),
    item: ({ thread, data }) => {
      const { rpc, glyph } = data;
      const state = data.states.get(thread.projectId);
      const background = state?.background ?? null;
      const running = state?.job?.status === "running";
      const items = running
        ? [{ id: "cancel", label: "Cancel generation", icon: "X" }]
        : [
            { id: "generate", label: background ? "Regenerate from project" : "Generate from project", icon: glyph("sparkles") },
            ...(background
              ? [
                  background.appearance.enabled
                    ? { id: "off", label: "Hide background", icon: glyph("eye-off") }
                    : { id: "on", label: "Show background", icon: glyph("eye") },
                  { id: "remove", label: "Remove background", icon: "Trash2" },
                ]
              : []),
          ];
      return {
        label: "Project background",
        icon: glyph("image"),
        detail: running ? "Generating…" : background ? (background.appearance.enabled ? "On" : "Off") : "None",
        choices: { items },
        run: async ({ value }) => {
          const projectId = thread.projectId;
          try {
            if (value === "generate") {
              await rpc.call("generate", { projectId });
              toast.message("Codex is drawing a background for this project. It takes about a minute.");
            } else if (value === "cancel") await rpc.call("cancel", { projectId });
            else if (value === "on" || value === "off")
              await rpc.call("setAppearance", { projectId, appearance: { enabled: value === "on" } });
            else if (value === "remove") await rpc.call("remove", { projectId });
          } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : String(cause));
          }
        },
      };
    },
  });
});
