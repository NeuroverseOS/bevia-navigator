// Bevia Navigator — Obsidian plugin entry (Bevia Local).
//
// Wires the pieces together:
//   1. Settings (pairing with the engine on this machine + panel behavior)
//   2. The sidebar Navigator (vault-local place card), Ask, and Home views
//   3. The active-leaf-change listener that drives the cybernetic loop
//      named in CLAUDE.md § Projection-as-stage / Navigator-is-bidirectional.
//
// The plugin is a NAVIGATOR per the doctrine:
//   - Intake side: sends the vault's notes to the engine on this machine
//     (the free lane) — never anywhere else
//   - Projection side: reads the materialized map (the Bevia/ folder the
//     engine writes) and renders where the open note sits
//   - Never modifies the user's notes
//
// Network truth, stated once: every request goes to the Bevia engine on
// the user's own machine (or a same-Wi-Fi address they typed; local.ts
// refuses anything else). The plugin makes no internet requests — the
// only external thing it ever does is open bevia.co/local in the
// browser when the user clicks "Get Bevia Local".
//
// Distribution: the manifest sits at ../manifest.json. The build pipeline
// (npm run build) bundles src/main.ts → main.js for the Obsidian
// community plugin format. Users install by dropping main.js + manifest.json
// + styles.css into their vault's .obsidian/plugins/bevia-navigator/.

import { Plugin, WorkspaceLeaf } from "obsidian";
import {
  BEVIA_NAVIGATOR_VIEW_TYPE,
  BeviaNavigatorView,
} from "./view";
import {
  BEVIA_HOME_VIEW_TYPE,
  BeviaHomeView,
} from "./home-view";
import {
  BEVIA_ASK_VIEW_TYPE,
  BeviaAskView,
} from "./ask-view";
import { beviaLinkifier } from "./linkifier";
import { openAskMolly } from "./ask";
import { GRAPH_RECIPES, applyGraphRecipe } from "./graph-recipes";
import { setLocalRouting } from "./local";
import { sendVaultToBevia } from "./sync-vault-intake";
import {
  BeviaNavigatorSettingTab,
  DEFAULT_SETTINGS,
  type BeviaNavigatorSettings,
} from "./settings";

export default class BeviaNavigatorPlugin extends Plugin {
  settings: BeviaNavigatorSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    // New notes — including the empty ones Obsidian makes when you click an
    // unresolved [[link]] — can be routed into the user-owned Workspace so
    // they never land loose in the vault root or inside Bevia's managed
    // folders. This rewrites Obsidian's CORE "new note location" config, so
    // it is strictly OPT-IN (default OFF) — Bevia never silently changes a
    // core editor setting. Only runs when the user enabled it in settings.
    if (this.settings.routeNewNotes) void this.routeNewNotesToWorkspace();

    // Register the views.
    this.registerView(
      BEVIA_NAVIGATOR_VIEW_TYPE,
      (leaf) => new BeviaNavigatorView(leaf, this),
    );
    this.registerView(
      BEVIA_HOME_VIEW_TYPE,
      (leaf) => new BeviaHomeView(leaf, this),
    );
    this.registerView(
      BEVIA_ASK_VIEW_TYPE,
      (leaf) => new BeviaAskView(leaf, this),
    );

    // Home Base — the front door. Opens as a full tab and explains what
    // Bevia is, whether this vault is paired, and what you can do.
    this.addRibbonIcon("house", "Open Bevia Home", async () => {
      await this.activateHomeView();
    });
    this.addCommand({
      id: "open-bevia-home",
      name: "Open Bevia Home",
      callback: async () => {
        await this.activateHomeView();
      },
    });

    // Ask Bevia — the conversational two-voice panel (Librarian grounded +
    // Consultant forward). Docked in the right sidebar; answered by the
    // engine on this machine. The standalone modal stays available as a
    // quick one-shot.
    this.addRibbonIcon("messages-square", "Ask Bevia", async () => {
      await this.activateAskView();
    });
    this.addCommand({
      id: "open-bevia-ask",
      name: "Ask Bevia",
      callback: async () => {
        await this.activateAskView();
      },
    });
    // Legacy one-shot modal, kept for users who prefer a quick popup.
    this.addCommand({
      id: "bevia-ask-molly",
      name: "Ask Bevia (quick popup)",
      callback: () => openAskMolly(this),
    });

