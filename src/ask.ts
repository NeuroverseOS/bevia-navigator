// Bevia — Ask Molly (the two-agent panel inside Obsidian).
//
// A modal where you ask your map a question in natural language. The
// LIBRARIAN answers from your own work (grounded, via recall); the
// CONSULTANT takes it further (a forward move that supports how you work).
// Pull = BYOK — the call runs on your own AI key. Read-only: never touches
// your notes. Backed by the /molly-ask EF.

import { App, Modal } from "obsidian";
import type BeviaNavigatorPlugin from "./main";
import { fetchMollyAsk, BeviaApiError, type MollyAskResponse } from "./api";

class AskMollyModal extends Modal {
  plugin: BeviaNavigatorPlugin;

  constructor(app: App, plugin: BeviaNavigatorPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("div", { cls: "bevia-eyebrow", text: "ASK MOLLY" });
    const h = contentEl.createEl("h2", { text: "Ask your map a question" });
    h.addClass("bv-u-margin-4px-0-2px");
    const lede = contentEl.createEl("p", {
      text: "The Librarian answers from your own work; the Consultant takes it further.",
    });
    lede.addClass("bv-u-color-text-muted");
    lede.addClass("bv-u-margin-top-0");

    const input = contentEl.createEl("textarea", {
      attr: { rows: "3", placeholder: "e.g. What did I do the last time onboarding broke?" },
    });
    input.addClass("bv-u-width-100");
    input.addClass("bv-u-resize-vertical");
    input.addClass("bv-u-margin-bottom-10px");

    const askBtn = contentEl.createEl("button", { text: "Ask", cls: "mod-cta" });
    const status = contentEl.createEl("p");
    status.addClass("bv-u-color-text-muted");
    status.addClass("bv-u-font-size-13px");
    status.addClass("bv-u-margin-top-8px");
    const answer = contentEl.createDiv();
    answer.addClass("bv-u-margin-top-12px");

    const run = async (): Promise<void> => {
      const message = input.value.trim();
      if (!message) {
        input.focus();
        return;
      }
      askBtn.disabled = true;
      status.setText("Molly is thinking…");
      answer.empty();
      try {
        const res = await fetchMollyAsk(
          { baseUrl: this.plugin.settings.baseUrl, token: this.plugin.settings.token },
          message,
        );
        status.setText("");
        this.renderAnswer(answer, res);
      } catch (e) {
        status.setText("");
        const msg = e instanceof BeviaApiError ? e.message : String(e);
        const err = answer.createEl("p", { text: msg });
        err.addClass("bv-u-color-text-error");
      } finally {
        askBtn.disabled = false;
      }
    };

    askBtn.onclick = () => void run();
    // Cmd/Ctrl+Enter submits.
    input.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        void run();
      }
    });
    input.focus();
  }

  private renderAnswer(parent: HTMLElement, res: MollyAskResponse): void {
    const section = (label: string, body: string, accent: boolean): void => {
      if (!body || !body.trim()) return;
      const box = parent.createDiv();
      box.addClass("bv-u-margin-0-0-12px");
      const tag = box.createEl("div", { cls: "bevia-eyebrow", text: label });
      if (accent) tag.addClass("bv-u-color-text-accent");
      const p = box.createEl("p", { text: body.trim() });
      p.addClass("bv-u-margin-2px-0-0");
      p.addClass("bv-u-line-height-1_5");
      if (accent) p.addClass("bv-u-color-text-accent");
    };
    // Librarian (grounded) plain; Consultant (forward) in the theme accent —
    // the same "this is the work-with-AI move" signal used elsewhere.
    section("THE LIBRARIAN", res.librarian, false);
    section("THE CONSULTANT", res.consultant, true);

    if (res.evidence && res.evidence.length > 0) {
      const ev = parent.createEl("details");
      ev.addClass("bv-u-margin-top-4px");
      const sum = ev.createEl("summary", {
        text: `Grounded in ${res.evidence.length} territor${res.evidence.length === 1 ? "y" : "ies"}`,
      });
      sum.addClass("bv-u-cursor-pointer");
      sum.addClass("bv-u-color-text-muted");
      sum.addClass("bv-u-font-size-13px");
      for (const e of res.evidence) {
        const row = ev.createEl("div");
        row.addClass("bv-u-font-size-12_5px");
        row.addClass("bv-u-color-text-muted");
        row.addClass("bv-u-margin-5px-0");
        row.createEl("b", { text: e.label });
        row.appendText(
          ` — ${e.summary}${e.what_changed ? ` · what changed: ${e.what_changed}` : ""}`,
        );
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function openAskMolly(plugin: BeviaNavigatorPlugin): void {
  new AskMollyModal(plugin.app, plugin).open();
}
