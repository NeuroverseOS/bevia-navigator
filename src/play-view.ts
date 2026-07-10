// Bevia — Play (games dealt from your own map).
//
// Three games, each an existing doctrine commitment as play
// (docs/specs/navigator-games-spec.md):
//
//   TWO TRUTHS AND A LIE — three readings about your thinking; two
//   drill to real, dated notes, one is the game's fiction. Evidence
//   grounding + explain() wearing a costume.
//
//   EXPEDITION — a territory quiet for 90+ days, dealt face-down.
//   "You had N notes here once — what do you remember?" Rediscovered
//   dormancy as a ritual instead of a notification.
//
//   TIME MACHINE — what a territory was doing months ago (a frozen
//   observation), recalled against what it's doing now, revealed with
//   the evolution compass. Playing against your own revisionism.
//
// Doctrine posture: user-initiated only (no badges, no daily-game
// nags); every truth drills to evidence; the lie is badged as the
// game's fiction and never persisted; scoring is developmental — the
// session ends with a surprise count, never a percentage.

import { ItemView, WorkspaceLeaf } from "obsidian";
import {
  fetchGameDeal,
  BeviaApiError,
  type GameDeal,
  type TwoTruthsDeal,
  type ExpeditionDeal,
  type TimeMachineDeal,
  type GameEvidence,
} from "./api";
import type BeviaNavigatorPlugin from "./main";

export const BEVIA_PLAY_VIEW_TYPE = "bevia-play-view";

type Action = "deal_two_truths" | "deal_expedition" | "deal_time_machine";

const GAMES: { action: Action; name: string; blurb: string }[] = [
  {
    action: "deal_two_truths",
    name: "Two Truths and a Lie",
    blurb:
      "Three readings about your thinking. Two are real — with the receipts. One is the game's fiction. Catch it.",
  },
  {
    action: "deal_expedition",
    name: "Expedition",
    blurb:
      "A territory you haven't touched in months, dealt face-down. What do you remember before the card flips?",
  },
  {
    action: "deal_time_machine",
    name: "Time Machine",
    blurb:
      "What a territory was doing months ago vs now. Recall what changed — then read the map's own account.",
  },
];

export class BeviaPlayView extends ItemView {
  plugin: BeviaNavigatorPlugin;
  private body: HTMLElement | null = null;
  private footer: HTMLElement | null = null;
  private busy = false;
  /** Developmental scoring: the surprise count IS the score. */
  private surprises = 0;

  constructor(leaf: WorkspaceLeaf, plugin: BeviaNavigatorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return BEVIA_PLAY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Play";
  }

  getIcon(): string {
    return "dices";
  }

  async onOpen(): Promise<void> {
    this.renderShell();
  }

  async onClose(): Promise<void> {
    this.body = null;
    this.footer = null;
  }

  // ── Shell ──────────────────────────────────────────────────────────

  private renderShell(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("bv-u-display-flex");
    root.addClass("bv-u-flex-direction-column");
    root.addClass("bv-u-height-100");
    root.addClass("bv-u-padding-0");

    const header = root.createDiv();
    header.addClass("bv-u-padding-12px-14px-8px");
    header.addClass("bv-u-border-bottom-1px-solid-background-modifier-border");
    header.createEl("div", { cls: "bevia-eyebrow", text: "PLAY" });
    const lede = header.createEl("p", {
      text: "Games dealt from your own map. Every real claim drills to your notes; the score is how often your map surprises you.",
    });
    lede.addClass("bv-u-color-text-muted");
    lede.addClass("bv-u-font-size-12_5px");
    lede.addClass("bv-u-line-height-1_45");
    lede.addClass("bv-u-margin-4px-0-0");

    const body = root.createDiv();
    body.addClass("bv-u-flex-1-1-auto");
    body.addClass("bv-u-overflow-y-auto");
    body.addClass("bv-u-padding-12px-14px");
    this.body = body;

    const footer = root.createDiv();
    footer.addClass("bv-u-border-top-1px-solid-background-modifier-border");
    footer.addClass("bv-u-padding-10px-12px");
    footer.addClass("bv-u-color-text-muted");
    footer.addClass("bv-u-font-size-12_5px");
    this.footer = footer;
    this.renderFooter();

    this.renderMenu();
  }

