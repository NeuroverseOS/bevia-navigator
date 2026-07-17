// Bevia — "Analyze My Vault" (the Discovery Atlas client).
//
// Design: design/v27-observatory/funnel.jsx (BVDiscovery) + funnel-content.js.
// Five states, render-rule clean, no progress bar, no time promise, no
// email-in-modal — the close is a create-account handoff.
//
// Reads a representative sample of the vault, sends it to /instant-cartography
// (anonymous), and renders the territories + emerging continents in the v27
// Observatory register. The wedge is TIME (frozen photo → living film), never
// coverage — so we never show "X of N notes"; we say "a representative sample."

import { App, Modal, Notice, TFile, TFolder, requestUrl } from "obsidian";
import { isLocalMode } from "./local";
import type BeviaNavigatorPlugin from "./main";
import {
  v27Root, aperture, mono, serif, text, button, territoryCard, readingAperture, dot,
  type BvState,
} from "./v27";
import { renderTwoDoorPanel } from "./two-door";
import { isSafeVaultPath } from "./sync";

const MAX_NOTES = 400; // ingest ceiling — matches the server; the real cost bound is the driver's total dollar budget
const MIN_CHARS = 40;
const TARGET_BUDGET_CHARS = 2_000_000; // match the server backstop; big vaults stay bounded
const POLL_MS = 2500; // status poll cadence while the map builds
const THIN_TERRITORY_THRESHOLD = 3; // below this → calibrated-humility "thin" state

interface SpockReading { where_shown?: string; ask_yourself?: string; ai_move?: string }
interface DiscoveryTerritory { label: string; summary?: string; strength?: number; note_count?: number; spock?: SpockReading }
interface DiscoveryResult {
  ok: boolean;
  session_id: string;
  /** Honest-failure message from the engine (status === "error") —
   *  e.g. the reading model was unavailable. Rendered verbatim. */
  error?: string;
  // Async build state — the demo runs the real reflective backfill and
  // streams progress to instant_cartography_result; the modal polls it.
  status?: "building" | "done" | "pending" | "error";
  phase?: "reading" | "mapping" | "done";
  progress?: { notes_total?: number; notes_read?: number };
  territory_count: number;
  headline_territories: DiscoveryTerritory[];
  continents_preview: Array<{ members: string[]; size: number; affinity: number }>;
  coverage?: { notes_analyzed?: number };
  /** The map materialized through the REAL pipeline (materialize-territory →
   *  envelopes) — path + body per file. The plugin writes these with its
   *  normal vault writer, so the demo vault is exactly what a connected vault
   *  gets. Absent on older engines. */
  vault_files?: Array<{ vault_path: string; body_md: string }>;
}

// Cycle states so the reveal has the design's visual variety.
const STATE_CYCLE: BvState[] = ["strengthening", "recurring", "strengthening", "emergence", "recurring", "emergence"];

/** Coverage selection: stratify across top-level folders, newest-first within
 *  each, round-robin across them — so the sample SPANS the vault. */
function selectNotes(files: TFile[]): TFile[] {
  const eligible = files.filter((f) => f.stat.size >= MIN_CHARS);
  const byFolder = new Map<string, TFile[]>();
  for (const f of eligible) {
    const top = f.path.split("/")[0] || "(root)";
    let arr = byFolder.get(top);
    if (!arr) { arr = []; byFolder.set(top, arr); }
    arr.push(f);
  }
  for (const arr of byFolder.values()) arr.sort((a, b) => b.stat.mtime - a.stat.mtime);
  const groups = Array.from(byFolder.values());
  const picked: TFile[] = [];
  for (let i = 0; picked.length < MAX_NOTES; i++) {
    let any = false;
    for (const g of groups) {
      const f = g[i];
      if (f) { picked.push(f); any = true; if (picked.length >= MAX_NOTES) break; }
    }
    if (!any) break;
  }
  return picked;
}

