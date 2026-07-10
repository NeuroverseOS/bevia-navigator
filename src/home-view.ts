// Bevia — Home Base (in-plugin front door).
//
// The one page inside Obsidian that tells a user what Bevia is, whether
// they're connected, what they can do, and how to tune what reaches the
// vault. Opens as a full tab in the main editor area (not the sidebar) —
// it's a page, not a panel. Auto-opens on load when the vault isn't
// connected yet, so a new user lands somewhere that explains itself
// instead of hunting through settings.
//
// Pure projection + controls: it reads settings and runs the same
// commands the ribbon/command-palette expose. It never modifies the
// user's notes.

import { ItemView, Notice, Setting, WorkspaceLeaf } from "obsidian";
import type BeviaNavigatorPlugin from "./main";
import { openConnectModal } from "./connect";
import { analyzeVault } from "./analyze";
import { syncAtlasNow } from "./sync";
import { sendVaultToBevia } from "./sync-vault-intake";
import { GRAPH_RECIPES, applyGraphRecipe } from "./graph-recipes";
import { openVaultWritePreview } from "./first-run";
import { renderTwoDoorPanel, openTwoDoorModal } from "./two-door";

export const BEVIA_HOME_VIEW_TYPE = "bevia-home-view";

export class BeviaHomeView extends ItemView {
  plugin: BeviaNavigatorPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: BeviaNavigatorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return BEVIA_HOME_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Bevia Home";
  }

  getIcon(): string {
    // Lucide renamed "home" → "house"; "home" renders blank on current
    // Obsidian builds. Use the canonical name.
    return "house";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    // No persistent resources.
  }

  /** Re-render — called after a connection changes so the status flips
   *  without a reload. */
  render(): void {
    const container = this.containerEl.children[1] ?? this.containerEl;
    container.empty();
    container.addClass("bevia-home");

    const wrap = container.createDiv({ cls: "bevia-home-wrap" });
    wrap.addClass("bv-u-max-width-760px");
    wrap.addClass("bv-u-margin-0-auto");
    wrap.addClass("bv-u-padding-28px-24px-64px");

    // ── The staleness line (Bevia Local spec §12.4) ──────────────────
    // ONE quiet ambient line — never a modal, never a Notice, never
    // stacked (this render is the only instance). Shown only when ALL
    // hold: a free analyze has drawn a map, the vault has no engine
    // (no cloud key), and notes have moved since the map was drawn.
    // The map's own honesty is the pitch: it's a photo, and the vault
    // has already walked out of frame.
    const lastAnalyze = this.plugin.settings.lastAnalyzeAt;
    if (
      !this.plugin.settings.token.trim() &&
      lastAnalyze &&
      vaultMovedSince(this.plugin, lastAnalyze)
    ) {
      const stale = wrap.createDiv({ cls: "bevia-staleness" });
      stale.createSpan({
        text: `This map is from ${relativeDay(lastAnalyze)}. Your thinking has moved — Bevia keeps it alive. `,
      });
      const link = stale.createEl("a", { text: "See how", href: "#" });
      link.onclick = (e) => {
        e.preventDefault();
        openTwoDoorModal(this.plugin.app, {
          onRent: () => openConnectModal(this.plugin),
          rentLabel: "Create account & connect",
        });
      };
    }

    // ── Header ──────────────────────────────────────────────────────
    wrap.createEl("div", { cls: "bevia-eyebrow", text: "BEVIA" });
    const h1 = wrap.createEl("h1", { text: "Your home base" });
    h1.addClass("bv-u-margin-6px-0-8px");
    const lede = wrap.createEl("p", {
      text:
        "Bevia watches what you think about across your tools and writes it back into this vault as a map you own. " +
        "Here's what you can do — and where to start.",
    });
    lede.addClass("bv-u-color-text-muted");
    lede.addClass("bv-u-margin-top-0");

    // "How it works" — opens the compilation-engine diagram on the web.
    const howLink = wrap.createEl("a", {
      text: "See how Bevia works →",
      href: "https://bevia.co/",
    });
    howLink.setAttr("target", "_blank");
    howLink.setAttr("rel", "noopener");
    howLink.addClass("bv-u-display-inline-block");
    howLink.addClass("bv-u-font-size-13px");
    howLink.addClass("bv-u-margin-bottom-10px");

    // ── Connection state decides the page's LEAD ─────────────────────
    // Three truthful states, not two: a token can be PRESENT and dead.
    // Before tokenHealth existed, a revoked/wrong-kind key left Home
    // saying "Connected — you're all set" while every call 401'd.
    const hasToken = !!this.plugin.settings.token.trim();
    const keyDead = hasToken && this.plugin.tokenHealth === "invalid";
    const connected = hasToken && !keyDead;

    // GOLDEN PATH (founder direction 2026-07-05): on a vault that isn't
    // connected, the ONLY button that works without a key is the free
    // Discovery run — so it leads the page as the hero, before anything
    // that needs a key. It was previously the third small card in a
    // six-card wall, below an "Ask Bevia" button that 401s without a
    // token; the founder herself couldn't find the free demo.
    if (!connected) {
      const hero = wrap.createDiv({ cls: "bevia-home-hero" });
      hero.addClass("bv-u-padding-18px-20px");
      hero.addClass("bv-u-border-radius-12px");
      hero.addClass("bv-u-border-1px-solid-background-modifier-border");
      hero.addClass("bv-u-background-background-secondary");
      hero.addClass("bv-u-margin-4px-0-18px");
      hero.createEl("h2", { text: "See this vault as a map — free" }).addClass("bv-u-margin-0-0-6px");
      const heroSub = hero.createEl("p", {
        text:
          "Bevia reads the notes already here and draws your first map — the ideas, " +
          "how they cluster, what connects. No account, no key, nothing saved.",
      });
      heroSub.addClass("bv-u-margin-0-0-12px");
      heroSub.addClass("bv-u-color-text-muted");
      const heroBtn = hero.createEl("button", { text: "✨ Analyze my vault", cls: "mod-cta" });
      heroBtn.addClass("bv-u-font-size-15px");
      heroBtn.addClass("bv-u-padding-10px-18px");
      heroBtn.onclick = () => void analyzeVault(this.plugin);
    } else {
      // Ask Bevia — the conversational two-voice panel (Librarian +
      // Consultant). Front-door entry for CONNECTED vaults; without a
      // key it can only fail, so it doesn't lead a disconnected page.
      const askBtn = wrap.createEl("button", { text: "Ask Bevia a question", cls: "mod-cta" });
      askBtn.addClass("bv-u-display-block");
      askBtn.addClass("bv-u-margin-bottom-14px");
      askBtn.onclick = () => void this.plugin.activateAskView();
    }
    const status = wrap.createDiv({ cls: "bevia-home-status" });
    status.addClass("bv-u-display-flex");
    status.addClass("bv-u-align-items-center");
    status.addClass("bv-u-gap-10px");
    status.addClass("bv-u-padding-12px-14px");
    status.addClass("bv-u-border-radius-10px");
    status.addClass("bv-u-margin-18px-0-6px");
    status.addClass("bv-u-border-1px-solid-background-modifier-border");
    status.style.background = connected
      ? "rgba(40, 160, 90, 0.10)"
      : keyDead
        ? "rgba(200, 130, 30, 0.10)"
        : "var(--background-secondary)";

    const dot = status.createSpan();
    dot.addClass("bv-u-width-9px");
    dot.addClass("bv-u-height-9px");
    dot.addClass("bv-u-border-radius-50");
    dot.addClass("bv-u-flex-0-0-auto");
    dot.style.background = connected
      ? "rgb(40, 160, 90)"
      : keyDead
        ? "rgb(200, 130, 30)"
        : "var(--text-faint)";

    const statusText = status.createSpan();
    if (keyDead) {
      statusText.createEl("b", { text: "Reconnect — your key stopped working" });
      const reason = this.plugin.tokenProblem;
      statusText.appendText(
        reason
          ? ` — Bevia said: "${reason}" Paste a fresh access key below.`
          : " — Bevia rejected it. Mint a fresh access key at bevia.co and paste it below.",
      );
    } else if (connected) {
      const who = this.plugin.settings.connectedEmail;
      statusText.createEl("b", { text: who ? `Connected as ${who}` : "Connected" });
      statusText.appendText(
        " — your map is syncing into this vault automatically. You're all set.",
      );
    } else {
      statusText.createEl("b", { text: "Not connected yet" });
      statusText.appendText(
        " — paste your Bevia key to bring this vault to life. (Already syncing via the desktop app? You can still connect here to add the live Navigator.)",
      );
    }

    new Setting(wrap)
      .setName(connected ? "Connection" : "Connect this vault")
      .setDesc(
        connected
          ? "Re-verify or switch the key this vault uses."
          : "Create a key at bevia.co → Connections → Keys, then paste and verify it here.",
      )
      .addButton((b) =>
        b
          .setButtonText(connected ? "Manage connection" : "Connect")
          .setCta()
          .onClick(() => openConnectModal(this.plugin)),
      );

    // ── What you can do ─────────────────────────────────────────────
    // Two different pages for two different people (golden path): a
    // connected vault gets its working tools; a disconnected vault gets
    // the free demo (the hero above) and ONE honest section about what
    // connecting unlocks — never a wall of buttons that all 401.
    if (connected) {
      this.section(wrap, "What you can do here");
      new Setting(wrap)
        .setName("Navigator")
        .setDesc("Stands beside the note you're writing and shows the territories, landmarks, and people it connects to.")
        .addButton((b) => b.setButtonText("Open").onClick(() => this.plugin.activateView()));
      new Setting(wrap)
        .setName("Query")
        .setDesc("Ask your map a question — contradictions this week, fastest-growing territories, what an AI contributed.")
        .addButton((b) => b.setButtonText("Open").onClick(() => this.plugin.activateQueryView()));
      new Setting(wrap)
        .setName("Sync now")
        .setDesc("Pull your latest territories and daily reads into the Bevia/ folder right now.")
        .addButton((b) => b.setButtonText("Sync").onClick(() => void syncAtlasNow(this.plugin)));
    } else {
      this.section(wrap, "After you connect");
      const unlocks = wrap.createEl("p", {
        text:
          "Connecting adds the live layer: a Navigator panel beside every note you write, " +
          "questions you can ask your whole map, and your map syncing into this vault's " +
          "Bevia/ folder automatically — fed by your AI conversations, code, and notes.",
      });
      unlocks.addClass("bv-u-color-text-muted");
      unlocks.addClass("bv-u-margin-top-0");
      // Two-door exit (Bevia Local spec §12.4): the old single
      // "Get Bevia → open bevia.co" CTA becomes two honest doors. The
      // Rent door is the existing create-account handoff, unchanged —
      // open bevia.co, make a key, paste it above.
      const doors = renderTwoDoorPanel(wrap, {
        lead: "Two ways to run Bevia",
        onRent: () => window.open(this.plugin.settings.appUrl, "_blank"),
        rentLabel: "Create account at bevia.co",
      });
      doors.addClass("bv-u-margin-top-12px");
    }

    // ── Feed your thinking in ───────────────────────────────────────
    // Bevia is bidirectional from this one surface (ADR-0097 / ADR-0203):
    // the plugin both pulls the map in AND sends your own writing back to
    // the engine. Surfacing intake here is what frees the user from having
    // to reason about the desktop app for their Obsidian notes — the
    // desktop app is for OTHER vaults and files, not this one.
    //
    // Everything from here down needs a key (or, for graph views, a
    // synced Bevia/ folder), so a disconnected vault doesn't see it —
    // its page is hero (free demo) → connect → what connecting unlocks.
    if (!connected) return;
    this.section(wrap, "Feed your thinking into Bevia");
    new Setting(wrap)
      .setName("Send this vault to Bevia")
      .setDesc(
        "Your own notes in this vault become part of your map — the same engine that reads your AI " +
          "conversations reads your writing here. Runs right from the plugin; you don't need the desktop app for this vault. " +
          "Bevia only reads your notes; it never changes them.",
      )
      .addButton((b) =>
        b.setButtonText("Send to Bevia").onClick(() => void sendVaultToBevia(this.plugin)),
      );
    new Setting(wrap)
      .setName("Feed your other vaults & files")
      .setDesc(
        "Want your other vaults, folders, or exports fed in too? Download the desktop app and point it at " +
          "those files — Bevia runs them through the engine and your thinking shows up here in this map.",
      )
      .addButton((b) =>
        b.setButtonText("Get the desktop app").onClick(() => window.open(this.plugin.settings.appUrl, "_blank")),
      );

    // ── Field guide: turning the map into work ──────────────────────
    // Reactivate / Think / Work act on the note you have open, so they have
    // no button here — they explain themselves and tell you where to run
    // them. (The ribbon icons ⚡/💡/🔨 and the Command Palette both fire them.)
    this.section(wrap, "Turn the map into work");
    const guide = wrap.createEl("p", {
      text:
        "These act on the note you have open. Open a Territory or Landmark note under " +
        "Bevia/4 Map/, then run the matching command from its ribbon icon or the Command Palette.",
    });
    guide.addClass("bv-u-color-text-muted");
    guide.addClass("bv-u-margin-top-0");
    new Setting(wrap)
      .setName("⚡ Reactivate this landmark")
      .setDesc(
        "From a Landmark note. Builds a Workspace folder pre-filled with that idea's origin, " +
          "the concepts that grew from it, and its open threads — so you can pick it back up where you left off.",
      );
    new Setting(wrap)
      .setName("💡 Think more about this")
      .setDesc(
        "From a Territory note. Opens a Thinking workspace with the territory's concepts, research " +
          "questions, and the territories sitting next to it on your map.",
      );
    new Setting(wrap)
      .setName("🔨 Work on this")
      .setDesc(
        "From a Landmark note. Opens a production workspace with a draft outline and a decision " +
          "record — oriented toward building rather than exploring.",
      );

    // ── Scope ───────────────────────────────────────────────────────
    // Density "levels" are retired: the whole map (and its [[wikilinks]]) is
    // always kept, and you slice what you SEE by date or by tool (the graph
    // views below + apertures), not by a breadth dial.
    this.section(wrap, "What reaches this vault");
    new Setting(wrap)
      .setName("Choose what syncs")
      .setDesc(
        "Pick the slice of your Atlas that lands here — just the daily read, just ideas, " +
          "everything — plus time window and importance.",
      )
      .addButton((b) =>
        b
          .setButtonText("Choose")
          .setCta()
          .onClick(() => {
            // Deep-link into this plugin's settings tab, where the
            // "Choose what syncs" panel lives (ADR-0202: the control UI
            // may live in many surfaces; the policy stays canonical).
            const settingApi = (this.app as unknown as {
              setting?: { open: () => void; openTabById: (id: string) => void };
            }).setting;
            settingApi?.open();
            settingApi?.openTabById(this.plugin.manifest.id);
          }),
      );
    new Setting(wrap)
      .setName("Sort your Bevia folders")
      .setDesc(
        "By last activity (Bevia only rewrites a note when something actually changed, so " +
          "modified time is honest) or A → Z. Sets Obsidian's file-explorer sort — the same " +
          "control as the sort icon at the top of the file list.",
      )
      .addButton((b) =>
        b.setButtonText("Last activity").onClick(() => this.setExplorerSort("byModifiedTime")),
      )
      .addButton((b) => b.setButtonText("A → Z").onClick(() => this.setExplorerSort("alphabetical")));
    new Setting(wrap)
      .setName("What Bevia writes & where")
      .setDesc("See exactly which files Bevia writes into this vault.")
      .addButton((b) =>
        b.setButtonText("Show me").onClick(() => openVaultWritePreview(this.plugin, { gateSync: false })),
      );

    // ── Graph views ─────────────────────────────────────────────────
    // Preset color-group recipes for Obsidian's graph. Each reads the human
    // axes Bevia stamps on every note and re-colors the graph along one lens.
    this.section(wrap, "Graph views");
    const graphNote = wrap.createEl("p", {
      text:
        "Color your whole graph along one lens. Pick one, then reopen the graph " +
        "(Graph view tab) to see it.",
    });
    graphNote.addClass("bv-u-color-text-muted");
    graphNote.addClass("bv-u-margin-top-0");
    for (const recipe of GRAPH_RECIPES) {
      new Setting(wrap)
        .setName(recipe.label)
        .setDesc(recipe.desc)
        .addButton((b) =>
          b.setButtonText("Apply").onClick(() => void applyGraphRecipe(this.plugin, recipe.key)),
        );
    }

    // ── Where the map lives ─────────────────────────────────────────
    this.section(wrap, "Where your map lives");
    const note = wrap.createEl("p", {
      text:
        "Bevia only ever writes inside its own Bevia/ folder — 1 Today (your daily read), 2 Ideas, 3 You, " +
        "and 4 Map. Your own notes are never touched, and you can delete the Bevia/ folder any time; it just " +
        "rebuilds.",
    });
    note.addClass("bv-u-color-text-muted");

    // ── Account ─────────────────────────────────────────────────────
    new Setting(wrap)
      .setName("Account, keys & billing")
      .setDesc("Manage your subscription, connections, and keys on the web.")
      .addButton((b) =>
        b.setButtonText("Open bevia.co").onClick(() => window.open(this.plugin.settings.appUrl, "_blank")),
      );
  }

  /** Set Obsidian's file-explorer sort — the same state its sort icon
   *  controls. The explorer view's setSortOrder is internal-but-stable
   *  API (community plugins rely on it); if it ever moves, fall back to
   *  pointing at the manual control instead of failing silently. */
  private setExplorerSort(order: "byModifiedTime" | "alphabetical"): void {
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    const view = leaf?.view as unknown as { setSortOrder?: (o: string) => void } | undefined;
    if (view?.setSortOrder) {
      view.setSortOrder(order);
      new Notice(
        order === "alphabetical"
          ? "File list sorted A → Z."
          : "File list sorted by last activity (newest first).",
      );
    } else {
      new Notice("Couldn't reach the file explorer — use the sort icon at the top of the file list.");
    }
  }

  private section(parent: HTMLElement, title: string): void {
    const h = parent.createEl("h2", { text: title });
    h.addClass("bv-u-margin-30px-0-4px");
    h.addClass("bv-u-font-size-16px");
  }
}

