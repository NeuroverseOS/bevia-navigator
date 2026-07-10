// Bevia — the one-screen "what Bevia writes & where" preview
// (audit Finding 5.2).
//
// Before Bevia ever writes into a vault, the user sees exactly what it
// will write (at their current Connection Density) and the one promise
// that matters: Bevia only ever writes inside its OWN folder — Bevia/
// — and never touches a note the user wrote.
//
// Two uses:
//   - gateSync: true  — shown once before the first auto-sync. "Start
//     syncing" records the acknowledgement (firstSyncAck) and kicks the
//     Living Atlas off; "Not yet" leaves the vault untouched.
//   - gateSync: false — re-openable any time from settings, purely
//     informational ("Got it").

import { App, Modal, Setting } from "obsidian";
import type BeviaNavigatorPlugin from "./main";
import { densitySummary, type ConnectionDensity } from "./sync";
// NOTE: connect.ts imports openVaultWritePreview from this file, so this
// import forms a cycle — safe here because both modules only call each
// other's exports at runtime (inside callbacks), never during module init.
import { openConnectModal } from "./connect";
import { renderTwoDoorPanel } from "./two-door";

const DENSITY_LABEL: Record<ConnectionDensity, string> = {
  minimal: "Minimal",
  balanced: "Balanced",
  rich: "Rich",
  full: "Full",
};

class VaultWritePreviewModal extends Modal {
  private plugin: BeviaNavigatorPlugin;
  private gateSync: boolean;

  constructor(app: App, plugin: BeviaNavigatorPlugin, gateSync: boolean) {
    super(app);
    this.plugin = plugin;
    this.gateSync = gateSync;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const density = this.plugin.settings.connectionDensity ?? "balanced";

    contentEl.createEl("h2", { text: "What Bevia writes into your vault" });

    const promise = contentEl.createEl("p");
    promise.setText(
      "Bevia only ever writes inside its own folder — Bevia/. " +
        "It never edits, links into, or deletes a note you wrote. Your vault is yours.",
    );

    contentEl.createEl("p", {
      text: `At your current density (${DENSITY_LABEL[density]}), Bevia writes:`,
    });

    const ul = contentEl.createEl("ul");
    for (const line of densitySummary(density)) {
      ul.createEl("li", { text: line });
    }

    const where = contentEl.createEl("p");
    where.setText(
      "All of it lands under Bevia/ (e.g. Bevia/1 Today, Bevia/4 Map/Territories). " +
        "Change how much appears any time with Connection density in settings.",
    );

    // Two-door exit (Bevia Local spec §12.4): no engine at all — no
    // cloud key, and Bevia Local isn't wired here yet — means nothing
    // above can sync. This surface used to dead-end; now it shows both
    // honest ways to get an engine. The connect flow itself is
    // unchanged — the Rent door just opens it (after this modal closes,
    // so modals never stack).
    if (!this.plugin.settings.token.trim()) {
      contentEl.createEl("p", {
        text: "Nothing syncs yet — this vault isn't connected to an engine. Two ways to get one:",
      });
      renderTwoDoorPanel(contentEl, {
        onRent: () => {
          this.close();
          openConnectModal(this.plugin);
        },
        rentLabel: "Create account & connect",
      });
    }

    const actions = new Setting(contentEl);
    if (this.gateSync) {
      actions
        .addButton((btn) =>
          btn
            .setButtonText("Start syncing")
            .setCta()
            .onClick(async () => {
              this.plugin.settings.firstSyncAck = true;
              await this.plugin.saveSettings();
              this.close();
              this.plugin.restartAtlasSync();
            }),
        )
        .addButton((btn) =>
          btn.setButtonText("Not yet").onClick(() => this.close()),
        );
    } else {
      actions.addButton((btn) =>
        btn.setButtonText("Got it").setCta().onClick(() => this.close()),
      );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function openVaultWritePreview(
  plugin: BeviaNavigatorPlugin,
  opts: { gateSync: boolean },
): void {
  new VaultWritePreviewModal(plugin.app, plugin, opts.gateSync).open();
}
