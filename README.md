# Backdrop — per-project thread backgrounds for bb

Codex reads each project and draws a seamless monochrome pattern for it.
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

## How it works

1. `codex exec --json --sandbox read-only --enable image_generation` runs in the
   project's local checkout. It skims the README/manifest and generates one
   black-on-white seamless tile (`codex.ts`).
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
| `codexPath` | `codex` | name or absolute path of the Codex CLI |
| `codexModel` | (blank) | model override for generation |
| `houseStyle` | (blank) | style direction added to every prompt |
| `tileSize` | `768` | stored mask edge in pixels |
| `timeoutSeconds` | `600` | generation timeout |

## Develop

```sh
npm install
npm run typecheck
bb plugin install .   # or: bb plugin dev
```
