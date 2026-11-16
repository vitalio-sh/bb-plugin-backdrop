---
name: backdrop
description: Generate or change the background pattern bb shows behind a project's threads. Use when the user asks for a project wallpaper, thread background, or to regenerate, hide, fade, or remove it.
---

# Project backgrounds (`bb backdrop`)

The Backdrop plugin stores one background per bb project. Codex reads the
project (README, manifest, AGENTS.md), picks a few motifs, and draws a
seamless black-on-white pattern. The plugin turns it into a transparent mask,
and bb paints it behind every thread and subthread of that project, tinted
with the theme's text colour, so it works in light and dark mode.

`--project` defaults to the current thread's project.

```sh
bb backdrop list                          # every project and its background
bb backdrop show                          # this project's background
bb backdrop generate                      # Codex draws one (about a minute; waits)
bb backdrop generate --hint "constellations, thin lines"
bb backdrop generate --mirror             # mirror the tile 2x2 to force clean seams
bb backdrop import ./pattern.png [--invert] [--mirror]   # use your own black-on-white PNG
bb backdrop set --opacity-light 0.05 --opacity-dark 0.08 --scale 384 --tint foreground
bb backdrop set --off                     # hide without deleting (--on to show)
bb backdrop remove
```

- Opacities are 0–0.5 (a fraction, not a percent). 0.04–0.10 reads as a
  quiet wallpaper. Tints: `foreground` (text colour), `muted`, `primary`.
- `--scale` is the on-screen tile edge in CSS pixels (64–2048).
- Generation runs on the bb server's machine with the user's Codex login. If
  it fails with "Could not start Codex", set the path:
  `bb plugin config backdrop set codexPath /absolute/path/to/codex`.
- Users manage the same settings under Settings → Backdrop → Project
  backgrounds, or from any thread's menu → Project background.
