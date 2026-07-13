// Bevia — Ask Bevia (the conversational Molly + Spock panel).
//
// The docked sidebar form of the two-voice interaction the
// librarian-consultant spec (§2) called for. Where ask.ts is the
// one-shot modal, this is the persistent panel: a running thread you
// converse with, the MCP-like Mind surface that lives beside the editor.
//
//   - THE LIBRARIAN (codename Molly) — answers grounded in your own
//     work, via recall. Cartographic: what your substrate actually holds.
//   - THE CONSULTANT (codename Spock) — takes it forward: an
//     invitational move that supports how you work (ADR-0207). Never a
//     command; the human stays the agent.
//
// Pull = BYOK — every question runs on the user's own AI key. Read-only:
// the panel never touches the user's notes (Navigator doctrine — a Mind
// surface that projects, never mutates). Backed by the /molly-ask EF,
// the same backend the modal uses.

import { ItemView, WorkspaceLeaf } from "obsidian";
import { fetchMollyAsk, BeviaApiError, type MollyAskResponse } from "./api";
import type BeviaNavigatorPlugin from "./main";

export const BEVIA_ASK_VIEW_TYPE = "bevia-ask-view";

const SUGGESTIONS = [
  "What did I do the last time onboarding broke?",
  "What have I been circling without resolving?",
  "Where is my thinking spending the most time lately?",
];