  private renderFooter(): void {
    if (!this.footer) return;
    this.footer.empty();
    this.footer.setText(
      this.surprises === 0
        ? "No surprises yet this session."
        : `Your map surprised you ${this.surprises} time${this.surprises === 1 ? "" : "s"} today.`,
    );
  }

  private noteSurprise(btn: HTMLButtonElement): void {
    this.surprises += 1;
    btn.disabled = true;
    btn.setText("Noted — that one counts.");
    this.renderFooter();
  }

  // ── Menu ───────────────────────────────────────────────────────────

  private renderMenu(): void {
    if (!this.body) return;
    this.body.empty();
    for (const g of GAMES) {
      const card = this.body.createDiv();
      card.addClass("bv-u-margin-0-0-10px");
      card.addClass("bv-u-padding-8px-10px");
      card.addClass("bv-u-background-background-secondary");
      card.addClass("bv-u-border-radius-8px");
      const name = card.createEl("p", { text: g.name });
      name.addClass("bv-u-margin-0");
      name.addClass("bv-u-font-size-13_5px");
      name.addClass("bv-u-font-weight-600");
      const blurb = card.createEl("p", { text: g.blurb });
      blurb.addClass("bv-u-color-text-muted");
      blurb.addClass("bv-u-font-size-12_5px");
      blurb.addClass("bv-u-line-height-1_45");
      blurb.addClass("bv-u-margin-4px-0-8px");
      const deal = card.createEl("button", { text: "Deal", cls: "mod-cta" });
      deal.onclick = () => void this.deal(g.action);
    }
  }

  private async deal(action: Action): Promise<void> {
    if (this.busy || !this.body) return;
    this.busy = true;
    this.body.empty();
    const pending = this.body.createEl("p", { text: "Dealing from your map…" });
    pending.addClass("bv-u-color-text-muted");
    pending.addClass("bv-u-font-size-13px");
    try {
      const deal = await fetchGameDeal(
        { baseUrl: this.plugin.settings.baseUrl, token: this.plugin.settings.token },
        action,
      );
      this.body.empty();
      this.renderDeal(deal, action);
    } catch (e) {
      this.body.empty();
      const msg = e instanceof BeviaApiError ? e.message : String(e);
      const err = this.body.createEl("p", { text: msg });
      err.addClass("bv-u-color-text-error");
      err.addClass("bv-u-font-size-13px");
      this.backRow(action);
    } finally {
      this.busy = false;
    }
  }

  private renderDeal(deal: GameDeal, action: Action): void {
    if ("unavailable" in deal && deal.unavailable) {
      const p = this.body!.createEl("p", { text: deal.reason });
      p.addClass("bv-u-color-text-muted");
      p.addClass("bv-u-font-size-13px");
      p.addClass("bv-u-line-height-1_5");
      this.backRow(action, false);
      return;
    }
    switch (deal.game) {
      case "two_truths":
        this.renderTwoTruths(deal as TwoTruthsDeal);
        break;
      case "expedition":
        this.renderExpedition(deal as ExpeditionDeal);
        break;
      case "time_machine":
        this.renderTimeMachine(deal as TimeMachineDeal);
        break;
    }
    this.backRow(action);
  }

  private backRow(action: Action, again = true): void {
    if (!this.body) return;
    const row = this.body.createDiv();
    row.addClass("bv-u-margin-top-14px");
    row.addClass("bv-u-display-flex");
    row.addClass("bv-u-gap-8px");
    if (again) {
      const redeal = row.createEl("button", { text: "Deal again" });
      redeal.onclick = () => void this.deal(action);
    }
    const back = row.createEl("button", { text: "All games" });
    back.onclick = () => this.renderMenu();
  }