export async function analyzeVault(plugin: BeviaNavigatorPlugin): Promise<void> {
  // Bevia Local (leg 2): the Discovery preview is a cloud run, and no
  // request may leave for a cloud host while Local mode is on. The modal's
  // two network calls are unreachable without this entry point, but each
  // is also guarded below.
  if (isLocalMode()) {
    new Notice(
      "Bevia Local is on — your map is built on your machine, and the cloud vault preview is not in Bevia Local yet.",
      8000,
    );
    return;
  }
  // Connected users don't belong on the free Discovery funnel — their
  // live Atlas already maps everything continuously and for real.
  // "Analyze My Vault" is the anonymous one-shot preview for people who
  // haven't connected yet; for a subscriber it's strictly worse than what
  // they already have. Send them to their real map instead of burning a
  // founder-funded ephemeral run.
  if (plugin.settings.token?.trim()) {
    new Notice(
      "You're connected — your live Atlas already maps your vault. " +
        "Use Sync now / the Navigator instead. (Analyze is the free preview for new vaults.)",
      8000,
    );
    void plugin.activateHomeView();
    return;
  }
  const baseUrl = plugin.settings.baseUrl?.replace(/\/+$/, "");
  if (!baseUrl) { new Notice("Set the Bevia base URL in settings first."); return; }
  if (plugin.app.vault.getMarkdownFiles().length === 0) {
    new Notice("No markdown notes found in this vault.");
    return;
  }
  new DiscoveryModal(plugin, baseUrl).open();
}

type DState = "invitation" | "reading" | "reveal" | "thin" | "handoff";

class DiscoveryModal extends Modal {
  private state: DState = "invitation";
  private result: DiscoveryResult | null = null;
  private statusTimer: number | null = null;
  // Async build: the poll timer survives re-renders (cleared only on close /
  // completion); the live element refs let each poll update the reading
  // screen in place without resetting the ambient animation.
  private pollTimer: number | null = null;
  private liveLineEl: HTMLElement | null = null;
  private liveListEl: HTMLElement | null = null;
  private shownLive = 0;
  // Optional visitor Google AI key. Present → the run bills THEIR key and is
  // UNLIMITED (all notes, no funded dollar cap). Blank → the free Bevia-funded
  // preview, capped intake. Same engine either way; the only lever is intake.
  private byokKey = "";

