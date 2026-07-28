// Bevia — Home Base (in-plugin front door).
//
// The one page inside Obsidian that tells a user what Bevia is, whether
// this vault is connected to their engine, and what they can do. Opens
// as a full tab in the main editor area (not the sidebar) — it's a
// page, not a panel. Auto-opens on load when the vault isn't paired
// yet, so a new user lands somewhere that explains itself instead of
// hunting through settings.
//
// THE FUNNEL (Marketplace map — every door is a funnel): the free story
// is one sentence — install the free Bevia app, point it at this vault,
// and a real map of your own notes appears in the Bevia/ folder. The
// widen moment ("pull in your AI chats, your repos, your meetings")
// exits through the one-door panel; the plugin itself never gates
// anything — the engine owns the one honest gate.
//
// Pure projection + controls: it reads settings and runs the same
// commands the ribbon/command-palette expose. It never modifies the
// user's notes.

import { ItemView, Notice, Setting, WorkspaceLeaf } from "obsidian";
import type BeviaNavigatorPlugin from "./main";
import { sendVaultToBevia } from "./sync-vault-intake";
import { GRAPH_RECIPES, applyGraphRecipe } from "./graph-recipes";
import { renderTwoDoorPanel, BEVIA_LOCAL_URL } from "./two-door";

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

    // ── Header ──────────────────────────────────────────────────────
    wrap.createEl("div", { cls: "bevia-eyebrow", text: "BEVIA" });
    const h1 = wrap.createEl("h1", { text: "Your vault, as a map" });
    h1.addClass("bv-u-margin-6px-0-8px");
    const lede = wrap.createEl("p", {
      text:
        "Bevia runs on your own machine, reads what you think about, and writes it back " +
        "into this vault as a map you own — plain markdown, working links, your words.",
    });
    lede.addClass("bv-u-color-text-muted");
    lede.addClass("bv-u-margin-top-0");

    const paired =
      !!this.plugin.settings.localToken?.trim() && this.plugin.settings.localPort > 0;

    // ── Connection status ────────────────────────────────────────────
    const status = wrap.createDiv({ cls: "bevia-home-status" });
    status.addClass("bv-u-display-flex");
    status.addClass("bv-u-align-items-center");
    status.addClass("bv-u-gap-10px");
    status.addClass("bv-u-padding-12px-14px");
    status.addClass("bv-u-border-radius-10px");
    status.addClass("bv-u-margin-18px-0-6px");
    status.addClass("bv-u-border-1px-solid-background-modifier-border");
    // CSS classes, not element.style — Obsidian's public plugin scan
    // flags direct style assignment, and the theme should win anyway.
    status.addClass(paired ? "bevia-status-ok" : "bevia-status-idle");

    const dot = status.createSpan();
    dot.addClass("bv-u-width-9px");
    dot.addClass("bv-u-height-9px");
    dot.addClass("bv-u-border-radius-50");
    dot.addClass("bv-u-flex-0-0-auto");
    dot.addClass(paired ? "bevia-dot-ok" : "bevia-dot-idle");

    const statusText = status.createSpan();
    if (paired) {
      statusText.createEl("b", { text: "Connected to your Bevia engine" });
      statusText.appendText(
        ` — this vault talks to the Bevia app on this computer (port ${this.plugin.settings.localPort}). ` +
          "Your map arrives in the Bevia/ folder; nothing leaves this machine.",
      );
    } else {
      statusText.createEl("b", { text: "Not connected yet" });
      statusText.appendText(
        " — Bevia needs its free app running on this computer. Get it below, then pair this vault.",
      );
    }

    const openOwnSettings = () => {
      const settingApi = (this.app as unknown as {
        setting?: { open: () => void; openTabById: (id: string) => void };
      }).setting;
      settingApi?.open();
      settingApi?.openTabById(this.plugin.manifest.id);
    };

    // ── The two pages ────────────────────────────────────────────────
    if (!paired) {
      // THE FUNNEL, three honest steps. The app is free; its trial reads
      // this one vault. Nothing here is a paywall — the plugin never
      // gates; the engine owns the one gate, at the widen moment.
      this.section(wrap, "See this vault as a map — free");
      const steps = wrap.createEl("ol");
      steps.addClass("bv-u-color-text-muted");
      steps.createEl("li", {
        text: "Get the free Bevia app — it runs on this computer; your notes never leave it.",
      });
      steps.createEl("li", {
        text: "Point it at this vault. Reading one place is free, forever.",
      });
      steps.createEl("li", {
        text:
          "Watch the Bevia/ folder appear: territory notes about YOUR ideas, linked — " +
          "and Obsidian's graph view shows the shape of your thinking.",
      });
      const getBtn = wrap.createEl("button", { text: "Get the free Bevia app", cls: "mod-cta" });
      getBtn.addClass("bv-u-font-size-15px");
      getBtn.addClass("bv-u-padding-10px-18px");
      getBtn.onclick = () => window.open(BEVIA_LOCAL_URL, "_blank");

      new Setting(wrap)
        .setName("Already running the Bevia app?")
        .setDesc("Pair this vault with it — one click when it's on this machine.")
        .addButton((b) => b.setButtonText("Pair this vault").setCta().onClick(openOwnSettings));
      return;
    }

    // ── Paired: the working page ────────────────────────────────────
    this.section(wrap, "What you can do here");
    new Setting(wrap)
      .setName("Ask your map")
      .setDesc(
        "Questions answered from the map on this computer — grounded in your own notes, nothing leaves the machine.",
      )
      .addButton((b) => b.setButtonText("Ask").onClick(() => void this.plugin.activateAskView()));
    new Setting(wrap)
      .setName("Navigator")
      .setDesc(
        "Stands beside the note you're reading and shows where it sits on your map — its territory, and what that connects to.",
      )
      .addButton((b) => b.setButtonText("Open").onClick(() => this.plugin.activateView()));

    // ── Feed your thinking in ───────────────────────────────────────
    // The plugin is bidirectional from this one surface (ADR-0097 /
    // ADR-0203): it both projects the map in AND sends your writing back
    // to the engine — this vault is the free lane.
    this.section(wrap, "Feed this vault into your map");
    new Setting(wrap)
      .setName("Send this vault to Bevia")
      .setDesc(
        "Your notes here become part of your map — read on this machine, by your own engine. " +
          "Bevia only reads your notes; it never changes them.",
      )
      .addButton((b) =>
        b.setButtonText("Send to Bevia").onClick(() => void sendVaultToBevia(this.plugin)),
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

    // ── The widen moment ────────────────────────────────────────────
    // This vault is one place you think. The license opens the rest —
    // AI chats, repos, meetings — on the same private engine. The door
    // panel is the ONE exit every close in the plugin shares.
    this.section(wrap, "This vault is one place you think");
    const widen = wrap.createEl("p", {
      text:
        "Your map gets its depth from everything pointing at the same places — the thinking " +
        "you do in AI chats, in your repos, in meetings. One license connects them all to the " +
        "same private engine.",
    });
    widen.addClass("bv-u-color-text-muted");
    widen.addClass("bv-u-margin-top-0");
    const doors = renderTwoDoorPanel(wrap);
    doors.addClass("bv-u-margin-top-12px");
  }

  private section(parent: HTMLElement, title: string): void {
    const h = parent.createEl("h2", { text: title });
    h.addClass("bv-u-margin-30px-0-4px");
    h.addClass("bv-u-font-size-16px");
  }
}

/** Kept for callers that want a quick "sorted" affordance later; unused
 *  in the current Home layout. */
export function noticeSortHint(): void {
  new Notice("Use the sort icon at the top of the file list to reorder.");
}
