# context_bar_4_antigravity

Shows the context-window usage of the open conversation as a small pill (`▬ 43% · 110.4k`) next to the chat composer in **Antigravity 2.0**. The bar turns yellow at 70% and red at 90%; a dot appears when the last step errored or is waiting for approval.

Hover (or click to pin) for details:
- used / limit and model
- token breakdown: System Prompt, Tools, Chat Messages, free space
- usage trend over recent model calls and an estimate of calls left at the current pace
- number of context compactions, last step status and its error message

## How it works
- `inject.mjs` reads `~/.gemini/antigravity*/conversations/<id>.db` (read-only, via `node:sqlite`, re-read only when the file changes) and decodes the `gen_metadata` protobuf: `1 → 9 → 10` holds `1` = used, `3` = breakdown, `4` = limit; `1 → 19` is the model. Steps with `step_type = 23` are compactions. The layout is reverse-engineered and may change between versions.
- It also attaches to the app's Chrome DevTools port (from `%APPDATA%/Antigravity/DevToolsActivePort`) and inserts the text into the composer footer. No app files are modified.
- Run as a **sidecar**, Antigravity starts it with the app; it exits ~20 s after the app closes.

## Install (sidecar, recommended)
Requires Node.js 22.5+ in `PATH` (no Python needed).
1. Copy `sidecar/` to `~/.gemini/config/sidecars/show-context/`.
2. Enable **Show Context** in Antigravity's Automations dashboard (ask the agent for the `sidecar://dashboard` link).
3. Or run `sidecar/start.bat` manually.

## VS Code / Antigravity IDE
`extension/` is a minimal status-bar extension (uses Python) (needs a VS Code extension host; does not work in Antigravity 2.0). Copy it to `~/.antigravity/extensions/local.show-context-0.0.1` or `~/.vscode/extensions/`.

## Caveats
Unofficial: relies on undocumented DB layout and UI DOM structure; may break on app updates.
