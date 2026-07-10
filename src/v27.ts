// Bevia — v27 "Observatory" atoms, ported to vanilla DOM.
//
// The design system (design/v27-observatory/atoms.jsx + funnel.jsx) is React;
// the Obsidian plugin builds DOM directly. This module is the faithful DOM
// translation of the shared primitives the funnel surfaces compose from —
// aperture, mono label, serif finding, body text, buttons, territory card,
// and the slow "reading" aperture (motion, never a progress bar).
//
// Color comes from CSS custom properties defined in styles.css (.bevia-v27),
// so light/dark follow Obsidian's theme automatically. Sizes that vary per
// usage are set inline, mirroring the JSX.

const SVG_NS = "http://www.w3.org/2000/svg";

export type BvState =
  | "strengthening"
  | "emergence"
  | "recurring"
  | "anomaly"
  | "unverified";

function stateVar(state: BvState, slot: "dot" | "ink" | "tint" | "rail"): string {
  return `var(--bv-${state}-${slot})`;
}

/** Root wrapper that scopes the v27 token layer. Everything funnel renders
 *  inside one of these. */
export function v27Root(parent: HTMLElement): HTMLElement {
  const root = parent.createDiv({ cls: "bevia-v27" });
  return root;
}

/** The observatory aperture: a thin ring + center pip. */
export function aperture(
  parent: HTMLElement,
  opts: { size?: number; stroke?: number; color?: string; pip?: boolean; state?: BvState; cls?: string } = {},
): SVGSVGElement {
  const size = opts.size ?? 18;
  const stroke = opts.stroke ?? 1.4;
  const color = opts.color ?? "var(--bv-ink-soft)";
  const pip = opts.pip ?? true;
  const pipColor = opts.state ? stateVar(opts.state, "dot") : color;
  const r = (size - stroke) / 2;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.addClass("bv-aperture");
  if (opts.cls) svg.addClass(opts.cls);

  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("cx", String(size / 2));
  ring.setAttribute("cy", String(size / 2));
  ring.setAttribute("r", String(r));
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", color);
  ring.setAttribute("stroke-width", String(stroke));
  ring.setAttribute("opacity", "0.85");
  svg.appendChild(ring);

  if (pip) {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", String(size / 2));
    dot.setAttribute("cy", String(size / 2));
    dot.setAttribute("r", String(Math.max(1, size * 0.11)));
    dot.setAttribute("fill", pipColor);
    svg.appendChild(dot);
  }
  parent.appendChild(svg);
  return svg;
}

/** Mono instrument label (uppercase, letterspaced). */
export function mono(
  parent: HTMLElement,
  textStr: string,
  opts: { size?: number; track?: number; dim?: boolean; color?: string; block?: boolean } = {},
): HTMLElement {
  const cls = ["bv-mono"];
  if (opts.dim) cls.push("bv-dim");
  if (opts.block) cls.push("bv-block");
  const span = parent.createSpan({ cls: cls.join(" "), text: textStr });
  // Genuinely dynamic per-call values stay inline (audit ST2).
  span.style.fontSize = `${opts.size ?? 10.5}px`;
  span.style.letterSpacing = `${opts.track ?? 0.14}em`;
  if (opts.color) span.style.color = opts.color;
  return span;
}

/** Serif finding text. */
export function serif(
  parent: HTMLElement,
  textStr: string,
  opts: { size?: number; weight?: number; italic?: boolean; color?: string; lh?: number } = {},
): HTMLElement {
  const div = parent.createDiv({ cls: opts.italic ? "bv-serif bv-italic" : "bv-serif", text: textStr });
  div.style.fontSize = `${opts.size ?? 17}px`;
  if (opts.weight) div.style.fontWeight = String(opts.weight);
  if (opts.color) div.style.color = opts.color;
  div.style.lineHeight = String(opts.lh ?? 1.32);
  return div;
}

/** Small sans body line. */
export function text(
  parent: HTMLElement,
  textStr: string,
  opts: { size?: number; color?: string; lh?: number; maxWidth?: number } = {},
): HTMLElement {
  const div = parent.createDiv({ cls: "bv-text", text: textStr });
  div.style.fontSize = `${opts.size ?? 12.5}px`;
  if (opts.color) div.style.color = opts.color;
  div.style.lineHeight = String(opts.lh ?? 1.45);
  if (opts.maxWidth) div.style.maxWidth = `${opts.maxWidth}px`;
  return div;
}

