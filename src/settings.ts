// Bevia Navigator — settings tab (Bevia Local).
//
// One connection exists: the Bevia engine on the user's own machine.
// Settings are the pairing (port + optional same-Wi-Fi address), the
// sidebar behavior, and the opt-in new-note routing. There is no
// account, no token from a website, no cloud endpoint — the plugin
// makes no internet requests.

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type BeviaNavigatorPlugin from "./main";
import {
  pairWithLocalEngine,
  autoPairWithLocalEngine,
  sanitizeLocalHost,
  checkLocalLink,
} from "./local";
import { renderTwoDoorPanel } from "./two-door";

export interface BeviaNavigatorSettings {
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
  /** How the Navigator place card speaks. `human` (default) — plain
   *  narration, humanized dates, counts in words. `technical` — shown
   *  to the user as **Evidence**: the underlying observations that
   *  produced the narration. */
  narration: "human" | "technical";
  /** Stable per-vault id for vault-intake dedup scope (ADR-0203 R2).
   *  Generated once on first intake send and persisted; per-vault
   *  because plugin data is per-vault. Not user-facing. */
  vaultId?: string;

  // ── Bevia Local pairing ────────────────────────────────────────────
  /** The local engine's port, from the desktop app. */
  localPort: number;
  /** The engine's address. Empty / "127.0.0.1" = the engine runs on THIS
   *  device (the default). A private-LAN IP (e.g. "192.168.1.42") reaches
   *  the engine on the SAME Wi-Fi from another device — iPad / phone
   *  Obsidian. Only loopback + RFC-1918 private ranges are ever accepted;
   *  a public host is refused so this stays "your machine / your network
   *  only, nothing leaves for the internet." */
  localHost?: string;
  /** The bearer token /pair issued to this vault. Per-vault secret;
   *  not user-facing. Empty = not paired. */
  localToken: string;
  /** The sensor id /pair returned. Display/debug only; not user-facing. */
  localSensorId?: string;
}