    // Graph view recipes — color the graph along one human axis (origin /
    // activity / kind). Also available as buttons on Bevia Home.
    for (const recipe of GRAPH_RECIPES) {
      this.addCommand({
        id: `bevia-graph-${recipe.key}`,
        name: `Graph view: ${recipe.label.toLowerCase()}`,
        callback: () => void applyGraphRecipe(this, recipe.key),
      });
    }

    // The Navigator panel — where the open note sits on the map.
    this.addRibbonIcon("compass", "Open Bevia Navigator", async () => {
      await this.activateView();
    });
    this.addCommand({
      id: "open-bevia-navigator",
      name: "Open Bevia Navigator",
      callback: async () => {
        await this.activateView();
      },
    });

    // Send my vault to Bevia (intake) — ADR-0203 Intake half. Reads the
    // vault's notes (never writes them), skips Bevia's own output, and
    // ships user-authored notes to the engine on this machine so they
    // become part of the map.
    this.addCommand({
      id: "bevia-send-vault-intake",
      name: "Send my vault to Bevia (intake)",
      callback: async () => {
        await sendVaultToBevia(this);
      },
    });

    // Lens-output markdown post-processor — provenance chips +
    // territory cross-link rewriting on files under /Bevia/*.
    // Scoped per-file inside the post-processor; safe to register
    // globally.
    this.registerMarkdownPostProcessor(beviaLinkifier);

    // Settings tab.
    this.addSettingTab(new BeviaNavigatorSettingTab(this.app, this));

