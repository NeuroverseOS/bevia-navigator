// Bevia Query view (Atlas Inquiry per ADR-0167 + ADR-0170) —
// direct access to the substrate query primitives from inside
// Obsidian. ADR-0154 Layer 2.
//
// Three modes:
//
//   1. Pick a primitive from the dropdown
//   2. Adjust window / threshold / limit inputs
//   3. Click Run — render the typed result inline
//
// Pure cartographic — every query is a deterministic substrate read
// (ADR-0152). The view never narrates; rows render as they are.
//
// ADR-0170 — Atlas Inquiry carries a mode toggle:
//   - Atlas: scoped to the user's active Projection (Aperture).
//     "Within this Atlas" question.
//   - Mind:  substrate-direct, Aperture-ignored. "What have I
//     learned about X?" question.
// The toggle ships forward-compat. The plugin declares intent
// today; server-side Aperture filtering wires through runQuery in
// follow-up substrate (ADR-0173+).
//
// Sibling to the Navigator view. Where the Navigator is "what does
// Bevia know about THIS note?" (always Mind), the Query view is
// "what does Bevia know about ANY of the substrate I ask about?"
// (user-elected mode).

import { App, ItemView, Notice, WorkspaceLeaf } from "obsidian";
import {
  BeviaApiError,
  fetchQuery,
  type InquiryMode,
  type QueryKind,
  type QueryResponse,
} from "./api";
import type BeviaNavigatorPlugin from "./main";

/** Optional wiring that makes query results LIVE — click a result to
 *  open its vault note, or (when the note doesn't exist yet) hand the
 *  thread to Ask Bevia. Both consumers (Query view, Navigator place
 *  card) pass their plugin; render-only callers can omit and get the
 *  old static rows. */
export interface QueryRenderOpts {
  app?: App;
  plugin?: BeviaNavigatorPlugin;
}

export const BEVIA_QUERY_VIEW_TYPE = "bevia-query-view";

interface PrimitiveDef {
  kind: QueryKind;
  label: string;
  description: string;
  /** Inputs to surface in the controls panel. */
  inputs: PrimitiveInput[];
}

type PrimitiveInput =
  | { kind: "window"; default: string }
  | { kind: "limit"; default: number; max?: number }
  | { kind: "threshold"; default: number }
  | { kind: "min_recurrence"; default: number }
  | { kind: "territory_id"; default: string }
  | { kind: "contributor_label"; default: string }
  | { kind: "source_kind"; default: string }
  | { kind: "days"; default: number };

const PRIMITIVES: PrimitiveDef[] = [
  {
    kind: "recent_moments",
    label: "Recent moments",
    description: "Things that happened in the window.",
    inputs: [
      { kind: "window", default: "24h" },
      { kind: "source_kind", default: "" },
      { kind: "limit", default: 20, max: 200 },
    ],
  },
  {
    kind: "recent_concepts",
    label: "Recent ideas (by day)",
    description: "Ideas taking shape lately — this week so far, plus recently folded weeks.",
    inputs: [
      { kind: "days", default: 14 },
      { kind: "limit", default: 40, max: 200 },
    ],
  },
  {
    kind: "territories_grown",
    label: "Territories grown",
    description: "Where your thinking spent time.",
    inputs: [
      { kind: "window", default: "7d" },
      { kind: "threshold", default: 2 },
      { kind: "limit", default: 20 },
    ],
  },
  {
    kind: "new_territories",
    label: "New territories",
    description: "Territories that emerged in the window.",
    inputs: [
      { kind: "window", default: "7d" },
      { kind: "limit", default: 20 },
    ],
  },
  {
    kind: "contradictions",
    label: "Contradictions",
    description: "Tension surfaced in the substrate.",
    inputs: [
      { kind: "window", default: "7d" },
      { kind: "limit", default: 20 },
    ],
  },
  {
    kind: "notable_connections",
    label: "Notable connections",
    description: "High-confidence non-trivial edges.",
    inputs: [
      { kind: "window", default: "7d" },
      { kind: "limit", default: 20 },
    ],
  },
  {
    kind: "contributor_activity",
    label: "Contributor activity",
    description: "Moments + territories per contributor in the window.",
    inputs: [
      { kind: "window", default: "7d" },
      { kind: "limit", default: 20 },
    ],
  },
  {
    kind: "landmarks_recurring",
    label: "Recurring landmarks",
    description: "Concepts mentioned across many moments.",
    inputs: [
      { kind: "window", default: "7d" },
      { kind: "min_recurrence", default: 3 },
      { kind: "limit", default: 30 },
    ],
  },
  {
    kind: "routes_emerged",
    label: "Routes emerged",
    description: "Edges newly formed between map objects.",
    inputs: [
      { kind: "window", default: "7d" },
      { kind: "limit", default: 30 },
    ],
  },
  {
    kind: "loop_breakdown",
    label: "Loop breakdown",
    description: "Person↔World vs Person↔AI territories.",
    inputs: [{ kind: "window", default: "30d" }],
  },
];

