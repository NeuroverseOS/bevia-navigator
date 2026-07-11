// Bevia Navigator — settings tab.
//
// Two settings, kept minimal per the doctrine: the user owns auth
// (paste your token) and the user owns the endpoint (default to
// production Bevia, override for self-host or staging).

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type BeviaNavigatorPlugin from "./main";
import { openConnectModal } from "./connect";
import { renderTwoDoorPanel } from "./two-door";
import type { ConnectionDensity } from "./sync";
import { syncAtlasNow } from "./sync";
import { openVaultWritePreview } from "./first-run";
import { setProjectionScope, BeviaApiError, type ProjectionScopePayload } from "./api";

export interface BeviaNavigatorSettings {
  /** The Supabase project URL Bevia is hosted at. Default is Bevia
   *  production. Self-hosted and staging users override here. */
  baseUrl: string;
  /** The user's Bevia auth token. Copy from the Bevia web app
   *  (Account → Connect Desktop & MCP → token). Treated as a
   *  per-vault secret. */
  token: string;
  /** Whether the Navigator sidebar should auto-update on note
   *  change. Off = manual refresh button only. */
  autoUpdate: boolean;
  /** OPT-IN: route Obsidian's core "new note location" to the user-owned
   *  Bevia/5 Workspace folder. Default OFF — Bevia never silently rewrites
   *  a core editor setting. When the user turns this off again, the prior
   *  core config is restored from the two `prior*` fields below. */
  routeNewNotes: boolean;
  /** The user's core `newFileLocation` before Bevia overrode it (captured
   *  once when routeNewNotes is first enabled; restored on disable).
   *  `undefined` = never overridden; `null` = was unset. Not user-facing. */
  priorNewFileLocation?: string | null;
  /** The user's core `newFileFolderPath` before Bevia overrode it. Not
   *  user-facing. */
  priorNewFileFolderPath?: string | null;
  /** The Bevia web app URL (Control Tower / checkout). Distinct from
   *  baseUrl, which is the Supabase functions host. Used for the
   *  Discovery → "Activate my Living Atlas" → subscribe handoff. */
  appUrl: string;
  /** Whether the Living Atlas should continuously materialize into the
   *  vault (Bevia/ + Atlas/ namespace). This is what a paid user is
   *  buying — the vault keeps updating on its own. */
  syncAtlas: boolean;
  /** How often (minutes) to pull new materialized territories/continents
   *  into the vault. */
  syncPollMinutes: number;
  /** How much of the Atlas reaches THIS vault (audit Finding 5.1). The
   *  projection boundary — the server materializes everything; this
   *  decides how much lands. Default 'balanced': the Atlas notes, no
   *  connective wikilink layer. */
  connectionDensity: ConnectionDensity;
  /** Whether the user has seen the one-screen "what Bevia writes & where"
   *  preview. Bevia does not auto-sync into the vault until they have. */
  firstSyncAck: boolean;
  /** Whether the user has dismissed the Navigator place card's
   *  first-run teach state ("everything on this card is real and
   *  touchable"). Shown until dismissed once. */
  placeCardTeachSeen: boolean;
  /** How the Navigator place card speaks. `human` (default) — plain
   *  narration, humanized dates, counts in words. `technical` — shown
   *  to the user as **Evidence**: the underlying observations that
   *  produced the narration (ISO dates, similarity numbers, resolution
   *  shares). Interpretation vs observation — two representations of
   *  the same substrate, not a "developer mode". The stored value stays
   *  `technical` for back-compat; only the display label changed. */
  narration: "human" | "technical";
  /** The email the connected token resolves to, shown in the Connect
   *  surface's "Connected as …" chip. Optional. */
  connectedEmail?: string;
  /** Stable per-vault id for vault-intake dedup scope (ADR-0203 R2).
   *  Generated once on first intake send and persisted; per-vault
   *  because plugin data is per-vault. Not user-facing. */
  vaultId?: string;
  /** When the free keyless "Analyze my vault" run last completed (ms
   *  epoch). Unset until the first run finishes. Drives the Home
   *  staleness line (Bevia Local spec §12.4): notes edited after this
   *  stamp mean the free map has fallen behind the vault. */
  lastAnalyzeAt?: number;

