// Bevia markdown post-processor.
//
// Decorates Lens output (anything Bevia writes into the vault under
// /Bevia/*). Two passes:
//
//   1. **Provenance chips on contributor labels.** When the Lens
//      render emits a line like `**RegardsKiki2** (principal)`, we
//      wrap the second parenthetical with a colored chip so the
//      user can see at a glance whether a contributor is a person,
//      an AI, or unresolved.
//
//   2. **Territory cross-link rewriting.** When the Lens render
//      emits `[[Bevia:Territory:<Name>]]`, we rewrite it to point at
//      the vault file at `/Bevia/Territories/<Name>.md` so the
//      Obsidian backlink graph picks it up. The Bevia: scheme keeps
//      the user's own wikilinks distinct from Bevia-emitted ones.
//
// Pure projection — never modifies the file's content on disk. The
// post-processor runs in render and the changes only affect what
// the user sees in preview mode.
//
// Scope: only fires on files whose path starts with `Bevia/`. The
// user's own notes are not touched — Source rule.

import type { MarkdownPostProcessorContext } from "obsidian";

const TERRITORY_LINK_RE = /\[\[Bevia:Territory:([^\]]+)\]\]/g;

/** Recognized contributor kinds, mirroring api.ts EntityKind. */
const KIND_TO_CLASS: Record<string, string> = {
  principal: "bevia-kind-principal",
  human: "bevia-kind-human",
  ai: "bevia-kind-ai",
  bot: "bevia-kind-organization",
  organization: "bevia-kind-organization",
  project: "bevia-kind-organization",
  unknown: "bevia-kind-unknown",
};

const KIND_NAMES = new Set(Object.keys(KIND_TO_CLASS));

export function beviaLinkifier(
  element: HTMLElement,
  ctx: MarkdownPostProcessorContext,
): void {
  // Source rule: only decorate Lens output files. The user's own
  // notes — even if they happen to write [[Bevia:Territory:X]] —
  // get the territory rewrite (it's their wikilink, they asked for
  // it), but provenance chip detection is restricted to Bevia-owned
  // paths to avoid false-positive decorating of "(human)" or "(ai)"
  // in arbitrary user prose.
  const path = ctx.sourcePath ?? "";
  const isBeviaOwned = path.startsWith("Bevia/");

  rewriteTerritoryLinks(element);
  if (isBeviaOwned) {
    decorateContributorKinds(element);
  }
}

/** Rewrites `[[Bevia:Territory:X]]` into `[[Bevia/Territories/X]]`
 *  so Obsidian resolves it to the vault file the materializer will
 *  write. Safe to run on user prose — the Bevia: scheme is
 *  Bevia-emitted by convention; if a user happens to type the same
 *  pattern, they explicitly asked for that link. */
function rewriteTerritoryLinks(element: HTMLElement): void {
  // Obsidian renders `[[X]]` as <a class="internal-link"> by the
  // time we see the DOM. The Bevia:Territory:X form arrives as
  // a literal text node inside paragraphs. Walk text nodes and
  // replace.
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null = walker.nextNode();
  while (node !== null) {
    textNodes.push(node as Text);
    node = walker.nextNode();
  }
  for (const text of textNodes) {
    const original = text.textContent ?? "";
    if (!TERRITORY_LINK_RE.test(original)) continue;
    TERRITORY_LINK_RE.lastIndex = 0;
    const replacement = original.replace(TERRITORY_LINK_RE, (_, name) => {
      const safe = String(name).trim();
      return `[[Bevia/Territories/${safe}|${safe}]]`;
    });
    text.textContent = replacement;
    TERRITORY_LINK_RE.lastIndex = 0;
  }
}

/** Finds patterns like `(principal)` / `(ai)` / `(human)` / `(bot)`
 *  immediately following a strong or em element (the contributor
 *  name), and wraps them in a colored chip. */
function decorateContributorKinds(element: HTMLElement): void {
  const anchors = element.querySelectorAll<HTMLElement>("strong, em");
  for (const anchor of Array.from(anchors)) {
    const next = anchor.nextSibling;
    if (!next || next.nodeType !== Node.TEXT_NODE) continue;
    const text = next.textContent ?? "";
    const match = text.match(/^\s*\(([a-z_]+)\)/);
    if (!match) continue;
    const kind = match[1];
    if (!KIND_NAMES.has(kind)) continue;
    const cls = KIND_TO_CLASS[kind] ?? "bevia-kind-unknown";

    // Replace the leading "(kind)" with a span chip; keep the rest
    // of the text node intact.
    const remainder = text.slice(match[0].length);
    const chip = document.createElement("span");
    chip.className = `bevia-contributor ${cls}`;
    const kindSpan = document.createElement("span");
    kindSpan.className = "bevia-contributor-kind";
    kindSpan.textContent = kind;
    chip.appendChild(kindSpan);
    next.textContent = remainder;
    anchor.parentNode?.insertBefore(chip, next);
  }
}