const PRIMITIVE_BY_KIND = new Map(PRIMITIVES.map((p) => [p.kind, p]));

export class BeviaQueryView extends ItemView {
  plugin: BeviaNavigatorPlugin;
  // Default to the primitive people actually reach for first: "what's new?"
  // Recent moments answers that directly, works live (captures always flow),
  // and makes the panel useful the instant it opens — discovery over hiding.
  private selectedKind: QueryKind = "recent_moments";
  private paramValues: Map<string, string> = new Map();
  /** Atlas Inquiry mode per ADR-0170. Default `atlas` so the
   *  question scopes to the active Projection until the user opts
   *  into the substrate-direct view. */
  private mode: InquiryMode = "atlas";
  private inflightSeq = 0;

  constructor(leaf: WorkspaceLeaf, plugin: BeviaNavigatorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return BEVIA_QUERY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Bevia Query";
  }

  getIcon(): string {
    return "search";
  }

  async onOpen(): Promise<void> {
    this.render();
    // Never open empty — run the default question ("Recent moments")
    // immediately, same as tapping its chip.
    this.maybeAutoRun();
  }

  async onClose(): Promise<void> {
    // No persistent resources.
  }

  private render(): void {
    const container = this.containerEl.children[1] ?? this.containerEl;
    container.empty();
    container.addClass("bevia-navigator");

    // Header — same register as the place card: a quiet eyebrow, one
    // human sentence, no dashboard prose.
    const header = container.createDiv({ cls: "bevia-header" });
    header.createEl("div", { cls: "bevia-eyebrow", text: "ASK YOUR MAP" });
    header.createEl("p", {
      text: "Pick a question — the answer comes straight from your map.",
      cls: "bevia-orient-summary",
    });

    // ─── Mode toggle (ADR-0170 Atlas Inquiry mode) ──
    // Atlas: scoped to active Projection. Mind: substrate-direct.
    const modeRow = header.createDiv({ cls: "bevia-mode-toggle" });
    const renderModeButton = (m: InquiryMode, label: string) => {
      const btn = modeRow.createEl("button", {
        text: label,
        cls: `bevia-mode-btn bevia-mode-${m}` + (this.mode === m ? " bevia-mode-active" : ""),
      });
      btn.addEventListener("click", () => {
        if (this.mode === m) return;
        this.mode = m;
        this.render();
        void this.runQuery();
      });
    };
    renderModeButton("atlas", "Atlas");
    renderModeButton("mind", "Whole map");
    const modeHint = header.createEl("p", { cls: "bevia-mode-hint" });
    modeHint.setText(
      this.mode === "atlas"
        ? "Atlas — scoped to your active Projection."
        : "Whole map — everything, Projection ignored.",
    );

    // ─── Question chips — the place card's chip language, one chip per
    // question. Tapping a chip runs it immediately (no Run button).
    const controls = container.createDiv({ cls: "bevia-section bevia-query-controls" });
    const chips = controls.createDiv({ cls: "bevia-pc-chips" });
    for (const p of PRIMITIVES) {
      const chip = chips.createEl("button", {
        text: p.label,
        cls: "bevia-pc-chip" + (p.kind === this.selectedKind ? " bevia-pc-chip-hot" : ""),
      });
      chip.addEventListener("click", () => {
        this.selectedKind = p.kind;
        this.paramValues.clear();
        this.render();
        void this.runQuery();
      });
    }

    const def = PRIMITIVE_BY_KIND.get(this.selectedKind);
    if (def) {
      controls.createEl("p", { text: def.description, cls: "bevia-orient-summary" });
      const paramsRow = controls.createDiv({ cls: "bevia-query-params" });
      for (const input of def.inputs) this.renderInput(paramsRow, input);
    }

    // ─── Result slot ──
    container.createDiv({ cls: "bevia-section bevia-query-result" });
  }

