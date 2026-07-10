# Bevia Navigator

The cartographic overlay for Obsidian. Stands beside your note and shows what Bevia has been thinking about — the territories your writing connects to, the landmarks it touches, the people (and AI partners) who built it with you.

## What it does

When you open a note in Obsidian:

1. **Intake** — the Navigator reads the note's title and first paragraph and ships them to Bevia's `/note-context` endpoint.
2. **Projection** — Bevia returns the territories, landmarks, and contributors that match. The Navigator renders them in a side panel.

The cybernetic loop closes at *source*: you write → Bevia notices → Bevia surfaces what your writing connects to → you remember something you'd forgotten → the essay changes → the changed essay becomes new substrate → the map updates → the projection updates.

That's the Navigator. It's not a dashboard about your notes. It's a map wrapping around the specific place you're currently standing.

## Doctrine — what this plugin will and won't do

Per `CLAUDE.md § Projection-as-stage`:

- **Bevia never edits your notes.** Sources are immutable. The plugin reads what Obsidian's API exposes; everything it writes lands inside the `Bevia/` folder it owns — the synced map, plus the worksites it opens for you under `Bevia/5 Workspace` (which are yours from the moment they're created and are never overwritten or removed). Your own files are never touched.
- **The Navigator is bidirectional** — both intake AND projection — but the intake side respects the source rule absolutely.
- **You control the loop.** Disable auto-update in settings, clear the token, or close the panel to stop observation.
- **The map is Bevia's understanding, not your vault.** Two layers: your thinking (the notes), Bevia's understanding (the territories). They sit side by side. They influence each other through the changes *you* make.

## Install (manual, pre-community-plugin)

1. Build: `npm install && npm run build` from this directory.
2. In your vault, create `.obsidian/plugins/bevia-navigator/`.
3. Copy `manifest.json`, `main.js`, and `styles.css` into it.
4. Reload Obsidian. In Settings → Community plugins, enable **Bevia Navigator**.
5. Open Settings → Bevia Navigator and paste your Bevia token (from the Bevia web app → Account → Connect Desktop & MCP).
6. Click the compass icon in the ribbon or run *Open Bevia Navigator* from the command palette.

## Settings

| Setting | What it does |
|---|---|
| **Bevia URL** | Your Bevia instance. Defaults to production. Override for self-host or staging. |
| **Bevia token** | Paste from `Bevia → Account → Connect Desktop & MCP`. Stored in vault config; treated as a secret. |
| **Auto-update on note change** | When on, the sidebar refreshes whenever you open a different note. Turn off for manual refresh only. |

## Roadmap

- v0.1 (this release) — title + excerpt match, basic territory + landmark + contributor render
- v0.2 — manual refresh button, error handling polish, embed-link rendering
- v0.3 — community plugin store submission, full plugin API alignment
- Later — note-level navigation (click a territory to open the Bevia Territory Explorer), source-attribution drill-down, weather indicators

## License

UNLICENSED — see the parent repository.
