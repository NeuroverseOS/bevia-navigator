// Bevia — Claim your Discovery snapshot (post-signup welcome).
//
// Design: design/v27-observatory/funnel2.jsx (BVClaim) + funnel-content.js.
// A one-time celebratory state shown after a vault connects: the map you
// discovered, claimed to your account, already growing. Rhymes with the
// Discovery reveal, then dissolves into the normal Atlas home.

import { Modal } from "obsidian";
import type BeviaNavigatorPlugin from "./main";
import { v27Root, aperture, mono, serif, text, territoryCard, dot, type BvState } from "./v27";

const STATE_CYCLE: BvState[] = ["strengthening", "recurring", "strengthening", "emergence"];

export interface ClaimTerritory { name: string; finding?: string; size?: string }

export function openClaimModal(plugin: BeviaNavigatorPlugin, territories: ClaimTerritory[] = []): void {
  new ClaimModal(plugin, territories).open();
}

class ClaimModal extends Modal {
  constructor(private plugin: BeviaNavigatorPlugin, private territories: ClaimTerritory[]) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("bevia-discovery-modal");
    const root = v27Root(this.contentEl);
    root.addClass("bv-wrap");
    const card = root.createDiv({ cls: "bv-card" });
    card.addClass("bv-u-max-width-360px");
    card.addClass("bv-u-margin-0-auto");
    card.addClass("bv-u-padding-24px-22px");

    const head = card.createDiv();
    head.addClass("bv-u-text-align-center");
    head.addClass("bv-u-margin-bottom-22px");
    const apRel = head.createDiv();
    apRel.addClass("bv-u-position-relative");
    apRel.addClass("bv-u-display-inline-block");
    apRel.addClass("bv-u-margin-bottom-18px");
    aperture(apRel, { size: 48, stroke: 1.2, color: "var(--bv-strengthening-dot)" });
    const pulse = apRel.createSpan({ cls: "bv-pulse" });
    pulse.addClass("bv-u-position-absolute"); pulse.addClass("bv-u-inset-7px"); pulse.addClass("bv-u-border-radius-50");
    pulse.addClass("bv-u-border-1px-solid-bv-strengthening-rail");
    mono(head, "Claimed to your account", { size: 9, track: 0.18, color: "var(--bv-strengthening-ink)", block: true }).addClass("bv-u-margin-bottom-12px");
    serif(head, "Here's the map you saw. It's yours now.", { size: 20, weight: 400, lh: 1.24 }).addClass("bv-u-margin-bottom-11px");
    text(head, "The territories you discovered are claimed to your account — and already growing as Bevia reads on.", { size: 12.5, color: "var(--bv-ink-soft)", lh: 1.55 });

    if (this.territories.length > 0) {
      const list = card.createDiv();
      list.addClass("bv-u-display-flex");
      list.addClass("bv-u-flex-direction-column");
      list.addClass("bv-u-gap-9px");
      this.territories.slice(0, 4).forEach((terr, i) =>
        territoryCard(list, { ...terr, state: STATE_CYCLE[i % STATE_CYCLE.length] }, { compact: true }));
    }

    const foot = card.createDiv();
    foot.addClass("bv-u-display-flex");
    foot.addClass("bv-u-align-items-center");
    foot.addClass("bv-u-justify-content-center");
    foot.addClass("bv-u-gap-8px");
    foot.addClass("bv-u-padding-top-16px");
    foot.addClass("bv-u-margin-top-16px");
    foot.addClass("bv-u-border-top-1px-solid-bv-rule-faint");
    const dotRel = foot.createSpan();
    dotRel.addClass("bv-u-position-relative");
    dotRel.addClass("bv-u-display-flex");
    dot(dotRel, "strengthening", 5);
    const dp = dotRel.createSpan({ cls: "bv-pulse" });
    dp.addClass("bv-u-position-absolute"); dp.addClass("bv-u-inset-3px"); dp.addClass("bv-u-border-radius-50");
    dp.addClass("bv-u-border-1px-solid-bv-strengthening-rail");
    mono(foot, "Settling into your Atlas home…", { size: 8.5, track: 0.06, dim: true });
  }

  onClose(): void { this.contentEl.empty(); }
}