  /** Auto-run the default question when the panel opens, so it never
   *  sits empty waiting for a button press. */
  private hasAutoRun = false;
  private maybeAutoRun(): void {
    if (this.hasAutoRun) return;
    this.hasAutoRun = true;
    void this.runQuery();
  }

  private renderInput(parent: HTMLElement, input: PrimitiveInput): void {
    const wrap = parent.createDiv({ cls: "bevia-query-param" });
    wrap.createEl("label", { text: inputLabel(input), cls: "bevia-mono" });
    const current = this.paramValues.get(input.kind) ?? String(inputDefault(input));
    const options = inputOptions(input);
    // Every parameter is a dropdown of presets — nothing to type, nothing to
    // guess. (The free-text identifier inputs were removed with their
    // primitives; `options` is non-null for every input we still render.)
    if (options) {
      // Record the default up front so a query the user never touched still
      // sends the right value.
      this.paramValues.set(input.kind, current);
      const sel = wrap.createEl("select", { cls: "bevia-query-input bevia-query-select" });
      for (const opt of options) {
        const o = sel.createEl("option", { text: opt.label, value: opt.value });
        if (opt.value === current) o.selected = true;
      }
      sel.addEventListener("change", () => {
        this.paramValues.set(input.kind, sel.value);
        // Changing a dial re-asks the question — no Run button.
        void this.runQuery();
      });
      return;
    }
    const el = wrap.createEl("input", { cls: "bevia-query-input", type: "text" });
    el.value = current;
    el.addEventListener("input", () => this.paramValues.set(input.kind, el.value));
    el.addEventListener("change", () => void this.runQuery());
  }