// ── Staleness helpers (Bevia Local spec §12.4) ─────────────────────

/** Bound the freshness walk — a sampled signal, never a full vault
 *  scan. A false negative just keeps the line quiet, which is the
 *  safe direction for an ambient surface. */
const STALENESS_SAMPLE_CAP = 500;

/** Cheap "has the vault moved since the map was drawn?" signal. The
 *  markdown file list + mtimes are already in memory (no disk reads);
 *  skip Bevia's own written notes (their mtimes ARE the map's write
 *  time, so they'd always read as newer), early-exit on the first
 *  newer note, and cap the walk. */
function vaultMovedSince(plugin: BeviaNavigatorPlugin, since: number): boolean {
  let checked = 0;
  for (const f of plugin.app.vault.getMarkdownFiles()) {
    if (f.path.startsWith("Bevia/") || f.path.startsWith("Atlas/")) continue;
    if (f.stat.mtime > since) return true;
    if (++checked >= STALENESS_SAMPLE_CAP) break;
  }
  return false;
}

/** Humanized distance for the staleness line — "today" / "yesterday" /
 *  "5 days ago" / "3 weeks ago" / "2 months ago". Matches the human
 *  narration register (never an ISO timestamp in body copy). */
function relativeDay(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) {
    const weeks = Math.round(days / 7);
    return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  }
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}