  constructor(private plugin: BeviaNavigatorPlugin, private baseUrl: string) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("bevia-discovery-modal");
    this.render();
  }

  onClose(): void {
    if (this.statusTimer !== null) window.clearInterval(this.statusTimer);
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    this.contentEl.empty();
  }

  private render(): void {
    if (this.statusTimer !== null) { window.clearInterval(this.statusTimer); this.statusTimer = null; }
    const { contentEl } = this;
    contentEl.empty();
    const root = v27Root(contentEl);
    root.addClass("bv-wrap");
    switch (this.state) {
      case "invitation": this.renderInvitation(root); break;
      case "reading": this.renderReading(root); break;
      case "reveal": this.renderReveal(root); break;
      case "thin": this.renderThin(root); break;
      case "handoff": this.renderHandoff(root); break;
    }
  }

  private card(root: HTMLElement, pad: string, center = true): HTMLElement {
    const card = root.createDiv({ cls: "bv-card" });
    card.style.padding = pad;
    card.addClass("bv-u-max-width-460px");
    card.addClass("bv-u-margin-0-auto");
    if (center) card.addClass("bv-u-text-align-center");
    return card;
  }

  private renderInvitation(root: HTMLElement): void {
    const card = this.card(root, "34px 32px 28px");
    const apWrap = card.createDiv();
    apWrap.addClass("bv-u-margin-bottom-20px");
    aperture(apWrap, { size: 46, stroke: 1.3, color: "var(--bv-strengthening-dot)" });
    mono(card, "Analyze my vault · on your key", { size: 9, track: 0.16, dim: true, block: true }).addClass("bv-u-margin-bottom-14px");
    serif(card, "The links you didn't have time to make.", { size: 24, weight: 400, lh: 1.2 }).addClass("bv-u-margin-bottom-14px");
    const sub = text(card, "Bevia reads a representative sample of your vault and builds a living mind map from it \u2014 finding the connections between your notes, adding to the links you already made, and writing pattern readings your AI can pick up and act on.", { size: 13.5, color: "var(--bv-ink-soft)", lh: 1.55, maxWidth: 330 });
    sub.addClass("bv-u-margin-0-auto-24px");
    const cta = button(card, "Analyze my vault", { full: true, onClick: () => void this.runAnalysis() });
    cta.addClass("bv-u-margin-bottom-12px");

    // Optional: run on your OWN Google AI key → unlimited (whole vault), on
    // your key. Blank = the free capped preview on Bevia. Same engine; the
    // only difference is how much it reads (founder 2026-07-07).
    const keyWrap = card.createDiv({ cls: "bv-card-sunk" });
    keyWrap.addClass("bv-u-text-align-left");
    keyWrap.addClass("bv-u-padding-11px-13px");
    keyWrap.addClass("bv-u-margin-bottom-16px");
    mono(keyWrap, "Have an AI key? Read the whole vault \u2014 any provider", { size: 9, track: 0.14, dim: true, block: true }).addClass("bv-u-margin-bottom-7px");
    const keyInput = keyWrap.createEl("input", { type: "password", placeholder: "Paste any AI key (optional) — Gemini, OpenAI, Claude, Grok, DeepSeek, Mistral" });
    keyInput.addClass("bv-u-width-100");
    keyInput.style.width = "100%";
    keyInput.style.boxSizing = "border-box";
    keyInput.value = this.byokKey;

    // Price preview — scan the vault and estimate the read cost up front,
    // before a single call, so a full BYOK run is never a surprise bill
    // (founder 2026-07-07; same honesty as the ChatGPT-backfill cap flow).
    const mdFiles = this.plugin.app.vault.getMarkdownFiles();
    const totalChars = mdFiles.reduce((n, f) => n + (f.stat.size || 0), 0);
    const noteCount = mdFiles.length;
    const charsLabel = totalChars >= 1_000_000
      ? `${(totalChars / 1_000_000).toFixed(1)}M`
      : `${Math.max(1, Math.round(totalChars / 1000))}k`;
    // One model read per note at intake; input ≈ chars/4 tokens. ~$0.15 / 1M
    // tokens blended (rounded UP so the estimate never undersells the bill).
    const estUsd = Math.max(0.01, (totalChars / 4 / 1_000_000) * 0.15);
    const estEl = text(keyWrap, "", { size: 10, color: "var(--bv-ink-faint)", lh: 1.5 });
    estEl.addClass("bv-u-margin-top-6px");
    const paintEstimate = (): void => {
      estEl.setText(this.byokKey.length > 0
        ? `Your vault: ${noteCount} notes, ~${charsLabel} characters — about $${estUsd.toFixed(2)} on your key to read all of it. You pay your AI provider directly; nothing to us. The lowest-cost model tier is plenty — Bevia asks small, structured questions.`
        : `Paste your AI key to run it — free-tier keys work (Google's takes about a minute). The price shows above before anything runs; you pay your provider directly, never us.`);
    };
    paintEstimate();
    keyInput.addEventListener("input", () => { this.byokKey = keyInput.value.trim(); paintEstimate(); });
    const reassure = card.createDiv({ cls: "bv-card-sunk" });
    reassure.addClass("bv-u-display-flex");
    reassure.addClass("bv-u-gap-8px");
    reassure.addClass("bv-u-align-items-flex-start");
    reassure.addClass("bv-u-text-align-left");
    reassure.addClass("bv-u-padding-11px-13px");
    aperture(reassure, { size: 12, stroke: 1.2, color: "var(--bv-ink-faint)", pip: false }).addClass("bv-u-margin-top-1px");
    // Full disclosure, not vibes (audit S2 + founder question 2026-07-05
    // "is this accurate though?"): the click IS the say-so, and what it
    // sends is real note text — say so. Retention truth per the
    // keep-&-claim design (migration 20261220000000): what was read is
    // held 30 days under a pending account so a signup has no cold
    // start; discovery_pending_purge deletes unclaimed runs at 30 days.
    text(reassure, "Clicking Analyze sends a sample of your note text to Bevia — that's the say-so. We hold what it read and the map it drew for 30 days, so your map is already alive if you sign up. Unclaimed, all of it is deleted.", { size: 10.5, color: "var(--bv-ink-faint)", lh: 1.5 });
  }

  private renderReading(root: HTMLElement): void {
    const card = this.card(root, "44px 32px 38px");
    const apWrap = card.createDiv();
    apWrap.addClass("bv-u-display-flex");
    apWrap.addClass("bv-u-justify-content-center");
    apWrap.addClass("bv-u-margin-bottom-28px");
    readingAperture(apWrap, 72);
    mono(card, "Reading", { size: 9, track: 0.18, color: "var(--bv-strengthening-ink)", block: true }).addClass("bv-u-margin-bottom-16px");

    const statuses = ["Reading your notes…", "Finding what recurs…", "Drawing the map…", "Naming the territories…"];
    const stack = card.createDiv();
    stack.addClass("bv-u-display-flex");
    stack.addClass("bv-u-flex-direction-column");
    stack.addClass("bv-u-gap-9px");
    stack.addClass("bv-u-align-items-center");
    stack.addClass("bv-u-margin-bottom-26px");
    const lines = statuses.map((s) => {
      const line = stack.createDiv({ text: s });
      line.addClass("bv-u-font-family-bv-serif");
      line.addClass("bv-u-font-size-17px");
      line.addClass("bv-u-font-style-italic");
      return line;
    });
    let lit = 0;
    const paint = () => lines.forEach((l, i) => {
      l.style.color = i === lit ? "var(--bv-ink)" : "var(--bv-ink-ghost)";
      l.style.opacity = i === lit ? "1" : "0.5";
    });
    paint();
    this.statusTimer = window.setInterval(() => { lit = (lit + 1) % lines.length; paint(); }, 1400);

    // Live build line + the territories forming, updated in place by each
    // status poll — the map assembles in front of the user.
    this.liveLineEl = mono(card, "This runs the real engine — you can watch the map fill in.", { size: 9, track: 0.05, dim: true, block: true });
    this.liveLineEl.addClass("bv-u-margin-bottom-14px");
    this.liveListEl = card.createDiv();
    this.liveListEl.addClass("bv-u-display-flex");
    this.liveListEl.addClass("bv-u-flex-direction-column");
    this.liveListEl.addClass("bv-u-gap-7px");
    this.liveListEl.addClass("bv-u-text-align-left");
    this.shownLive = 0;
  }

  /** Apply one status poll to the reading screen without re-rendering
   *  (re-render would reset the ambient animation). New territories append
   *  as compact cards the moment they form. */
  private applyLiveStatus(data: DiscoveryResult): void {
    this.result = { ...(this.result ?? data), ...data };
    if (this.liveLineEl) {
      const p = data.progress ?? {};
      const total = p.notes_total ?? 0;
      const read = Math.min(p.notes_read ?? 0, total);
      this.liveLineEl.setText(
        data.phase === "mapping"
          ? (data.territory_count
              ? `Naming what recurs — ${data.territory_count} territor${data.territory_count === 1 ? "y" : "ies"} so far`
              : "Finding what recurs…")
          : total > 0
            ? `Reading your thinking — ${read} of ${total} notes`
            : "Reading your thinking…",
      );
    }
    if (this.liveListEl) {
      const terrs = (data.headline_territories ?? []).slice(0, 6);
      for (let i = this.shownLive; i < terrs.length; i++) {
        territoryCard(this.liveListEl, this.toTerr(terrs[i], i), { compact: true });
      }
      this.shownLive = Math.max(this.shownLive, terrs.length);
    }
  }

  /** Poll the status row until the build completes, then reveal. The timer
   *  survives renders; onClose clears it. Transient poll failures are
   *  ignored — the next tick retries. */
  private pollStatus(sessionId: string): void {
    if (isLocalMode()) return; // leg 2 belt-and-suspenders — never poll the cloud
    this.pollTimer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await requestUrl({
            url: `${this.baseUrl}/functions/v1/instant-cartography-status`,
            method: "POST",
            contentType: "application/json",
            body: JSON.stringify({ session_id: sessionId }),
            throw: false,
          });
          if (res.status >= 200 && res.status < 300) {
            const data = res.json as DiscoveryResult;
            if (data && data.ok !== false) {
              if (data.status === "error") {
                // The engine says the run failed (e.g. the reading model
                // was unavailable). Say so honestly and stop — never show
                // a "still becoming legible" screen for an engine failure.
                this.pollTimer = null;
                new Notice(
                  data.error ??
                    "The map couldn't be drawn this time — nothing about your vault caused this. Try again in a little while.",
                  10000,
                );
                this.state = "invitation";
                this.render();
                return;
              }
              this.applyLiveStatus(data);
              if (data.status === "done") {
                this.pollTimer = null;
                void this.recordAnalyzeComplete();
                this.state = (this.result?.territory_count ?? 0) < THIN_TERRITORY_THRESHOLD ? "thin" : "reveal";
                this.render();
                // Push the map to the vault automatically — the demo's whole
                // point is the vault blooming, not a popup. Writes the real
                // materializer output (vault_files) through the one system.
                void this.saveSampleToVault();
                return;
              }
            }
          }
        } catch { /* transient — next tick retries */ }
        this.pollStatus(sessionId);
      })();
    }, POLL_MS);
  }

  private renderThin(root: HTMLElement): void {
    const card = this.card(root, "32px 30px 26px", false);
    card.addClass("bv-u-max-width-460px");
    const eyebrow = card.createDiv();
    eyebrow.addClass("bv-u-display-flex");
    eyebrow.addClass("bv-u-align-items-center");
    eyebrow.addClass("bv-u-gap-9px");
    eyebrow.addClass("bv-u-margin-bottom-14px");
    dot(eyebrow, "unverified", 6);
    mono(eyebrow, "Still becoming legible", { size: 9, track: 0.16, color: "var(--bv-unverified-ink)" });
    serif(card, "Your vault is still becoming legible.", { size: 22, weight: 400, lh: 1.22 }).addClass("bv-u-margin-bottom-12px");
    text(card, "Here's the start of the shape. As more of your thinking accumulates, the territories sharpen — there's no threshold to cross, only evidence to gather.", { size: 13, color: "var(--bv-ink-soft)", lh: 1.55 }).addClass("bv-u-margin-bottom-22px");
    const found = this.result?.headline_territories.length ?? 0;
    mono(card, `${found} early shape${found === 1 ? "" : "s"} so far`, { size: 8.5, track: 0.12, dim: true, block: true }).addClass("bv-u-margin-bottom-12px");
    const list = card.createDiv();
    list.addClass("bv-u-display-flex");
    list.addClass("bv-u-flex-direction-column");
    list.addClass("bv-u-gap-9px");
    list.addClass("bv-u-margin-bottom-22px");
    (this.result?.headline_territories ?? []).slice(0, 2).forEach((terr, i) => {
      territoryCard(list, this.toTerr(terr, i), { compact: true });
    });
    button(card, "Keep watching as it grows", { kind: "ghost", full: true, onClick: () => { this.state = "handoff"; this.render(); } });
  }

  private renderReveal(root: HTMLElement): void {
    const r = this.result;
    if (!r) return;
    const card = root.createDiv({ cls: "bv-card" });
    card.addClass("bv-u-max-width-560px");
    card.addClass("bv-u-margin-0-auto");
    card.addClass("bv-u-overflow-hidden");

    const head = card.createDiv();
    head.addClass("bv-u-padding-26px-30px-20px");
    head.addClass("bv-u-border-bottom-1px-solid-bv-rule-faint");
    const eyebrow = head.createDiv();
    eyebrow.addClass("bv-u-display-flex");
    eyebrow.addClass("bv-u-align-items-center");
    eyebrow.addClass("bv-u-gap-8px");
    eyebrow.addClass("bv-u-margin-bottom-13px");
    aperture(eyebrow, { size: 16, stroke: 1.3, color: "var(--bv-strengthening-dot)" });
    mono(eyebrow, "What recurs", { size: 9, track: 0.16, color: "var(--bv-strengthening-ink)" });
    serif(head, `You keep returning to ${r.territory_count} territories.`, { size: 25, weight: 400, lh: 1.18 }).addClass("bv-u-margin-bottom-10px");
    text(head, "These are the shapes your thinking already makes. Bevia found them by what recurs — not by what's newest.", { size: 12.5, color: "var(--bv-ink-soft)", lh: 1.5, maxWidth: 430 });

    const body = card.createDiv();
    body.addClass("bv-u-padding-18px-30px-8px");
    const list = body.createDiv();
    list.addClass("bv-u-display-flex");
    list.addClass("bv-u-flex-direction-column");
    list.addClass("bv-u-gap-9px");
    r.headline_territories.slice(0, 4).forEach((terr, i) => {
      territoryCard(list, this.toTerr(terr, i), {});
      if (terr.spock) this.spockBlock(list, terr.spock);
    });
    const remaining = r.headline_territories.length - 4;
    if (remaining > 0) {
      const more = button(body, `Show ${remaining} more territories  ↓`, { kind: "bare", onClick: () => {
        more.remove();
        r.headline_territories.slice(4).forEach((terr, i) => {
          territoryCard(list, this.toTerr(terr, i + 4), {});
          if (terr.spock) this.spockBlock(list, terr.spock);
        });
      } });
      more.addClass("bv-u-margin-12px-0-4px");
    }

    if (r.continents_preview.length > 0) {
      const cont = card.createDiv();
      cont.addClass("bv-u-padding-16px-30px-24px");
      cont.addClass("bv-u-border-top-1px-solid-bv-rule-faint");
      cont.addClass("bv-u-background-bv-panel-sunk");
      mono(cont, "These are starting to cluster", { size: 8.5, track: 0.16, dim: true, block: true }).addClass("bv-u-margin-bottom-12px");
      const cl = cont.createDiv();
      cl.addClass("bv-u-display-flex");
      cl.addClass("bv-u-flex-direction-column");
      cl.addClass("bv-u-gap-9px");
      r.continents_preview.slice(0, 3).forEach((c, i) => {
        const kind = i % 2 === 0 ? "supports" : "emerges";
        const row = cl.createDiv();
        row.addClass("bv-u-display-flex");
        row.addClass("bv-u-align-items-center");
        row.addClass("bv-u-gap-11px");
        row.addClass("bv-u-padding-10px-13px");
        row.addClass("bv-u-border-radius-8px");
        row.addClass("bv-u-border-1px-solid-bv-rule");
        row.style.background = `var(--bv-${kind}-tint)`;
        const d = row.createSpan();
        d.addClass("bv-u-width-7px"); d.addClass("bv-u-height-7px"); d.addClass("bv-u-border-radius-50");
        d.style.background = `var(--bv-${kind}-dot)`; d.addClass("bv-u-flex-0-0-auto");
        const nm = row.createSpan({ text: `${c.size} territories` });
        nm.addClass("bv-u-font-family-bv-serif"); nm.addClass("bv-u-font-size-16px"); nm.addClass("bv-u-color-bv-ink"); nm.addClass("bv-u-flex-0-0-auto");
        const mem = row.createSpan({ text: c.members.slice(0, 3).join(" · ") });
        mem.addClass("bv-u-font-family-bv-mono"); mem.addClass("bv-u-font-size-9_5px"); mem.addClass("bv-u-color-bv-ink-faint"); mem.addClass("bv-u-line-height-1_4");
      });
    }

    const foot = card.createDiv();
    foot.addClass("bv-u-padding-16px-30px-22px");
    foot.addClass("bv-u-border-top-1px-solid-bv-rule-faint");
    foot.addClass("bv-u-text-align-center");
    button(foot, "Save these as notes", { kind: "ghost", full: true, onClick: () => void this.saveSampleToVault() });
    button(foot, "Keep it alive", { full: true, onClick: () => { this.state = "handoff"; this.render(); } });
  }

  /** Write the sample map into the vault — the SAME envelopes the real
   *  materializer produced (vault_files on the status result), written with the
   *  vault API exactly like a connected vault syncs. ONE system: the demo
   *  enters and exits where every vault does; the only difference is capped
   *  intake. No bespoke sample writer, no invented note shapes — the demo vault
   *  is byte-for-byte what a connected vault gets, at the sample's size.
   *
   *  Safe from the Atlas mirror: reapOrphans only deletes under the
   *  MANAGED_PREFIXES, and these are the materializer's own canonical paths. */
  private async saveSampleToVault(): Promise<void> {
    const r = this.result;
    if (!r) return;
    const files = r.vault_files ?? [];
    if (files.length === 0) { new Notice("Nothing to save yet — the map is still forming."); return; }
    try {
      // Vault API, not vault.adapter (audit ST3/S5): keeps Obsidian's file
      // cache coherent and satisfies the store reviewer guideline.
      const vault = this.plugin.app.vault;
      const ensureFolders = async (filePath: string): Promise<void> => {
        const parts = filePath.split("/");
        parts.pop(); // drop the filename
        let cur = "";
        for (const p of parts) {
          cur = cur ? `${cur}/${p}` : p;
          if (!(vault.getAbstractFileByPath(cur) instanceof TFolder)) {
            await vault.createFolder(cur).catch(() => {});
          }
        }
      };
      let wrote = 0;
      for (const f of files) {
        const path = (f.vault_path ?? "").replace(/^\/+/, "").trim();
        if (!path || !path.toLowerCase().endsWith(".md") || !f.body_md) continue;
        // SOURCE IMMUTABILITY (audit B5): the server-returned vault_path is
        // untrusted input, and this save path is reachable anonymously in the
        // Discovery flow. Refuse anything that isn't a traversal-free path
        // inside the Bevia/ managed tree — the SAME gate the Atlas sync uses
        // (isSafeVaultPath). This guarantees the modify() below can only ever
        // overwrite a file inside Bevia's own namespace, never a pre-existing
        // note the plugin didn't author.
        if (!isSafeVaultPath(path)) continue;
        await ensureFolders(path);
        const existing = vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) await vault.modify(existing, f.body_md);
        else await vault.create(path, f.body_md);
        wrote++;
      }
      new Notice(`Your map is in your vault (${wrote} note${wrote === 1 ? "" : "s"} under Bevia/) — open Graph view and it lights up. Yours to keep.`);
    } catch (e) {
      new Notice(`Couldn't save: ${(e as Error).message}`);
    }
  }

  private renderHandoff(root: HTMLElement): void {
    const card = this.card(root, "32px 30px 26px");
    mono(card, "This is today's map", { size: 9, track: 0.16, dim: true, block: true }).addClass("bv-u-margin-bottom-14px");
    serif(card, "This is your vault today — and it's already changing.", { size: 22, weight: 400, lh: 1.24 }).addClass("bv-u-margin-bottom-13px");
    const sub = text(card, "Bevia keeps the map alive in your vault as your thinking moves — on this machine, or in the cloud. Or keep working locally; nothing's lost.", { size: 13, color: "var(--bv-ink-soft)", lh: 1.55, maxWidth: 340 });
    sub.addClass("bv-u-margin-0-auto-20px");
    const stack = card.createDiv();
    stack.addClass("bv-u-display-flex");
    stack.addClass("bv-u-flex-direction-column");
    stack.addClass("bv-u-gap-7px");
    stack.addClass("bv-u-margin-bottom-22px");
    stack.addClass("bv-u-text-align-left");
    (this.result?.headline_territories ?? []).slice(0, 2).forEach((terr, i) => territoryCard(stack, this.toTerr(terr, i), { compact: true }));
    // Two-door exit (Bevia Local spec §12.4): the Rent door is the
    // existing create-account handoff (activate → bevia.co/welcome?lead=
    // session), unchanged; the Own door points at Bevia Local honestly.
    renderTwoDoorPanel(card, {
      onRent: () => this.activate(),
      rentLabel: "Keep it alive",
    });
    const bare = button(card, "Just looking", { kind: "bare", onClick: () => this.close() });
    bare.addClass("bv-u-margin-top-12px");
  }

  /** Stamp when the free analyze finished — the Home staleness line
   *  (Bevia Local spec §12.4) compares vault edits against this. */
  private async recordAnalyzeComplete(): Promise<void> {
    this.plugin.settings.lastAnalyzeAt = Date.now();
    await this.plugin.saveSettings();
  }

  /** The governed advisory reading under a top territory — the demo's
   *  "build + advisory" showcase. Rendered server-side through the
   *  Molly-epistemic lens, so every line is grounded and non-verdict. */
  private spockBlock(parent: HTMLElement, s: SpockReading): void {
    const box = parent.createDiv();
    box.addClass("bv-u-margin-2px-0-4px");
    box.addClass("bv-u-padding-11px-14px");
    box.addClass("bv-u-border-radius-8px");
    box.addClass("bv-u-border-left-2px-solid-var-bv-emergence-dot-interactive-");
    box.addClass("bv-u-background-var-bv-panel-sunk-background-secondary");
    const rows: Array<[string, string | undefined]> = [
      ["Where it shows up", s.where_shown],
      ["A question to ask yourself", s.ask_yourself],
      ["A way to work with your AI", s.ai_move],
    ];
    for (const [label, val] of rows) {
      if (!val || !val.trim()) continue;
      mono(box, label, { size: 8.5, track: 0.12, dim: true, block: true }).addClass("bv-u-margin-4px-0-2px");
      text(box, val.trim(), { size: 12.5, color: "var(--bv-ink-soft)", lh: 1.5 });
    }
  }

  private toTerr(t: DiscoveryTerritory, i: number): { name: string; finding?: string; size?: string; state: BvState } {
    return {
      name: t.label,
      finding: t.summary,
      size: t.note_count ? `${t.note_count} notes` : undefined,
      state: STATE_CYCLE[i % STATE_CYCLE.length],
    };
  }

  private activate(): void {
    const app = (this.plugin.settings.appUrl || "https://bevia.co").replace(/\/+$/, "");
    const sid = this.result?.session_id ?? "";
    window.open(`${app}/welcome?lead=${encodeURIComponent(sid)}`, "_blank");
    new Notice("Opening Bevia in your browser. Create your account, then paste your token here to bring the vault to life.");
    this.close();
  }

  private async runAnalysis(): Promise<void> {
    // The run is on THEIR key — the Bevia-funded free lane is retired
    // (founder, 2026-07-17). The server 402s keyless runs; catch it here
    // with a friendlier nudge instead of burning a round-trip.
    if (this.byokKey.length === 0) {
      new Notice("Paste your AI key first — free-tier keys work (any provider).", 6000);
      return;
    }
    this.state = "reading";
    this.render();

    // Intake is the only lever: with the visitor's own key the run is
    // UNLIMITED (every note).
    const byok = this.byokKey.length > 0;
    const allFiles = this.plugin.app.vault.getMarkdownFiles();
    const selected = byok
      ? allFiles.slice().sort((a, b) => b.stat.mtime - a.stat.mtime)
      : selectNotes(allFiles);
    const notes: Array<{ path: string; title: string; body: string; mtime: number }> = [];
    let chars = 0;
    for (const f of selected) {
      const body = await this.plugin.app.vault.cachedRead(f);
      if (body.trim().length < MIN_CHARS) continue;
      chars += body.length;
      if (!byok && chars > TARGET_BUDGET_CHARS) break; // cap only the funded preview
      notes.push({ path: f.path, title: f.basename, body, mtime: f.stat.mtime });
    }

    if (isLocalMode()) {
      // leg 2 belt-and-suspenders — analyzeVault already refuses entry.
      new Notice("Bevia Local is on — the cloud vault preview is not in Bevia Local yet.", 8000);
      this.state = "invitation";
      this.render();
      return;
    }
    try {
      const res = await requestUrl({
        url: `${this.baseUrl}/functions/v1/instant-cartography`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ notes, ...(byok ? { byok_ai_key: this.byokKey } : {}) }),
        throw: false,
      });
      if (res.status < 200 || res.status >= 300) {
        // The EF's refusals speak in a human voice (bad key shape, key
        // rejected, caps reached) — ALWAYS surface its copy, never a
        // bare status code. Fall back per class only when no copy came.
        let msg =
          res.status === 429
            ? "Today's free map is used up — try again tomorrow."
            : `Discovery analysis failed (${res.status}).`;
        try { const p = res.json as { error?: string }; if (p?.error) msg = p.error; } catch { /* keep fallback */ }
        new Notice(msg, 9000);
        this.state = "invitation";
        this.render();
        return;
      }
      // The kickoff returns { ok, session_id, status: 'building' } and the
      // build streams in via the status poll — territories appear live on
      // the reading screen, and the reveal fires when the map completes.
      const kick = res.json as DiscoveryResult;
      if (!kick?.ok || !kick.session_id) {
        new Notice("Couldn't start the analysis — try again in a moment.");
        this.state = "invitation";
        this.render();
        return;
      }
      this.result = {
        ...kick,
        // The kickoff carries no map yet — the poll fills these in.
        territory_count: kick.territory_count ?? 0,
        headline_territories: kick.headline_territories ?? [],
        continents_preview: kick.continents_preview ?? [],
      };
      if (kick.status === "done") {
        // Back-compat: an older EF that still answers synchronously.
        void this.recordAnalyzeComplete();
        this.state = (this.result.territory_count ?? 0) < THIN_TERRITORY_THRESHOLD ? "thin" : "reveal";
        this.render();
        void this.saveSampleToVault();
        return;
      }
      this.pollStatus(kick.session_id);
    } catch (e) {
      new Notice(`Discovery analysis error: ${(e as Error).message}`);
      this.state = "invitation";
      this.render();
      return;
    }
  }
}