  private async runQuery(): Promise<void> {
    const def = PRIMITIVE_BY_KIND.get(this.selectedKind);
    if (!def) return;

    const params: Record<string, unknown> = {};
    for (const input of def.inputs) {
      const raw = (this.paramValues.get(input.kind) ?? String(inputDefault(input))).trim();
      if (raw === "") continue;
      if (input.kind === "limit" || input.kind === "threshold" || input.kind === "min_recurrence" || input.kind === "days") {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n)) params[input.kind] = n;
      } else {
        params[input.kind] = raw;
      }
    }

    const seq = ++this.inflightSeq;
    const container = this.containerEl.children[1] ?? this.containerEl;
    const resultSlot = container.querySelector(".bevia-query-result") as HTMLElement | null;
    if (resultSlot) {
      resultSlot.empty();
      resultSlot.createEl("p", { text: "Asking your map…", cls: "bevia-humility" });
    }

    try {
      const response = await fetchQuery(
        {
          baseUrl: this.plugin.settings.baseUrl,
          token: this.plugin.settings.token,
        },
        { kind: def.kind, params, mode: this.mode },
      );
      if (seq !== this.inflightSeq) return;
      if (resultSlot) {
        renderQueryResult(resultSlot, response, this.mode, {
          app: this.app,
          plugin: this.plugin,
        });
        this.appendAskComposer(resultSlot, def, response);
      }
    } catch (err) {
      if (seq !== this.inflightSeq) return;
      const message =
        err instanceof BeviaApiError ? err.message : (err as Error).message ?? "Unknown error";
      if (resultSlot) {
        resultSlot.empty();
        resultSlot.createEl("p", { text: "Couldn't run that query.", cls: "bevia-state" });
        resultSlot.createEl("p", { text: message, cls: "bevia-error-detail" });
      }
    }
  }

  /** The founder's natural next move after a query is a QUESTION about
   *  it ("my tendency after running a query is to want to ask bevia
   *  questions about the query"). This composer sits under every result
   *  and hands the question — with the query's context woven in — to
   *  Ask Bevia, which opens beside and answers live. */
  private appendAskComposer(
    resultSlot: HTMLElement,
    def: PrimitiveDef,
    response: QueryResponse,
  ): void {
    const wrap = resultSlot.createDiv({ cls: "bevia-section bevia-query-ask" });
    wrap.createEl("div", { cls: "bevia-eyebrow", text: "ASK ABOUT THIS" });
    const row = wrap.createDiv({ cls: "bevia-query-ask-row" });
    const input = row.createEl("input", {
      cls: "bevia-query-input bevia-query-ask-input",
      type: "text",
      placeholder: `Ask Bevia about these ${def.label.toLowerCase()}…`,
    });
    const send = row.createEl("button", { cls: "bevia-pc-chip", text: "Ask →" });
    const fire = () => {
      const q = input.value.trim();
      if (!q) return;
      input.value = "";
      void this.plugin.askBevia(this.composeAskContext(def, response, q));
    };
    send.addEventListener("click", fire);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        fire();
      }
    });
  }

  /** Weave the query's identity + top results into the question so Ask
   *  Bevia answers about what the user is LOOKING AT, not in a vacuum. */
  private composeAskContext(
    def: PrimitiveDef,
    response: QueryResponse,
    question: string,
  ): string {
    const result = response.result as Record<string, unknown>;
    const rows = Array.isArray((result as { rows?: unknown[] }).rows)
      ? ((result as { rows: Array<Record<string, unknown>> }).rows)
      : [];
    const tops = rows
      .slice(0, 5)
      .map((r) => rowHeadline(def.kind, r))
      .filter(Boolean);
    const context =
      `I just ran the "${def.label}" question on my map` +
      ` (${humanParams(response.resolved_params, this.mode)})` +
      (tops.length > 0 ? `. Top results: ${tops.join("; ")}` : "");
    return `${context}.\n\nMy question: ${question}`;
  }
}

// ─── Input helpers ────────────────────────────────────────────────

function inputDefault(input: PrimitiveInput): string | number {
  return input.default;
}

function inputLabel(input: PrimitiveInput): string {
  switch (input.kind) {
    case "window": return "time window";
    case "limit": return "show";
    case "threshold": return "min growth";
    case "min_recurrence": return "min recurrence";
    case "territory_id": return "territory id";
    case "contributor_label": return "contributor";
    case "source_kind": return "source";
    case "days": return "history";
  }
}

/** Preset options for every parameter — so the Query view is all dropdowns,
 *  no free-text typing or format-guessing (the recurring confusion the
 *  founder flagged). Returns null only for the free-text identifier inputs,
 *  which no current primitive uses. */
function inputOptions(
  input: PrimitiveInput,
): Array<{ value: string; label: string }> | null {
  switch (input.kind) {
    case "window":
      return [
        { value: "24h", label: "past 24 hours" },
        { value: "7d", label: "past 7 days" },
        { value: "30d", label: "past 30 days" },
        { value: "90d", label: "past 90 days" },
      ];
    case "limit":
      return [10, 20, 50, 100].map((n) => ({ value: String(n), label: `${n} results` }));
    case "threshold":
      return [1, 2, 3, 5].map((n) => ({ value: String(n), label: `${n}+ moments` }));
    case "min_recurrence":
      return [2, 3, 5, 10].map((n) => ({ value: String(n), label: `${n}+ times` }));
    case "days":
      return [7, 14, 30, 60].map((n) => ({ value: String(n), label: `past ${n} days` }));
    case "source_kind":
      return [
        { value: "", label: "Any source" },
        { value: "github_event", label: "GitHub" },
        { value: "claude", label: "Claude" },
        { value: "chatgpt", label: "ChatGPT" },
        { value: "slack", label: "Slack" },
        { value: "notion", label: "Notion" },
        { value: "obsidian", label: "Obsidian" },
      ];
    default:
      return null;
  }
}

