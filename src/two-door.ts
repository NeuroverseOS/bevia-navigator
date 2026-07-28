// Bevia — the exit panel (ONE door: Bevia Local).
//
// Every close in the plugin exits through the same panel:
//
//   Own it — Bevia Local · $30 once · runs on this machine · your
//   data never leaves. The CTA opens bevia.co/local in the browser,
//   where checkout is live.
//
//   PRICE STRINGS MIRROR src/copy/canonical.ts PRICING (this package
//   can't import the website's module). Local = $30 one-time (the
//   two-product model, ADR-0218). When canonical.ts changes, change
//   here too.
//
// (Filename note: this began as a two-door panel — Own Local / Rent
// Cloud. Cloud is not sold; the second door is gone. The file keeps
// its name so history reads.)
//
// Kept dependency-light on purpose (obsidian + the v27 atoms only) so
// Home Base, the Navigator's not-connected state, and the settings tab
// can all render the same panel without import cycles.

import { App, Modal } from "obsidian";
import { v27Root, mono, serif, text, button } from "./v27";

/** The Bevia Local landing page — the "learn more" click-through
 *  target. The ONLY external link the plugin ever opens, and it opens
 *  in the user's browser; the plugin itself makes no internet
 *  requests. */
export const BEVIA_LOCAL_URL = "https://www.bevia.co/local";

export interface LocalDoorOptions {
  /** Optional mono lead line above the door. */
  lead?: string;
}

/** Render the Bevia Local door into `parent`. Returns the panel root
 *  so a caller can add spacing utilities. Safe inside or outside an
 *  existing v27 scope (it wraps itself). */
export function renderTwoDoorPanel(
  parent: HTMLElement,
  opts: LocalDoorOptions = {},
): HTMLElement {
  const root = v27Root(parent);
  if (opts.lead) {
    mono(root, opts.lead, { size: 9, track: 0.16, dim: true, block: true })
      .addClass("bv-u-margin-bottom-10px");
  }
  const row = root.createDiv({ cls: "bv-two-door" });

  const d = row.createDiv({ cls: "bv-door" });
  mono(d, "Own it", { size: 8.5, track: 0.16, dim: true, block: true });
  serif(d, "Bevia Local", { size: 17, weight: 500, lh: 1.2 });
  mono(d, "$30 once — yours forever", {
    size: 10,
    track: 0.06,
    color: "var(--bv-strengthening-ink)",
    block: true,
  });
  const pts = d.createDiv({ cls: "bv-door-points" });
  for (const p of [
    "Keep all of your data on your machine.",
    "Pull in everything else — your AI chats, your repos, your meetings.",
    "Your AI reads your map and thinks with you, proactively.",
  ]) {
    text(pts, p, { size: 11.5, color: "var(--bv-ink-soft)", lh: 1.4 });
  }
  button(d, "Get Bevia Local", {
    full: true,
    onClick: () => window.open(BEVIA_LOCAL_URL, "_blank"),
  });

  return root;
}

/** The door as a standalone modal — opened from ambient surfaces that
 *  only have room for a link. */
class LocalDoorModal extends Modal {
  constructor(app: App, private opts: LocalDoorOptions = {}) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("bevia-discovery-modal");
    const { contentEl } = this;
    contentEl.empty();
    const root = v27Root(contentEl);
    root.addClass("bv-wrap");
    const card = root.createDiv({ cls: "bv-card" });
    card.addClass("bv-u-max-width-460px");
    card.addClass("bv-u-margin-0-auto");
    card.addClass("bv-u-padding-30px-28px-26px");
    mono(card, "Keep it alive", { size: 9, track: 0.16, dim: true, block: true })
      .addClass("bv-u-margin-bottom-12px");
    serif(card, "Your map is a photo. Bevia keeps the film running.", {
      size: 21,
      weight: 400,
      lh: 1.22,
    }).addClass("bv-u-margin-bottom-16px");
    renderTwoDoorPanel(card, this.opts);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function openTwoDoorModal(app: App, opts: LocalDoorOptions = {}): void {
  new LocalDoorModal(app, opts).open();
}
