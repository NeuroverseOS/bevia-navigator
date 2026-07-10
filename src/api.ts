// Bevia Navigator — API client.
//
// One responsibility: fetch /note-context from Bevia and return the
// typed response. Auth via the user's Bevia token (entered in settings,
// per CLAUDE.md § Identity sovereignty — the user owns their auth).

import { requestUrl, type RequestUrlParam } from "obsidian";
import type { ConnectionDensity } from "./sync";

export type AttributionSource = "declared" | "inferred" | "unresolved";
export type EntityKind =
  | "principal"
  | "human"
  | "ai"
  | "bot"
  | "organization"
  | "project"
  | "unknown";

export interface Contributor {
  label: string;
  kind: EntityKind;
  weight: number;
  attribution_source: AttributionSource;
}

export interface MatchedTerritory {
  id: string;
  label: string;
  summary: string;
  recurrence_count: number;
  abstract_concept_tags: string[];
  contributors: Contributor[];
  match_strength: "high" | "medium" | "low";
  match_reason: "title_exact" | "title_overlap" | "concept_overlap";
  score: number;
}

export interface LandmarkAggregate {
  label: string;
  territory_ids: string[];
  count: number;
}

export interface NoteContextResponse {
  ok: true;
  user_id: string;
  computed_at: string;
  note: { title: string; excerpt_chars: number };
  matched_territories: MatchedTerritory[];
  landmarks: LandmarkAggregate[];
  themes_scanned: number;
}

export interface BeviaClientConfig {
  baseUrl: string;
  token: string;
}

export class BeviaApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "BeviaApiError";
  }
}

/** Calls the Navigator-facing EF that returns territories, landmarks,
 *  and contributors matching a note. Pure projection read; the call
 *  itself never modifies the user's vault.
 *
 *  Uses Obsidian's requestUrl to avoid CORS issues with fetch. The
 *  Supabase Edge Function gateway accepts the user's Bevia token as
 *  a Bearer credential. */
export async function fetchNoteContext(
  config: BeviaClientConfig,
  body: { title: string; excerpt?: string; vault_path?: string },
): Promise<NoteContextResponse> {
  if (!config.token) {
    throw new BeviaApiError(
      "Bevia token missing — open Settings → Bevia Navigator and paste your token.",
      401,
    );
  }
  const url = `${config.baseUrl.replace(/\/+$/, "")}/functions/v1/note-context`;
  const req: RequestUrlParam = {
    url,
    method: "POST",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(body),
    throw: false,
  };
  const res = await requestUrl(req);
  if (res.status >= 400) {
    let detail = "";
    try {
      const j = res.json as { error?: string };
      detail = j?.error ?? "";
    } catch {
      detail = res.text?.slice(0, 200) ?? "";
    }
    throw new BeviaApiError(
      `Bevia /note-context returned ${res.status}${detail ? ` — ${detail}` : ""}`,
      res.status,
    );
  }
  return res.json as NoteContextResponse;
}

// ─── Vault intake (ADR-0203 — the Intake half, plugin producer) ────

export interface VaultIntakeNote {
  /** Vault-relative path. Obsidian's file.path is already relative, so
   *  the server's canonical, vault-scoped source_ref is correct for free. */
  path: string;
  content_text: string;
  title?: string;
  /** File mtime, ISO — the note's real "when". */
  occurred_at?: string;
}

export interface VaultIntakeResponse {
  ok: true;
  moments: number;
  skipped: string[];
  vault_id: string;
}

/** Ships a batch of vault notes to /vault-intake so the user's own notes
 *  become substrate. The call READS the vault and POSTs; it never writes
 *  the vault. The server enforces the ADR-0203 guards (skip Atlas/, dedup
 *  key) regardless of what we send — this is intake, not projection. */