// ─── Result rendering ─────────────────────────────────────────────
//
// Each primitive returns a slightly different shape. We render a
// reasonable view of each — no schema gymnastics, no LLM in the path.
// Exported so the Navigator place card's query chips reuse the exact
// same machinery (one renderer, many consumers).

export function renderQueryResult(
  parent: HTMLElement,
  response: QueryResponse,
  mode: InquiryMode,
  opts?: QueryRenderOpts,
): void {
  parent.empty();

  // One quiet meta line in place-card language — never raw JSON.
  const meta = parent.createEl("p", { cls: "bevia-query-meta" });
  meta.setText(humanParams(response.resolved_params, mode));

  const result = response.result as Record<string, unknown>;
  // Special-case shape: { rows: [...] } for most primitives;
  // territory_detail returns a flat object; loop_breakdown returns
  // {loop_1_count, ...}.
  if ("rows" in result && Array.isArray(result.rows)) {
    renderRows(parent, response.kind, result.rows as Array<Record<string, unknown>>, opts);
  } else if (response.kind === "loop_breakdown") {
    renderLoopBreakdown(parent, result);
  } else if (response.kind === "territory_detail") {
    renderTerritoryDetail(parent, result);
  } else {
    parent.createEl("pre", { text: JSON.stringify(result, null, 2), cls: "bevia-mono" });
  }
}

/** The resolved params, in words — "past 24 hours · any source · up to
 *  20 · Atlas". Same register as the place card's fact rows; the raw
 *  key/value JSON never reaches the panel. */
function humanParams(params: Record<string, unknown>, mode: InquiryMode): string {
  const parts: string[] = [];
  const window = params.window ?? params.time_window;
  if (typeof window === "string") {
    const windows: Record<string, string> = {
      "24h": "past 24 hours", "7d": "past 7 days", "30d": "past 30 days", "90d": "past 90 days",
    };
    parts.push(windows[window] ?? window);
  }
  if (typeof params.days === "number") parts.push(`past ${params.days} days`);
  if (typeof params.source_kind === "string" && params.source_kind) {
    parts.push(String(params.source_kind).replace(/_event$/, "").replace(/_/g, " "));
  }
  if (typeof params.threshold === "number") parts.push(`${params.threshold}+ moments`);
  if (typeof params.min_recurrence === "number") parts.push(`seen ${params.min_recurrence}+ times`);
  if (typeof params.limit === "number") parts.push(`up to ${params.limit}`);
  parts.push(mode === "atlas" ? "Atlas" : "whole map");
  return parts.join(" · ");
}

/** Per-question glyph — the same quiet accent glyphs the place card's
 *  fact rows use. */
function kindGlyph(kind: QueryKind): string {
  switch (kind) {
    case "recent_moments": return "☰";
    case "recent_concepts": return "✦";
    case "territories_grown": return "▲";
    case "new_territories": return "✦";
    case "contradictions": return "≠";
    case "notable_connections":
    case "routes_emerged": return "⇄";
    case "contributor_activity": return "◉";
    case "landmarks_recurring": return "↺";
    default: return "◆";
  }
}

function renderRows(
  parent: HTMLElement,
  kind: QueryKind,
  rows: Array<Record<string, unknown>>,
  opts?: QueryRenderOpts,
): void {
  if (rows.length === 0) {
    parent.createEl("p", {
      text: "Nothing here in this window yet — try a wider one.",
      cls: "bevia-humility",
    });
    return;
  }
  const list = parent.createDiv({ cls: "bevia-fact-rows" });
  const glyph = kindGlyph(kind);
  for (const row of rows) {
    const rowEl = list.createDiv({ cls: "bevia-fact-row" });
    rowEl.createEl("span", { cls: "bevia-fact-glyph", text: glyph });
    const text = rowEl.createDiv({ cls: "bevia-fact-text" });
    text.createEl("b", { text: rowHeadline(kind, row) });
    const metaBits = rowMeta(kind, row).filter(Boolean);
    if (metaBits.length > 0) {
      text.createEl("span", { cls: "bevia-fact-sub", text: metaBits.join(" · ") });
    }
    const summary = rowSummary(kind, row);
    if (summary) {
      text.createEl("span", { cls: "bevia-fact-sub", text: summary });
    }
    // Every result is a door, not a dead label (founder 2026-07-09:
    // "I can't click on any of the results"). Click opens the vault
    // note when it exists; otherwise the thread hands to Ask Bevia so
    // the click ALWAYS goes somewhere.
    wireRowNavigation(rowEl, kind, row, opts);
  }
}

