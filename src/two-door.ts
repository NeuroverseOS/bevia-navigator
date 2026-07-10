// Bevia — the two-door exit panel (Bevia Local spec §12.4).
//
// Every place the plugin used to dead-end into a single "create an
// account" CTA now exits through TWO doors:
//
//   Own it — Bevia Local · $15 once · runs on this machine · your data
//   never leaves. Not purchasable yet, so the door says so honestly
//   ("almost here") and opens bevia.co/local in the browser — it
//   informs, it never pretends to sell.
//
//   Rent it — Bevia Cloud · from $15/mo · zero setup · we run the
//   models. This door IS the surface's existing create-account/connect
//   flow, unchanged — the caller passes it in; this module never
//   invents a new handoff.
//
// Kept dependency-light on purpose (obsidian + the v27 atoms only) so
// the analyze close, the first-run preview, Home Base, and the settings
// tab can all render the same panel without import cycles.

import { App, Modal } from "obsidian";
import { v27Root, mono, serif, text, button } from "./v27";

/** The Bevia Local landing page — the "learn more" click-through
 *  target named in the Local Edition spec (§12.4). */
export const BEVIA_LOCAL_URL = "https://www.bevia.co/local";

export interface TwoDoorOptions {
  /** The EXISTING create-account/connect flow for this surface. The
   *  Rent door runs it unchanged — each caller keeps its own handoff. */
  onRent: () => void;
  /** Rent-door CTA label. Default "Create account". */
  rentLabel?: string;
  /** Optional mono lead line above the doors. */
  lead?: string;
}

/** Render the two doors into `parent`. Returns the panel root so a
 *  caller can add spacing utilities. Safe inside or outside an existing
 *  v27 scope (it wraps itself). */
export function renderTwoDoorPanel(
  parent: HTMLElement,
  opts: TwoDoorOptions,
): HTMLElement {
  const root = v27Root(parent);
  if (opts.lead) {
    mono(root, opts.lead, { size: 9, track: 0.16, dim: true, block: true })
      .addClass("bv-u-margin-bottom-10px");
  }
  const row = root.createDiv({ cls: "bv-two-door" });

  const door = (
    eyebrow: string,
    title: string,
    price: string,
    points: string[],
  ): HTMLElement => {
    const d = row.createDiv({ cls: "bv-door" });
    mono(d, eyebrow, { size: 8.5, track: 0.16, dim: true, block: true });
    serif(d, title, { size: 17, weight: 500, lh: 1.2 });
    mono(d, price, { size: 10, track: 0.06, color: "var(--bv-strengthening-ink)", block: true });
    const pts = d.createDiv({ cls: "bv-door-points" });
    for (const p of points) {
      text(pts, p, { size: 11.5, color: "var(--bv-ink-soft)", lh: 1.4 });
    }
    return d;
  };

  // Door 1 — Own it. Honest copy: Local isn't purchasable yet, hence
  // "almost here" — the CTA is a learn-more, never a fake buy button.
  const own = door("Own it", "Bevia Local", "$15 once", [
    "Runs on this machine.",
    "Your data never leaves.",
  ]);
  button(own, "Almost here — learn more", {
    kind: "ghost",
    full: true,
    onClick: () => window.open(BEVIA_LOCAL_URL, "_blank"),
  });

  // Door 2 — Rent it. The existing single-flow behavior, unchanged.
  const rent = door("Rent it", "Bevia Cloud", "from $15/mo", [
    "Zero setup.",
    "We run the models.",
  ]);
  button(rent, opts.rentLabel ?? "Create account", {
    full: true,
    onClick: opts.onRent,
  });

  return root;
}

/** The two doors as a standalone modal — opened from ambient surfaces
 *  (the Home staleness line) that only have room for a link. */
class TwoDoorModal extends Modal {
  constructor(app: App, private opts: TwoDoorOptions) {
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
    renderTwoDoorPanel(card, {
      ...this.opts,
      // Close first so the existing flow (its own modal or a browser
      // tab) never stacks on top of this one.
      onRent: () => {
        this.close();
        this.opts.onRent();
      },
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function openTwoDoorModal(app: App, opts: TwoDoorOptions): void {
  new TwoDoorModal(app, opts).open();
}