export async function postVaultNotes(
  config: BeviaClientConfig,
  body: { vault_id: string; notes: VaultIntakeNote[] },
): Promise<VaultIntakeResponse> {
  if (!config.token) {
    throw new BeviaApiError(
      "Bevia token missing — open Settings → Bevia Navigator and paste your token.",
      401,
    );
  }
  const url = `${config.baseUrl.replace(/\/+$/, "")}/functions/v1/vault-intake`;
  const req: RequestUrlParam = {
    url,
    method: "POST",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(body),
    throw: false,
  };
  const res = await requestUrl(req);
  if (res.status >= 400) {
    let detail = "";
    try {
      const j = res.json as { error?: string };
      detail = j?.error ?? "";
    } catch {
      detail = res.text?.slice(0, 200) ?? "";
    }
    throw new BeviaApiError(
      `Bevia /vault-intake returned ${res.status}${detail ? ` — ${detail}` : ""}`,
      res.status,
    );
  }
  return res.json as VaultIntakeResponse;
}

// ─── Query layer (ADR-0154) ───────────────────────────────────────

export type QueryKind =
  | "recent_moments"
  | "territories_grown"
  | "new_territories"
  | "contradictions"
  | "notable_connections"
  | "territory_detail"
  | "contributor_activity"
  | "landmarks_recurring"
  | "routes_emerged"
  | "loop_breakdown"
  | "recent_concepts"
  | "open_threads"
  | "territory_moments";

/** Atlas Inquiry surface mode per ADR-0170.
 *
 *  - `atlas` — read filtered by the user's active Projection
 *    (Aperture). "Within this Atlas" question.
 *  - `mind`  — substrate-direct. Full Atlas, ignores Aperture
 *    filter. "What have I learned about X?" question.
 *
 *  Server-side projection filtering ships in subsequent ADR
 *  substrate; today the mode is plumbed forward-compat — the
 *  plugin sends explicit intent and the EF treats it as a no-op
 *  until ADR-0173+ wires the Aperture filter through `runQuery`.
 */
export type InquiryMode = "atlas" | "mind";

export interface QueryRequest {
  kind: QueryKind;
  params: Record<string, unknown>;
  /** Atlas / Mind per ADR-0170. Optional; defaults atlas on the
   *  server when omitted. */
  mode?: InquiryMode;
}

export interface QueryResponse {
  ok: true;
  user_id: string;
  computed_at: string;
  kind: QueryKind;
  resolved_params: Record<string, unknown>;
  result: unknown;
}

/** Calls the Query layer EF. Pure cartographic substrate read; no
 *  Molly interpretation in the answer path (ADR-0152). Consumed by
 *  the Bevia Query view in the right sidebar. */
export async function fetchQuery(
  config: BeviaClientConfig,
  request: QueryRequest,
): Promise<QueryResponse> {
  if (!config.token) {
    throw new BeviaApiError(
      "Bevia token missing — open Settings → Bevia Navigator and paste your token.",
      401,
    );
  }
  const url = `${config.baseUrl.replace(/\/+$/, "")}/functions/v1/query-run`;
  const req: RequestUrlParam = {
    url,
    method: "POST",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(request),
    throw: false,
  };
  const res = await requestUrl(req);
  if (res.status >= 400) {
    let detail = "";
    try {
      const j = res.json as { error?: string };
      detail = j?.error ?? "";
    } catch {
      detail = res.text?.slice(0, 200) ?? "";
    }
    throw new BeviaApiError(
      `Bevia /query-run returned ${res.status}${detail ? ` — ${detail}` : ""}`,
      res.status,
    );
  }
  return res.json as QueryResponse;
}

// ─── Navigator place card (orientation + directions) ──────────────
//
// The Google-Maps-style "you are here" panel. Two Convergent Navigator
// reads (live query, never materializes) + the two Control Tower
// setter EFs the card's Promote / Share verbs write through
// (ADR-0202 — projection control lives in the surface it governs;
// the setters are windows onto the ONE canonical policy).