export class BeviaAskView extends ItemView {
  plugin: BeviaNavigatorPlugin;
  private thread: HTMLElement | null = null;
  private input: HTMLTextAreaElement | null = null;
  private askBtn: HTMLButtonElement | null = null;
  private busy = false;
  /** Question handed in before the shell finished rendering (the
   *  suggestion-chip path opens the view and asks in one gesture);
   *  consumed at the end of onOpen. */
  private pendingQuestion: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: BeviaNavigatorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return BEVIA_ASK_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Ask Bevia";
  }

  getIcon(): string {
    return "messages-square";
  }

  async onOpen(): Promise<void> {
    this.renderShell();
    if (this.pendingQuestion) {
      const q = this.pendingQuestion;
      this.pendingQuestion = null;
      if (this.input) this.input.value = q;
      void this.run();
    }
  }

  async onClose(): Promise<void> {
    this.thread = null;
    this.input = null;
    this.askBtn = null;
  }

  /** External hook — the Navigator place card's Ask verb activates
   *  this view and puts the cursor in the composer. */
  focusInput(): void {
    this.input?.focus();
  }

  private renderShell(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("bv-u-display-flex");
    root.addClass("bv-u-flex-direction-column");
    root.addClass("bv-u-height-100");
    root.addClass("bv-u-padding-0");

    // Header — eyebrow + lede. Fixed at the top.
    const header = root.createDiv();
    header.addClass("bv-u-padding-12px-14px-8px");
    header.addClass("bv-u-border-bottom-1px-solid-background-modifier-border");
    header.createEl("div", { cls: "bevia-eyebrow", text: "ASK BEVIA" });
    const lede = header.createEl("p", {
      text: "The Librarian answers from your own work; the Consultant takes it further. Runs on your AI key — never touches your notes.",
    });
    lede.addClass("bv-u-color-text-muted");
    lede.addClass("bv-u-font-size-12_5px");
    lede.addClass("bv-u-line-height-1_45");
    lede.addClass("bv-u-margin-4px-0-0");

    // Conversation thread — scrolls.
    const thread = root.createDiv();
    thread.addClass("bv-u-flex-1-1-auto");
    thread.addClass("bv-u-overflow-y-auto");
    thread.addClass("bv-u-padding-12px-14px");
    this.thread = thread;
    this.renderEmptyState();

    // Composer — pinned at the bottom.
    const composer = root.createDiv();
    composer.addClass("bv-u-border-top-1px-solid-background-modifier-border");
    composer.addClass("bv-u-padding-10px-12px");
    composer.addClass("bv-u-display-flex");
    composer.addClass("bv-u-flex-direction-column");
    composer.addClass("bv-u-gap-8px");

    const input = composer.createEl("textarea", {
      attr: { rows: "2", placeholder: "Ask your map a question…" },
    });
    input.addClass("bv-u-width-100");
    input.addClass("bv-u-resize-vertical");
    this.input = input;

    const askBtn = composer.createEl("button", { text: "Ask", cls: "mod-cta" });
    this.askBtn = askBtn;

    askBtn.onclick = () => void this.run();
    // Enter sends (chat convention); Shift+Enter makes a newline.
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        void this.run();
      }
    });
  }

  /** First-run state — explains the panel and offers seed questions. */
  private renderEmptyState(): void {
    if (!this.thread) return;
    this.thread.empty();
    const wrap = this.thread.createDiv();
    wrap.addClass("bv-u-color-text-muted");
    wrap.addClass("bv-u-font-size-13px");
    wrap.createEl("p", {
      text: "Ask anything about what you've worked out. Two voices answer:",
    }).addClass("bv-u-margin-0-0-8px");

    const voices = wrap.createEl("ul");
    voices.addClass("bv-u-margin-0-0-14px");
    voices.addClass("bv-u-padding-left-18px");
    voices.addClass("bv-u-line-height-1_5");
    const lib = voices.createEl("li");
    lib.createEl("b", { text: "The Librarian" });
    lib.appendText(" — grounded in your own map.");
    const con = voices.createEl("li");
    const conB = con.createEl("b", { text: "The Consultant" });
    conB.addClass("bv-u-color-text-accent");
    con.appendText(" — a forward move for how you work.");

    const tryEl = wrap.createEl("div", { cls: "bevia-eyebrow", text: "TRY" });
    tryEl.addClass("bv-u-margin-bottom-6px");
    for (const s of SUGGESTIONS) {
      const chip = wrap.createEl("button", { text: s });
      chip.addClass("bv-u-display-block");
      chip.addClass("bv-u-width-100");
      chip.addClass("bv-u-text-align-left");
      chip.addClass("bv-u-margin-0-0-6px");
      chip.addClass("bv-u-padding-7px-10px");
      chip.addClass("bv-u-font-size-12_5px");
      chip.addClass("bv-u-cursor-pointer");
      chip.onclick = () => {
        if (this.input) this.input.value = s;
        void this.run();
      };
    }
  }

  private async run(): Promise<void> {
    if (this.busy || !this.input || !this.thread) return;
    const message = this.input.value.trim();
    if (!message) {
      this.input.focus();
      return;
    }

    // First real question clears the empty state.
    if (this.thread.querySelector("button")) this.thread.empty();

    this.busy = true;
    if (this.askBtn) this.askBtn.disabled = true;
    this.input.value = "";

    this.appendQuestion(message);
    const pending = this.appendPending();

    try {
      const res = await fetchMollyAsk(
        { baseUrl: this.plugin.settings.baseUrl, token: this.plugin.settings.token },
        message,
      );
      pending.remove();
      this.appendAnswer(res);
    } catch (e) {
      pending.remove();
      const msg = e instanceof BeviaApiError ? e.message : String(e);
      const err = this.thread.createEl("p", { text: msg });
      err.addClass("bv-u-color-text-error");
      err.addClass("bv-u-font-size-13px");
    } finally {
      this.busy = false;
      if (this.askBtn) this.askBtn.disabled = false;
      this.scrollToEnd();
    }
  }

  private appendQuestion(text: string): void {
    if (!this.thread) return;
    const box = this.thread.createDiv();
    box.addClass("bv-u-margin-0-0-10px");
    box.addClass("bv-u-padding-8px-10px");
    box.addClass("bv-u-background-background-secondary");
    box.addClass("bv-u-border-radius-8px");
    const q = box.createEl("p", { text });
    q.addClass("bv-u-margin-0");
    q.addClass("bv-u-font-size-13_5px");
    q.addClass("bv-u-font-weight-600");
    q.addClass("bv-u-line-height-1_45");
    this.scrollToEnd();
  }

  private appendPending(): HTMLElement {
    const box = this.thread!.createDiv();
    box.addClass("bv-u-margin-0-0-16px");
    const p = box.createEl("p", { text: "Bevia is thinking…" });
    p.addClass("bv-u-color-text-muted");
    p.addClass("bv-u-font-size-13px");
    p.addClass("bv-u-margin-0");
    this.scrollToEnd();
    return box;
  }

  private appendAnswer(res: MollyAskResponse): void {
    if (!this.thread) return;
    const box = this.thread.createDiv();
    box.addClass("bv-u-margin-0-0-18px");

    const section = (label: string, body: string, accent: boolean): void => {
      if (!body || !body.trim()) return;
      const tag = box.createEl("div", { cls: "bevia-eyebrow", text: label });
      tag.addClass("bv-u-margin-top-0");
      if (accent) tag.addClass("bv-u-color-text-accent");
      const p = box.createEl("p", { text: body.trim() });
      p.addClass("bv-u-margin-2px-0-12px");
      p.addClass("bv-u-line-height-1_5");
      p.addClass("bv-u-font-size-13_5px");
      if (accent) p.addClass("bv-u-color-text-accent");
    };
    // Librarian (grounded) plain; Consultant (Spock — forward) in the
    // theme accent: the "work-with-AI move" signal used across surfaces.
    // Bevia Local degraded answers are the engine's deterministic grounded
    // readout — label them for what they are, never as narration.
    section(res.degraded ? "FROM YOUR MAP" : "THE LIBRARIAN", res.librarian, false);
    section("THE CONSULTANT", res.consultant, true);
    if (res.degraded) {
      const note = box.createEl("p", {
        text: "Answered straight from your map — no AI narration ran on this one.",
      });
      note.addClass("bv-u-color-text-muted");
      note.addClass("bv-u-font-size-12px");
      note.addClass("bv-u-margin-0-0-8px");
    }

    if (res.evidence && res.evidence.length > 0) {
      const ev = box.createEl("details");
      const sum = ev.createEl("summary", {
        text: `Grounded in ${res.evidence.length} territor${res.evidence.length === 1 ? "y" : "ies"}`,
      });
      sum.addClass("bv-u-cursor-pointer");
      sum.addClass("bv-u-color-text-muted");
      sum.addClass("bv-u-font-size-12_5px");
      for (const e of res.evidence) {
        const row = ev.createEl("div");
        row.addClass("bv-u-font-size-12px");
        row.addClass("bv-u-color-text-muted");
        row.addClass("bv-u-margin-5px-0");
        row.createEl("b", { text: e.label });
        const similarity =
          typeof e.similarity === "number" ? ` · similarity ${e.similarity.toFixed(2)}` : "";
        row.appendText(
          ` — ${e.summary}${e.what_changed ? ` · what changed: ${e.what_changed}` : ""}${similarity}`,
        );
      }
    }
  }

  private scrollToEnd(): void {
    if (this.thread) this.thread.scrollTop = this.thread.scrollHeight;
  }

  /** Let an external caller (ribbon/command/suggestion chip) preseed a
   *  question and run it. Safe to call before the shell renders — the
   *  question queues and fires at the end of onOpen. */
  askQuestion(question: string): void {
    if (!this.input || !this.thread) {
      this.pendingQuestion = question;
      return;
    }
    this.input.value = question;
    void this.run();
  }
}