  // ── Projection scope (Build C — "Choose what syncs") ───────────────
  // These drive the server projection_scope row (materialization-pull
  // enforces it). Kept locally so the panel renders current state; a
  // "Save & sync" push writes them to the canonical policy (ADR-0202 —
  // one policy, this surface is a window onto it). Defaults are "the
  // whole map" so opening the panel and saving never narrows a vault by
  // surprise — the user opts INTO a slice.
  /** Full-detail window in days: 7 / 30 / 90 / 3650 (="all"). */
  syncTimeWindowDays: number;
  /** Importance percentile floor for territories: 70 (top 30%) / 50
   *  (top 50%) / 0 (everything). */
  syncImportanceFloor: number;
  /** Trajectory-direction filter. 'all' = the whole map. */
  syncCompass: "all" | "north" | "east" | "south" | "west";
  /** Per-category toggles — which map layers reach this vault. */
  syncCatTerritories: boolean;
  syncCatContinents: boolean;
  syncCatWorldviews: boolean;
  /** Legacy combined insight toggle — migrated into the split pair
   *  below on first load; kept so old saved settings still parse. */
  syncCatInsights: boolean;
  /** Returning ideas — the Telescope (2 Ideas family). */
  syncCatIdeas: boolean;
  /** Readings about how you work — the Mirror (3 You family). */
  syncCatBehaviors: boolean;
}

export const DEFAULT_SETTINGS: BeviaNavigatorSettings = {
  baseUrl: "https://qjxotoeviqlfazjcwask.supabase.co",
  token: "",
  autoUpdate: true,
  routeNewNotes: false,
  appUrl: "https://bevia.co",
  syncAtlas: true,
  syncPollMinutes: 10,
  // Balanced by default: the map notes + their relationships (the
  // [[wikilinks]] — evidence is always kept at balanced+), so Obsidian's
  // Graph view works without the 2k-concept flood Rich adds. Density
  // controls breadth, never whether the links exist.
  connectionDensity: "balanced",
  firstSyncAck: false,
  placeCardTeachSeen: false,
  narration: "human",
  // Projection scope defaults = the whole map (no narrowing until the
  // user explicitly picks a slice — matches the server's "absence of a
  // scope row = everything" safety).
  syncTimeWindowDays: 3650,
  syncImportanceFloor: 0,
  syncCompass: "all",
  syncCatTerritories: true,
  syncCatContinents: true,
  syncCatWorldviews: true,
  syncCatInsights: true,
  syncCatIdeas: true,
  syncCatBehaviors: true,
};

export class BeviaNavigatorSettingTab extends PluginSettingTab {
  plugin: BeviaNavigatorPlugin;

