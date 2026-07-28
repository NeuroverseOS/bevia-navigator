// Bevia Navigator — engine routing (the plugin's ONE network seam).
//
// The plugin talks ONLY to the Bevia engine — pairing (/pair), intake
// (/intake/capture), and ask (/query). The engine address is 127.0.0.1
// by default (engine on THIS device); a user may point it at a
// private-LAN IP (10.x / 172.16–31.x / 192.168.x) to reach the engine
// on the SAME Wi-Fi from another device (iPad/phone Obsidian).
// `sanitizeLocalHost` is the guard: only loopback or an RFC-1918 private
// range is ever accepted — never a public host — so the criterion holds as
// "your machine / your local network only, nothing leaves for the internet."
//
// Materialization is not fetched here at all: the map arrives as files
// the Bevia app writes into the vault.
//
// The routing state is a module-level snapshot fed from plugin settings
// (main.ts calls setLocalRouting on load and on every settings save), so
// every network caller consults ONE source of truth.

import { Notice, requestUrl } from "obsidian";
import { BeviaApiError, LOCAL_RECONNECT } from "./errors";

export interface LocalRoutingState {
  /** True when the "Use Bevia Local" toggle is on. */
  enabled: boolean;
  /** The local engine's port (from the desktop app's Pair a sensor screen). */
  port: number;
  /** The bearer token /pair issued to this vault. Empty = not paired. */
  token: string;
  /** The engine's address. `127.0.0.1` (default) when the engine runs on
   *  THIS device; a private-LAN IP (e.g. `192.168.1.42`) to reach the
   *  engine on the SAME Wi-Fi from another device (iPad/phone Obsidian).
   *  Only loopback + RFC-1918 private ranges are ever accepted — never a
   *  public host — so leg 2 stays "your machine / your network only,
   *  nothing leaves for the internet." */
  host?: string;
}

// Local is the ONLY mode — the plugin has no cloud path at all, so the
// seam boots enabled and main.ts keeps it that way. The flag survives in
// the type so the seam's shape is stable, not because anything turns it off.
let routing: LocalRoutingState = { enabled: true, port: 0, token: "", host: "127.0.0.1" };

/** Accept ONLY loopback or an RFC-1918 private-LAN IPv4. Returns the
 *  normalized host, or null if the input is anything else (a public IP,
 *  a domain name) — the sovereignty guard: Bevia Local only ever talks to
 *  this machine or another device on your own local network. */
export function sanitizeLocalHost(raw: string | undefined | null): string | null {
  const h = (raw ?? "").trim().toLowerCase();
  if (h === "" || h === "127.0.0.1" || h === "localhost") return "127.0.0.1";
  // Strip an accidental scheme/port/path the user may have pasted.
  const bare = h.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
  const m = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((o) => Number(o) > 255)) return null;
  if (a === 127) return "127.0.0.1";
  const isPrivate =
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168); // 192.168.0.0/16
  return isPrivate ? bare : null;
}

/** Feed the routing snapshot from settings. Called by main.ts on load and
 *  after every settings save, and by the settings tab after pairing.
 *  The host is sanitized here too, so a bad value can never widen the
 *  guard even if a stale setting slips through. */
export function setLocalRouting(next: LocalRoutingState): void {
  routing = { ...next, host: sanitizeLocalHost(next.host) ?? "127.0.0.1" };
}

/** THE routing seam. Every cloud caller checks this before building a
 *  cloud URL; true means the call must go local or refuse. */
export function isLocalMode(): boolean {
  return routing.enabled;
}

export function localRouting(): LocalRoutingState {
  return { ...routing };
}

function localBase(port?: number, host?: string): string {
  const h = sanitizeLocalHost(host ?? routing.host) ?? "127.0.0.1";
  return `http://${h}:${port ?? routing.port}`;
}

// ── Pairing ───────────────────────────────────────────────────────────

export type PairOutcome =
  | { ok: true; sensor_id: string; token: string }
  | { ok: false; message: string };