  // ── Shared pieces ──────────────────────────────────────────────────

  private eyebrow(parent: HTMLElement, text: string, accent = false): void {
    const el = parent.createEl("div", { cls: "bevia-eyebrow", text });
    el.addClass("bv-u-margin-bottom-6px");
    if (accent) el.addClass("bv-u-color-text-accent");
  }

  private para(parent: HTMLElement, text: string, muted = false): HTMLElement {
    const p = parent.createEl("p", { text });
    p.addClass("bv-u-margin-2px-0-12px");
    p.addClass("bv-u-line-height-1_5");
    p.addClass("bv-u-font-size-13_5px");
    if (muted) p.addClass("bv-u-color-text-muted");
    return p;
  }

  private evidenceBlock(parent: HTMLElement, evidence: GameEvidence[]): void {
    if (evidence.length === 0) return;
    const ev = parent.createEl("details");
    const sum = ev.createEl("summary", {
      text: `Grounded in ${evidence.length} of your notes`,
    });
    sum.addClass("bv-u-cursor-pointer");
    sum.addClass("bv-u-color-text-muted");
    sum.addClass("bv-u-font-size-12_5px");
    for (const e of evidence) {
      const row = ev.createEl("div");
      row.addClass("bv-u-font-size-12px");
      row.addClass("bv-u-color-text-muted");
      row.addClass("bv-u-margin-5px-0");
      if (e.occurred_at) row.createEl("b", { text: e.occurred_at.slice(0, 10) });
      row.appendText(`${e.occurred_at ? " — " : ""}${e.excerpt}`);
    }
  }

  private surpriseRow(parent: HTMLElement): void {
    const btn = parent.createEl("button", { text: "That surprised me" });
    btn.addClass("bv-u-margin-top-8px");
    btn.onclick = () => this.noteSurprise(btn);
  }

  // ── Two Truths and a Lie ───────────────────────────────────────────

  private renderTwoTruths(deal: TwoTruthsDeal): void {
    const body = this.body!;
    this.eyebrow(body, "TWO TRUTHS AND A LIE");
    this.para(
      body,
      "Two of these are pulled straight from your map — with receipts. One is the game's fiction. Which is the lie?",
      true,
    );

    let answered = false;
    const cards: { el: HTMLElement; btn: HTMLButtonElement }[] = [];

    const reveal = (guessedId: string): void => {
      if (answered) return;
      answered = true;
      for (const { btn } of cards) btn.disabled = true;

      const lie = deal.readings.find((r) => r.is_lie);
      const caught = lie && guessedId === lie.id;

      for (let i = 0; i < deal.readings.length; i++) {
        const r = deal.readings[i];
        const { el } = cards[i];
        if (r.is_lie) {
          const badge = el.createEl("div", {
            cls: "bevia-eyebrow",
            text: "THE GAME'S FICTION",
          });
          badge.addClass("bv-u-color-text-accent");
          badge.addClass("bv-u-margin-top-8px");
          const note = el.createEl("p", {
            text: "Invented for this round only — it lives nowhere on your map.",
          });
          note.addClass("bv-u-color-text-muted");
          note.addClass("bv-u-font-size-12px");
          note.addClass("bv-u-margin-0");
        } else {
          const badge = el.createEl("div", { cls: "bevia-eyebrow", text: "TRUE" });
          badge.addClass("bv-u-margin-top-8px");
          this.evidenceBlock(el, r.evidence);
        }
      }

      const outcome = body.createDiv();
      outcome.addClass("bv-u-margin-top-10px");
      this.para(
        outcome,
        caught
          ? "You caught the fiction. The other two carry your own receipts — worth a look."
          : "The map had receipts you didn't expect — that's a discovery, not a miss. Drill into the truths.",
      );
      this.surpriseRow(outcome);
    };

    for (const r of deal.readings) {
      const card = body.createDiv();
      card.addClass("bv-u-margin-0-0-10px");
      card.addClass("bv-u-padding-8px-10px");
      card.addClass("bv-u-background-background-secondary");
      card.addClass("bv-u-border-radius-8px");
      const text = card.createEl("p", { text: r.text });
      text.addClass("bv-u-margin-0-0-8px");
      text.addClass("bv-u-font-size-13_5px");
      text.addClass("bv-u-line-height-1_5");
      const btn = card.createEl("button", { text: "This is the lie" });
      btn.onclick = () => reveal(r.id);
      cards.push({ el: card, btn });
    }
  }

