// Bevia Navigator — Bevia Local routing (pass/fail matrix leg 2).
//
// When Bevia Local is on, this plugin talks ONLY to the local engine at
// http://127.0.0.1:<port> — pairing (/pair), intake (/intake/capture),
// and ask (/query). Everything else the plugin knows how to do against
// the cloud is refused with the typed LocalModeUnavailableError so the
// user sees one honest line ("Not in Bevia Local yet.") instead of a
// request quietly leaving the machine. There is NO silent cloud fallback
// anywhere on this path — leg 2's criterion is zero requests to any
// non-127.0.0.1 host while Local mode is on.
//
// Materialization is not fetched here at all: in Local mode the map
// arrives as files the desktop app writes into the vault.
//
// The routing state is a module-level snapshot fed from plugin settings
// (main.ts calls setLocalRouting on load and on every settings save), so
// every network caller — api.ts and the standalone requestUrl sites —
// consults ONE source of truth instead of each call site re-deriving it
// from a config object that might have been built without the flag.

import { Notice, requestUrl } from "obsidian";
import { BeviaApiError, LOCAL_RECONNECT } from "./errors";

export interface LocalRoutingState {
  /** True when the "Use Bevia Local" toggle is on. */
  enabled: boolean;
  /** The local engine's port (from the desktop app's Pair a sensor screen). */
  port: number;
  /** The bearer token /pair issued to this vault. Empty = not paired. */
  token: string;
}

let routing: LocalRoutingState = { enabled: false, port: 0, token: "" };

/** Feed the routing snapshot from settings. Called by main.ts on load and
 *  after every settings save, and by the settings tab after pairing. */
export function setLocalRouting(next: LocalRoutingState): void {
  routing = { ...next };
}

/** THE routing seam. Every cloud caller checks this before building a
 *  cloud URL; true means the call must go local or refuse. */
export function isLocalMode(): boolean {
  return routing.enabled;
}

export function localRouting(): LocalRoutingState {
  return { ...routing };
}

function localBase(port?: number): string {
  return `http://127.0.0.1:${port ?? routing.port}`;
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
): Promise<PairOutcome> {
  try {
    const res = await requestUrl({
      url: `${localBase(port)}/pair`,
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
