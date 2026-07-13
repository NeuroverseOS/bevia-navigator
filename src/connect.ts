// Bevia — Connect a vault (post-subscribe authorization).
//
// Design: design/v27-observatory/funnel2.jsx (BVConnect) + funnel-content.js.
// States: notConnected (paste token) → verifying → connected | error.
// The deeplink state is reached when a bevia.co → obsidian:// handoff drops
// the token in without a paste.
//
// Verification is real: it calls /materialization-pull with limit 1 using the
// pasted token. A 2xx means the bvex_mcp_ token resolves to a user → connected;
// anything else → error. On success the token is saved and the Living Atlas
// sync loop starts immediately.

import { Modal, Notice, requestUrl } from "obsidian";
import { isLocalMode } from "./local";
import type BeviaNavigatorPlugin from "./main";
import { v27Root, aperture, mono, serif, text, button } from "./v27";
import { openVaultWritePreview } from "./first-run";

const SVG_NS = "http://www.w3.org/2000/svg";
type CState = "notConnected" | "verifying" | "connected" | "error" | "deeplink";

export function openConnectModal(
  plugin: BeviaNavigatorPlugin,
  initial: CState = "notConnected",
  /** Token handed in by the obsidian://bevia-connect deeplink. Verified
   *  exactly like a paste — saved only after the server accepts it. */
  deeplinkToken?: string,
): void {
  new ConnectModal(plugin, initial, deeplinkToken).open();
}

class ConnectModal extends Modal {
  private state: CState;
  private pasted = "";
  /** True when the token arrived via deeplink — success renders the
   *  "one click from bevia.co" copy instead of the paste copy. */
  private fromDeeplink = false;
  /** Why the last verify failed — drives honest error copy (a server
   *  outage must not read as "your token expired"). */
  private failure: "unreachable" | "rejected" = "rejected";
  private failureDetail = "";

  constructor(private plugin: BeviaNavigatorPlugin, initial: CState, deeplinkToken?: string) {
    super(plugin.app);
    this.state = initial;
    // Deliberately NO prefill of the existing token: the connect input
    // renders as plain text while typing, and echoing the current
    // secret on open leaks it to screen shares.
    if (deeplinkToken?.trim()) {
      this.pasted = deeplinkToken.trim();
      this.fromDeeplink = true;
    }
  }

  onOpen(): void {
    this.modalEl.addClass("bevia-discovery-modal");
    this.render();
    // Deeplink handoff — verify immediately; no paste step.
    if (this.fromDeeplink && this.state === "notConnected") {
      void this.verify();
    }
  }
  onClose(): void {
    this.contentEl.empty();
    // First-sync preview, SEQUENCED after this modal closes (audit P4)
    // instead of stacking on top of the "connected" card: if the vault
    // just connected and the user hasn't yet acknowledged what Bevia
    // writes & where, show the one-screen preview now.
    const s = this.plugin.settings;
    if (s.token.trim() && s.syncAtlas && !s.firstSyncAck) {
      openVaultWritePreview(this.plugin, { gateSync: true });
    }
  }

