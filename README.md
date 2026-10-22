# context_bar_4_antigravity

Shows the context-window usage of the current conversation (e.g. `Ctx 151.6k/256.0k (59%)`) as small text next to the chat composer in **Antigravity 2.0**. Turns yellow at 70%, red at 90%; hover for the last step's status (done / error / waiting).

## How it works
- `ctx.py` reads `~/.gemini/antigravity*/conversations/<id>.db` (read-only) and extracts token usage from the `gen_metadata` protobuf (`field 1 → 9 → 10`: subfield 1 = used, 4 = limit). The layout is reverse-engineered and may change between versions.
- `inject.mjs` attaches to the app's Chrome DevTools port (from `%APPDATA%/Antigravity/DevToolsActivePort`) and inserts the text into the composer footer. No app files are modified.
- Run as a **sidecar**, Antigravity starts it with the app; it exits ~20 s after the app closes.

## Install (sidecar, recommended)
Requires Node.js and Python in `PATH`.
1. Copy `sidecar/` to `~/.gemini/config/sidecars/show-context/`.
2. Enable **Show Context** in Antigravity's Automations dashboard (ask the agent for the `sidecar://dashboard` link).
3. Or run `sidecar/start.bat` manually.

## VS Code / Antigravity IDE
`extension/` is a minimal status-bar extension (needs a VS Code extension host; does not work in Antigravity 2.0). Copy it to `~/.antigravity/extensions/local.show-context-0.0.1` or `~/.vscode/extensions/`.

## Caveats
Unofficial: relies on undocumented DB layout and UI DOM structure; may break on app updates.
