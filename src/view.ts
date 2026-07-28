// Bevia Navigator — the place card (vault-local).
//
// "This note lives in Territory X, near Y" — answered entirely from the
// materialized map already in the vault (the Bevia/ folder the engine
// writes). ZERO network: the map IS the files the user owns, and this
// panel reads them through Obsidian's metadata cache. It works even
// when the engine is off — the last-written map still answers.
//
// Doctrine: the Navigator is a projection reader (CLAUDE.md §
// Projection-layer architecture). The engine compiled the map and
// materialized it as notes-with-wikilinks; this panel is a thin reader
// of that projection. It never modifies notes, never writes files
// (Navigators never materialize), and never re-derives what the map
// already says — a note "lives in" a territory exactly when the
// territory note links to it.
//
// Four honest states:
//   1. No Bevia/ map in this vault yet   → the funnel (open Home).
//   2. Open note IS a map note           → the place itself: neighbors
//      + how much of the user's own writing it carries.
//   3. Open user note referenced by map  → "where you are" + doors.
//   4. Open user note not on the map yet → honest absence; the engine
//      compiles on its own rhythm — never an apology, never a spinner.

import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { GRAPH_RECIPES, applyGraphRecipe } from "./graph-recipes";
import type BeviaNavigatorPlugin from "./main";

export const BEVIA_NAVIGATOR_VIEW_TYPE = "bevia-navigator-view";

/** Where the materialized map lives (canonical root first, legacy root
 *  as fallback). Read-only from here, always. */
const MAP_ROOTS = ["Bevia/", "Atlas/"];

type MapKind = "territory" | "continent" | "worldview" | "landmark";

const KIND_TAGS: Record<string, MapKind> = {
  territory: "territory",
  continent: "continent",
  worldview: "worldview",
  landmark: "landmark",
};

const KIND_LABEL: Record<MapKind, string> = {
  territory: "Territory",
  continent: "Continent",
  worldview: "Worldview",
  landmark: "Landmark",
};

interface MapNote {
  file: TFile;
  kind: MapKind;
}