export interface SemanticResolutionReading {
  level: "low" | "medium" | "high" | string;
  closely_observed_share: number;
}

export interface YouAreHere {
  territory_id: string;
  label: string;
  summary: string;
  /** Optional technical register summary — render only when present
   *  and the user elected the Technical narration setting. */
  technical_summary?: string | null;
  first_seen_at: string;
  days_here: number;
  evidence_count: number;
  /** Evidence that arrived in the trailing 7 days. 0 renders as
   *  silence, never as "no activity". */
  evidence_added_7d?: number;
  last_major_change: { at: string; what: string } | null;
  attention_state: "default" | "promoted" | "dampened" | string;
  share_state: "private" | "shared" | string;
  semantic_resolution: SemanticResolutionReading | null;
  recurrence_count: number;
}

export interface NearbyTerritory {
  territory_id: string;
  label: string;
  /** Ordering signal only — never displayed as a number/percent. */
  similarity: number;
  summary_first_sentence: string;
  shared_evidence_count?: number;
  /** The why-near in plain words: concept ground the two territories
   *  hold in common (max 3, humanized). Optional: older engines omit. */
  shared_ground?: string[];
}

export interface NavigatorOrientationResponse {
  ok: true;
  you_are_here: YouAreHere | null;
  nearby: NearbyTerritory[];
  /** IDEAS ALIVE HERE — the Telescope's recurring ideas placed in this
   *  territory. Optional: older engines omit it; empty until the
   *  concept-embedding backfill links ideas to territories. */
  ideas_here?: Array<{ title: string; returns: number; last_seen: string; summary_line: string }>;
  /** HOW YOU WORK — top behavioral dispositions, global (not note-
   *  specific). Optional: older engines omit it. Present on every path,
   *  including no_match, so the panel can teach that this dimension
   *  exists even on an unmapped note. */
  how_you_work?: Array<{ title: string; summary_line: string; recurrence: number }>;
  no_match: boolean;
  nearest: { territory_id: string; label: string } | null;
}

export interface DirectionsStep {
  step: number;
  kind: "territory" | "moment" | "bridge";
  label: string;
  occurred_at?: string | null;
  excerpt?: string | null;
  id?: string | null;
}

export interface NavigatorDirectionsResponse {
  ok: true;
  connected: boolean;
  route: DirectionsStep[];
  nearest_bridge: { territory_id: string; label: string } | null;
}

/** Shared POST helper for the place-card endpoints — same auth shape
 *  (Bearer only — audit S4: the user's secret token must never ride
 *  the `apikey` header, which Supabase reserves for project keys)
 *  and error surface as every other call in this file. */
async function postBevia<T>(
  config: BeviaClientConfig,
  fn: string,
  body: unknown,
): Promise<T> {
  if (!config.token) {
    throw new BeviaApiError(
      "Bevia token missing — open Settings → Bevia Navigator and paste your token.",
      401,
    );
  }
  const url = `${config.baseUrl.replace(/\/+$/, "")}/functions/v1/${fn}`;
  const req: RequestUrlParam = {
    url,
    method: "POST",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(body),
    throw: false,
  };
  const res = await requestUrl(req);
  if (res.status >= 400) {
    let detail = "";
    try {
      const j = res.json as { error?: string };
      detail = j?.error ?? "";
    } catch {
      detail = res.text?.slice(0, 200) ?? "";
    }
    throw new BeviaApiError(
      `Bevia /${fn} returned ${res.status}${detail ? ` — ${detail}` : ""}`,
      res.status,
    );
  }
  return res.json as T;
}

/** "Where am I?" — the place card's spine. Send the active note
 *  (path + title) OR a known territory_id (territory files carry
 *  theme_id frontmatter). Pure projection read. */
export async function fetchNavigatorOrientation(
  config: BeviaClientConfig,
  body: { note_path: string; note_title: string } | { territory_id: string },
): Promise<NavigatorOrientationResponse> {
  return postBevia<NavigatorOrientationResponse>(config, "navigator-orientation", body);
}

