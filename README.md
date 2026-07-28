# Bevia Navigator

Not memory. Meaning. Your vault, as a map.

Bevia runs on your own machine, reads what you think about, and writes
it back into your vault as a map you own — territory notes about YOUR
ideas, linked to the notes they grew from, in plain markdown. This
plugin is the map's home surface: a side panel that shows where the
note you're reading sits, questions answered from your own work, and
graph-view lenses that make the shape of your thinking visible.

## What it does

- **Navigator side panel** — open any note and see where it lives:
  *"This note lives in Territory X, near Y."* Answered entirely from
  the map files already in your vault — it works even when the engine
  is off.
- **Ask Bevia** — ask your map a question. The Librarian answers from
  your own notes (grounded, with the territories it drew on); the
  Consultant thinks forward. Answered by the engine on this computer.
- **Send this vault to Bevia** — your notes here become part of your
  map. Reading is one-way: the plugin never modifies your notes.
- **Graph views** — one-click color lenses for Obsidian's graph:
  structure only (the shape of your thinking), by origin (your own /
  built with AI / from reading), by activity (active / quiet /
  dormant).
- **The `Bevia/` folder** — the map itself, written by the Bevia app
  as plain markdown with working `[[wikilinks]]`. Delete it any time;
  it rebuilds. Your own notes are never touched.

## Free, and what's paid

The plugin is free. The Bevia app it pairs with is free to try —
**reading one place (this vault) is free**, and a real map compiles
from it. A Bevia Local license ($30 once, yours forever) widens the
same private engine to everything else you think in — your AI
conversations, your repos, your meetings. There is nothing to unlock
inside this plugin; it does everything it does on the free vault lane.

## Disclosures — network use, account, and payment

Please read before installing:

- **Network use.** This plugin makes **no internet requests.** Every
  network call goes to the Bevia engine on **your own machine**
  (`http://127.0.0.1:<port>`) or — only if you type one in — a
  private-LAN address on your own Wi-Fi (`10.x` / `172.16–31.x` /
  `192.168.x`), for three things: pairing, note intake, and Ask.
  Public hosts are refused in code (`sanitizeLocalHost`). No
  telemetry, no analytics, no ads. The one external link ("Get Bevia
  Local") opens `bevia.co/local` in your browser; the plugin itself
  never calls it.
- **Companion app.** The plugin needs the Bevia app running on your
  computer. Without it, the plugin shows how to get it and does
  nothing else — no request leaves the machine either way.
- **No account.** There is no sign-in and no token from a website.
  Pairing is one click against the engine on your own machine (a
  code only when pairing across your own Wi-Fi).
- **Payment.** The app's trial (this vault as the one free source) is
  free. Connecting more sources requires a Bevia Local license
  ($30 one-time) — sold on bevia.co, never inside this plugin.
- **What Bevia writes.** The Bevia app only writes inside its own
  `Bevia/` folder; it never edits your existing notes. This plugin
  writes nothing into your notes at all. The optional "Send new notes
  to the Workspace folder" setting rewrites one core Obsidian config
  value (default new-note location) and restores it when turned off.

## Endpoints called, and what leaves the vault

All requests go to the engine on your machine (or your own LAN device):

| Engine endpoint | When | What is sent |
|---|---|---|
| `/pair` · `/pair/local` | You connect the vault | The vault's name; the engine answers with this vault's own token |
| `/intake/capture` | You run "Send my vault to Bevia" | The **full body text** of your user-authored notes (Bevia's own output is skipped) |
| `/query` | You use Ask | Your question |
| `/whoami` | Settings opens (pairing health check) | Only the vault's pairing token |

The Navigator side panel itself sends **nothing** — it reads the map
files already in the vault through Obsidian's metadata cache.

## Ground rules — what this plugin will and won't do

- **Bevia never edits your notes.** Sources are immutable. Everything
  the Bevia app writes lands inside the `Bevia/` folder it owns — the
  map, plus the user-owned `Bevia/5 Workspace` (yours from the moment
  it's created; never overwritten or removed).
- **The Navigator is bidirectional** — both intake AND projection —
  but the intake side respects the source rule absolutely, and only
  runs when you tell it to.
- **You control the loop.** Disable auto-update in settings,
  disconnect the pairing, close the panel, or quit the Bevia app —
  any one of them stops everything.
- **The map is Bevia's understanding, not your vault.** Two layers:
  your thinking (the notes), Bevia's understanding (the territories).
  They sit side by side and influence each other only through the
  changes *you* make.

## Install (manual, until the community listing lands)

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   latest release.
2. Drop them into `<your vault>/.obsidian/plugins/bevia-navigator/`.
3. Enable **Bevia Navigator** in Settings → Community plugins.
4. Get the Bevia app at <https://www.bevia.co/local>, run it, and
   pair the vault from the plugin's settings — one click on the same
   machine.

## Development

```bash
npm install
npm run build   # bundles src/main.ts → main.js
```

The plugin builds with esbuild; `npm run dev` watches. Set
`BEVIA_VAULT_DIR` (or create a `.vault-dir` file) to auto-install the
build into a local vault for testing.