/** Human copy for the engine's /pair 403 reasons. */
const PAIR_ERROR_COPY: Record<string, string> = {
  code_expired:
    "That code expired — open Pair a sensor in the desktop app for a fresh one.",
  code_mismatch:
    "That code doesn't match — check the code on the desktop app's Pair a sensor screen and try again.",
  no_active_code:
    "No pairing window is open — open Pair a sensor in the desktop app first.",
};

/** POST /pair with the one-time code the desktop app shows. On success the
 *  engine issues this vault its own token; the caller persists it. */
export async function pairWithLocalEngine(
  port: number,
  code: string,
  name: string,
  host?: string,
): Promise<PairOutcome> {
  try {
    const res = await requestUrl({
      url: `${localBase(port, host)}/pair`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ code, name, kind: "obsidian" }),
      throw: false,
    });
    if (res.status >= 200 && res.status < 300) {
      const j = res.json as { sensor_id?: string; token?: string } | null;
      if (j?.sensor_id && j?.token) {
        return { ok: true, sensor_id: j.sensor_id, token: j.token };
      }
      return {
        ok: false,
        message: "The local engine answered in a shape this plugin doesn't recognize.",
      };
    }
    let reason = "";
    try {
      reason = (res.json as { error?: string })?.error ?? "";
    } catch {
      /* non-JSON body — status alone */
    }
    return {
      ok: false,
      message:
        PAIR_ERROR_COPY[reason] ??
        `The local engine said no (${res.status}${reason ? ` — ${reason}` : ""}).`,
    };
  } catch {
    return {
      ok: false,
      message: `Couldn't reach the local engine on port ${port}. Is the desktop app running?`,
    };
  }
}

/** POST /pair/local — codeless auto-pair for a SAME-MACHINE engine. The
 *  engine only honors this from loopback (127.0.0.1), so the plugin offers
 *  it only when the Engine address IS this device. One click, no code:
 *  same-machine trust is implied (the engine and the vault are the same
 *  machine). On success the engine issues this vault its own token, exactly
 *  like the code path. A 403 means the address points at a DIFFERENT
 *  device — that case still needs the on-screen code. */
export async function autoPairWithLocalEngine(
  port: number,
  name: string,
  host?: string,
): Promise<PairOutcome> {
  try {
    const res = await requestUrl({
      url: `${localBase(port, host)}/pair/local`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ name, kind: "obsidian" }),
      throw: false,
    });
    if (res.status >= 200 && res.status < 300) {
      const j = res.json as { sensor_id?: string; token?: string } | null;
      if (j?.sensor_id && j?.token) {
        return { ok: true, sensor_id: j.sensor_id, token: j.token };
      }
      return {
        ok: false,
        message: "The local engine answered in a shape this plugin doesn't recognize.",
      };
    }
    if (res.status === 403) {
      return {
        ok: false,
        message:
          "That engine address isn't this machine — to connect from another " +
          "device, enter the code from the desktop app's Pair a sensor screen.",
      };
    }
    let reason = "";
    try {
      reason = (res.json as { error?: string })?.error ?? "";
    } catch {
      /* non-JSON body — status alone */
    }
    return {
      ok: false,
      message: `The local engine said no (${res.status}${reason ? ` — ${reason}` : ""}).`,
    };
  } catch {
    return {
      ok: false,
      message: `Couldn't reach the local engine on port ${port}. Is the desktop app running?`,
    };
  }
}

// ── Authenticated local calls (intake + ask) ─────────────────────────