/** "Directions from here to…" — the route between two territories,
 *  or the honest not-connected state with the nearest bridge. */
export async function fetchNavigatorDirections(
  config: BeviaClientConfig,
  body: { from_territory_id: string; to_territory_id: string },
): Promise<NavigatorDirectionsResponse> {
  return postBevia<NavigatorDirectionsResponse>(config, "navigator-directions", body);
}

/** Promote / Dampen knob write — the card's Promote verb.
 *  Reversible, auditable, never deletes substrate. */
export async function setTerritoryAttention(
  config: BeviaClientConfig,
  territoryId: string,
  state: "default" | "promoted" | "dampened",
): Promise<{ ok: true; territory: { id: string; label: string; attention_state: string } }> {
  return postBevia(config, "set-territory-attention", {
    territory_id: territoryId,
    attention_state: state,
  });
}

// ── Projection scope (Build C — "choose what syncs") ─────────────────
//
// The Control Tower slice policy for this vault, written from the plugin's
// "Choose what syncs" panel. Projection control belongs in the surface it
// governs (ADR-0202) — this is a second window onto the ONE canonical
// projection_scope row that materialization-pull enforces, never a second
// source of truth.

export interface ProjectionScopePayload {
  worldviews_on: boolean;
  continents_on: boolean;
  territories_on: boolean;
  landmarks_mode: "off" | "material" | "all";
  concepts_mode: "off" | "material" | "all";
  /** Legacy combined toggle — kept in the payload for back-compat;
   *  the split pair below is authoritative on the server. */
  insights_on: boolean;
  ideas_on: boolean;
  behaviors_on: boolean;
  density: ConnectionDensity;
  /** Full-detail window in days. 3650 (≈10y) = "all", no time narrowing. */
  time_full_days: number;
  /** 0..100 percentile floor for territories. 0 = everything. */
  importance_floor: number;
  /** Trajectory-direction axis. 'all' = the whole map. */
  compass_filter: "all" | "north" | "east" | "south" | "west";
}

export interface ProjectionScopeResponse {
  ok: true;
  surface: string;
  filtering_active: boolean;
  scope: ProjectionScopePayload & { surface: string };
  counts: Record<string, number>;
  total_count: number;
  projected_count: number;
}

/** Persist the vault's projection scope. The setter EF sanitizes/clamps
 *  every field server-side, so a malformed payload can never land. */
export async function setProjectionScope(
  config: BeviaClientConfig,
  scope: ProjectionScopePayload,
): Promise<ProjectionScopeResponse> {
  return postBevia<ProjectionScopeResponse>(config, "projection-scope", {
    action: "set",
    surface: "vault",
    scope,
  });
}

/** Share knob write — the card's Share verb. Private by default. */
export async function setTerritoryShare(
  config: BeviaClientConfig,
  territoryId: string,
  state: "private" | "shared",
): Promise<{ ok: true; territory: { id: string; label: string; share_state: string } }> {
  return postBevia(config, "set-territory-share", {
    territory_id: territoryId,
    share_state: state,
  });
}

// ── Ask Molly (the two-agent brain) ──────────────────────────────────

export interface MollyAskEvidence {
  label: string;
  summary: string;
  recurrence_count: number;
  last_seen_at: string;
  what_changed: string | null;
}

export interface MollyAskResponse {
  ok: boolean;
  question: string;
  /** The Librarian — grounded reflection of the user's own map. */
  librarian: string;
  /** The Consultant — a forward move that supports how they work. */
  consultant: string;
  /** The territories the answer was grounded in (drill-down). */
  evidence: MollyAskEvidence[];
}

/** Ask Molly a question. The Librarian retrieves from the user's own map
 *  (recall) and the Consultant thinks forward. Pull = BYOK; the call runs
 *  on the user's own AI key. Read-only — never modifies the vault. */