export class BeviaNavigatorView extends ItemView {
  plugin: BeviaNavigatorPlugin;

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
    await this.refresh();
  }

  async onClose(): Promise<void> {
    // Nothing persistent to release.
  }

  /** Recompute for the active note. Called by main.ts on leaf change
   *  (when auto-update is on) and by the refresh affordance. Cheap —
   *  metadata cache only; the one disk touch is the open place's
   *  summary line, via Obsidian's own read cache. */
  async refresh(): Promise<void> {
    const container = this.containerEl.children[1] ?? this.containerEl;
    container.empty();
    container.addClass("bevia-navigator");
    const wrap = container.createDiv({ cls: "bevia-nav-wrap" }) as HTMLElement;

    const map = this.mapNotes();
    if (map.length === 0) {
      this.renderNoMapYet(wrap);
      return;
    }

    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== "md") {
      this.renderMapOverview(wrap, map);
      return;
    }

    const activeKind = this.kindOf(active);
    if (activeKind) {
      await this.renderMapPlace(wrap, active, activeKind, map);
      return;
    }

    const homes = this.mapNotesLinkingTo(active, map);
    if (homes.length > 0) {
      this.renderWhereYouAre(wrap, active, homes);
    } else {
      this.renderNotOnMapYet(wrap, active);
    }
  }

  /** Re-render without refetching — the data source is the metadata
   *  cache, so a re-render IS a refresh. Kept as a named method because
   *  settings (narration flip) calls it. */
  rerenderFromCache(): void {
    void this.refresh();
  }

  // ── Data (metadata cache only) ────────────────────────────────────

  /** Every materialized map note in the vault, by kind tag. */
  private mapNotes(): MapNote[] {
    const out: MapNote[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!MAP_ROOTS.some((r) => file.path.startsWith(r))) continue;
      const kind = this.kindOf(file);
      if (kind) out.push({ file, kind });
    }
    return out;
  }

  /** A note's map kind, from the tags the materializer stamps
   *  (#territory / #continent / #worldview / #landmark) — frontmatter
   *  or inline. Null for user notes. */
  private kindOf(file: TFile): MapKind | null {
    if (!MAP_ROOTS.some((r) => file.path.startsWith(r))) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return null;
    const tags: string[] = [];
    for (const t of cache.tags ?? []) tags.push(t.tag);
    const fmTags = cache.frontmatter?.tags as unknown;
    if (typeof fmTags === "string") tags.push(...fmTags.split(/[,\s]+/));
    else if (Array.isArray(fmTags)) tags.push(...fmTags.map(String));
    for (const t of tags) {
      const kind = KIND_TAGS[t.replace(/^#/, "").toLowerCase()];
      if (kind) return kind;
    }
    return null;
  }

  /** Map notes whose wikilinks point at `target` — the "where does this
   *  note live?" read. The materializer writes territory → note links,
   *  so reverse-reading resolvedLinks answers membership without any
   *  network call or re-derivation. */
  private mapNotesLinkingTo(target: TFile, map: MapNote[]): MapNote[] {
    const resolved = this.app.metadataCache.resolvedLinks;
    return map.filter((m) => (resolved[m.file.path] ?? {})[target.path] > 0);
  }

  /** Outgoing links from a map note, split into map neighbors and the
   *  user's own notes (the evidence the place carries). */
  private linksFrom(
    file: TFile,
    map: MapNote[],
  ): { neighbors: MapNote[]; carried: string[] } {
    const resolved = this.app.metadataCache.resolvedLinks[file.path] ?? {};
    const byPath = new Map(map.map((m) => [m.file.path, m] as const));
    const neighbors: MapNote[] = [];
    const carried: string[] = [];
    for (const targetPath of Object.keys(resolved)) {
      if (targetPath === file.path) continue;
      const m = byPath.get(targetPath);
      if (m) neighbors.push(m);
      else if (!MAP_ROOTS.some((r) => targetPath.startsWith(r))) carried.push(targetPath);
    }
    return { neighbors, carried };
  }

  /** First real paragraph of a note — its summary line on the card.
   *  Skips frontmatter, headings, and blank lines. */
  private async summaryOf(file: TFile): Promise<string | null> {
    try {
      const raw = await this.app.vault.cachedRead(file);
      const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
      for (const line of body.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#") || t.startsWith("---")) continue;
        const clean = t
          .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
          .replace(/\[\[([^\]]+)\]\]/g, "$1")
          .replace(/[*_`]/g, "");
        if (clean.length > 0) return clean.length > 220 ? `${clean.slice(0, 217)}…` : clean;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── Render states ─────────────────────────────────────────────────

  private eyebrow(parent: HTMLElement, label: string): void {
    parent.createEl("div", { cls: "bevia-eyebrow", text: label });
  }

  private renderNoMapYet(wrap: HTMLElement): void {
    this.eyebrow(wrap, "BEVIA");
    wrap.createEl("h3", { text: "Your map hasn't arrived in this vault yet" });
    wrap.createEl("p", {
      cls: "bevia-nav-muted",
      text:
        "When the Bevia app on this computer has read this vault, a Bevia/ folder appears " +
        "here — territory notes about your ideas, linked to the notes they grew from. " +
        "This panel then shows where the note you're reading sits.",
    });
    const btn = wrap.createEl("button", { text: "Open Bevia Home", cls: "mod-cta" });
    btn.onclick = () => void this.plugin.activateHomeView();
  }

  private renderMapOverview(wrap: HTMLElement, map: MapNote[]): void {
    this.eyebrow(wrap, "YOUR MAP");
    const counts: Partial<Record<MapKind, number>> = {};
    for (const m of map) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
    wrap.createEl("h3", { text: "The map in this vault" });
    const parts: string[] = [];
    for (const kind of ["worldview", "continent", "territory", "landmark"] as MapKind[]) {
      const n = counts[kind];
      if (n) parts.push(`${n} ${KIND_LABEL[kind].toLowerCase()}${n === 1 ? "" : "s"}`);
    }
    wrap.createEl("p", {
      cls: "bevia-nav-muted",
      text: `${parts.join(" · ")}. Open any note and this panel shows where it sits.`,
    });
    const structure = GRAPH_RECIPES.find((r) => r.key === "structure");
    if (structure) {
      const btn = wrap.createEl("button", { text: "See the shape (graph view)" });
      btn.onclick = () => void applyGraphRecipe(this.plugin, structure.key);
    }
  }

  private async renderMapPlace(
    wrap: HTMLElement,
    file: TFile,
    kind: MapKind,
    map: MapNote[],
  ): Promise<void> {
    this.eyebrow(wrap, KIND_LABEL[kind].toUpperCase());
    wrap.createEl("h3", { text: file.basename });

    const summary = await this.summaryOf(file);
    if (summary) wrap.createEl("p", { text: summary });

    const { neighbors, carried } = this.linksFrom(file, map);
    const technical = this.plugin.settings.narration === "technical";
    if (carried.length > 0) {
      wrap.createEl("p", {
        cls: "bevia-nav-muted",
        text: technical
          ? `carries ${carried.length} vault note(s) as evidence links`
          : carried.length === 1
            ? "One of your notes lives here."
            : `${carried.length} of your notes live here.`,
      });
    }

    if (neighbors.length > 0) {
      wrap.createEl("h4", { text: "Connected on your map" });
      const list = wrap.createEl("ul", { cls: "bevia-nav-list" });
      for (const n of neighbors.slice(0, 8)) {
        const li = list.createEl("li");
        const a = li.createEl("a", { text: n.file.basename, href: "#" });
        a.onclick = (e) => {
          e.preventDefault();
          void this.app.workspace.getLeaf(false).openFile(n.file);
        };
        li.createSpan({ cls: "bevia-nav-kind", text: ` — ${KIND_LABEL[n.kind].toLowerCase()}` });
      }
    }

    const ask = wrap.createEl("button", { text: "Ask about this", cls: "mod-cta" });
    ask.onclick = () =>
      void this.plugin.askBevia(`What does my map say about "${file.basename}"?`);
  }

  private renderWhereYouAre(wrap: HTMLElement, file: TFile, homes: MapNote[]): void {
    this.eyebrow(wrap, "WHERE YOU ARE");
    const primary = homes.find((h) => h.kind === "territory") ?? homes[0];
    wrap.createEl("h3", { text: `This note lives in ${primary.file.basename}` });
    if (homes.length > 1) {
      const others = homes.filter((h) => h !== primary).slice(0, 3);
      wrap.createEl("p", {
        cls: "bevia-nav-muted",
        text:
          this.plugin.settings.narration === "technical"
            ? `linked from ${homes.length} map notes`
            : `It also touches ${others.map((h) => h.file.basename).join(", ")}.`,
      });
    }
    const open = wrap.createEl("button", {
      text: `Open ${KIND_LABEL[primary.kind].toLowerCase()}`,
      cls: "mod-cta",
    });
    open.onclick = () => void this.app.workspace.getLeaf(false).openFile(primary.file);

    const ask = wrap.createEl("button", { text: "Ask about this" });
    ask.onclick = () =>
      void this.plugin.askBevia(
        `What does my map say about "${primary.file.basename}" and "${file.basename}"?`,
      );
  }

  private renderNotOnMapYet(wrap: HTMLElement, file: TFile): void {
    this.eyebrow(wrap, "BEVIA");
    wrap.createEl("h3", { text: "Not on your map yet" });
    wrap.createEl("p", {
      cls: "bevia-nav-muted",
      text:
        `Your map doesn't reference "${file.basename}" yet. The engine reads and compiles ` +
        "on its own rhythm — new writing takes a little while to find its place. If this " +
        "vault isn't being read yet, send it from Bevia Home.",
    });
    const btn = wrap.createEl("button", { text: "Open Bevia Home" });
    btn.onclick = () => void this.plugin.activateHomeView();
  }
}
