// Bevia — graph recipes (preset color-group sets for Obsidian's graph view).
//
// Obsidian's graph can color nodes by "Groups" — each a search query + a color
// — but it only holds ONE colorGroups array (one active coloring) and has no
// native saved presets. So a "recipe" is a SET of groups the user applies on
// demand; applying one replaces the color groups with that recipe's set.
//
// The recipes read the six human axes Bevia writes onto every note
// (shared/materialization/human-axes.ts): Origin / Activity / Kind. The user
// picks the lens; the graph re-reads itself along it.
//
// Sovereignty note: Bevia's AUTOMATIC materialization only ever writes under
// Bevia/. This is different — a command the USER explicitly runs to set up their
// own graph view. It edits .obsidian/graph.json (Obsidian config, not notes),
// preserves every other graph setting, and only ever touches colorGroups.
// Obsidian reads graph.json when the graph opens, so the user reopens the graph
// (or toggles it) to see the new colors.

import { Notice } from "obsidian";
import type BeviaNavigatorPlugin from "./main";

interface ColorGroup {
  query: string;
  color: { a: number; rgb: number };
}

export interface GraphRecipe {
  key: string;
  label: string;
  desc: string;
  /** Optional graph search filter — limits which nodes appear. Empty/absent
   *  shows the whole map. Used by the skeleton view to hide landmark events. */
  search?: string;
  groups: ColorGroup[];
}

const c = (rgb: number): { a: number; rgb: number } => ({ a: 1, rgb });

// The three lenses. Queries match the plain-English tags the materializers
// stamp; colors are chosen to read at a glance (warm = self/active, cool =
// AI/structure, grey = quiet).
export const GRAPH_RECIPES: GraphRecipe[] = [
  {
    // The "see the shape of my thinking" view. Filters the graph down to the
    // cartographic skeleton — worldviews, continents, territories — and hides
    // the landmark events that otherwise flood the global graph into a cloud.
    // Links between the shown nodes (worldview→continent→territory) remain, so
    // the hierarchy reads cleanly. Colored by kind so the three altitudes are
    // distinct at a glance.
    key: "structure",
    label: "Structure only (the shape)",
    desc: "Just the skeleton of your thinking — worldviews, continents, and territories, connected. Hides the landmark events so the map reads as regions, not a cloud. The best 'see my whole mind' view.",
    search: "tag:#worldview OR tag:#continent OR tag:#territory",
    groups: [
      { query: "tag:#worldview", color: c(0x9b59b6) },  // purple
      { query: "tag:#continent", color: c(0x1abc9c) },  // teal
      { query: "tag:#territory", color: c(0x3498db) },  // blue
    ],
  },
  {
    key: "origin",
    label: "Color by origin",
    desc: "Where the thinking came from — your own, built with AI, or from what you read.",
    search: "",
    groups: [
      { query: "tag:#built-with-ai", color: c(0x4c8dff) }, // blue
      { query: "tag:#my-thinking", color: c(0x35c46b) },   // green
      { query: "tag:#from-reading", color: c(0xe0a93b) },  // amber
    ],
  },
  {
    key: "activity",
    label: "Color by activity",
    desc: "How alive each part of the map is right now — active, quiet, or dormant.",
    search: "",
    groups: [
      { query: "tag:#active", color: c(0x2ecc71) },  // bright green
      { query: "tag:#quiet", color: c(0x9aa0a6) },   // grey
      { query: "tag:#dormant", color: c(0x4a4f55) }, // faint
    ],
  },
  {
    key: "kind",
    label: "Color by kind",
    desc: "What each node is — worldview, continent, territory, behavior, or idea.",
    search: "",
    groups: [
      { query: "tag:#worldview", color: c(0x9b59b6) },  // purple
      { query: "tag:#continent", color: c(0x1abc9c) },  // teal
      { query: "tag:#territory", color: c(0x3498db) },  // blue
      { query: "tag:#behavior", color: c(0xe05780) },   // rose
      { query: "tag:#idea", color: c(0xe0a93b) },       // amber
    ],
  },
];

const GRAPH_CONFIG_PATH = ".obsidian/graph.json";

/** Apply one recipe: set the graph's colorGroups to that recipe's set,
 *  preserving every other graph setting. Idempotent. */
export async function applyGraphRecipe(
  plugin: BeviaNavigatorPlugin,
  recipeKey: string,
): Promise<void> {
  const recipe = GRAPH_RECIPES.find((r) => r.key === recipeKey);
  if (!recipe) {
    new Notice(`Bevia: unknown graph recipe "${recipeKey}".`);
    return;
  }
  // Deliberate vault.adapter exception (audit ST3): graph.json lives in
  // .obsidian/, which is app config — the Vault API only handles vault
  // content (TFile/TFolder), so the adapter is the supported way here.
  const adapter = plugin.app.vault.adapter;

  let config: Record<string, unknown> = {};
  try {
    if (await adapter.exists(GRAPH_CONFIG_PATH)) {
      const raw = await adapter.read(GRAPH_CONFIG_PATH);
      config = JSON.parse(raw) as Record<string, unknown>;
    }
  } catch {
    // Corrupt or unreadable graph.json — start from a minimal config rather
    // than clobbering blindly. Obsidian fills in the rest of its defaults.
    config = {};
  }

  config.colorGroups = recipe.groups;
  // The filter — skeleton view sets it to the structure tags; the color-only
  // recipes clear it so they show the whole map. Switching recipes always
  // produces a clean, complete view rather than compounding filters.
  config.search = recipe.search ?? "";

  try {
    await adapter.write(GRAPH_CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    new Notice(`Bevia: couldn't update the graph view (${(e as Error).message}).`);
    return;
  }
  new Notice(`Bevia: graph is now ${recipe.label.toLowerCase()}. Reopen the graph to see it.`);
}
