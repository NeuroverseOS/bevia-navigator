// Bevia Navigator — the place card.
//
// The Google-Maps-style right panel: the territory you're standing in
// is the PLACE, and everything Bevia knows about it is something you
// can touch. Anatomy borrowed element-for-element from the Maps place
// panel (see design/navigator-place-card):
//
//   Photo of your house      → the orientation sentence (recognition)
//   Directions               → Go deeper (the note, then the evidence)
//   Save                     → Promote (the attention knob)
//   Nearby                   → Related territories, with the reason
//   Send to phone            → Ask (carry the territory into a question)
//   Share                    → Share (private by default)
//   Restaurants/Hotels chips → query chips scoped to here
//
// Doctrine: Navigator is a Mind surface, not an Atlas surface
// (ADR-0170) — it reads the full substrate, never the active
// Projection. Navigators never materialize (live query + render
// ONLY; this file never writes a vault file). The Promote / Share
// verbs write through the existing Control Tower setter EFs
// (ADR-0202 — a second window onto the one canonical policy, never
// a second source of truth).
//
// Narration register: every string this panel composes itself speaks
// HUMAN narration by default — plain words, sentences a sharp
// colleague would say. The `narration: "technical"` setting flips the
// same panel to raw values (ISO dates, similarity numbers, resolution
// shares) and internal vocabulary.

import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf, type App } from "obsidian";
import {
  BeviaApiError,
  fetchNavigatorDirections,
  fetchNavigatorOrientation,
  fetchQuery,
  setTerritoryAttention,
  setTerritoryShare,
  type NavigatorOrientationResponse,
  type NearbyTerritory,
  type QueryResponse,
  type YouAreHere,
} from "./api";
import { renderQueryResult } from "./query-view";
import { BEVIA_ASK_VIEW_TYPE, BeviaAskView } from "./ask-view";
import { GRAPH_RECIPES, applyGraphRecipe } from "./graph-recipes";
import type BeviaNavigatorPlugin from "./main";

export const BEVIA_NAVIGATOR_VIEW_TYPE = "bevia-navigator-view";

/** Where materialized territory notes live in the vault (canonical
 *  root first, legacy roots as fallback — see sync.ts
 *  MANAGED_PREFIXES). Used to resolve "Go deeper" and to seed the
 *  Directions autocomplete; never written to from here. */
const TERRITORY_FOLDERS = [
  "Bevia/4 Map/Territories",
  "Bevia/Territories",
  "Atlas/Territories",
];

/** How long the panel waits after the last keystroke-save before it
 *  re-reads the note's place. Never per keystroke. */
const TYPING_REFRESH_MS = 30_000;