export const DEFAULT_SETTINGS: BeviaNavigatorSettings = {
  autoUpdate: true,
  routeNewNotes: false,
  narration: "human",
  localPort: 0,
  localHost: "127.0.0.1",
  localToken: "",
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
      "The Navigator stands beside your note and shows where it sits on your map — " +
        "the territories your writing belongs to and what they connect to. " +
        "Bevia never modifies your notes; the sidebar is rendered alongside, and the map " +
        "arrives as plain markdown in this vault's Bevia/ folder.",
    );

    this.renderBeviaLocal(containerEl);

    new Setting(containerEl)
      .setName("Narration")
      .setDesc(
        "How the Navigator panel speaks. Human — the story, in plain words. " +
          "Evidence — the underlying observations that produced it. Same facts, two registers.",
      )
      .addDropdown((dd) =>
        dd
          .addOption("human", "Human (default)")
          .addOption("technical", "Evidence")
          .setValue(this.plugin.settings.narration)
          .onChange(async (value) => {
            this.plugin.settings.narration = value === "technical" ? "technical" : "human";
            await this.plugin.saveSettings();
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
      "About sovereignty: this plugin talks only to the Bevia engine on your own machine " +
        "(or a device on your own Wi-Fi that you named) — it makes no internet requests. " +
        "Nothing in your vault is modified; the map arrives as files you own and can delete " +
        "any time. Stop everything by disconnecting below or quitting the Bevia app.",
    );
  }

  /** "Bevia Local" — the one connection. Pair this vault with the engine
   *  on this machine (one click, no code) or with an engine on another
   *  device on the same Wi-Fi (port + code). */
  private renderBeviaLocal(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const paired = !!s.localToken?.trim();

    containerEl.createEl("h3", { text: "Bevia Local" });
    const desc = containerEl.createEl("p");
    desc.setText(
      "Bevia runs on your own machine. This plugin talks only to that engine — " +
        "your notes and questions go to it and nowhere else, and your map arrives " +
        "as files the Bevia app writes into this vault.",
    );

    const status = containerEl.createEl("p");
    status.addClass("bv-u-color-text-muted");
    status.setText(
      paired
        ? `This vault is paired (port ${s.localPort}). Nothing leaves this machine.`
        : "Not paired yet — install the Bevia app, then connect below.",
    );

    // Honest link check. "paired" above only means "a token is stored" —
    // it does NOT mean the engine still accepts it. A stale token (engine
    // reinstalled, pairing revoked) made the plugin claim "paired" while
    // every capture silently 401'd. Verify against the engine's /whoami
    // and correct the line + surface a re-pair path when the engine no
    // longer recognizes this vault.
    if (paired) {
      void checkLocalLink().then((state) => {
        if (state === "linked") {
          status.setText(
            `Connected (port ${s.localPort}) — the engine recognizes this vault. Nothing leaves this machine.`,
          );
          return;
        }
        if (state === "rejected") {
          status.setText(
            "The engine on this computer no longer recognizes this vault — its pairing is stale (the app was likely reinstalled). Your notes aren't reaching your map until you re-pair.",
          );
          status.removeClass("bv-u-color-text-muted");
          const fix = containerEl.createEl("p");
          fix.addClass("bv-u-color-text-muted");
          fix.setText(
            "To fix: press Disconnect below, then connect again with the port the Bevia app shows.",
          );
          status.insertAdjacentElement("afterend", fix);
        } else if (state === "unreachable") {
          status.setText(
            `The engine isn't answering on port ${s.localPort}. Is the Bevia app running on this computer?`,
          );
        }
      });
    }

    // The door: a vault with no pairing gets the honest way in — the
    // free app download (its trial reads this one vault), not a dead-end.
    if (!paired) {
      const doors = renderTwoDoorPanel(containerEl, { lead: "Get Bevia" });
      doors.addClass("bv-u-margin-bottom-16px");
    }

    new Setting(containerEl)
      .setName("Engine port")
      .setDesc("The port the Bevia app shows on its Output screen ('Engine running (port …)').")
      .addText((text) =>
        text
          .setPlaceholder("Port from the Bevia app")
          .setValue(s.localPort > 0 ? String(s.localPort) : "")
          .onChange(async (value) => {
            const n = parseInt(value.trim(), 10);
            s.localPort = Number.isFinite(n) && n > 0 && n <= 65535 ? n : 0;
            await this.plugin.saveSettings();
            this.plugin.applyLocalRouting();
          }),
      );

    new Setting(containerEl)
      .setName("Engine address")
      .setDesc(
        "Leave blank if the Bevia app runs on THIS device. To reach it from " +
          "another device on the same Wi-Fi (iPad or phone), enter the app's " +
          "local network address, e.g. 192.168.1.42. Only your own machine or " +
          "local network is allowed — nothing else.",
      )
      .addText((text) =>
        text
          .setPlaceholder("127.0.0.1 (this device)")
          .setValue(s.localHost && s.localHost !== "127.0.0.1" ? s.localHost : "")
          .onChange(async (value) => {
            const clean = sanitizeLocalHost(value);
            if (value.trim() && clean === null) {
              new Notice(
                "That address isn't your machine or a local-network address — " +
                  "Bevia only talks to 127.0.0.1 or a 10.x / 172.16–31.x / 192.168.x device.",
                8000,
              );
              // Keep the last good value; don't persist the rejected one.
              return;
            }
            s.localHost = clean ?? "127.0.0.1";
            await this.plugin.saveSettings();
            this.plugin.applyLocalRouting();
          }),
      );

    // Same-machine (loopback) vs another-device (LAN) connect. When the
    // engine is on THIS machine, there is no code to read off a screen —
    // the machine authorizing the pairing and the machine being paired are
    // the same machine, so we auto-pair with one click (POST /pair/local,
    // which the engine only honors from loopback). A code is required ONLY
    // when the Engine address points at a DIFFERENT device on the LAN,
    // where same-machine trust isn't implied.
    const onLocalHost = !s.localHost || s.localHost === "127.0.0.1";

    // Shared success path for either connect flow.
    const applyPairing = async (outcome: {
      ok: boolean;
      token?: string;
      sensor_id?: string;
      message?: string;
    }) => {
      if (!outcome.ok) {
        new Notice(outcome.message ?? "Couldn't connect to Bevia.", 8000);
        return;
      }
      s.localToken = outcome.token!;
      s.localSensorId = outcome.sensor_id;
      await this.plugin.saveSettings();
      this.plugin.applyLocalRouting();
      new Notice("Connected — this vault now talks to your Bevia engine.");
      this.display();
    };

    if (onLocalHost) {
      new Setting(containerEl)
        .setName("Connect to Bevia")
        .setDesc(
          "Bevia is running on this machine — one click, no code. Just make " +
            "sure the engine port above matches the Bevia app.",
        )
        .addButton((btn) =>
          btn
            .setButtonText("Connect")
            .setCta()
            .onClick(async () => {
              if (!s.localPort) {
                new Notice("Enter the engine port first — the Bevia app shows it on its Output screen.");
                return;
              }
              btn.setDisabled(true);
              try {
                const outcome = await autoPairWithLocalEngine(
                  s.localPort,
                  `Obsidian — ${this.app.vault.getName()}`,
                  s.localHost,
                );
                await applyPairing(outcome);
              } finally {
                btn.setDisabled(false);
              }
            }),
        );
    } else {
      let pairingCode = "";
      new Setting(containerEl)
        .setName("Pairing code")
        .setDesc(
          "Connecting from another device — open Pair a sensor in the Bevia " +
            "app, enter the code it shows, then press Connect.",
        )
        .addText((text) => {
          text.setPlaceholder("Code from the Bevia app").onChange((value) => {
            pairingCode = value.trim();
          });
        })
        .addButton((btn) =>
          btn
            .setButtonText("Connect")
            .setCta()
            .onClick(async () => {
              if (!s.localPort) {
                new Notice("Enter the engine port first — it's on the Bevia app's Pair a sensor screen.");
                return;
              }
              if (!pairingCode) {
                new Notice("Enter the pairing code from the Bevia app.");
                return;
              }
              btn.setDisabled(true);
              try {
                const outcome = await pairWithLocalEngine(
                  s.localPort,
                  pairingCode,
                  `Obsidian — ${this.app.vault.getName()}`,
                  s.localHost,
                );
                await applyPairing(outcome);
              } finally {
                btn.setDisabled(false);
              }
            }),
        );
    }

    if (paired) {
      new Setting(containerEl)
        .setName("Disconnect from Bevia")
        .setDesc("Forget this vault's pairing. Nothing talks to the engine until you connect again.")
        .addButton((btn) =>
          btn
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              s.localToken = "";
              s.localSensorId = undefined;
              await this.plugin.saveSettings();
              this.plugin.applyLocalRouting();
              new Notice("Disconnected from the engine.");
              this.display();
            }),
        );
    }
  }
}
