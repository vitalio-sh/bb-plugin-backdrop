# Backdrop — per-project thread backgrounds for bb

An image model reads each project and draws a seamless monochrome pattern for it.
Backdrop turns the pattern into a transparent mask and paints it behind every
thread and subthread of that project, tinted with the theme's text colour, so
the same image works in day and night themes.

It is a standalone bb plugin, so bb updates do not overwrite it.

## Use it

- **Settings → Backdrop → Project backgrounds**: generate, regenerate with a
  direction ("botanical", "constellations"), adjust day/night opacity, pattern
  size, tint, hide or remove.
- **Thread menu → Project background**: generate, hide/show, remove for the
  thread's project.
- **CLI / agents**: `bb backdrop generate`, `bb backdrop set …`; see
  `skills/backdrop/SKILL.md`.

## Image providers

| id | what it uses | setup |
| --- | --- | --- |
| `codex` (default) | Codex CLI with its image tool; Codex reads the repo itself | Codex signed in on the bb server |
| `openai` | OpenAI Images API (`gpt-image-2`) or any compatible endpoint | `openaiApiKey` setting or `OPENAI_API_KEY` |
| `gemini` | Google Gemini API (`gemini-3.1-flash-image`) | `geminiApiKey` setting or `GEMINI_API_KEY` |
| `command` | any shell command (ComfyUI, fal, Replicate, a local model) | `imageCommand`: read `$BACKDROP_PROMPT`, write PNG/JPEG to `$BACKDROP_OUTPUT` |

Pick the default with the `provider` setting, per generation in Settings, or with
`bb backdrop generate --provider <id>`. For non-Codex providers the plugin reads
the README, AGENTS.md/CLAUDE.md and the manifest itself and puts a short prose
excerpt (no code, tables, URLs or ALL_CAPS identifiers) into the prompt
(`providers.ts`).

A custom command gets the prompt only through the environment, never spliced into
the command text, so a prompt cannot inject shell syntax. Example with a local
script:

```sh
bb plugin config backdrop set provider command
bb plugin config backdrop set imageCommand 'python3 ~/bin/comfy_pattern.py --out "$BACKDROP_OUTPUT"'
```

## How it works

1. The chosen provider draws one black-on-white seamless tile. For Codex,
   `codex exec --json --sandbox read-only --enable image_generation` runs in the
   project's checkout and skims the README/manifest (`codex.ts`).
2. `image.ts` converts it to a black PNG whose alpha is the ink (levels are
   normalised so off-white paper becomes fully transparent). "Force seamless"
   mirrors the tile 2×2.
3. The original and the mask are stored in the plugin's SQLite
   (`~/.bb/plugins/backdrop/data.db`) and served from
   `/api/v1/plugins/backdrop/http/mask?project=…&v=…`.
4. `app.tsx` follows the current route's project and adds a `::before` layer
   to the main pane: `background-color: var(--foreground)` masked by the tile,
   at the day or night opacity.

## Settings

`bb plugin config backdrop set <key> <value>`

| key | default | |
| --- | --- | --- |
| `provider` | `codex` | default image provider: `codex`, `openai`, `gemini`, `command` |
| `codexPath` | `codex` | name or absolute path of the Codex CLI |
| `codexModel` | (blank) | model override for generation |
| `openaiApiKey` | (secret) | OpenAI key; falls back to `OPENAI_API_KEY` |
| `openaiModel` | `gpt-image-2` | OpenAI image model |
| `openaiBaseUrl` | `https://api.openai.com/v1` | for OpenAI-compatible endpoints |
| `geminiApiKey` | (secret) | Gemini key; falls back to `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| `geminiModel` | `gemini-3.1-flash-image` | Gemini image model |
| `geminiBaseUrl` | `https://generativelanguage.googleapis.com` | for proxies |
| `imageCommand` | (blank) | custom command provider |
| `houseStyle` | (blank) | style direction added to every prompt |
| `tileSize` | `768` | stored mask edge in pixels |
| `timeoutSeconds` | `600` | generation timeout |

## Develop

```sh
npm install
npm run typecheck
bb plugin install .   # or: bb plugin dev
```
