# Bevia Navigator

The cartographic overlay for Obsidian. Stands beside your note and shows what Bevia has been thinking about — the territories your writing connects to, the landmarks it touches, the people (and AI partners) who built it with you.

## What it does

When you open a note in Obsidian:

1. **Intake** — the Navigator reads the note's title and first paragraph and ships them to Bevia's `/note-context` endpoint.
2. **Projection** — Bevia returns the territories, landmarks, and contributors that match. The Navigator renders them in a side panel.

The cybernetic loop closes at *source*: you write → Bevia notices → Bevia surfaces what your writing connects to → you remember something you'd forgotten → the essay changes → the changed essay becomes new substrate → the map updates → the projection updates.

That's the Navigator. It's not a dashboard about your notes. It's a map wrapping around the specific place you're currently standing.

## Disclosures — network use, account, and payment

Please read before installing:

- **Network use.** This plugin sends data over the network to a remote
  Bevia server. It contacts **only** the host configured in the **Bevia
  URL** setting — by default `https://qjxotoeviqlfazjcwask.supabase.co`
  (Bevia's hosted Supabase Edge Functions) — and the Bevia web app at
  `https://bevia.co`. It makes **no** other network calls: no telemetry,
  no third-party analytics, no ads. What is uploaded to each endpoint is
  itemized in [Network use](#network-use) below.
- **Account required.** The core features (the Navigator side panel, Ask,
  and Living Atlas vault sync) require a **Bevia account**. You paste an
  access token from the Bevia web app; without a valid token these
  features do nothing.
- **Paid service.** A Bevia account is a **paid subscription** (see
  <https://bevia.co/pricing>). This plugin is a client for that hosted
  service — it is free to install, but the service it connects to is not.
  The one exception is the free **“Analyze my vault”** Discovery preview,
  which runs **anonymously with no account and no token**.
- **What Bevia writes.** Bevia only writes inside its own `Bevia/` folder.
  It never edits your existing notes. Vault sync can remove Bevia-authored
  notes it no longer recognizes, but only files carrying a Bevia
  frontmatter marker, and removals go to your system trash (recoverable) —
  your own notes are never deleted, even under a same-named folder.

## Doctrine — what this plugin will and won't do

Per `CLAUDE.md § Projection-as-stage`:

- **Bevia never edits your notes.** Sources are immutable. The plugin reads what Obsidian's API exposes; everything it writes lands inside the `Bevia/` folder it owns — the synced map, plus the worksites it opens for you under `Bevia/5 Workspace` (which are yours from the moment they're created and are never overwritten or removed). Your own files are never touched.
- **The Navigator is bidirectional** — both intake AND projection — but the intake side respects the source rule absolutely.
- **You control the loop.** Disable auto-update in settings, clear the token, or close the panel to stop observation.
- **The map is Bevia's understanding, not your vault.** Two layers: your thinking (the notes), Bevia's understanding (the territories). They sit side by side. They influence each other through the changes *you* make.

## Network use

This plugin talks to a remote Bevia server. It makes no other network
calls (no telemetry, no third-party analytics). All requests go to the
host set in **Bevia URL**, which defaults to
`https://qjxotoeviqlfazjcwask.supabase.co` (Bevia's hosted Edge
Functions); the account/sign-in surface is `https://bevia.co`. You can
point **Bevia URL** at your own self-host or staging instance.

Every authenticated request carries your Bevia access token as a
`Bearer` credential. The one exception is the free "Analyze my vault"
Discovery preview, which runs anonymously.

**Endpoints called, and what is uploaded to each:**

| Endpoint (`/functions/v1/…`) | When | What leaves your vault |
|---|---|---|
| `note-context` | You open/switch a note (Navigator) | The note's **title, a first-paragraph excerpt, and its vault-relative path** |
| `instant-cartography` | "Analyze my vault" / Discovery preview | The **full body text** of a sampled set of notes (character-capped for the free preview; uncapped when you supply your own model key) |
| `instant-cartography-status` | While a Discovery map builds | The build session id (polled about every 2.5s until done) |
| `vault-intake` | Vault intake sync | The **full body text** (`content_text`) of the notes being ingested |
| `materialization-pull` | Atlas sync | Downloads your map into `Bevia/`; uploads only your token |
| `vault-sync-status` | While Atlas sync is on | A lightweight sync-signal poll (about every **20 seconds**); uploads only your token |
| `query-run` | You run a saved query | The query text |
| `molly-ask` | You use Ask | Your question plus the active note's context |
| `navigator-orientation`, `navigator-directions`, `navigator-games` | Navigator place-cards | Territory/context identifiers |
| `territory-research-dossier`, `landmark-reactivation-bundle` | Territory/landmark reads | Territory/landmark identifiers |
| `projection-scope`, `set-territory-attention`, `set-territory-share` | Projection & Control Tower controls | Territory identifiers plus the setting you changed |

**Polling cadence:** while Atlas sync is enabled the plugin does a full
pull every **N minutes** (default 10, configurable) and a small
`vault-sync-status` signal check about every **20 seconds**; a Discovery
build is polled about every **2.5 seconds** until it completes. All are
pull-shaped — the plugin asks; the server never pushes to it.

**Account requirement:** the live Navigator, Ask, and Atlas sync
features require a paid Bevia account (the token gates them). The free
"Analyze my vault" Discovery preview works with **no account** and no
token. See <https://bevia.co/pricing>.

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