  constructor(app: App, plugin: BeviaNavigatorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // No plugin-name heading — Obsidian's settings sidebar already names
    // the plugin, and the review bot flags a repeated top-level H2.
    const intro = containerEl.createEl("p");
    intro.setText(
      "The Navigator stands beside your note and shows what Bevia has been thinking about — " +
        "territories your writing connects to, landmarks it touches, contributors who built it with you. " +
        "Bevia never modifies your notes; the sidebar is rendered alongside.",
    );

    new Setting(containerEl)
      .setName("Bevia URL")
      .setDesc("Your Bevia instance. Leave as the default unless you self-host.")
      .addText((text) =>
        text
          .setPlaceholder("https://qjxotoeviqlfazjcwask.supabase.co")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Bevia token")
      .setDesc(
        "Paste your token from Bevia → Account → Connect Desktop & MCP. " +
          "Stays on your machine; never sent to anyone except your Bevia instance.",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("eyJ…")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
            // Pasting the token after subscribing should bring the vault
            // to life immediately, not on the next plugin reload.
            this.plugin.restartAtlasSync();
          });
      });

    new Setting(containerEl)
      .setName("Connect a vault")
      .setDesc("Paste and verify your token in a guided flow, then start syncing your Living Atlas.")
      .addButton((btn) =>
        btn
          .setButtonText("Connect Obsidian")
          .setCta()
          .onClick(() => openConnectModal(this.plugin)),
      );

    // Two-door exit (Bevia Local spec §12.4): when NEITHER engine is
    // configured — no cloud key, and Bevia Local isn't wired here yet —
    // the connect surface shows both honest ways to get one instead of
    // a single cloud-only dead-end. The Rent door is the existing
    // guided connect flow, unchanged.
    if (!this.plugin.settings.token.trim()) {
      const doors = renderTwoDoorPanel(containerEl, {
        lead: "Two ways to run Bevia",
        onRent: () => openConnectModal(this.plugin),
        rentLabel: "Create account & connect",
      });
      doors.addClass("bv-u-margin-bottom-16px");
    }

    new Setting(containerEl)
      .setName("Keep my Atlas live in this vault")
      .setDesc(
        "When on, Bevia continuously writes your territories and continents into the " +
          "Bevia/ folder as they form — your vault stays up to date on its own. " +
          "Bevia only ever writes inside its own Bevia/ and Atlas/ folders; your notes are never touched.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncAtlas)
          .onChange(async (value) => {
            this.plugin.settings.syncAtlas = value;
            await this.plugin.saveSettings();
            this.plugin.restartAtlasSync();
          }),
      );

    new Setting(containerEl)
      .setName("Connection density")
      .setDesc(
        "How much of your Atlas reaches this vault. Density controls BREADTH — how much " +
          "projects — never whether the links exist: the [[wikilinks]] that connect your notes " +
          "are always kept, so Obsidian's Graph view always works. Minimal = your Daily Pulse " +
          "only. Balanced = your Atlas notes (territories, continents, landmarks) WITH their " +
          "connecting wikilinks. Rich = adds every named concept (more breadth). Full = " +
          "everything. Bevia only ever writes inside its own Bevia/ and Atlas/ folders — never " +
          "your notes — at any level.",
      )
      .addDropdown((dd) =>
        dd
          .addOption("minimal", "Minimal — Daily Pulse only")
          .addOption("balanced", "Balanced — your Atlas + its links (graph works)")
          .addOption("rich", "Rich — + every concept (more breadth)")
          .addOption("full", "Full — everything")
          .setValue(this.plugin.settings.connectionDensity)
          .onChange(async (value) => {
            this.plugin.settings.connectionDensity = value as ConnectionDensity;
            await this.plugin.saveSettings();
            // Apply immediately: lowering density reaps the now-excluded
            // files on the next tick; restart so it happens now.
            this.plugin.restartAtlasSync();
          }),
      );

    new Setting(containerEl)
      .setName("What Bevia writes & where")
      .setDesc("See exactly which files Bevia writes into this vault at your current density, and where.")
      .addButton((btn) =>
        btn
          .setButtonText("Show me")
          .onClick(() => openVaultWritePreview(this.plugin, { gateSync: false })),
      );

    this.renderChooseWhatSyncs(containerEl);

    new Setting(containerEl)
      .setName("Atlas update frequency (minutes)")
      .setDesc("How often Bevia checks for new territories to bring into the vault.")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.syncPollMinutes))
          .onChange(async (value) => {
            const n = Number(value.trim());
            this.plugin.settings.syncPollMinutes = Number.isFinite(n) && n >= 1 ? n : 10;
            await this.plugin.saveSettings();
            this.plugin.restartAtlasSync();
          }),
      );

    new Setting(containerEl)
      .setName("Bevia web app URL")
      .setDesc("Where the Control Tower and subscription live. Leave as default unless you self-host.")
      .addText((text) =>
        text
          .setPlaceholder("https://bevia.co")
          .setValue(this.plugin.settings.appUrl)
          .onChange(async (value) => {
            this.plugin.settings.appUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Narration")
      .setDesc(
        "How the Navigator panel speaks. Human — the story, in plain words. " +
          "Evidence — the underlying observations that produced it (dates, " +
          "similarity numbers, resolution shares). Same facts, two registers.",
      )
      .addDropdown((dd) =>
        dd
          .addOption("human", "Human (default)")
          .addOption("technical", "Evidence")
          .setValue(this.plugin.settings.narration)
          .onChange(async (value) => {
            this.plugin.settings.narration = value === "technical" ? "technical" : "human";
            await this.plugin.saveSettings();
            // Flip live — re-render open panels from their cached read,
            // no refetch needed.
            this.plugin.rerenderNavigatorViews();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-update on note change")
      .setDesc(
        "When on, the sidebar refreshes whenever you open a different note. " +
          "Turn off if you'd rather click the refresh button each time.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoUpdate)
          .onChange(async (value) => {
            this.plugin.settings.autoUpdate = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Send new notes to the Workspace folder")
      .setDesc(
        "Off by default. When on, Bevia changes Obsidian's core “Default location for " +
          "new notes” to Bevia/5 Workspace, so new notes — including the empty ones " +
          "Obsidian creates when you click an unresolved [[link]] — land in the user-owned " +
          "Workspace instead of the vault root. Turning it off restores your previous setting.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.routeNewNotes)
          .onChange(async (value) => {
            this.plugin.settings.routeNewNotes = value;
            await this.plugin.saveSettings();
            if (value) await this.plugin.routeNewNotesToWorkspace();
            else await this.plugin.restoreNewNotesLocation();
          }),
      );

    const link = containerEl.createEl("p");
    link.setText(
      "About sovereignty: Bevia reads your active note (title + first paragraph) " +
        "and asks its own substrate what the note connects to. Nothing in your vault is modified. " +
        "Stop the connection any time by clearing the token above.",
    );
  }

  /** "Choose what syncs" — the projection-control panel (Build C). The
   *  substrate is enormous; this picks the slice that reaches THIS vault
   *  (time window, importance, category, compass direction) and writes it
   *  to the canonical projection_scope (ADR-0202 — projection control lives
   *  in the surface it governs). Controls persist locally as the user
   *  tunes; "Save & sync" pushes the scope and pulls the vault fresh. */
  private renderChooseWhatSyncs(containerEl: HTMLElement): void {
    const s = this.plugin.settings;

    containerEl.createEl("h3", { text: "Choose what syncs" });
    const desc = containerEl.createEl("p");
    desc.setText(
      "Your Atlas is enormous — don't dump all of it here. Pick the slice you want in this " +
        "vault, then Save & sync. Bevia only writes what you keep, and never leaves a link " +
        "pointing at a note it didn't write.",
    );

    new Setting(containerEl)
      .setName("Time window")
      .setDesc("Keep territories, continents, landmarks and ideas active within this window. Older ones stay in your Atlas; they just don't sync here.")
      .addDropdown((dd) =>
        dd
          .addOption("7", "Last 7 days")
          .addOption("30", "Last 30 days")
          .addOption("90", "Last 90 days")
          .addOption("3650", "All time")
          .setValue(String(s.syncTimeWindowDays))
          .onChange(async (value) => {
            const n = Number(value);
            s.syncTimeWindowDays = Number.isFinite(n) ? n : 3650;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Importance")
      .setDesc("How much of the map to keep, ranked by how much your thinking returns to each territory.")
      .addDropdown((dd) =>
        dd
          .addOption("70", "Top 30% — the places you keep coming back to")
          .addOption("50", "Top 50%")
          .addOption("0", "Everything")
          .setValue(String(s.syncImportanceFloor))
          .onChange(async (value) => {
            const n = Number(value);
            s.syncImportanceFloor = Number.isFinite(n) ? n : 0;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Direction of motion")
      .setDesc(
        "Sync one direction of your map's movement — or all of it. Emergent = what's appearing. " +
          "Growing = what's strengthening. Fading = what's going quiet. Settling = what's transforming. " +
          "A direction keeps only the territories moving that way.",
      )
      .addDropdown((dd) =>
        dd
          .addOption("all", "All directions")
          .addOption("east", "Emergent — what's appearing")
          .addOption("north", "Growing — what's strengthening")
          .addOption("south", "Fading — what's going quiet")
          .addOption("west", "Settling — what's transforming")
          .setValue(s.syncCompass)
          .onChange(async (value) => {
            s.syncCompass = value === "north" || value === "east" || value === "south" || value === "west"
              ? value
              : "all";
            await this.plugin.saveSettings();
          }),
      );

    const catToggle = (
      name: string,
      desc: string,
      get: () => boolean,
      set: (v: boolean) => void,
    ): void => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((toggle) =>
          toggle.setValue(get()).onChange(async (value) => {
            set(value);
            await this.plugin.saveSettings();
          }),
        );
    };
    catToggle("Territories", "The regions of your map — what you've been thinking about.",
      () => s.syncCatTerritories, (v) => { s.syncCatTerritories = v; });
    catToggle("Continents", "The larger groupings your territories cluster into.",
      () => s.syncCatContinents, (v) => { s.syncCatContinents = v; });
    catToggle("Worldviews", "The highest-altitude shape — how it all hangs together.",
      () => s.syncCatWorldviews, (v) => { s.syncCatWorldviews = v; });
    catToggle("Ideas", "Returning ideas the Telescope tracks (the 2 Ideas folder).",
      () => s.syncCatIdeas, (v) => { s.syncCatIdeas = v; });
    catToggle("About you", "Readings on how you work — the Mirror (the 3 You folder).",
      () => s.syncCatBehaviors, (v) => { s.syncCatBehaviors = v; });

    new Setting(containerEl)
      .setName("Save & sync")
      .setDesc("Write these choices to your Atlas and bring the matching slice into this vault now.")
      .addButton((btn) =>
        btn
          .setButtonText("Save & sync")
          .setCta()
          .onClick(async () => {
            if (!s.token?.trim()) {
              new Notice("Add your Bevia token above first.");
              return;
            }
            const scope: ProjectionScopePayload = {
              worldviews_on: s.syncCatWorldviews,
              continents_on: s.syncCatContinents,
              territories_on: s.syncCatTerritories,
              // Not exposed in this panel — kept at 'all' so the panel only
              // ever narrows via the axes it DOES show, never silently drops
              // landmarks/concepts. Density still gates concepts server-side.
              landmarks_mode: "all",
              concepts_mode: "all",
              insights_on: s.syncCatIdeas || s.syncCatBehaviors,
              ideas_on: s.syncCatIdeas,
              behaviors_on: s.syncCatBehaviors,
              density: s.connectionDensity,
              time_full_days: s.syncTimeWindowDays,
              importance_floor: s.syncImportanceFloor,
              compass_filter: s.syncCompass,
            };
            btn.setDisabled(true);
            try {
              const res = await setProjectionScope(
                { baseUrl: s.baseUrl, token: s.token },
                scope,
              );
              new Notice(`Saved — about ${res.projected_count} notes in scope. Syncing…`);
              await syncAtlasNow(this.plugin);
            } catch (e) {
              const msg = e instanceof BeviaApiError ? e.message : (e as Error).message;
              new Notice(`Couldn't save your scope: ${msg}`);
            } finally {
              btn.setDisabled(false);
            }
          }),
      );
  }
}
