// Bevia Navigator — Obsidian plugin entry.
//
// Wires the three pieces together:
//   1. Settings (Bevia URL + token + auto-update toggle)
//   2. The sidebar ItemView (BeviaNavigatorView)
//   3. The active-leaf-change listener that drives the cybernetic loop
//      named in CLAUDE.md § Projection-as-stage / Navigator-is-bidirectional.
//
// The plugin is a NAVIGATOR per the doctrine:
//   - Intake side: reads the active note's title + first ~1000 chars
//   - Projection side: renders Bevia's /note-context response in the
//     sidebar
//   - Never modifies the user's notes
//
// Distribution: the manifest sits at ../manifest.json. The build pipeline
// (npm run build) bundles src/main.ts → main.js for the Obsidian
// community plugin format. Users install by dropping main.js + manifest.json
// + styles.css into their vault's .obsidian/plugins/bevia-navigator/.

import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
  BEVIA_NAVIGATOR_VIEW_TYPE,
  BeviaNavigatorView,
} from "./view";
import {
  BEVIA_QUERY_VIEW_TYPE,
  BeviaQueryView,
} from "./query-view";
import {
  BEVIA_HOME_VIEW_TYPE,
  BeviaHomeView,
} from "./home-view";
import {
  BEVIA_ASK_VIEW_TYPE,
  BeviaAskView,
} from "./ask-view";
import {
  BEVIA_PLAY_VIEW_TYPE,
  BeviaPlayView,
} from "./play-view";
import { beviaLinkifier } from "./linkifier";
import { analyzeVault } from "./analyze";
import { openAskMolly } from "./ask";
import { openConnectModal } from "./connect";
import { reactivateActiveLandmark } from "./reactivate";
import { thinkAboutActiveTerritory } from "./think";
import { workOnActiveLandmark } from "./work";
import { startAtlasSync, syncAtlasNow, type AtlasSyncHandle } from "./sync";
import { GRAPH_RECIPES, applyGraphRecipe } from "./graph-recipes";
import { sendVaultToBevia } from "./sync-vault-intake";
import { openVaultWritePreview } from "./first-run";
import {
  BeviaNavigatorSettingTab,
  DEFAULT_SETTINGS,
  type BeviaNavigatorSettings,
} from "./settings";

export default class BeviaNavigatorPlugin extends Plugin {
  settings: BeviaNavigatorSettings = { ...DEFAULT_SETTINGS };
  private atlasSync: AtlasSyncHandle | null = null;

  /** Runtime token health — never persisted. Before this existed, a dead
   *  key produced the worst possible triple: background sync swallowed
   *  every 401 and retried forever, the Navigator asked the user to
   *  "connect this vault," and Home Base still said "Connected — you're
   *  all set" (it only checked that a token string was PRESENT). Three
   *  surfaces, three different answers. Health flips here on real call
   *  results and every surface renders from the same truth. */
  tokenHealth: "unknown" | "ok" | "invalid" = "unknown";
  /** The server's own reason when the key was rejected (e.g. "this token
   *  is capture-scoped to the browser extension — use an MCP token").
   *  Surfaced verbatim so the user learns WHICH kind of key to paste. */
  tokenProblem: string | null = null;

  /** A Bevia call succeeded with the current key. */
  noteTokenOk(): void {
    if (this.tokenHealth === "ok") return;
    this.tokenHealth = "ok";
    this.tokenProblem = null;
    this.rerenderHomeViews();
  }

  /** A Bevia call came back 401/403 with the current key. First flip
   *  fires one Notice (not one per retry) and re-renders Home. */
  noteTokenInvalid(reason?: string): void {
    const firstFlip = this.tokenHealth !== "invalid";
    this.tokenHealth = "invalid";
    this.tokenProblem = reason?.trim() || null;
    if (firstFlip) {
      new Notice(
        "Bevia: this vault's key stopped working — open Bevia Home to reconnect.",
        8000,
      );
      this.rerenderHomeViews();
    }
  }