  // ── Expedition ─────────────────────────────────────────────────────

  private renderExpedition(deal: ExpeditionDeal): void {
    const body = this.body!;
    this.eyebrow(body, "EXPEDITION");
    const t = deal.territory;
    this.para(
      body,
      `${t.label} — ${t.note_count} notes, quiet for ${t.dormant_days} days.`,
    );
    this.para(
      body,
      "Before the card flips: what do you remember of this place? Say it out loud, or just hold it in mind.",
      true,
    );

    const flipBtn = body.createEl("button", { text: "Flip the card", cls: "mod-cta" });
    const revealWrap = body.createDiv();

    flipBtn.onclick = () => {
      flipBtn.remove();
      this.eyebrow(revealWrap, "WHAT THE MAP KEPT", true);
      if (deal.reveal.summary) this.para(revealWrap, deal.reveal.summary);
      if (deal.reveal.landmarks.length > 0) {
        this.eyebrow(revealWrap, "LANDMARKS");
        for (const lm of deal.reveal.landmarks) {
          const row = revealWrap.createEl("div");
          row.addClass("bv-u-font-size-12_5px");
          row.addClass("bv-u-margin-5px-0");
          row.addClass("bv-u-line-height-1_45");
          if (lm.occurred_at) row.createEl("b", { text: lm.occurred_at.slice(0, 10) });
          row.appendText(`${lm.occurred_at ? " — " : ""}${lm.text}`);
        }
      }
      this.evidenceBlock(revealWrap, deal.reveal.evidence);
      this.surpriseRow(revealWrap);
    };
  }

  // ── Time Machine ───────────────────────────────────────────────────

  private renderTimeMachine(deal: TimeMachineDeal): void {
    const body = this.body!;
    this.eyebrow(body, "TIME MACHINE");
    this.para(body, deal.territory.label);

    const thenCard = body.createDiv();
    thenCard.addClass("bv-u-margin-0-0-10px");
    thenCard.addClass("bv-u-padding-8px-10px");
    thenCard.addClass("bv-u-background-background-secondary");
    thenCard.addClass("bv-u-border-radius-8px");
    this.eyebrow(thenCard, `THEN — ${deal.then.observed_at.slice(0, 10)}`);
    const thenP = thenCard.createEl("p", { text: deal.then.state_summary });
    thenP.addClass("bv-u-margin-0");
    thenP.addClass("bv-u-font-size-13_5px");
    thenP.addClass("bv-u-line-height-1_5");

    this.para(body, "That's what this territory was doing then — frozen at the time, never rewritten. What changed since?", true);

    const flipBtn = body.createEl("button", { text: "Show me what actually changed", cls: "mod-cta" });
    const revealWrap = body.createDiv();

    flipBtn.onclick = () => {
      flipBtn.remove();
      this.eyebrow(revealWrap, `NOW — ${deal.now.observed_at.slice(0, 10)}`, true);
      this.para(revealWrap, deal.now.state_summary);

      const compass: { label: string; text: string }[] = [
        { label: "PERSISTED", text: deal.evolution.north },
        { label: "EMERGED", text: deal.evolution.east },
        { label: "FADED", text: deal.evolution.south },
        { label: "TRANSFORMED", text: deal.evolution.west },
      ];
      for (const c of compass) {
        if (!c.text || !c.text.trim()) continue;
        this.eyebrow(revealWrap, c.label);
        this.para(revealWrap, c.text.trim());
      }
      this.surpriseRow(revealWrap);
    };
  }
}