export async function fetchMollyAsk(
  config: BeviaClientConfig,
  message: string,
): Promise<MollyAskResponse> {
  if (!config.token) {
    throw new BeviaApiError(
      "Bevia token missing — open Settings → Bevia Navigator and paste your token.",
      401,
    );
  }
  const url = `${config.baseUrl.replace(/\/+$/, "")}/functions/v1/molly-ask`;
  const req: RequestUrlParam = {
    url,
    method: "POST",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ message }),
    throw: false,
  };
  const res = await requestUrl(req);
  if (res.status >= 400) {
    let detail = "";
    try {
      detail = (res.json as { error?: string })?.error ?? "";
    } catch {
      detail = res.text?.slice(0, 200) ?? "";
    }
    throw new BeviaApiError(
      `Bevia /molly-ask returned ${res.status}${detail ? ` — ${detail}` : ""}`,
      res.status,
    );
  }
  return res.json as MollyAskResponse;
}

// ─── Navigator Games — /navigator-games ─────────────────────────────────────
//
// Three games dealt from the user's own substrate (spec:
// docs/specs/navigator-games-spec.md). One EF owns every deal
// composition (canonical readout pattern); the view only renders and
// flips. Reveal data ships with the deal — the flip is a client
// interaction, never a second compose.

export type GameKind = "two_truths" | "expedition" | "time_machine";

export interface GameEvidence {
  moment_id: string;
  excerpt: string;
  occurred_at: string;
  source_kind: string | null;
}

export interface TwoTruthsReading {
  id: string;
  text: string;
  /** True on exactly one reading — the game's fiction. Never persisted,
   *  always badged as fiction at reveal. */
  is_lie: boolean;
  evidence: GameEvidence[];
}

export interface TwoTruthsDeal {
  game: "two_truths";
  readings: TwoTruthsReading[];
}

export interface ExpeditionDeal {
  game: "expedition";
  territory: {
    id: string;
    label: string;
    note_count: number;
    last_active_at: string;
    dormant_days: number;
  };
  reveal: {
    summary: string;
    landmarks: { text: string; occurred_at: string | null }[];
    evidence: GameEvidence[];
  };
}

export interface TimeMachineDeal {
  game: "time_machine";
  territory: { id: string; label: string };
  then: { observed_at: string; state_summary: string };
  now: { observed_at: string; state_summary: string };
  evolution: {
    north: string;
    east: string;
    south: string;
    west: string;
  };
}

export interface GameUnavailable {
  game: GameKind;
  unavailable: true;
  /** Honest absence — why the map can't deal this game yet. */
  reason: string;
}

export type GameDeal =
  | TwoTruthsDeal
  | ExpeditionDeal
  | TimeMachineDeal
  | GameUnavailable;

/** Deal one game round. Expedition and Time Machine are pure substrate
 *  reads ($0); Two Truths runs one schema-constrained model call (the
 *  fabricated reading) on the user's own key via the SPE. */
export async function fetchGameDeal(
  config: BeviaClientConfig,
  action: "deal_two_truths" | "deal_expedition" | "deal_time_machine",
): Promise<GameDeal> {
  return postBevia<GameDeal>(config, "navigator-games", { action });
}

export interface GameReadinessEntry {
  ready: boolean;
  /** Honest absence — what the map still needs before this game can
   *  deal (with real counts; never a clock, never a progress bar). */
  detail: string;
}

export interface GameReadinessResponse {
  readiness: {
    two_truths: GameReadinessEntry;
    expedition: GameReadinessEntry;
    time_machine: GameReadinessEntry;
  };
}

/** Which games can this map support right now? Pure substrate read —
 *  the games switch on from substrate density, never a clock. */
export async function fetchGameReadiness(
  config: BeviaClientConfig,
): Promise<GameReadinessResponse> {
  return postBevia<GameReadinessResponse>(config, "navigator-games", {
    action: "readiness",
  });
}