async function localPost<T>(path: string, body: unknown): Promise<T> {
  if (!routing.token) {
    throw new BeviaApiError(
      "Bevia Local isn't paired yet — open Settings → Bevia Local and connect with the code from the desktop app.",
      401,
    );
  }
  const res = await requestUrl({
    url: `${localBase()}${path}`,
    method: "POST",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${routing.token}` },
    body: JSON.stringify(body),
    throw: false,
  });
  if (res.status === 401) {
    // Pairing revoked. Say so once, loudly, and stop — never fall back
    // to the cloud.
    new Notice(LOCAL_RECONNECT, 8000);
    throw new BeviaApiError(LOCAL_RECONNECT, 401);
  }
  if (res.status >= 400) {
    let detail = "";
    try {
      detail = (res.json as { error?: string })?.error ?? "";
    } catch {
      detail = res.text?.slice(0, 200) ?? "";
    }
    throw new BeviaApiError(
      `Bevia Local ${path} returned ${res.status}${detail ? ` — ${detail}` : ""}`,
      res.status,
    );
  }
  return res.json as T;
}

/** One conversation turn, per the engine's capture contract
 *  (capture-normalizer.ts CaptureTurn). */
export interface LocalCaptureTurn {
  speaker?: string;
  text?: string;
  emitted_at?: string;
}

/** The `capture` payload the engine's validateCaptureBody accepts:
 *  conversation (non-empty) + thread_id (non-empty) required;
 *  source_platform / source_url / captured_at / source_kind optional. */
export interface LocalCapturePayload {
  conversation: LocalCaptureTurn[];
  source_platform?: string;
  source_url?: string;
  captured_at?: string;
  thread_id: string;
  source_kind?: string;
}

export interface LocalCaptureResult {
  written: number;
  skipped: number;
  item_errors: string[];
}

/** POST /intake/capture — the engine normalizes + Pass-0-writes; it stamps
 *  source refs itself (source_ref = `${thread_id}::turn::${i}`), so a
 *  stable thread_id makes re-sends dedupe for free. */
export async function postLocalCapture(
  capture: LocalCapturePayload,
): Promise<LocalCaptureResult> {
  return localPost<LocalCaptureResult>("/intake/capture", { capture });
}

/** One grounded citation from the local /query (query-core
 *  AnswerEvidenceRow). similarity is an ordering signal, never a verdict. */
export interface LocalQueryEvidence {
  theme_id: string;
  label: string;
  summary: string;
  similarity: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  recurrence_count: number;
}

/** The local ask answer (query-core AnswerQueryResult). degraded=true
 *  means no AI narration ran — librarian carries the deterministic
 *  grounded readout and consultant is empty. Render it as-is; never
 *  pretend it was narrated. */
export interface LocalQueryAnswer {
  ok: boolean;
  question: string;
  librarian: string;
  consultant: string;
  method: "embedding" | "keyword" | string;
  degraded: boolean;
  evidence: LocalQueryEvidence[];
  error?: string;
}

/** POST /query — ask the local map a question. The engine allows kind
 *  'obsidian' on this route by design (the Experience Plane may Explore). */
export async function postLocalQuery(question: string): Promise<LocalQueryAnswer> {
  return localPost<LocalQueryAnswer>("/query", { question });
}

/** The live link state between this vault and the engine — the honest
 *  answer to "am I actually connected?", not "do I have a token?". */
export type LocalLinkState =
  | "linked" // the engine recognizes this vault's token right now
  | "rejected" // a token exists but the engine no longer accepts it (re-pair)
  | "unreachable" // the engine isn't answering (app not running / wrong port)
  | "unpaired"; // no token stored

/** GET /whoami with the stored token — the engine authenticates it and
 *  400s/401s if it no longer recognizes this vault (revoked, or the
 *  engine's data dir was wiped and re-created). Lets the settings tab
 *  render the TRUE link state instead of trusting a stored token that may
 *  be dead — the exact "says paired in Obsidian but the desktop app
 *  disagrees" gap. Cheap: the engine just authenticates and returns
 *  display fields, no substrate work. */
export async function checkLocalLink(): Promise<LocalLinkState> {
  if (!routing.token) return "unpaired";
  try {
    const res = await requestUrl({
      url: `${localBase()}/whoami`,
      method: "GET",
      headers: { Authorization: `Bearer ${routing.token}` },
      throw: false,
    });
    if (res.status >= 200 && res.status < 300) return "linked";
    if (res.status === 401) return "rejected";
    // Any other status (the engine answered but oddly) — treat as reachable
    // but not linked, which reads the same as "re-pair" to the user.
    return "rejected";
  } catch {
    return "unreachable";
  }
}
