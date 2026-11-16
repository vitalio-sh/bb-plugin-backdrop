---
name: backdrop
description: Generate or change the background pattern bb shows behind a project's threads. Use when the user asks for a project wallpaper, thread background, or to regenerate, hide, fade, or remove it.
---

# Project backgrounds (`bb backdrop`)

The Backdrop plugin stores one background per bb project. An image provider
draws a seamless black-on-white pattern from the project's README and
manifest: Codex CLI (default), the OpenAI Images API, the Google Gemini API,
or a custom shell command. The plugin turns it into a transparent mask,
and bb paints it behind every thread and subthread of that project, tinted
with the theme's text colour, so it works in light and dark mode.

`--project` defaults to the current thread's project.

```sh
bb backdrop list                          # every project and its background
bb backdrop show                          # this project's background
bb backdrop providers                     # which providers are ready; * marks the default
bb backdrop generate                      # the default provider draws one (waits)
bb backdrop generate --provider gemini    # codex | openai | gemini | command
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
- Generation runs on the bb server's machine. Run `bb backdrop providers`
  first; a provider marked "not set" needs the user's setup, so tell them
  what it says instead of retrying:
  - codex: `bb plugin config backdrop set codexPath /absolute/path/to/codex`
  - openai / gemini: an API key in Settings → Backdrop (secret fields), or
    `OPENAI_API_KEY` / `GEMINI_API_KEY` in the server's environment. Never
    ask for a key in chat or pass one on a command line.
  - command: `bb plugin config backdrop set imageCommand '<shell command>'`.
    The command reads `$BACKDROP_PROMPT` and writes a PNG or JPEG to
    `$BACKDROP_OUTPUT`; its last stdout line becomes the description.
- Change the default with `bb plugin config backdrop set provider <id>`.
- Users manage the same settings under Settings → Backdrop → Project
  backgrounds, or from any thread's menu → Project background.