  private statusMark(parent: HTMLElement): void {
    const wrap = parent.createDiv();
    wrap.addClass("bv-u-display-flex");
    wrap.addClass("bv-u-justify-content-center");
    wrap.addClass("bv-u-margin-bottom-18px");

    if (this.state === "verifying") {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", "44"); svg.setAttribute("height", "44"); svg.setAttribute("viewBox", "0 0 44 44");
      svg.addClass("bv-spin"); svg.addClass("bv-u-display-block");
      const base = document.createElementNS(SVG_NS, "circle");
      base.setAttribute("cx", "22"); base.setAttribute("cy", "22"); base.setAttribute("r", "20");
      base.setAttribute("fill", "none"); base.setAttribute("stroke", "var(--bv-rule)"); base.setAttribute("stroke-width", "1.4");
      svg.appendChild(base);
      const arc = document.createElementNS(SVG_NS, "circle");
      arc.setAttribute("cx", "22"); arc.setAttribute("cy", "22"); arc.setAttribute("r", "20");
      arc.setAttribute("fill", "none"); arc.setAttribute("stroke", "var(--bv-strengthening-dot)");
      arc.setAttribute("stroke-width", "1.8"); arc.setAttribute("stroke-linecap", "round"); arc.setAttribute("stroke-dasharray", "22 110");
      svg.appendChild(arc);
      wrap.appendChild(svg);
      return;
    }
    if (this.state === "connected" || this.state === "deeplink") {
      const rel = wrap.createDiv();
      rel.addClass("bv-u-position-relative");
      aperture(rel, { size: 44, stroke: 1.3, color: "var(--bv-strengthening-dot)" });
      const pulse = rel.createSpan({ cls: "bv-pulse" });
      pulse.addClass("bv-u-position-absolute"); pulse.addClass("bv-u-inset-6px"); pulse.addClass("bv-u-border-radius-50");
      pulse.addClass("bv-u-border-1px-solid-bv-strengthening-rail");
      return;
    }
    if (this.state === "error") {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", "44"); svg.setAttribute("height", "44"); svg.setAttribute("viewBox", "0 0 44 44"); svg.addClass("bv-u-display-block");
      const ring = document.createElementNS(SVG_NS, "circle");
      ring.setAttribute("cx", "22"); ring.setAttribute("cy", "22"); ring.setAttribute("r", "20");
      ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "var(--bv-anomaly-rail)"); ring.setAttribute("stroke-width", "1.4");
      svg.appendChild(ring);
      const bar = document.createElementNS(SVG_NS, "path");
      bar.setAttribute("d", "M22 13v12"); bar.setAttribute("stroke", "var(--bv-anomaly-dot)"); bar.setAttribute("stroke-width", "2"); bar.setAttribute("stroke-linecap", "round");
      svg.appendChild(bar);
      const dotp = document.createElementNS(SVG_NS, "circle");
      dotp.setAttribute("cx", "22"); dotp.setAttribute("cy", "30"); dotp.setAttribute("r", "1.4"); dotp.setAttribute("fill", "var(--bv-anomaly-dot)");
      svg.appendChild(dotp);
      wrap.appendChild(svg);
      return;
    }
    // not connected — ghost dashed ring
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "44"); svg.setAttribute("height", "44"); svg.setAttribute("viewBox", "0 0 44 44"); svg.addClass("bv-u-display-block");
    const ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("cx", "22"); ring.setAttribute("cy", "22"); ring.setAttribute("r", "20");
    ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "var(--bv-ink-ghost)"); ring.setAttribute("stroke-width", "1.3"); ring.setAttribute("stroke-dasharray", "3 4");
    svg.appendChild(ring);
    wrap.appendChild(svg);
  }

  private copy(): { eyebrow: string; title: string; sub: string } {
    switch (this.state) {
      case "verifying": return { eyebrow: "Verifying", title: "Checking the token…", sub: "One moment while Bevia confirms this vault." };
      case "connected": return { eyebrow: "Connected", title: "This vault is connected.", sub: "Your Atlas will appear in this vault as territories form. Nothing to watch — it arrives on its own." };
      case "deeplink": return { eyebrow: "One click from bevia.co", title: "Return to Obsidian — you're connected.", sub: "Bevia handed the token straight to your plugin. No copy, no paste." };
      case "error":
        if (this.failure === "unreachable") {
          return {
            eyebrow: "Couldn't reach Bevia",
            title: "Bevia is out of reach right now.",
            sub: "Your token wasn't the problem — the connection was. Check your internet and try again in a minute.",
          };
        }
        return {
          eyebrow: "Couldn't connect",
          title: "That token didn't take.",
          sub: this.failureDetail
            ? `Bevia said: "${this.failureDetail}" Generate a fresh access key at bevia.co and paste it here.`
            : "It may have expired or been copied incompletely. Generate a fresh one at bevia.co and paste it again.",
        };
      default: return { eyebrow: "Connect Obsidian", title: "Connect this vault to Bevia.", sub: "Paste the token from bevia.co to let your Living Atlas sync into this vault." };
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const root = v27Root(contentEl);
    root.addClass("bv-wrap");
    const card = root.createDiv({ cls: "bv-card" });
    card.addClass("bv-u-width-380px");
    card.addClass("bv-u-max-width-100");
    card.addClass("bv-u-margin-0-auto");
    card.addClass("bv-u-padding-30px-28px-26px");
    card.addClass("bv-u-text-align-center");

    this.statusMark(card);
    const c = this.copy();
    const eyebrowColor = this.state === "error" ? "var(--bv-anomaly-ink)"
      : (this.state === "connected" || this.state === "deeplink") ? "var(--bv-strengthening-ink)"
      : "var(--bv-ink-faint)";
    mono(card, c.eyebrow, { size: 9, track: 0.16, color: eyebrowColor, block: true }).addClass("bv-u-margin-bottom-12px");
    serif(card, c.title, { size: 21, weight: 400, lh: 1.22 }).addClass("bv-u-margin-bottom-11px");
    const sub = text(card, c.sub, { size: 12.5, color: "var(--bv-ink-soft)", lh: 1.55, maxWidth: 300 });
    sub.addClass("bv-u-margin-0-auto-22px");

    if (this.state === "notConnected") {
      const fieldLabel = mono(card, "Paste your token", { size: 8.5, track: 0.14, dim: true, block: true });
      fieldLabel.addClass("bv-u-text-align-left"); fieldLabel.addClass("bv-u-margin-bottom-8px");
      // type=password: the token is a secret; never echo it on screen.
      const input = card.createEl("input", { type: "password", value: this.pasted });
      input.placeholder = "bvma_••••••••••••••••";
      input.addClass("bv-u-width-100");
      input.addClass("bv-u-box-sizing-border-box");
      input.addClass("bv-u-padding-12px-13px");
      input.addClass("bv-u-border-radius-6px");
      input.addClass("bv-u-border-1px-solid-bv-rule");
      input.addClass("bv-u-background-bv-panel-sunk");
      input.addClass("bv-u-font-family-bv-mono");
      input.addClass("bv-u-font-size-13px");
      input.addClass("bv-u-color-bv-ink");
      input.addClass("bv-u-margin-bottom-13px");
      input.oninput = () => { this.pasted = input.value.trim(); };
      const cta = button(card, "Connect Obsidian", { full: true, onClick: () => void this.verify() });
      cta.addClass("bv-u-margin-bottom-13px");
      mono(card, "Find your token at bevia.co → Account → Connect a vault.", { size: 9, track: 0.04, dim: true, block: true });
    } else if (this.state === "error") {
      button(card, "Try another token", { full: true, onClick: () => { this.state = "notConnected"; this.render(); } });
    } else if (this.state === "connected" || this.state === "deeplink") {
      const chip = card.createDiv();
      chip.addClass("bv-u-display-flex"); chip.addClass("bv-u-align-items-center"); chip.addClass("bv-u-justify-content-center");
      chip.addClass("bv-u-gap-8px"); chip.addClass("bv-u-padding-11px-14px"); chip.addClass("bv-u-border-radius-8px");
      chip.addClass("bv-u-background-bv-strengthening-tint"); chip.addClass("bv-u-border-1px-solid-bv-strengthening-rail");
      aperture(chip, { size: 12, stroke: 1.2, color: "var(--bv-strengthening-dot)" });
      const email = this.plugin.settings.connectedEmail;
      const meta = this.state === "deeplink"
        ? "Opened from bevia.co · vault authorized"
        : `Connected${email ? ` as ${email}` : ""} · Full Atlas`;
      mono(chip, meta, { size: 9, track: 0.05, color: "var(--bv-strengthening-ink)" });
    }
  }

  private async verify(): Promise<void> {
    // Bevia Local (leg 2): verifying a cloud token is a cloud call, and no
    // request may leave for a cloud host while Local mode is on.
    if (isLocalMode()) {
      new Notice(
        "Bevia Local is on — this vault talks only to your local engine. Turn off Bevia Local in settings to connect a cloud account.",
        8000,
      );
      return;
    }
    const token = this.pasted.trim();
    if (!token) { new Notice("Paste your token first."); return; }
    this.state = "verifying";
    this.render();
    const baseUrl = this.plugin.settings.baseUrl?.replace(/\/+$/, "");
    try {
      const res = await requestUrl({
        url: `${baseUrl}/functions/v1/materialization-pull`,
        method: "POST",
        contentType: "application/json",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ limit: 1 }),
        throw: false,
      });
      if (res.status >= 200 && res.status < 300) {
        this.plugin.settings.token = token;
        await this.plugin.saveSettings();
        this.plugin.restartAtlasSync();
        this.state = this.fromDeeplink ? "deeplink" : "connected";
        this.render();
        return;
      }
      // Honest failure split: only an auth status means the TOKEN was
      // the problem. A 5xx/edge failure is Bevia's problem, and telling
      // the user their token "expired" sends them minting keys for
      // nothing. Surface the server's own reason when it gives one
      // (revoked / expired / capture-scoped-to-extension).
      if (res.status === 401 || res.status === 403) {
        this.failure = "rejected";
        try {
          const body = res.json as Record<string, unknown> | null;
          this.failureDetail = body && typeof body.error === "string" ? body.error : "";
        } catch { this.failureDetail = ""; }
      } else {
        this.failure = "unreachable";
        this.failureDetail = "";
      }
    } catch {
      this.failure = "unreachable";
      this.failureDetail = "";
    }
    this.state = "error";
    this.render();
  }
}