/** The vault note name(s) a query row points at — the same names the
 *  materializer uses as file basenames (territory labels, idea titles).
 *  Empty when the row has no note-shaped target (e.g. raw moments). */
function rowLinkTargets(kind: QueryKind, row: Record<string, unknown>): string[] {
  const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  switch (kind) {
    case "territories_grown":
    case "new_territories":
      return [s(row.label)].filter(Boolean);
    case "contradictions":
    case "landmarks_recurring":
      return [s(row.territory_label)].filter(Boolean);
    case "notable_connections":
    case "routes_emerged":
      return [s(row.from_label), s(row.to_label)].filter(Boolean);
    case "recent_concepts":
      return [s(row.title)].filter(Boolean);
    default:
      return [];
  }
}

/** The Ask Bevia question a row falls back to when no vault note
 *  exists for it yet — the click still goes somewhere real. */
function rowAskQuestion(kind: QueryKind, row: Record<string, unknown>): string | null {
  const targets = rowLinkTargets(kind, row);
  if (kind === "recent_concepts" && targets[0]) {
    return `Tell me about "${targets[0]}" — where does this idea show up in my map, and what is it connected to?`;
  }
  if ((kind === "notable_connections" || kind === "routes_emerged") && targets.length === 2) {
    return `What connects "${targets[0]}" and "${targets[1]}" in my map?`;
  }
  if (targets[0]) {
    return `Tell me about "${targets[0]}" — what's in this territory and where is it heading?`;
  }
  return null;
}

function wireRowNavigation(
  rowEl: HTMLElement,
  kind: QueryKind,
  row: Record<string, unknown>,
  opts?: QueryRenderOpts,
): void {
  const app = opts?.app;
  if (!app) return;
  const targets = rowLinkTargets(kind, row);
  if (targets.length === 0) return;
  rowEl.addClass("bevia-clickable");
  rowEl.setAttr("role", "link");
  const resolved = targets.find(
    (t) => app.metadataCache.getFirstLinkpathDest(t, "") !== null,
  );
  rowEl.setAttr(
    "title",
    resolved
      ? `Open "${resolved}" in your vault`
      : "Not in your vault yet — click to ask Bevia about it",
  );
  rowEl.addEventListener("click", () => {
    if (resolved) {
      void app.workspace.openLinkText(resolved, "", false);
      return;
    }
    const question = rowAskQuestion(kind, row);
    if (question && opts?.plugin) {
      // Ideas from the day fold live in the engine before they land as
      // vault notes (the Telescope weaves folded weeks into findings) —
      // the honest door is the conversation, not a dead click.
      void opts.plugin.askBevia(question);
      return;
    }
    new Notice("This isn't in your vault yet — it lands as the map materializes.");
  });
}

function rowHeadline(kind: QueryKind, row: Record<string, unknown>): string {
  switch (kind) {
    case "recent_moments":
      return String(row.text_excerpt ?? "(no excerpt)").slice(0, 80) || "(no excerpt)";
    case "territories_grown":
    case "new_territories":
      return String(row.label ?? "(unlabeled territory)");
    case "contradictions":
      return String(row.summary ?? "Contradiction").slice(0, 80);
    case "notable_connections":
    case "routes_emerged":
      return `${row.from_label ?? "?"} ↔ ${row.to_label ?? "?"}`;
    case "contributor_activity":
      return String(row.label ?? "(contributor)");
    case "landmarks_recurring":
      return String(row.label ?? "(landmark)");
    case "recent_concepts":
      return String(row.title ?? "(idea)");
    default:
      return JSON.stringify(row).slice(0, 80);
  }
}