    // The cybernetic loop trigger — when the active leaf changes,
    // refresh the Navigator so it follows the user's focus.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (!this.settings.autoUpdate) return;
        void this.refreshAllNavigatorViews();
      }),
    );

    // Also refresh on file-open, which fires earlier than
    // active-leaf-change for new files.
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        if (!this.settings.autoUpdate) return;
        void this.refreshAllNavigatorViews();
      }),
    );

    // Front door: if this vault isn't paired yet, land the user on the
    // Home Base so they see what Bevia is and how to start — instead of
    // hunting through settings. Deferred until layout is ready so we don't
    // fight Obsidian's own startup tabs. Paired vaults open the Navigator
    // silently, so the map is standing next to whatever note opens first.
    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.localToken.trim()) {
        void this.activateHomeView();
      } else {
        void this.activateView();
      }
    });
  }

  async onunload(): Promise<void> {
    // Obsidian handles view cleanup when the plugin unloads.
  }

  async loadSettings(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<BeviaNavigatorSettings> &
      Record<string, unknown>;
    this.settings = { ...DEFAULT_SETTINGS, ...stored };
    // Feed the local routing seam before ANY network caller can run.
    this.applyLocalRouting();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Keep the routing seam in lockstep with settings — no caller should
    // ever act on a stale snapshot.
    this.applyLocalRouting();
  }

  /** Push the current pairing into the routing seam that every network
   *  caller consults (local.ts). Local is the only mode — enabled is
   *  always true. */
  applyLocalRouting(): void {
    setLocalRouting({
      enabled: true,
      port: Number(this.settings.localPort) || 0,
      token: this.settings.localToken ?? "",
      host: this.settings.localHost ?? "127.0.0.1",
    });
  }

  /**
   * Point Obsidian's "new note location" at the user-owned Workspace
   * (Bevia/5 Workspace). New notes — including the empty ones Obsidian
   * creates when you click an unresolved [[link]] — then land in the one
   * folder Bevia never writes to or reaps, instead of loose in the vault
   * root or inside the managed Map/Ideas/Today folders.
   *
   * OPT-IN ONLY: this rewrites Obsidian's CORE config, so it runs solely
   * when the user turned on the "Send new notes to the Workspace folder"
   * setting. The user's prior choice is captured once so it can be
   * restored when the setting is turned back off (see
   * restoreNewNotesLocation). Best-effort: uses Obsidian's internal config
   * API, so every step is guarded.
   */
  async routeNewNotesToWorkspace(): Promise<void> {
    const WORKSPACE = "Bevia/5 Workspace";
    try {
      if (!this.app.vault.getAbstractFileByPath(WORKSPACE)) {
        await this.app.vault.createFolder(WORKSPACE).catch(() => {});
      }
      const vault = this.app.vault as unknown as {
        getConfig?(key: string): unknown;
        setConfig?(key: string, value: unknown): void;
      };
      if (typeof vault.setConfig !== "function") return;
      // Remember the user's prior choice ONCE so disabling can restore it.
      if (
        this.settings.priorNewFileLocation === undefined &&
        typeof vault.getConfig === "function"
      ) {
        const loc = vault.getConfig("newFileLocation");
        const dir = vault.getConfig("newFileFolderPath");
        this.settings.priorNewFileLocation = typeof loc === "string" ? loc : null;
        this.settings.priorNewFileFolderPath = typeof dir === "string" ? dir : null;
        await this.saveSettings();
      }
      vault.setConfig("newFileLocation", "folder");
      vault.setConfig("newFileFolderPath", WORKSPACE);
    } catch (e) {
      console.warn("[Bevia] could not route new notes to Workspace:", e);
    }
  }

  /** Undo routeNewNotesToWorkspace — restore the user's prior core "new
   *  note location" config. Called when the setting is turned off, so
   *  Bevia leaves the editor exactly as it found it. */
  async restoreNewNotesLocation(): Promise<void> {
    try {
      const vault = this.app.vault as unknown as {
        setConfig?(key: string, value: unknown): void;
      };
      if (typeof vault.setConfig !== "function") return;
      if (this.settings.priorNewFileLocation != null) {
        vault.setConfig("newFileLocation", this.settings.priorNewFileLocation);
      }
      if (this.settings.priorNewFileFolderPath != null) {
        vault.setConfig("newFileFolderPath", this.settings.priorNewFileFolderPath);
      }
      this.settings.priorNewFileLocation = undefined;
      this.settings.priorNewFileFolderPath = undefined;
      await this.saveSettings();
    } catch (e) {
      console.warn("[Bevia] could not restore new-note location:", e);
    }
  }

  /** Open the Navigator panel in the right sidebar. If it's already
   *  open, focus it. */
  async activateView(): Promise<void> {
    await this.openSidebarView(BEVIA_NAVIGATOR_VIEW_TYPE);
  }

  /** Open the conversational Ask Bevia panel in the right sidebar. */
  async activateAskView(): Promise<void> {
    await this.openSidebarView(BEVIA_ASK_VIEW_TYPE);
  }

  /** Open the Ask panel AND run a question in it. This is what makes
   *  every suggestion on the Navigator a live door instead of a silent
   *  clipboard copy (founder, 2026-07-09: "I clicked and nothing
   *  happened") — the conversation starts in front of you. */
  async askBevia(question: string): Promise<void> {
    await this.activateAskView();
    const leaf = this.app.workspace.getLeavesOfType(BEVIA_ASK_VIEW_TYPE)[0];
    const view = leaf?.view;
    if (view instanceof BeviaAskView) view.askQuestion(question);
  }

  /** Open the Home Base as a full tab in the main editor area. Reuses the
   *  existing tab if one is open; re-renders it so the connection status
   *  is current. */
  async activateHomeView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(BEVIA_HOME_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null;
    if (existing.length > 0) {
      leaf = existing[0];
      const view = leaf.view;
      if (view instanceof BeviaHomeView) view.render();
    } else {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: BEVIA_HOME_VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  private async openSidebarView(viewType: string): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(viewType);
    let leaf: WorkspaceLeaf | null;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: viewType, active: true });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  /** Iterate every open Navigator view and ask it to refresh. */
  private async refreshAllNavigatorViews(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(BEVIA_NAVIGATOR_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof BeviaNavigatorView) {
        await view.refresh();
      }
    }
  }

  /** Re-render open Navigator panels from their cached read — no
   *  refetch. Used by the Narration setting so the register flips
   *  live. */
  rerenderNavigatorViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(BEVIA_NAVIGATOR_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof BeviaNavigatorView) {
        view.rerenderFromCache();
      }
    }
  }
}