  private rerenderHomeViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(BEVIA_HOME_VIEW_TYPE)) {
      if (leaf.view instanceof BeviaHomeView) leaf.view.render();
    }
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    // New notes — including the empty ones Obsidian makes when you click an
    // unresolved [[link]] — belong in the user-owned Workspace, never loose
    // in the vault root or inside Bevia's managed folders. Enforce it.
    void this.routeNewNotesToWorkspace();

    // Register the sidebar views.
    this.registerView(
      BEVIA_NAVIGATOR_VIEW_TYPE,
      (leaf) => new BeviaNavigatorView(leaf, this),
    );
    this.registerView(
      BEVIA_QUERY_VIEW_TYPE,
      (leaf) => new BeviaQueryView(leaf, this),
    );
    this.registerView(
      BEVIA_HOME_VIEW_TYPE,
      (leaf) => new BeviaHomeView(leaf, this),
    );
    this.registerView(
      BEVIA_ASK_VIEW_TYPE,
      (leaf) => new BeviaAskView(leaf, this),
    );
    this.registerView(
      BEVIA_PLAY_VIEW_TYPE,
      (leaf) => new BeviaPlayView(leaf, this),
    );

    // Home Base — the front door. Opens as a full tab and explains what
    // Bevia is, whether you're connected, and what you can do.
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
    // Consultant forward). Docked in the right sidebar; runs on the user's
    // own AI key. The standalone modal stays available as a quick one-shot.
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

    // Play — games dealt from the user's own map (Two Truths and a Lie,
    // Expedition, Time Machine). User-initiated only: a command + a Home
    // row, never a badge or a nag (docs/specs/navigator-games-spec.md).
    this.addCommand({
      id: "open-bevia-play",
      name: "Play — games from your map",
      callback: async () => {
        await this.activatePlayView();
      },
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

    // Add a ribbon icon that opens / focuses the Navigator panel.
    this.addRibbonIcon("compass", "Open Bevia Navigator", async () => {
      await this.activateView();
    });
    // Second ribbon icon for the Query view.
    this.addRibbonIcon("search", "Open Bevia Query", async () => {
      await this.activateQueryView();
    });

    // Command palette entries.
    this.addCommand({
      id: "open-bevia-navigator",
      name: "Open Bevia Navigator",
      callback: async () => {
        await this.activateView();
      },
    });
    this.addCommand({
      id: "open-bevia-query",
      name: "Open Bevia Query",
      callback: async () => {
        await this.activateQueryView();
      },
    });
    // Discovery Atlas — the acquisition surface. Reads the vault, sends a
    // representative sample to /instant-cartography, renders the atlas.
    // No account/token needed (anonymous). See docs/specs/instant-
    // cartography-spec.md.
    //
    // Only surfaced to NOT-yet-connected vaults — it's the free preview that
    // sells the real thing. A connected subscriber already has the live
    // Atlas, so the ribbon/command are not registered for them (and
    // analyzeVault backstops with an explanation if reached anyway). Token
    // changes take effect on next reload, matching the Home-auto-open gate.
    if (!this.settings.token.trim()) {
      this.addCommand({
        id: "bevia-analyze-vault",
        name: "Analyze My Vault (Discovery Atlas)",
        callback: async () => {
          await analyzeVault(this);
        },
      });
      this.addRibbonIcon("sparkles", "Analyze My Vault (Bevia Discovery)", async () => {
        await analyzeVault(this);
      });
    }

    // Living Atlas sync — the plugin IS the sync client. A paid user's
    // territories/continents land in the Bevia/ folder automatically.
    // No watcher, no terminal. (CLAUDE.md § Navigator-is-bidirectional;
    // the Living Atlas product per the three-tier funnel.)
    this.addCommand({
      id: "bevia-sync-atlas",
      name: "Sync my Atlas now",
      callback: async () => {
        await syncAtlasNow(this);
      },
    });
    // Reactivate this landmark — the bridge from Atlas (museum) to
    // Workspace (studio). Reads the open landmark's frontmatter
    // landmark_id, calls /landmark-reactivation-bundle, builds
    // Workspace/<title>/00 - Index.md pre-linked to the spark +
    // concepts + opens, then opens the Index. Per the user-sketched
    // Atlas/Workspace architecture (2026-06-08).
    this.addCommand({
      id: "bevia-reactivate-landmark",
      name: "Reactivate this landmark (open Workspace)",
      callback: async () => {
        await reactivateActiveLandmark(this.app, {
          baseUrl: this.settings.baseUrl,
          token: this.settings.token,
        });
      },
    });
    // Ribbon icon — the lightning is the spark of an idea being
    // reactivated. Click while inside any landmark file to fire
    // the same command.
    this.addRibbonIcon("zap", "Reactivate this landmark", async () => {
      await reactivateActiveLandmark(this.app, {
        baseUrl: this.settings.baseUrl,
        token: this.settings.token,
      });
    });

    // Think mode (ADR-0192) — open a Thinking workspace from a
    // territory file. Mirrors Reactivate, one altitude up.
    this.addCommand({
      id: "bevia-think-territory",
      name: "Think more about this (open Thinking workspace)",
      callback: async () => {
        await thinkAboutActiveTerritory(this.app, {
          baseUrl: this.settings.baseUrl,
          token: this.settings.token,
        });
      },
    });
    this.addRibbonIcon("lightbulb", "Think more about this territory", async () => {
      await thinkAboutActiveTerritory(this.app, {
        baseUrl: this.settings.baseUrl,
        token: this.settings.token,
      });
    });

    // Work mode (ADR-0192) — open a production Workspace from a
    // landmark file. Reuses the reactivation bundle, build-oriented.
    this.addCommand({
      id: "bevia-work-landmark",
      name: "Work on this (open Working workspace)",
      callback: async () => {
        await workOnActiveLandmark(this.app, {
          baseUrl: this.settings.baseUrl,
          token: this.settings.token,
        });
      },
    });
    this.addRibbonIcon("hammer", "Work on this landmark", async () => {
      await workOnActiveLandmark(this.app, {
        baseUrl: this.settings.baseUrl,
        token: this.settings.token,
      });
    });

    // Connect a vault — the guided token paste → verify → connected flow.
    this.addCommand({
      id: "bevia-connect-vault",
      name: "Connect a vault to Bevia",
      callback: () => openConnectModal(this),
    });

    // The one-click handoff the connect copy promises:
    // obsidian://bevia-connect?token=bvma_… from bevia.co lands here, and
    // the Connect modal verifies it exactly like a paste would — the token
    // is saved only after the server accepts it.
    this.registerObsidianProtocolHandler("bevia-connect", (params) => {
      const token = (params.token ?? "").trim();
      openConnectModal(this, "notConnected", token || undefined);
    });

    // Send my vault to Bevia (intake) — ADR-0203 Intake half. Reads the
    // vault's notes (never writes them), skips Bevia's own output, and
    // ships user-authored notes to /vault-intake so they become substrate.
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

    // Start the background Living Atlas sync loop (gated on first-run
    // acknowledgement — see restartAtlasSync). Startup is a deliberate
    // arrival, so an un-acknowledged connected vault gets the one-screen
    // first-sync preview here.
    this.restartAtlasSync({ promptFirstRun: true });

    // Front door: if this vault isn't connected yet, land the user on the
    // Home Base so they see what Bevia is and how to connect — instead of
    // hunting through settings. Deferred until layout is ready so we don't
    // fight Obsidian's own startup tabs. Connected vaults open silently.
    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.token.trim()) {
        // Not connected yet → land on Home Base so they can connect.
        void this.activateHomeView();
      } else {
        // Connected → auto-open the NAVIGATOR (the place card) in the
        // sidebar so the map is standing next to whatever note the user
        // opens first. It's the plugin's primary surface — the Query
        // panel stays one ribbon-click away (and shares its renderer via
        // the place card's query chips).
        void this.activateView();
      }
    });
  }

  async onunload(): Promise<void> {
    // Obsidian handles view cleanup when the plugin unloads.
    this.atlasSync?.stop();
    this.atlasSync = null;
  }

  /** Tear down and restart the Atlas sync loop — called when the token,
   *  the sync toggle, or the poll cadence changes in settings.
   *
   *  `promptFirstRun` (audit P4): the "what Bevia writes & where"
   *  preview modal opens ONLY from deliberate entry points (plugin
   *  startup, the connect flow's close) — never as a side effect of a
   *  settings keystroke, where it used to pop over the tab mid-edit.
   *  Without the flag, an un-acknowledged vault just doesn't start
   *  syncing yet. */
  restartAtlasSync(opts?: { promptFirstRun?: boolean }): void {
    // The token may have changed — health is unknown again until the
    // next real call answers.
    this.tokenHealth = "unknown";
    this.tokenProblem = null;
    // A token/sync change usually means the connection state changed —
    // refresh any open Home Base so its status flips without a reload.
    this.rerenderHomeViews();
    this.atlasSync?.stop();
    this.atlasSync = null;
    // First-run gate (audit Finding 5.2): never auto-write into the vault
    // until the user has seen the one-screen "what Bevia writes & where"
    // preview. The modal's "Start syncing" sets firstSyncAck and calls
    // back here to actually start. Manual "Sync now" is user-initiated and
    // not gated.
    if (
      this.settings.syncAtlas &&
      this.settings.token?.trim() &&
      !this.settings.firstSyncAck
    ) {
      if (opts?.promptFirstRun) openVaultWritePreview(this, { gateSync: true });
      return;
    }
    this.atlasSync = startAtlasSync(this);
  }

  async loadSettings(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<BeviaNavigatorSettings> &
      Record<string, unknown>;
    // Migrate the legacy combined insight toggle: settings saved before
    // the Ideas / About-you split inherit its value into both, so a
    // user who had insights OFF doesn't silently widen.
    if ("syncCatInsights" in stored && !("syncCatIdeas" in stored)) {
      stored.syncCatIdeas = stored.syncCatInsights as boolean;
      stored.syncCatBehaviors = stored.syncCatInsights as boolean;
    }
    this.settings = { ...DEFAULT_SETTINGS, ...stored };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Point Obsidian's "new note location" at the user-owned Workspace
   * (Bevia/5 Workspace). New notes — including the empty ones Obsidian
   * creates when you click an unresolved [[link]] — then land in the one
   * folder Bevia never writes to or reaps, instead of loose in the vault
   * root or inside the managed Map/Ideas/Today folders. Best-effort: uses
   * Obsidian's internal config API, so every step is guarded.
   */
  private async routeNewNotesToWorkspace(): Promise<void> {
    const WORKSPACE = "Bevia/5 Workspace";
    try {
      if (!this.app.vault.getAbstractFileByPath(WORKSPACE)) {
        await this.app.vault.createFolder(WORKSPACE).catch(() => {});
      }
      const vault = this.app.vault as unknown as {
        setConfig?(key: string, value: unknown): void;
      };
      if (typeof vault.setConfig === "function") {
        vault.setConfig("newFileLocation", "folder");
        vault.setConfig("newFileFolderPath", WORKSPACE);
      }
    } catch (e) {
      console.warn("[Bevia] could not route new notes to Workspace:", e);
    }
  }

  /** Open the Navigator panel in the right sidebar. If it's already
   *  open, focus it. */
  async activateView(): Promise<void> {
    await this.openSidebarView(BEVIA_NAVIGATOR_VIEW_TYPE);
  }

  /** Open the Query panel in the right sidebar. */
  async activateQueryView(): Promise<void> {
    await this.openSidebarView(BEVIA_QUERY_VIEW_TYPE);
  }

  /** Open the conversational Ask Bevia panel in the right sidebar. */
  async activateAskView(): Promise<void> {
    await this.openSidebarView(BEVIA_ASK_VIEW_TYPE);
  }

  /** Open the Play panel (games dealt from the map) in the right sidebar. */
  async activatePlayView(): Promise<void> {
    await this.openSidebarView(BEVIA_PLAY_VIEW_TYPE);
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