/** Primary / ghost / bare buttons. */
export function button(
  parent: HTMLElement,
  label: string,
  opts: { kind?: "primary" | "ghost" | "bare"; full?: boolean; onClick?: () => void } = {},
): HTMLButtonElement {
  const kind = opts.kind ?? "primary";
  const cls =
    kind === "bare" ? "bv-btn-bare" : kind === "ghost" ? "bv-btn bv-ghost" : "bv-btn";
  const btn = parent.createEl("button", { cls, text: label });
  if (opts.full) btn.addClass("bv-full");
  if (opts.onClick) btn.onclick = opts.onClick;
  return btn;
}

/** A territory card: mono anchor + serif finding, left state rail. */
export function territoryCard(
  parent: HTMLElement,
  terr: { name: string; finding?: string; size?: string; state?: BvState },
  opts: { compact?: boolean; muted?: boolean } = {},
): HTMLElement {
  const st = terr.state ?? "strengthening";
  const cls = ["bv-terr", `bv-st-${st}`];
  if (opts.compact) cls.push("bv-compact");
  if (opts.muted) cls.push("bv-muted");
  const card = parent.createDiv({ cls: cls.join(" ") });

  aperture(card, {
    size: opts.compact ? 15 : 17,
    stroke: 1.3,
    color: opts.muted ? "var(--bv-ink-faint)" : stateVar(st, "dot"),
  });

  const body = card.createDiv({ cls: "bv-terr-body" });
  const head = body.createDiv({ cls: "bv-terr-head" });
  head.createSpan({ cls: "bv-terr-name", text: terr.name });
  if (terr.size) head.createSpan({ cls: "bv-terr-size", text: terr.size });
  if (!opts.compact && terr.finding) {
    body.createDiv({ cls: "bv-terr-finding", text: terr.finding });
  }
  return card;
}

/** The slow-rotating "reading" aperture — motion, never a progress bar. */
export function readingAperture(parent: HTMLElement, size = 72): HTMLElement {
  const wrap = parent.createDiv({ cls: "bv-reading" });
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;

  wrap.createDiv({ cls: "bv-reading-glow" });

  const r1 = size / 2 - 2;
  const r2 = size / 2 - 11;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.addClass("bv-spin");
  svg.addClass("bv-reading-svg");

  const base = document.createElementNS(SVG_NS, "circle");
  base.setAttribute("cx", String(size / 2));
  base.setAttribute("cy", String(size / 2));
  base.setAttribute("r", String(r1));
  base.setAttribute("fill", "none");
  base.setAttribute("stroke", "var(--bv-rule)");
  base.setAttribute("stroke-width", "1");
  svg.appendChild(base);

  const arc = document.createElementNS(SVG_NS, "circle");
  arc.setAttribute("cx", String(size / 2));
  arc.setAttribute("cy", String(size / 2));
  arc.setAttribute("r", String(r1));
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke", "var(--bv-strengthening-dot)");
  arc.setAttribute("stroke-width", "1.6");
  arc.setAttribute("stroke-linecap", "round");
  arc.setAttribute("stroke-dasharray", `${r1 * 1.1} ${r1 * 6}`);
  svg.appendChild(arc);

  const inner = document.createElementNS(SVG_NS, "circle");
  inner.setAttribute("cx", String(size / 2));
  inner.setAttribute("cy", String(size / 2));
  inner.setAttribute("r", String(r2));
  inner.setAttribute("fill", "none");
  inner.setAttribute("stroke", "var(--bv-strengthening-rail)");
  inner.setAttribute("stroke-width", "1");
  inner.setAttribute("stroke-dasharray", `${r2 * 0.6} ${r2 * 3}`);
  inner.addClass("bv-spin-rev");
  svg.appendChild(inner);
  wrap.appendChild(svg);

  const pipWrap = wrap.createDiv({ cls: "bv-reading-pipwrap" });
  const pip = pipWrap.createSpan({ cls: "bv-reading-pip" });
  pip.style.width = `${size * 0.13}px`;
  pip.style.height = `${size * 0.13}px`;

  return wrap;
}

/** A filled state dot. */
export function dot(parent: HTMLElement, state: BvState, size = 7): HTMLElement {
  const span = parent.createSpan({ cls: "bv-dot" });
  span.style.width = `${size}px`;
  span.style.height = `${size}px`;
  span.style.background = stateVar(state, "dot");
  return span;
}