export class BeviaNavigatorView extends ItemView {
  plugin: BeviaNavigatorPlugin;
  /** Dedup key for the current read (note path or territory id). */
  private lastKey: string | null = null;
  /** In-flight request marker so we can ignore stale responses. */
  private inflightSeq = 0;
  /** Chip / directions request marker (separate lifecycle). */
  private chipSeq = 0;
  /** Last successful orientation read — lets the Narration setting
   *  flip the register live without a refetch. */
  private cache: { title: string; data: NavigatorOrientationResponse } | null = null;
  /** Debounce timer for the lazy while-typing refresh. */
  private typeTimer: number | null = null;
  /** label → territory_id for the Directions autocomplete. */
  private labelIndex: Map<string, string> = new Map();
  /** Scroll anchor for the Related verb. */
  private nearbyEl: HTMLElement | null = null;
  /** Result slot the Directions walk renders into. */
  private directionsResultEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: BeviaNavigatorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return BEVIA_NAVIGATOR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Bevia Navigator";
  }

  getIcon(): string {
    return "compass";
  }

  async onOpen(): Promise<void> {
    this.renderShell();
    void this.refresh();

    // Lazy while-typing refresh: when the ACTIVE note is modified,
    // wait for a quiet gap, then re-read. Never per keystroke.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.plugin.settings.autoUpdate) return;
        const active = this.app.workspace.getActiveFile();
        if (!active || file.path !== active.path) return;
        if (this.typeTimer !== null) window.clearTimeout(this.typeTimer);
        this.typeTimer = window.setTimeout(() => {
          this.typeTimer = null;
          void this.refresh(true);
        }, TYPING_REFRESH_MS);
      }),
    );
  }

  async onClose(): Promise<void> {
    if (this.typeTimer !== null) {
      window.clearTimeout(this.typeTimer);
      this.typeTimer = null;
    }
  }

  /** External hook — main.ts calls this when the active leaf changes
   *  so the panel follows the user's focus (graph-view node clicks
   *  open files → same event → the panel follows). */
  async refresh(force = false): Promise<void> {
    const note = currentNoteFromApp(this.app);
    if (!note) {
      // The graph IS the map — when it's up, the card flips to the
      // whole-map Atlas view (graph lenses + map-wide questions)
      // instead of asking for a note. Atlas alongside Navigator, per
      // the surfaces-are-combinations doctrine.
      if (graphViewIsCurrent(this.app)) {
        if (!force && this.lastKey === "atlas:graph") return;
        this.lastKey = "atlas:graph";
        this.renderAtlasCard();
        return;
      }
      this.renderEmpty("Open a note to see where it sits on your map.");
      this.lastKey = null;
      return;
    }
    const key = note.vaultPath ?? note.title;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;

    const seq = ++this.inflightSeq;
    this.renderLoading(note.title);

    // Territory notes materialized by Bevia carry their own id in
    // frontmatter — orient by id directly (exact, no matching).
    const territoryId = note.file ? extractTerritoryId(this.app, note.file) : null;

    try {
      const response = await fetchNavigatorOrientation(
        { baseUrl: this.plugin.settings.baseUrl, token: this.plugin.settings.token },
        territoryId
          ? { territory_id: territoryId }
          : { note_path: note.vaultPath ?? note.title, note_title: note.title },
      );
      if (seq !== this.inflightSeq) return; // stale
      this.cache = { title: note.title, data: response };
      this.renderResponse(note.title, response);
    } catch (err) {
      if (seq !== this.inflightSeq) return;
      this.renderOffline(note.title, err);
    }
  }

  /** Re-render the last read without refetching — used when the
   *  Narration setting flips or a verb changes local state. */
  rerenderFromCache(): void {
    if (this.cache) this.renderResponse(this.cache.title, this.cache.data);
  }

  /** Follow the map itself: load another territory's place card by id
   *  (nearby row click, nearest-territory click, bridge click). */
  private async loadTerritory(territoryId: string, label: string): Promise<void> {
    const seq = ++this.inflightSeq;
    this.lastKey = `territory:${territoryId}`;
    this.renderLoading(label);
    try {
      const response = await fetchNavigatorOrientation(
        { baseUrl: this.plugin.settings.baseUrl, token: this.plugin.settings.token },
        { territory_id: territoryId },
      );
      if (seq !== this.inflightSeq) return;
      this.cache = { title: label, data: response };
      this.renderResponse(label, response);
    } catch (err) {
      if (seq !== this.inflightSeq) return;
      this.renderOffline(label, err);
    }
  }

  // ─── Shell + simple states ─────────────────────────────────────────

  private container(): HTMLElement {
    const container = (this.containerEl.children[1] ?? this.containerEl) as HTMLElement;
    container.addClass("bevia-navigator");
    return container;
  }

  private renderShell(): void {
    this.container().empty();
  }

  private renderEmpty(message: string): void {
    const container = this.container();
    container.empty();
    this.nearbyEl = null;
    const wrap = container.createDiv({ cls: "bevia-state bevia-state-empty" });
    wrap.createEl("div", { cls: "bevia-eyebrow", text: "BEVIA NAVIGATOR" });
    // Positioning canon — kept verbatim with src/copy/canonical.ts POSITIONING.
    wrap.createEl("p", {
      cls: "bevia-slogan",
      text: "To boldly go where your thoughts can take you.",
    });
    wrap.createEl("p", { text: message });
    wrap.createEl("p", {
      cls: "bevia-capability",
      text:
        "Everything you work out with AI becomes a living map you can search, question, and build on — right inside your vault.",
    });
  }

  private renderLoading(title: string): void {
    const container = this.container();
    container.empty();
    this.nearbyEl = null;
    const wrap = container.createDiv({ cls: "bevia-state bevia-state-loading" });
    wrap.createEl("div", { cls: "bevia-eyebrow", text: "BEVIA NAVIGATOR" });
    wrap.createEl("p", { text: `Finding "${title}" on your map…` });
  }

  // ─── The Atlas card — the graph's companion ────────────────────────
  //
  // When the graph view is up there's no "you are here" — you're looking
  // at everywhere. The card flips from Navigator (local) to Atlas
  // (global): graph lenses that recolor the graph you're looking at,
  // plus map-wide questions through the same query chips + renderer the
  // place card uses. Click a node → Obsidian opens the note → the card
  // flips back to that note's place card automatically.

  private renderAtlasCard(): void {
    const container = this.container();
    container.empty();
    this.nearbyEl = null;

    const header = container.createDiv({ cls: "bevia-header" });
    header.createEl("div", { cls: "bevia-eyebrow", text: "YOUR WHOLE MAP" });
    header.createEl("p", {
      cls: "bevia-orient",
      text: "You're looking at everything at once. Click any node to fly there — this card will follow.",
    });

    // Graph lenses — recolor the graph along one human axis. These act
    // directly on the graph view that's open right now.
    const lensWrap = container.createDiv({ cls: "bevia-section" });
    lensWrap.createEl("div", { cls: "bevia-eyebrow bevia-eyebrow-spaced", text: "LENSES" });
    const lenses = lensWrap.createDiv({ cls: "bevia-pc-chips" });
    for (const recipe of GRAPH_RECIPES) {
      const chip = lenses.createEl("button", { cls: "bevia-pc-chip", text: recipe.label });
      chip.addEventListener("click", () => void applyGraphRecipe(this.plugin, recipe.key));
    }

    // Map-wide questions — the same chips + renderer as the place card,
    // just unscoped: the whole map is the subject here.
    const askWrap = container.createDiv({ cls: "bevia-section" });
    askWrap.createEl("div", { cls: "bevia-eyebrow bevia-eyebrow-spaced", text: "ASK YOUR MAP" });
    const chips = askWrap.createDiv({ cls: "bevia-pc-chips" });
    const resultSlot = askWrap.createDiv({ cls: "bevia-pc-result" });
    const makeChip = (
      label: string,
      hot: boolean,
      kind: Parameters<typeof fetchQuery>[1]["kind"],
      params: Record<string, unknown>,
    ) => {
      const chip = chips.createEl("button", {
        cls: "bevia-pc-chip" + (hot ? " bevia-pc-chip-hot" : ""),
        text: label,
      });
      chip.addEventListener("click", async () => {
        const seq = ++this.chipSeq;
        resultSlot.empty();
        resultSlot.createEl("p", { cls: "bevia-humility", text: "Asking your map…" });
        try {
          const response = await this.runQuery(kind, params);
          if (seq !== this.chipSeq) return;
          renderQueryResult(resultSlot, response, "mind", { app: this.app, plugin: this.plugin });
        } catch (err) {
          if (seq !== this.chipSeq) return;
          this.renderChipError(resultSlot, err);
        }
      });
    };
    makeChip("What grew this week?", true, "territories_grown", { window: "7d", threshold: 2, limit: 10 });
    makeChip("New territories", false, "new_territories", { window: "7d", limit: 10 });
    makeChip("Recent moments", false, "recent_moments", { window: "24h", limit: 15 });
    makeChip("Contradictions", false, "contradictions", { window: "7d", limit: 10 });
    makeChip("Alone vs with AI", false, "loop_breakdown", { window: "30d" });

    // Free-form ask over the whole map — same live door as the place
    // card's, unscoped.
    this.appendAskComposer(askWrap, "Ask Bevia about your map…", (q) => q);
  }

  /** The quiet offline state — never a raw error dump. */
  private renderOffline(title: string, err: unknown): void {
    const container = this.container();
    container.empty();
    this.nearbyEl = null;
    const wrap = container.createDiv({ cls: "bevia-state bevia-state-empty" });
    wrap.createEl("div", { cls: "bevia-eyebrow", text: "BEVIA NAVIGATOR" });
    if (err instanceof BeviaApiError && err.status === 401) {
      wrap.createEl("p", {
        text: "Connect this vault to see where your notes sit on your map.",
      });
      wrap.createEl("p", {
        cls: "bevia-capability",
        text: "Open Settings → Bevia Navigator and paste your token.",
      });
    } else {
      wrap.createEl("p", { text: "Bevia is out of reach right now." });
      wrap.createEl("p", {
        cls: "bevia-capability",
        text: "The map is still there — it will be back the moment the connection is.",
      });
      if (this.plugin.settings.narration === "technical") {
        const detail = err instanceof Error ? err.message : String(err);
        wrap.createEl("p", { cls: "bevia-error-detail", text: detail });
      }
    }
    const retryBtn = wrap.createEl("button", { text: "Try again", cls: "bevia-retry" });
    retryBtn.addEventListener("click", () => {
      this.lastKey = null;
      void this.refresh(true);
    });
  }

  // ─── The card ──────────────────────────────────────────────────────

  private renderResponse(title: string, data: NavigatorOrientationResponse): void {
    const container = this.container();
    container.empty();
    this.nearbyEl = null;
    this.directionsResultEl = null;

    if (data.no_match || !data.you_are_here) {
      this.renderNoMatch(container, title, data.nearest);
      // HOW YOU WORK is GLOBAL — it rides even when the note isn't on the
      // map yet, so the panel still teaches that Bevia watches how you
      // think, not only what you're writing about.
      this.renderHowYouWork(container, data.how_you_work ?? []);
      return;
    }

    const t = data.you_are_here;
    const nearby = data.nearby ?? [];
    const ideasHere = data.ideas_here ?? [];
    this.labelIndex = this.buildLabelIndex(t, nearby);

    // First-run teach state — shown until dismissed once. Everything
    // on the card is real; the teach card just says so.
    if (!this.plugin.settings.placeCardTeachSeen) {
      this.renderTeach(container);
    }

    // ── You-Are-Here header + orientation prose ──
    const header = container.createDiv({ cls: "bevia-header" });
    header.createEl("div", { cls: "bevia-eyebrow", text: "YOU ARE HERE" });
    header.createEl("div", { cls: "bevia-note-title", text: t.label });
    this.renderOrientation(header, t);

    // ── The five verbs ──
    this.renderVerbs(container, t);

    // ── Query chips + their result slot ──
    this.renderChips(container, t);

    // ── How you work — the behavioral Mirror (founder 2026-07-07;
    //    promoted from the panel's tail 2026-07-09: the reflection
    //    suggestions were "hidden at the bottom" and read as dead) ──
    this.renderHowYouWork(container, data.how_you_work ?? []);

    // ── Fact rows ──
    this.renderFactRows(container, t);

    // ── Directions ──
    this.renderDirections(container, t);

    // ── Nearby ──
    this.renderNearby(container, t, nearby);

    // ── Ideas alive here (founder direction 2026-07-05) ──
    this.renderIdeasHere(container, ideasHere);

    // ── Footer ──
    const footer = container.createDiv({ cls: "bevia-footer" });
    const meta = footer.createDiv();
    // Mind-mode indicator per ADR-0170 — small, persistent, never
    // hideable. The Navigator always reads the whole map ("Mind" is the
    // doctrine name; the chip speaks plainly).
    const modeChip = meta.createDiv({ cls: "bevia-mode-chip bevia-mode-mind" });
    modeChip.createEl("span", { cls: "bevia-mono", text: "WHOLE MAP — nothing filtered" });
    meta.createEl("div", {
      cls: "bevia-pc-meta",
      text: "Quiet things stay on the map · nothing here leaves your vault",
    });
    const refresh = footer.createEl("button", { cls: "bevia-refresh", text: "Refresh" });
    refresh.addEventListener("click", () => {
      this.lastKey = null;
      void this.refresh(true);
    });
  }

  private renderNoMatch(
    container: HTMLElement,
    title: string,
    nearest: { territory_id: string; label: string } | null,
  ): void {
    if (!this.plugin.settings.placeCardTeachSeen) this.renderTeach(container);
    const header = container.createDiv({ cls: "bevia-header" });
    header.createEl("div", { cls: "bevia-eyebrow", text: "BEVIA NAVIGATOR" });
    header.createEl("div", { cls: "bevia-note-title", text: title });
    const wrap = container.createDiv({ cls: "bevia-state bevia-state-empty" });

    // Bevia-written notes (everything under Bevia/ except the user's
    // 5 Workspace) are the map's own rendering — Bevia never re-reads its
    // own output as intake (sync-vault-intake skips it), so "isn't on your
    // map yet — reading it now" was false and self-blind on exactly the
    // notes Bevia authored (founder finding 2026-07-07, on an idea note).
    const activePath = this.app.workspace.getActiveFile()?.path ?? "";
    const isBeviaNote =
      activePath.startsWith("Bevia/") && !activePath.startsWith("Bevia/5 Workspace/");
    if (isBeviaNote) {
      const isIdea = activePath.startsWith("Bevia/2 Ideas/");
      wrap.createEl("p", {
        text: isIdea
          ? "One of your ideas — Bevia wrote this note from your own recurring thinking. Its ground is in the links inside: where it lives, and what it travels with."
          : "A Bevia-written note — part of your map's own rendering, not new material to read.",
      });
      if (nearest) {
        const p = wrap.createEl("p");
        p.appendText(isIdea ? "Nearest territory: " : "Nearest ground: ");
        const link = p.createEl("a", { text: nearest.label, cls: "bevia-route-link" });
        link.addEventListener("click", (ev) => {
          ev.preventDefault();
          void this.loadTerritory(nearest.territory_id, nearest.label);
        });
        p.appendText(".");
      }
      return;
    }

    wrap.createEl("p", {
      text: "This note isn't on your map yet — Bevia is reading it now.",
    });
    if (nearest) {
      const p = wrap.createEl("p");
      p.appendText("The closest ground so far is ");
      const link = p.createEl("a", { text: nearest.label, cls: "bevia-route-link" });
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        void this.loadTerritory(nearest.territory_id, nearest.label);
      });
      p.appendText(".");
    }
  }

  private renderTeach(container: HTMLElement): void {
    const teach = container.createDiv({ cls: "bevia-teach" });
    teach.createEl("span", { cls: "bevia-teach-tag", text: "First time here" });
    teach.createEl("p", {
      text:
        "This card is your \"you are here\" pin. Everything on it is real, and everything is touchable — " +
        "the evidence row opens the conversations and notes that built this territory, the chips ask your " +
        "map a question, and Directions walks the path between two territories.",
    });
    const cta = teach.createEl("button", { cls: "bevia-teach-cta", text: "Got it →" });
    cta.addEventListener("click", () => {
      this.plugin.settings.placeCardTeachSeen = true;
      void this.plugin.saveSettings();
      this.rerenderFromCache();
    });
  }

  // ─── Orientation prose (the "photo of your house") ────────────────
  //
  // ONE narrated paragraph composed deterministically from the
  // payload — recognition, not dashboard sections. Every claim below
  // traces to a field on the wire (render rule: evidence grounding).

  private renderOrientation(parent: HTMLElement, t: YouAreHere): void {
    const technical = this.plugin.settings.narration === "technical";

    if (technical) {
      const mono = parent.createDiv({ cls: "bevia-orient-tech bevia-mono" });
      const added = t.evidence_added_7d ?? 0;
      mono.setText(
        `territory_id ${t.territory_id} · first_seen_at ${isoDate(t.first_seen_at)} · ` +
          `evidence_count ${t.evidence_count}${added > 0 ? ` (+${added}/7d)` : ""} · recurrence ×${t.recurrence_count}`,
      );
      const summary = t.technical_summary?.trim() || t.summary?.trim();
      if (summary) parent.createEl("p", { cls: "bevia-orient-summary", text: summary });
      if (t.last_major_change?.at) {
        parent.createEl("div", {
          cls: "bevia-orient-tech bevia-mono",
          text: `last_major_change ${isoDate(t.last_major_change.at)} — ${t.last_major_change.what ?? ""}`,
        });
      }
      if (t.semantic_resolution) {
        parent.createEl("div", {
          cls: "bevia-orient-tech bevia-mono",
          text:
            `semantic_resolution ${t.semantic_resolution.level} · ` +
            `closely_observed ${t.semantic_resolution.closely_observed_share}`,
        });
      }
      return;
    }

    const p = parent.createEl("p", { cls: "bevia-orient" });
    p.appendText("You're in ");
    p.createEl("b", { text: t.label });
    p.appendText(". ");

    const days = t.days_here;
    const daysPhrase =
      days <= 0
        ? "You arrived here today"
        : days === 1
          ? "You've been here a day"
          : `You've been here ${days} days`;
    const added = t.evidence_added_7d ?? 0;
    let evidencePhrase = `${t.evidence_count} ${t.evidence_count === 1 ? "piece" : "pieces"} of evidence`;
    // Liveness: weave in the week's motion when there is some;
    // when there is none, silence — never "no activity".
    if (added > 0) {
      evidencePhrase += `, ${added} of ${added === 1 ? "it" : "them"} this week`;
    }
    p.appendText(`${daysPhrase} — ${evidencePhrase}.`);

    if (t.last_major_change?.at) {
      p.appendText(` Last major change: ${humanizeWhen(t.last_major_change.at)}`);
      if (t.last_major_change.what?.trim()) {
        p.appendText(` — ${t.last_major_change.what.trim().replace(/\.$/, "")}`);
      }
      p.appendText(".");
    }

    if (t.summary?.trim()) {
      parent.createEl("p", { cls: "bevia-orient-summary", text: t.summary.trim() });
    }

    // Calibrated humility (ADR-0175) — the atlas observes at varying
    // resolutions and must surface it. Only low/medium speak up.
    const level = t.semantic_resolution?.level;
    if (level === "low") {
      parent.createEl("p", {
        cls: "bevia-humility",
        text: "Bevia has mostly read this territory from a distance — the shape is real, the fine detail is still thin.",
      });
    } else if (level === "medium") {
      parent.createEl("p", {
        cls: "bevia-humility",
        text: "Parts of this territory were read from a distance — most of the detail is in, some is still filling in.",
      });
    }
  }

  // ─── The five verbs ────────────────────────────────────────────────

  private renderVerbs(container: HTMLElement, t: YouAreHere): void {
    const row = container.createDiv({ cls: "bevia-verbs" });
    const promoted = t.attention_state === "promoted";
    const shared = t.share_state === "shared";

    this.renderVerb(row, "→", "Go deeper", "Open this territory's note — the evidence behind everything on this card.", () =>
      void this.goDeeper(t),
    );
    this.renderVerb(
      row,
      "♥",
      promoted ? "Promoted" : "Promote",
      promoted
        ? "Promoted — click to let this territory settle back to normal."
        : "Promote — surface this territory more in your daily reads.",
      () => void this.togglePromote(t),
      promoted,
    );
    this.renderVerb(row, "◎", "Related", "Jump to the territories nearby on your map.", () => {
      this.nearbyEl?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    this.renderVerb(row, "✦", "Ask", "Ask a question — the answer draws on your own map.", () =>
      void this.focusAsk(),
    );
    this.renderVerb(
      row,
      "↗",
      shared ? "Shared" : "Share",
      shared
        ? "Shared — click to make this territory private again."
        : "Share — private by default; make this territory visible to what you've connected.",
      () => void this.toggleShare(t),
      shared,
    );
  }

  private renderVerb(
    parent: HTMLElement,
    glyph: string,
    label: string,
    tooltip: string,
    onClick: () => void,
    filled = false,
  ): void {
    const verb = parent.createEl("button", { cls: "bevia-verb" });
    verb.setAttr("title", tooltip);
    verb.setAttr("aria-label", tooltip);
    const ic = verb.createDiv({ cls: "bevia-verb-ic" + (filled ? " bevia-filled" : "") });
    ic.setText(glyph);
    verb.createEl("span", { cls: "bevia-verb-label", text: label });
    verb.addEventListener("click", onClick);
  }

  private async goDeeper(t: YouAreHere): Promise<void> {
    const file = this.findTerritoryFile(t.territory_id, t.label);
    if (file) {
      await this.app.workspace.getLeaf(false).openFile(file);
      return;
    }
    new Notice(
      "This territory's note hasn't landed in your vault yet — run \"Sync my Atlas now\" and try again.",
    );
  }

  private async togglePromote(t: YouAreHere): Promise<void> {
    const next = t.attention_state === "promoted" ? "default" : "promoted";
    try {
      const res = await setTerritoryAttention(
        { baseUrl: this.plugin.settings.baseUrl, token: this.plugin.settings.token },
        t.territory_id,
        next,
      );
      // Update the cached read so the re-render reflects the knob.
      if (this.cache?.data.you_are_here?.territory_id === t.territory_id) {
        this.cache.data.you_are_here.attention_state = res.territory.attention_state;
      }
      new Notice(
        next === "promoted"
          ? `Promoted — ${t.label} will surface first in your reads.`
          : `${t.label} is back to normal.`,
      );
      this.rerenderFromCache();
    } catch (err) {
      new Notice(err instanceof BeviaApiError ? err.message : "Couldn't reach Bevia — the knob is unchanged.");
    }
  }

  private async toggleShare(t: YouAreHere): Promise<void> {
    const next = t.share_state === "shared" ? "private" : "shared";
    try {
      const res = await setTerritoryShare(
        { baseUrl: this.plugin.settings.baseUrl, token: this.plugin.settings.token },
        t.territory_id,
        next,
      );
      if (this.cache?.data.you_are_here?.territory_id === t.territory_id) {
        this.cache.data.you_are_here.share_state = res.territory.share_state;
      }
      new Notice(next === "shared" ? `${t.label} is now shared.` : `${t.label} is private again.`);
      this.rerenderFromCache();
    } catch (err) {
      new Notice(err instanceof BeviaApiError ? err.message : "Couldn't reach Bevia — the knob is unchanged.");
    }
  }

  private async focusAsk(): Promise<void> {
    await this.plugin.activateAskView();
    const leaf = this.app.workspace.getLeavesOfType(BEVIA_ASK_VIEW_TYPE)[0];
    if (leaf && leaf.view instanceof BeviaAskView) leaf.view.focusInput();
  }

  // ─── Query chips ───────────────────────────────────────────────────
  //
  // Canned questions over the existing query primitives (ADR-0154
  // Layer 2 — cartographic reads, no LLM in the path), scoped to this
  // territory where the primitive supports it. "Why this exists"
  // renders locally from the payload — orientation before exploration.

  private renderChips(container: HTMLElement, t: YouAreHere): void {
    const chips = container.createDiv({ cls: "bevia-pc-chips" });
    const resultSlot = container.createDiv({ cls: "bevia-pc-result" });

    // Every chip answer ends with a "keep going →" handoff: one tap
    // continues that exact thread in Ask Bevia (founder 2026-07-09 —
    // the chips looked like dead ends). The handoff question is scoped
    // to the territory so the Librarian recalls the right ground.
    const makeChip = (
      label: string,
      hot: boolean,
      run: (slot: HTMLElement) => void | Promise<void>,
      askQuestion: string,
    ) => {
      const chip = chips.createEl("button", {
        cls: "bevia-pc-chip" + (hot ? " bevia-pc-chip-hot" : ""),
        text: label,
      });
      chip.addEventListener("click", () => {
        resultSlot.empty();
        resultSlot.createEl("p", { cls: "bevia-mono", text: "Looking…" });
        void (async () => {
          await run(resultSlot);
          this.appendAskHandoff(resultSlot, askQuestion);
        })();
      });
    };

    makeChip("Why this exists", true, (slot) => this.chipWhyThisExists(slot, t),
      `Why does "${t.label}" keep showing up in my work — what's actually driving it?`);
    makeChip("What's grown here?", false, (slot) => this.chipGrownHere(slot, t),
      `What's been growing in "${t.label}" lately, and where does it seem to be heading?`);
    makeChip("Recent moments", false, (slot) => this.chipRecentMoments(slot),
      "What have I been working on lately, and what's the thread connecting it?");
    makeChip("Contradictions", false, (slot) => this.chipContradictions(slot, t),
      `Where am I holding contradictory positions around "${t.label}"?`);
    makeChip("Open threads", false, (slot) => this.chipOpenThreads(slot),
      "Which threads have I left open, and which one is most worth picking back up?");

    // Free-form ask, scoped to this territory — the chips answer the
    // common questions; this answers YOURS (founder 2026-07-09: Ask
    // Bevia belongs on the Navigator too, not only standalone).
    this.appendAskComposer(
      container,
      `Ask Bevia about "${t.label}"…`,
      (q) => `About the territory "${t.label}" on my map: ${q}`,
    );
  }

  /** A one-line Ask Bevia composer — typed question opens the Ask panel
   *  and runs immediately, with the given context woven in. */
  private appendAskComposer(
    container: HTMLElement,
    placeholder: string,
    compose: (question: string) => string,
  ): void {
    const wrap = container.createDiv({ cls: "bevia-section bevia-query-ask" });
    wrap.createEl("div", { cls: "bevia-eyebrow", text: "ASK BEVIA" });
    const row = wrap.createDiv({ cls: "bevia-query-ask-row" });
    const input = row.createEl("input", {
      cls: "bevia-query-input bevia-query-ask-input",
      type: "text",
      placeholder,
    });
    const send = row.createEl("button", { cls: "bevia-pc-chip", text: "Ask →" });
    const fire = () => {
      const q = input.value.trim();
      if (!q) return;
      input.value = "";
      void this.plugin.askBevia(compose(q));
    };
    send.addEventListener("click", fire);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        fire();
      }
    });
  }

  /** The chip result's continuation affordance — hands the thread to
   *  Ask Bevia (opens the panel, asks immediately). */
  private appendAskHandoff(slot: HTMLElement, question: string): void {
    const row = slot.createDiv({ cls: "bevia-ask-handoff" });
    const link = row.createEl("a", { text: "keep going →" });
    link.setAttr("title", "Continue this thread in Ask Bevia — runs on your AI key.");
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      void this.plugin.askBevia(question);
    });
  }

  /** Local render, no endpoint — the orientation-before-exploration chip. */
  private chipWhyThisExists(slot: HTMLElement, t: YouAreHere): void {
    slot.empty();
    slot.createEl("div", { cls: "bevia-eyebrow", text: "WHY THIS EXISTS" });
    if (t.summary?.trim()) {
      slot.createEl("p", { cls: "bevia-orient", text: t.summary.trim() });
    }
    const technical = this.plugin.settings.narration === "technical";
    slot.createEl("p", {
      cls: "bevia-orient-summary",
      text: technical
        ? `first_seen_at ${isoDate(t.first_seen_at)} · evidence_count ${t.evidence_count} · recurrence ×${t.recurrence_count}`
        : `First seen ${humanizeWhen(t.first_seen_at)} — ${t.evidence_count} ${
            t.evidence_count === 1 ? "piece" : "pieces"
          } of evidence since.`,
    });
  }

  private async chipGrownHere(slot: HTMLElement, t: YouAreHere): Promise<void> {
    const seq = ++this.chipSeq;
    try {
      const response = await this.runQuery("territories_grown", {
        window: "30d",
        threshold: 1,
        limit: 100,
      });
      if (seq !== this.chipSeq) return;
      const rows = extractRows(response).filter((r) => r.id === t.territory_id);
      slot.empty();
      if (rows.length === 0) {
        slot.createEl("p", {
          cls: "bevia-orient-summary",
          text:
            this.plugin.settings.narration === "technical"
              ? "territories_grown(30d): 0 new member moments for this territory."
              : "Nothing new here in the past month — this ground is holding steady.",
        });
        return;
      }
      renderQueryResult(slot, withRows(response, rows), "mind", { app: this.app, plugin: this.plugin });
    } catch (err) {
      if (seq !== this.chipSeq) return;
      this.renderChipError(slot, err);
    }
  }

  private async chipRecentMoments(slot: HTMLElement): Promise<void> {
    const seq = ++this.chipSeq;
    try {
      const response = await this.runQuery("recent_moments", { window: "7d", limit: 10 });
      if (seq !== this.chipSeq) return;
      slot.empty();
      slot.createEl("p", {
        cls: "bevia-orient-summary",
        text: "Across your whole map — the newest things Bevia saw.",
      });
      renderQueryResult(slot.createDiv(), response, "mind", { app: this.app, plugin: this.plugin });
    } catch (err) {
      if (seq !== this.chipSeq) return;
      this.renderChipError(slot, err);
    }
  }

  private async chipContradictions(slot: HTMLElement, t: YouAreHere): Promise<void> {
    const seq = ++this.chipSeq;
    try {
      const response = await this.runQuery("contradictions", { window: "30d", limit: 50 });
      if (seq !== this.chipSeq) return;
      const rows = extractRows(response).filter((r) => r.territory_id === t.territory_id);
      slot.empty();
      if (rows.length === 0) {
        slot.createEl("p", {
          cls: "bevia-orient-summary",
          text:
            this.plugin.settings.narration === "technical"
              ? "contradictions(30d): 0 rows for this territory."
              : "No tension touching this territory in the past month.",
        });
        return;
      }
      renderQueryResult(slot, withRows(response, rows), "mind", { app: this.app, plugin: this.plugin });
    } catch (err) {
      if (seq !== this.chipSeq) return;
      this.renderChipError(slot, err);
    }
  }

  private async chipOpenThreads(slot: HTMLElement): Promise<void> {
    const seq = ++this.chipSeq;
    const technical = this.plugin.settings.narration === "technical";
    try {
      const response = await this.runQuery("open_threads", { limit: 3 });
      if (seq !== this.chipSeq) return;
      const rows = extractRows(response);
      slot.empty();
      slot.createEl("div", { cls: "bevia-eyebrow", text: "OPEN THREADS" });
      if (rows.length === 0) {
        slot.createEl("p", {
          cls: "bevia-orient-summary",
          text: "Nothing left hanging — every thread you opened either landed or is still warm.",
        });
        return;
      }
      // Open threads predate naming (they never became a territory),
      // so the render names what it can and stays honest about the
      // rest — a custom render; renderQueryResult has no shape for it.
      const list = slot.createDiv({ cls: "bevia-territory-list" });
      for (const row of rows) {
        const card = list.createDiv({ cls: "bevia-territory bevia-strength-low" });
        const quietSince = typeof row.last_strengthened_at === "string" ? row.last_strengthened_at : null;
        const opened = typeof row.first_seen_at === "string" ? row.first_seen_at : null;
        if (technical) {
          card.createEl("div", {
            cls: "bevia-territory-label",
            text: `thread ${String(row.cluster_signature ?? "").slice(0, 12)} · ${String(row.emergence_state ?? "")}`,
          });
          card.createEl("p", {
            cls: "bevia-territory-summary",
            text: `recurrence_score ${row.recurrence_score} · baseline_delta ${row.baseline_delta} · last_strengthened_at ${
              quietSince ? isoDate(quietSince) : "?"
            }`,
          });
        } else {
          card.createEl("div", {
            cls: "bevia-territory-label",
            text: "A thread you kept circling back to",
          });
          const parts: string[] = [];
          if (opened) parts.push(`opened ${humanizeWhen(opened)}`);
          if (quietSince) parts.push(`quiet since ${humanizeWhen(quietSince)}`);
          card.createEl("p", {
            cls: "bevia-territory-summary",
            text:
              (parts.length > 0 ? parts.join(" · ") + ". " : "") +
              "It never settled into a named territory — it may be finished offline, or waiting.",
          });
        }
      }
    } catch (err) {
      if (seq !== this.chipSeq) return;
      this.renderChipError(slot, err);
    }
  }

  private runQuery(kind: Parameters<typeof fetchQuery>[1]["kind"], params: Record<string, unknown>) {
    return fetchQuery(
      { baseUrl: this.plugin.settings.baseUrl, token: this.plugin.settings.token },
      // The place card is a Mind surface (ADR-0170) — full substrate.
      { kind, params, mode: "mind" },
    );
  }

  private renderChipError(slot: HTMLElement, err: unknown): void {
    slot.empty();
    slot.createEl("p", { cls: "bevia-orient-summary", text: "Couldn't ask the map just now." });
    if (this.plugin.settings.narration === "technical") {
      slot.createEl("p", {
        cls: "bevia-error-detail",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Fact rows (quiet, Maps-style — every fact an affordance) ─────

  private renderFactRows(container: HTMLElement, t: YouAreHere): void {
    const technical = this.plugin.settings.narration === "technical";
    const rows = container.createDiv({ cls: "bevia-fact-rows" });

    const addRow = (glyph: string, render: (text: HTMLElement) => void, onClick?: () => void, tooltip?: string) => {
      const row = rows.createDiv({ cls: "bevia-fact-row" + (onClick ? " bevia-clickable" : "") });
      row.createEl("span", { cls: "bevia-fact-glyph", text: glyph });
      const text = row.createDiv({ cls: "bevia-fact-text" });
      render(text);
      if (onClick) {
        row.addEventListener("click", onClick);
        if (tooltip) {
          row.setAttr("title", tooltip);
          row.setAttr("aria-label", tooltip);
        }
      }
    };

    // First seen.
    addRow("◆", (el) => {
      if (technical) {
        el.setText(`first_seen_at — ${isoDate(t.first_seen_at)}`);
      } else {
        el.appendText("First seen ");
        el.createEl("b", { text: humanizeWhen(t.first_seen_at) });
      }
    });

    // Evidence — the drill into the originals. Opens a real dated
    // list right here (founder 2026-07-09 — this line used to jump to
    // the territory note, which read as "nothing happened"). Explain
    // doctrine: composition + provenance, drillable in place.
    let evidenceDrill: HTMLElement | null = null;
    addRow(
      "☰",
      (el) => {
        if (technical) {
          const added = t.evidence_added_7d ?? 0;
          el.setText(
            `evidence_count — ${t.evidence_count} · recurrence ×${t.recurrence_count}${added > 0 ? ` · +${added}/7d` : ""}`,
          );
        } else {
          el.createEl("b", { text: `${t.evidence_count} conversations and notes` });
          el.appendText(" built this — tap to read the originals");
        }
      },
      () => {
        if (evidenceDrill) {
          evidenceDrill.remove();
          evidenceDrill = null;
          return;
        }
        evidenceDrill = rows.createDiv({ cls: "bevia-evidence-drill" });
        void this.renderEvidenceDrill(evidenceDrill, t);
      },
      "See the dated list of conversations and notes behind this territory.",
    );

    // Attention state.
    addRow("♥", (el) => {
      if (technical) {
        el.setText(`attention_state — ${t.attention_state} · share_state — ${t.share_state}`);
        return;
      }
      if (t.attention_state === "promoted") {
        el.appendText("Attention: ");
        el.createEl("b", { text: "promoted" });
        el.appendText(" — surfaced first in your reads");
      } else if (t.attention_state === "dampened") {
        el.appendText("Attention: ");
        el.createEl("b", { text: "quiet" });
        el.appendText(" — you asked for this one to be quieter");
      } else {
        el.appendText("Attention: on the map, at its natural weight");
      }
      if (t.share_state === "shared") el.appendText(" · shared");
    });

    // Observation depth (ADR-0175 — surface the resolution).
    if (t.semantic_resolution) {
      addRow("◐", (el) => {
        if (technical) {
          el.setText(
            `semantic_resolution — ${t.semantic_resolution!.level} · closely_observed ${t.semantic_resolution!.closely_observed_share}`,
          );
          return;
        }
        const level = t.semantic_resolution!.level;
        el.setText(
          level === "high"
            ? "Read closely — the detail is solid"
            : level === "medium"
              ? "Partly read closely — some detail is still filling in"
              : "Read from a distance so far",
        );
      });
    }
  }

  /** The evidence drill-down — a first-class dated list of the member
   *  moments that built this territory (newest first, event time).
   *  Reads the territory_moments query primitive; never re-derives. */
  private async renderEvidenceDrill(slot: HTMLElement, t: YouAreHere): Promise<void> {
    const technical = this.plugin.settings.narration === "technical";
    slot.empty();
    slot.createEl("p", { cls: "bevia-mono", text: "Pulling the originals…" });
    try {
      const response = await this.runQuery("territory_moments", {
        territory_id: t.territory_id,
        limit: 12,
      });
      const result = response.result as {
        total?: number;
        rows?: Array<{ id: string; occurred_at: string; source_kind: string | null; text_excerpt: string }>;
      };
      const rows = result.rows ?? [];
      const total = result.total ?? rows.length;
      slot.empty();
      if (rows.length === 0) {
        slot.createEl("p", {
          cls: "bevia-orient-summary",
          text: "The originals haven't synced into a readable list yet — the territory note has the full story.",
        });
        return;
      }
      slot.createEl("div", { cls: "bevia-eyebrow", text: "THE ORIGINALS" });
      for (const m of rows) {
        const row = slot.createDiv({ cls: "bevia-evidence-row" });
        const when = m.occurred_at
          ? (technical ? isoDate(m.occurred_at) : humanizeWhen(m.occurred_at))
          : "";
        const source = m.source_kind ? ` · ${m.source_kind.replace(/[-_]/g, " ")}` : "";
        row.createEl("div", {
          cls: "bevia-evidence-when bevia-mono",
          text: `${when}${source}`,
        });
        if (m.text_excerpt?.trim()) {
          row.createEl("p", { cls: "bevia-evidence-excerpt", text: m.text_excerpt.trim() });
        }
      }
      if (total > rows.length) {
        const more = slot.createEl("a", {
          cls: "bevia-evidence-more",
          text: `…and ${total - rows.length} more — open the territory note →`,
        });
        more.addEventListener("click", (ev) => {
          ev.preventDefault();
          void this.goDeeper(t);
        });
      }
    } catch (err) {
      slot.empty();
      slot.createEl("p", { cls: "bevia-orient-summary", text: "Couldn't pull the originals just now." });
      if (technical) {
        slot.createEl("p", {
          cls: "bevia-error-detail",
          text: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ─── Directions ────────────────────────────────────────────────────

  private renderDirections(container: HTMLElement, t: YouAreHere): void {
    const section = container.createDiv({ cls: "bevia-section bevia-directions" });
    section.createEl("div", { cls: "bevia-eyebrow", text: "DIRECTIONS" });

    const input = section.createEl("input", {
      cls: "bevia-dir-input",
      attr: { type: "text", placeholder: "Directions from here to…", "aria-label": "Directions from here to another territory" },
    });
    const suggest = section.createDiv({ cls: "bevia-dir-suggest" });
    suggest.hide();
    const result = section.createDiv({ cls: "bevia-dir-result" });
    this.directionsResultEl = result;

    const showSuggestions = () => {
      const q = input.value.trim().toLowerCase();
      suggest.empty();
      const entries = [...this.labelIndex.entries()]
        .filter(([label]) => label.toLowerCase() !== t.label.toLowerCase())
        .filter(([label]) => q === "" || label.toLowerCase().includes(q))
        .slice(0, 8);
      if (entries.length === 0) {
        suggest.hide();
        return;
      }
      for (const [label, id] of entries) {
        const item = suggest.createDiv({ cls: "bevia-dir-suggest-item", text: label });
        // mousedown, not click — fires before the input's blur hides the list.
        item.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          input.value = label;
          suggest.hide();
          void this.runDirections(t, id, label);
        });
      }
      suggest.show();
    };

    input.addEventListener("input", showSuggestions);
    input.addEventListener("focus", showSuggestions);
    input.addEventListener("blur", () => window.setTimeout(() => suggest.hide(), 120));
    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      const q = input.value.trim().toLowerCase();
      if (!q) return;
      const exact = [...this.labelIndex.entries()].find(([label]) => label.toLowerCase() === q);
      const first = exact ?? [...this.labelIndex.entries()].find(([label]) => label.toLowerCase().includes(q));
      if (first) {
        input.value = first[0];
        suggest.hide();
        void this.runDirections(t, first[1], first[0]);
      }
    });
  }

  private async runDirections(from: YouAreHere, toId: string, toLabel: string): Promise<void> {
    const slot = this.directionsResultEl;
    if (!slot) return;
    const seq = ++this.chipSeq;
    slot.empty();
    slot.createEl("p", { cls: "bevia-mono", text: "Walking the path…" });

    try {
      const res = await fetchNavigatorDirections(
        { baseUrl: this.plugin.settings.baseUrl, token: this.plugin.settings.token },
        { from_territory_id: from.territory_id, to_territory_id: toId },
      );
      if (seq !== this.chipSeq) return;
      slot.empty();

      if (!res.connected) {
        // The honest state — an invitation, never an error.
        const invite = slot.createDiv({ cls: "bevia-invite" });
        const p = invite.createEl("p");
        p.appendText("These two haven't touched yet");
        if (res.nearest_bridge) {
          p.appendText(" — the nearest bridge is ");
          const link = p.createEl("a", { text: res.nearest_bridge.label, cls: "bevia-route-link" });
          const bridge = res.nearest_bridge;
          link.addEventListener("click", (ev) => {
            ev.preventDefault();
            void this.loadTerritory(bridge.territory_id, bridge.label);
          });
          p.appendText(".");
        } else {
          p.appendText(". Writing that connects them would draw the first line.");
        }
        return;
      }

      slot.createEl("p", {
        cls: "bevia-orient-summary",
        text: `From ${from.label} to ${toLabel}:`,
      });
      const list = slot.createEl("ul", { cls: "bevia-route" });
      for (const step of res.route) {
        const li = list.createEl("li", {
          cls: step.kind === "moment" ? "bevia-route-moment" : "bevia-route-place",
        });
        if (step.kind === "moment") {
          // Moments render as text with their timestamp.
          li.appendText(step.excerpt?.trim() || step.label);
          if (step.occurred_at) {
            li.createEl("span", {
              cls: "bevia-mono bevia-route-when",
              text:
                " · " +
                (this.plugin.settings.narration === "technical"
                  ? isoDate(step.occurred_at)
                  : humanizeWhen(step.occurred_at)),
            });
          }
          continue;
        }
        // Territory / bridge steps — clickable when they map to a
        // vault note; otherwise plain text.
        const file = this.findTerritoryFile(step.id ?? null, step.label);
        if (file) {
          const link = li.createEl("a", { text: step.label, cls: "bevia-route-link" });
          link.addEventListener("click", (ev) => {
            ev.preventDefault();
            void this.app.workspace.getLeaf(false).openFile(file);
          });
        } else {
          li.appendText(step.label);
        }
        if (step.kind === "bridge") {
          li.createEl("span", { cls: "bevia-mono bevia-route-when", text: " · bridge" });
        }
      }
    } catch (err) {
      if (seq !== this.chipSeq) return;
      slot.empty();
      slot.createEl("p", { cls: "bevia-orient-summary", text: "Couldn't walk that path just now." });
      if (this.plugin.settings.narration === "technical") {
        slot.createEl("p", {
          cls: "bevia-error-detail",
          text: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ─── Nearby ────────────────────────────────────────────────────────

  /** IDEAS ALIVE HERE — the Telescope's recurring ideas in this
   *  territory. Tap = copy the idea-grain forward-move packet
   *  (ADR-0207: grounded, invitational, provider-agnostic). Silence
   *  when the engine sent none — never fabricated. */
  private renderIdeasHere(
    container: HTMLElement,
    ideas: Array<{ title: string; returns: number; last_seen: string; summary_line: string }>,
  ): void {
    if (!ideas || ideas.length === 0) return;
    const section = container.createDiv({ cls: "bevia-section bevia-near" });
    section.createEl("div", { cls: "bevia-eyebrow", text: "IDEAS ALIVE HERE" });
    // Teach what this is — nothing like it exists elsewhere (founder
    // 2026-07-07). One plain line; the rows below are the real thing.
    section.createEl("p", {
      cls: "bevia-orient-summary",
      text: "Ideas that keep coming back in your thinking — Bevia pulls them out so they don't slip past. Tap one to push it further in any AI chat.",
    });
    for (const idea of ideas) {
      const row = section.createDiv({ cls: "bevia-near-row" });
      const name = row.createEl("a", { cls: "bevia-near-name", text: idea.title });
      name.setAttr("title", "Copy a grounded packet to push this idea further in any AI chat.");
      const why = row.createEl("span", { cls: "bevia-near-why", text: `returned ×${idea.returns} · push further` });
      name.addEventListener("click", (ev) => {
        ev.preventDefault();
        const packet = [
          `An idea from my Bevia map: ${idea.title}`,
          idea.summary_line ? `Current form: ${idea.summary_line}` : null,
          `It has returned ${idea.returns} times in my thinking (last on ${idea.last_seen}).`,
          `Help me take it one concrete step further than it has been.`,
        ].filter(Boolean).join("\n");
        void navigator.clipboard.writeText(packet).then(() => {
          why.setText("copied — paste into your AI");
          window.setTimeout(() => why.setText(`returned ×${idea.returns} · push further`), 2500);
        });
      });
    }
  }

  /** HOW YOU WORK — the behavioral Mirror's top dispositions. GLOBAL,
   *  not note-specific: patterns in HOW you think, not what this note is
   *  about — so the panel teaches that this whole dimension exists.
   *
   *  Tap = OPEN Ask Bevia with the grounded reflection packet already
   *  running (shadow-as-cost-of-trait, ADR-0076: "where it serves me
   *  and where it costs me"). The old behavior — silent clipboard copy
   *  with a 2.5s label flash — read as a dead link (founder,
   *  2026-07-09: "I clicked and nothing happened"); the conversation
   *  now starts in front of you, and a small copy affordance remains
   *  for taking the packet to an external AI. Silence when the engine
   *  sent none — never fabricated. */
  private renderHowYouWork(
    container: HTMLElement,
    patterns: Array<{ title: string; summary_line: string; recurrence: number }>,
  ): void {
    if (!patterns || patterns.length === 0) return;
    const section = container.createDiv({ cls: "bevia-section bevia-near" });
    section.createEl("div", { cls: "bevia-eyebrow", text: "HOW YOU WORK" });
    section.createEl("p", {
      cls: "bevia-orient-summary",
      text: "Patterns in how you think — not what you think about. Tap one and Bevia reflects on it with you, grounded in your map.",
    });
    for (const p of patterns) {
      const packet = [
        `A pattern in how I work, from my Bevia map: ${p.title}`,
        p.summary_line ? p.summary_line : null,
        `It shows up across my work (seen ${p.recurrence} times).`,
        `Help me see where this serves me and where it costs me — and one small thing to try.`,
      ].filter(Boolean).join("\n");

      const row = section.createDiv({ cls: "bevia-near-row" });
      const name = row.createEl("a", { cls: "bevia-near-name", text: p.title });
      name.setAttr("title", "Reflect on this with Bevia — opens the chat with the question ready.");
      const why = row.createEl("span", { cls: "bevia-near-why" });
      const reflectBtn = why.createEl("a", { text: `reflect with Bevia →` });
      reflectBtn.setAttr("title", "Opens Ask Bevia and starts the reflection.");
      why.appendText(` · seen ×${p.recurrence} · `);
      const copyBtn = why.createEl("a", { text: "copy" });
      copyBtn.setAttr("title", "Copy the reflection to paste into any other AI chat.");

      const openAsk = (ev: Event) => {
        ev.preventDefault();
        void this.plugin.askBevia(packet);
      };
      name.addEventListener("click", openAsk);
      reflectBtn.addEventListener("click", openAsk);
      copyBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void navigator.clipboard.writeText(packet).then(() => {
          copyBtn.setText("copied ✓");
          window.setTimeout(() => copyBtn.setText("copy"), 2500);
        });
      });
    }
  }

  private renderNearby(container: HTMLElement, t: YouAreHere, nearby: NearbyTerritory[]): void {
    const section = container.createDiv({ cls: "bevia-section bevia-near" });
    this.nearbyEl = section;
    section.createEl("div", { cls: "bevia-eyebrow", text: "NEARBY" });

    if (nearby.length === 0) {
      section.createEl("p", {
        cls: "bevia-orient-summary",
        text: "Nothing sits close to this yet — it stands on its own ground.",
      });
      return;
    }

    const technical = this.plugin.settings.narration === "technical";
    for (const n of nearby) {
      const row = section.createDiv({ cls: "bevia-near-row" });
      const name = row.createEl("a", { cls: "bevia-near-name", text: n.label });
      name.setAttr("title", `Move the pin to ${n.label}.`);
      name.addEventListener("click", (ev) => {
        ev.preventDefault();
        void this.loadTerritory(n.territory_id, n.label);
      });
      // The WHY — Nearby teaches the graph. Counts of evidence and
      // plain words; similarity stays internal (ordering only) in the
      // human register. Preference order: shared conversations (the
      // strongest basis) → shared concept ground (the usual case —
      // member-moment sets are mostly disjoint by construction) →
      // the neighbor's first sentence as a last resort.
      const shared = n.shared_evidence_count ?? 0;
      const ground = n.shared_ground ?? [];
      let why: string;
      if (technical) {
        why = `similarity ${n.similarity.toFixed(2)}${shared > 0 ? ` · shared ${shared}` : ""}${
          ground.length > 0 ? ` · ground ${ground.join(", ")}` : ""
        }`;
      } else if (shared > 0) {
        why = `shares ${shared} ${shared === 1 ? "conversation" : "conversations"} with here`;
      } else if (ground.length > 0) {
        why = `common ground: ${ground.join(", ")}`;
      } else {
        why = n.summary_first_sentence?.trim() || "thinks alike";
      }
      row.createEl("span", { cls: "bevia-near-why", text: why });
    }
  }

  // ─── Vault lookups (read-only — Navigators never materialize) ─────

  /** label → territory_id for the Directions autocomplete. Sources:
   *  the nearby payload + territory notes already materialized in the
   *  vault (their frontmatter carries theme_id). */
  private buildLabelIndex(t: YouAreHere, nearby: NearbyTerritory[]): Map<string, string> {
    const index = new Map<string, string>();
    for (const n of nearby) {
      if (n.label && n.territory_id) index.set(n.label, n.territory_id);
    }
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!TERRITORY_FOLDERS.some((f) => file.path.startsWith(f + "/"))) continue;
      const id = extractTerritoryId(this.app, file);
      if (id && !index.has(file.basename)) index.set(file.basename, id);
    }
    index.delete(t.label);
    return index;
  }

  /** Resolve a territory to its materialized vault note — by
   *  frontmatter id first (exact), then by label-shaped filename. */
  private findTerritoryFile(territoryId: string | null, label: string): TFile | null {
    const candidates = this.app.vault
      .getMarkdownFiles()
      .filter((file) => TERRITORY_FOLDERS.some((f) => file.path.startsWith(f + "/")));
    if (territoryId) {
      for (const file of candidates) {
        if (extractTerritoryId(this.app, file) === territoryId) return file;
      }
    }
    const safe = safeFilename(label);
    for (const file of candidates) {
      if (file.basename === label || file.basename === safe) return file;
    }
    return null;
  }
}

// ─── Pure helpers (testable) ─────────────────────────────────────────

interface CurrentNote {
  title: string;
  vaultPath: string | null;
  file: TFile | null;
}

/** True when the most recently active leaf in the MAIN editor area is
 *  a graph view — the moment the panel should speak Atlas, not
 *  Navigator. Covers the global graph and local graphs. */
function graphViewIsCurrent(app: App): boolean {
  const recent = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
  const type = recent?.view?.getViewType?.() ?? "";
  return type === "graph" || type === "localgraph";
}

function currentNoteFromApp(app: App): CurrentNote | null {
  // Normal case: a note has focus in the main editor.
  let mdView = app.workspace.getActiveViewOfType(MarkdownView);
  if (!mdView) {
    // Focus is elsewhere — this sidebar panel (every ribbon click moves
    // focus here), the graph view, a modal. Fall back to the most
    // recently active leaf in the MAIN editor area so the card keeps
    // pointing at the note the user was just in instead of blanking to
    // the welcome message.
    const recent = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
    if (recent && recent.view instanceof MarkdownView) mdView = recent.view;
  }
  if (!mdView) return null;
  const file = mdView.file;
  if (!file) return null;
  const title = file.basename;
  if (!title) return null;
  return { title, vaultPath: file.path, file };
}

/** Read theme_id / territory_id from a note's frontmatter — Bevia's
 *  materialized territory notes carry it (same convention think.ts
 *  uses). */
function extractTerritoryId(app: App, file: TFile): string | null {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!fm) return null;
  const id = fm["theme_id"] ?? fm["territory_id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Same label-to-filename shape the materializer + think.ts use. */
function safeFilename(label: string): string {
  return label
    .replace(/[\/\\:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

/** ISO → the date part, for the technical register. */
function isoDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

/** Human narration for a timestamp — the way a colleague would say
 *  it, never a telemetry stamp. */
function humanizeWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  const month = d.toLocaleString(undefined, { month: "long" });
  if (d.getFullYear() === now.getFullYear()) {
    const dom = d.getDate();
    const part = dom <= 10 ? "early" : dom <= 20 ? "mid" : "late";
    return `${part} ${month}`;
  }
  return `${month} ${d.getFullYear()}`;
}

/** Pull the rows array out of a query response (most primitives
 *  return `{ rows: [...] }`). */
function extractRows(response: QueryResponse): Array<Record<string, unknown>> {
  const result = response.result as Record<string, unknown> | null;
  if (result && Array.isArray(result.rows)) {
    return result.rows as Array<Record<string, unknown>>;
  }
  return [];
}

/** Clone a query response with a filtered row set — lets the chips
 *  scope a map-wide primitive to this territory while reusing the
 *  shared renderer. */
function withRows(response: QueryResponse, rows: Array<Record<string, unknown>>): QueryResponse {
  return { ...response, result: { ...(response.result as Record<string, unknown>), rows } };
}