function rowMeta(kind: QueryKind, row: Record<string, unknown>): string[] {
  const out: string[] = [];
  switch (kind) {
    case "recent_moments":
      if (row.source_kind) out.push(String(row.source_kind));
      if (row.occurred_at) out.push(new Date(String(row.occurred_at)).toLocaleString());
      break;
    case "territories_grown":
      out.push(`+${row.new_moment_count ?? 0}`);
      out.push(`×${row.total_recurrence ?? 0}`);
      break;
    case "new_territories":
      out.push(`×${row.recurrence_count ?? 0}`);
      break;
    case "contradictions":
      if (row.territory_label) out.push(String(row.territory_label));
      break;
    case "notable_connections":
    case "routes_emerged":
      out.push(String(row.edge_kind ?? ""));
      if (row.confidence !== undefined) out.push(`conf ${row.confidence}`);
      break;
    case "contributor_activity":
      out.push(`${row.moment_count ?? 0} things`);
      out.push(`${row.territory_count ?? 0} territories`);
      break;
    case "landmarks_recurring":
      out.push(`×${row.recurrence ?? 0}`);
      if (row.territory_label) out.push(String(row.territory_label));
      break;
    case "recent_concepts":
      out.push(row.partial ? "this week so far" : "folded");
      if (row.as_of) out.push(String(row.as_of));
      if (row.concept_type && row.concept_type !== "other") out.push(String(row.concept_type));
      break;
  }
  return out;
}

function rowSummary(kind: QueryKind, row: Record<string, unknown>): string | null {
  switch (kind) {
    case "new_territories":
    case "territories_grown":
      return (row.summary as string) || null;
    case "recent_concepts":
      return (row.summary as string) || null;
    case "contradictions":
      return Array.isArray(row.evidence_moment_ids) && row.evidence_moment_ids.length > 0
        ? `${row.evidence_moment_ids.length} evidence moments`
        : null;
    default:
      return null;
  }
}

function renderLoopBreakdown(parent: HTMLElement, result: Record<string, unknown>): void {
  const rows = parent.createDiv({ cls: "bevia-fact-rows" });
  const addRow = (glyph: string, headline: string, sub: string) => {
    const rowEl = rows.createDiv({ cls: "bevia-fact-row" });
    rowEl.createEl("span", { cls: "bevia-fact-glyph", text: glyph });
    const text = rowEl.createDiv({ cls: "bevia-fact-text" });
    text.createEl("b", { text: headline });
    text.createEl("span", { cls: "bevia-fact-sub", text: sub });
  };
  addRow(
    "◐",
    `${result.loop_1_count} territories you built with the world (${result.loop_1_percent}%)`,
    "Books, projects, people, work — your cognition over the world.",
  );
  addRow(
    "◑",
    `${result.loop_2_count} territories you built with AI (${result.loop_2_percent}%)`,
    "Thinking you and your intelligences worked out together.",
  );
}

function renderTerritoryDetail(parent: HTMLElement, result: Record<string, unknown>): void {
  const card = parent.createDiv({ cls: "bevia-territory bevia-strength-high" });
  card.createEl("div", { cls: "bevia-territory-label", text: String(result.label ?? "") });
  if (result.summary) {
    card.createEl("p", { cls: "bevia-territory-summary", text: String(result.summary) });
  }
  const meta = card.createDiv({ cls: "bevia-territory-meta" });
  meta.createEl("span", { cls: "bevia-mono", text: `×${result.recurrence_count ?? 0}` });

  const landmarks = (result.landmarks as Array<{ label: string; member_count: number }>) ?? [];
  if (landmarks.length > 0) {
    const eyebrow = parent.createDiv({ cls: "bevia-eyebrow" });
    eyebrow.setText("LANDMARKS");
    const list = parent.createDiv({ cls: "bevia-landmark-list" });
    for (const l of landmarks) {
      const span = list.createEl("span", { cls: "bevia-landmark" });
      span.createEl("span", { text: l.label });
      if (l.member_count > 1) {
        span.createEl("span", { cls: "bevia-mono", text: `×${l.member_count}` });
      }
    }
  }
}
