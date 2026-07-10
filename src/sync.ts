// Bevia — Living Atlas sync (the plugin-side materializer).
//
// This is the last mile that makes the product real: a paid user's
// territories and continents reach their Obsidian vault automatically,
// continuously, with no second app to install. It is the in-plugin
// equivalent of the desktop watcher's materialize loop — it polls
// /materialization-pull and mirrors the result into the vault.
//
// Self-healing mirror: each sync makes the Bevia-managed part of the
// vault an EXACT reflection of the server's current envelope set. It
// (a) writes every current envelope (only when content changed), and
// (b) reaps any file under a Bevia-managed folder that no longer has a
// matching envelope. Legacy folders, stale paths, renamed objects, and
// deleted substrate all self-correct — no flag, no button. Guardrails:
// it never reaps when the pull errored or returned zero envelopes, and
// it only ever touches Bevia-managed folders — the user's own zones
// (Bevia/5 Workspace and any non-managed folder) are never reaped.
//
// Sovereignty (ADR-0138): Bevia only ever writes inside its OWN
// namespace (Bevia/). Any envelope whose vault_path escapes that
// namespace — absolute, traversal, or outside the prefix — is
// refused. The user's own notes are never touched.
//
// Auth: the same bvex_mcp_ token the user pastes in settings (the token
// that already powers the Navigator). materialization-pull is per-user
// and only returns substrate the orchestrator has materialized, so a
// non-subscribed user simply gets nothing — no extra gate needed here.

import { Notice, TFile, TFolder, requestUrl } from "obsidian";
import type BeviaNavigatorPlugin from "./main";

// Bevia-owned vault namespaces. Mirrors the desktop watcher's
// ALLOWED_PREFIXES so both bridges enforce identical source immutability.
// Bevia writes only under Bevia/ now.
const ALLOWED_PREFIXES = ["Bevia/"];

// Bevia-MANAGED folders — the only places the mirror is allowed to delete
// orphans. These are the canonical Atlas Vault IA roots
// (docs/specs/atlas-vault-ia-spec.md). Bevia/5 Workspace is the user-owned
// free zone and is deliberately ABSENT — the mirror never touches it (nor
// the bare Bevia/ root). Any folder not listed here (e.g. a top-level WORK/)
// is likewise left alone.
//
// The old Atlas/* roots and the old Bevia/Journal path below are ONE-TIME
// migration cleanup: they get reaped on the next sync once their content has
// moved to the new Bevia/ tree. These entries can be removed in a later
// release once existing vaults have converged.
const MANAGED_PREFIXES = [
  // Canonical roots (new Bevia/ tree).
  "Bevia/1 Today",
  "Bevia/2 Ideas",
  "Bevia/3 You",
  "Bevia/4 Map",
  "Bevia/6 Help",
  // One-time migration cleanup — old Atlas Vault IA roots.
  "Atlas/01-Daily",
  "Atlas/02-Knowledge Insights",
  "Atlas/03-User Insights",
  "Atlas/05-Knowledge",
  // One-time migration cleanup — pre-IA flat roots.
  "Atlas/Concepts",
  "Atlas/Continents",
  "Atlas/Territories",
  "Atlas/Landmarks",
  "Atlas/Negotiations",
  "Atlas/Relationships",
  "Atlas/Behaviors",
  "Atlas/Daily",
  "Atlas/Worldviews",
  "Atlas/Threads",
  "Atlas/_Drafts",
  // One-time migration cleanup — old Journal path.
  "Bevia/Journal",
];

interface PulledEnvelope {
  artifact_type: string;
  artifact_key: string;
  vault_path: string | null;
  body_md: string | null;
  integrity_state: string | null;
  computed_at: string;
}

// ─── Connection Density (audit Finding 5.1) ──────────────────────────
// The projection boundary: the server materializes everything; the
// plugin decides how much of it reaches THIS vault. Density controls
// BREADTH, never EVIDENCE — the connective links (relationships →
// [[wikilinks]]) are always kept, projecting alongside the notes they
// connect at every non-minimal density. You never get the map without
// the evidence that ties it together.
//   minimal  — Daily Pulse only
//   balanced — + the Atlas notes (territories / continents / landmarks /
//              insights) AND their relationships (the wikilinks — evidence)
//   rich     — + concepts (more breadth: every named idea)
//   full     — everything (all edge types, fields)
// Lowering density reaps the now-excluded files (they drop out of
// validPaths below) — but the links between whatever IS projected stay.
export type ConnectionDensity = "minimal" | "balanced" | "rich" | "full";

const DENSITY_RANK: Record<ConnectionDensity, number> = {
  minimal: 0,
  balanced: 1,
  rich: 2,
  full: 3,
};

const ARTIFACT_MIN_RANK: Record<string, number> = {
  briefing: 0,            // Minimal — the Daily Pulse
  daily: 0,
  helpful_hint: 0,        // Minimal — the one Help note (tool instructions);
                          // structural, never density-gated
  territory: 1,           // Balanced — the Atlas notes
  continent: 1,
  worldview: 1,
  landmark: 1,
  behavioral_pattern: 1,
  telescope_finding: 1,
  relationship: 1,        // Balanced — the connective EVIDENCE (wikilinks),
                          // never gated above the notes it connects
  concept: 2,             // Rich — breadth (every named idea)
  negotiation: 3,         // Full — everything
};
// Unknown / future note-types appear at Balanced+ (they're notes, not
// the connective layer). New connective types should be classified here.
const UNKNOWN_MIN_RANK = 1;

export function envelopeAllowedAtDensity(
  artifactType: string,
  density: ConnectionDensity,
): boolean {
  const need = ARTIFACT_MIN_RANK[artifactType] ?? UNKNOWN_MIN_RANK;
  return DENSITY_RANK[density] >= need;
}

/** Human, one-line-per-thing description of what a density writes —
 *  used by the first-run "what Bevia writes & where" screen. */
export function densitySummary(density: ConnectionDensity): string[] {
  const lines = ["Your Daily Pulse note"];
  if (DENSITY_RANK[density] >= 1) {
    lines.push("Territory, continent & landmark notes (your Atlas)");
    lines.push("Insight notes (patterns Bevia notices)");
    lines.push("Relationship notes — the [[wikilinks]] that connect them (always kept)");
  }
  if (DENSITY_RANK[density] >= 2) lines.push("Concepts — every named idea (more breadth)");
  if (DENSITY_RANK[density] >= 3) lines.push("Everything else (negotiations, all edge types)");
  return lines;
}

interface PullResult {
  ok: boolean;
  envelopes: PulledEnvelope[];
  error?: string;
  /** HTTP status when the pull failed at the wire — lets the caller
   *  distinguish a dead key (401/403) from a server blip (5xx). */
  status?: number;
}

/** True only for a relative, traversal-free path inside a Bevia-owned
 *  namespace. Everything else is refused (source immutability). Ported
 *  from the desktop watcher's isSafeVaultPath, normalized for the
 *  browser/Obsidian environment (no node:path). */
export function isSafeVaultPath(vaultPath: string): boolean {
  if (!vaultPath) return false;
  // Reject absolute paths (POSIX or Windows drive) and backslashes.
  if (vaultPath.startsWith("/") || /^[A-Za-z]:/.test(vaultPath)) return false;
  const norm = vaultPath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (norm.startsWith("..") || norm.includes("/../") || norm.includes("/..")) return false;
  if (norm.split("/").some((seg) => seg === "..")) return false;
  return ALLOWED_PREFIXES.some((prefix) => norm.startsWith(prefix));
}

/** True if a vault path sits under a Bevia-managed folder — i.e. the
 *  mirror is allowed to delete it as an orphan. */
function isManagedPath(vaultPath: string): boolean {
  return MANAGED_PREFIXES.some(
    (p) => vaultPath === p || vaultPath.startsWith(`${p}/`),
  );
}

async function fetchEnvelopes(
  baseUrl: string,
  token: string,
): Promise<PullResult> {
  // No `since` cursor (Phase 2 — one full-pull model): the server returns
  // the user's whole envelope set in one response, and the mirror needs all
  // of it to tell which on-disk files are orphans. An incremental cursor
  // also silently dropped same-timestamp envelope clusters.
  const body: Record<string, unknown> = { limit: 20000 };
  try {
    const res = await requestUrl({
      url: `${baseUrl}/functions/v1/materialization-pull`,
      method: "POST",
      contentType: "application/json",
      // x-bevia-client identifies this as the Obsidian plugin so the server can
      // record an Obsidian-specific heartbeat — the web Connections page then
      // shows the vault connected from SYNC alone, not only when the Navigator
      // fires note-context.
      headers: { Authorization: `Bearer ${token}`, "x-bevia-client": "obsidian" },
      body: JSON.stringify(body),
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      // Carry the server's own reason forward — the auth layer's 401
      // body says WHY (revoked, expired, capture-scoped-to-extension),
      // and that copy is the difference between a user who re-pastes
      // the same wrong key and one who mints the right kind.
      let detail = "";
      try {
        const body = res.json as Record<string, unknown> | null;
        if (body && typeof body.error === "string") detail = body.error;
      } catch { /* non-JSON body — status alone */ }
      return {
        ok: false,
        envelopes: [],
        error: `HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
        status: res.status,
      };
    }
    const p = res.json as Record<string, unknown>;
    if (p?.ok !== true || !Array.isArray(p.envelopes)) {
      return { ok: false, envelopes: [], error: "payload missing envelopes" };
    }
    return { ok: true, envelopes: p.envelopes as PulledEnvelope[] };
  } catch (e) {
    return { ok: false, envelopes: [], error: (e as Error).message };
  }
}

/** The user-owned zone marker inside Bevia-managed notes. Everything
 *  from this heading to EOF is the user's and survives regeneration. */
const YOURS_MARKER = "\n## Yours";

/** Merge the server's fresh body with the user's preserved "## Yours"
 *  section from the existing file. The server body may itself ship a
 *  (seed) Yours section — the user's existing one always wins. */
export function mergeYoursSection(serverBody: string, existing: string | null): string {
  if (!existing) return serverBody;
  const userIdx = existing.indexOf(YOURS_MARKER);
  if (userIdx === -1) return serverBody; // user never wrote below the line
  const userSection = existing.slice(userIdx);
  const serverIdx = serverBody.indexOf(YOURS_MARKER);
  const managed = serverIdx === -1 ? serverBody : serverBody.slice(0, serverIdx);
  return managed.replace(/\s+$/, "") + "\n" + userSection.replace(/^\n/, "\n");
}

// ── Vault-API file I/O (audit ST3/S5) ─────────────────────────────────
// All reads/writes/deletes below go through the Vault API — never
// `vault.adapter` — so Obsidian's file cache and locking stay coherent
// and the store reviewer's most-requested change is satisfied.

/** Ensure every ancestor folder of a vault-relative file path exists.
 *  `vault.createFolder` creates missing intermediate folders. */
async function ensureParentFolders(
  plugin: BeviaNavigatorPlugin,
  vaultPath: string,
): Promise<void> {
  const vault = plugin.app.vault;
  const dir = vaultPath.split("/").slice(0, -1).join("/");
  if (!dir) return;
  try {
    if (!(vault.getAbstractFileByPath(dir) instanceof TFolder)) {
      await vault.createFolder(dir);
    }
  } catch {
    // Race or already-exists — the create/modify below surfaces a real error.
  }
}

/** Every markdown file (vault-relative) beneath a folder, from Obsidian's
 *  file cache. Empty when the folder is absent. */
function listFilesRecursive(
  plugin: BeviaNavigatorPlugin,
  dir: string,
): TFile[] {
  const root = plugin.app.vault.getAbstractFileByPath(dir);
  if (!(root instanceof TFolder)) return [];
  const out: TFile[] = [];
  const walk = (folder: TFolder): void => {
    for (const child of folder.children) {
      if (child instanceof TFile) out.push(child);
      else if (child instanceof TFolder) walk(child);
    }
  };
  walk(root);
  return out;
}

/** Remove now-empty folders under `dir`, depth-first. Leaves `dir` itself
 *  removed too when it ends up empty. Best-effort. */
async function pruneEmptyDirs(
  plugin: BeviaNavigatorPlugin,
  dir: string,
): Promise<void> {
  const vault = plugin.app.vault;
  const root = vault.getAbstractFileByPath(dir);
  if (!(root instanceof TFolder)) return;
  for (const child of [...root.children]) {
    if (child instanceof TFolder) await pruneEmptyDirs(plugin, child.path);
  }
  try {
    if (root.children.length === 0) await vault.delete(root, true);
  } catch {
    // Best-effort — a folder that won't remove is left in place.
  }
}

/** Reap Bevia-managed files that have no matching current envelope, then
 *  prune the folders left empty. Only ever touches MANAGED_PREFIXES — the
 *  user's own zones are never visited. Returns how many files were reaped. */
async function reapOrphans(
  plugin: BeviaNavigatorPlugin,
  validPaths: Set<string>,
): Promise<number> {
  const vault = plugin.app.vault;
  let reaped = 0;
  for (const prefix of MANAGED_PREFIXES) {
    const files = listFilesRecursive(plugin, prefix);
    for (const f of files) {
      if (validPaths.has(f.path)) continue;
      // Defensive: Bevia only writes .md content; never reap a non-.md file
      // or a dotfile (e.g. the .bevia-managed.md markers, which are valid
      // envelopes anyway — this is belt-and-suspenders).
      if (!f.name.endsWith(".md") || f.name.startsWith(".")) continue;
      try {
        await vault.delete(f);
        reaped++;
      } catch {
        // Best-effort — leave anything we can't remove.
      }
    }
    await pruneEmptyDirs(plugin, prefix);
  }
  return reaped;
}

export interface SyncResult {
  wrote: number;
  reaped: number;
  skipped: number;
  error?: string;
}

/** Mirror the server's current envelope set into the vault: pull the full
 *  set, write what changed, reap Bevia-managed orphans. Idempotent. */
export async function syncAtlasOnce(
  plugin: BeviaNavigatorPlugin,
): Promise<SyncResult> {
  const baseUrl = plugin.settings.baseUrl?.replace(/\/+$/, "");
  const token = plugin.settings.token?.trim();
  if (!baseUrl || !token) {
    return { wrote: 0, reaped: 0, skipped: 0, error: "no-token" };
  }

  // 1. Pull the FULL current set in one request. The mirror needs every
  //    envelope, not an incremental slice, so it can tell which on-disk
  //    files are orphans. The server returns the whole set (it pages
  //    internally and never caps), so no client-side `since` cursor is
  //    needed — and an incremental cursor silently dropped same-timestamp
  //    envelope clusters.
  const res = await fetchEnvelopes(baseUrl, token);
  // GUARDRAIL: any pull error aborts the whole sync WITHOUT reaping —
  // never delete the vault on the strength of a failed/partial pull.
  if (!res.ok) {
    // Token truth: a 401/403 means the key is dead or wrong-kind — flip
    // the plugin-wide health flag so Home tells the truth, the loop
    // stops hammering, and the user sees the server's reason once.
    if (res.status === 401 || res.status === 403) {
      plugin.noteTokenInvalid(res.error);
    }
    return { wrote: 0, reaped: 0, skipped: 0, error: res.error };
  }
  plugin.noteTokenOk();
  const all: PulledEnvelope[] = res.envelopes;

  // 2. SAFETY (pre-density): did the pull return any usable envelope at
  //    all? If not, this is a transient/empty response — write nothing
  //    and DO NOT reap. A failed pull must never wipe the vault.
  const safe = all.filter(
    (env) => env.vault_path && env.body_md && isSafeVaultPath(env.vault_path),
  );
  if (safe.length === 0) {
    return { wrote: 0, reaped: 0, skipped: 0 };
  }

  // 2b. CONNECTION DENSITY: of everything the server materialized, keep
  //     only what this vault's density allows. validPaths is the kept
  //     set — so anything the density excludes drops out and gets reaped
  //     below (lowering density cleans the vault; raising it re-adds).
  const density: ConnectionDensity = plugin.settings.connectionDensity ?? "balanced";
  const kept = safe.filter((env) => envelopeAllowedAtDensity(env.artifact_type, density));
  const validPaths = new Set<string>(kept.map((env) => env.vault_path as string));

  // 3. Write what changed (skip identical files to avoid churn + reindex).
  //
  //    THE "YOURS" CONTRACT (founder direction 2026-07-05): anything the
  //    user writes under the "## Yours" heading of a managed note is
  //    THEIRS — it survives every regeneration. The server owns the text
  //    above the marker; the user owns everything from the marker down.
  //    Without this, writing on an idea note was silently clobbered on
  //    the next sync — working IN ideas was architecturally punished.
  let wrote = 0;
  let skipped = 0;
  const vault = plugin.app.vault;
  for (const env of kept) {
    const vaultPath = env.vault_path as string;
    const bodyMd = env.body_md as string;
    try {
      const existingFile = vault.getAbstractFileByPath(vaultPath);
      const existing = existingFile instanceof TFile ? await vault.read(existingFile) : null;
      const merged = mergeYoursSection(bodyMd, existing);
      if (existing === merged) continue; // unchanged (incl. user section)
      if (existingFile instanceof TFile) {
        await vault.modify(existingFile, merged);
      } else {
        await ensureParentFolders(plugin, vaultPath);
        await vault.create(vaultPath, merged);
      }
      wrote++;
    } catch {
      skipped++;
    }
  }

  // 4. Reap orphaned Bevia-managed files + prune emptied folders. Only
  //    ever touches MANAGED_PREFIXES; the user's own zones are untouched.
  const reaped = await reapOrphans(plugin, validPaths);

  return { wrote, reaped, skipped };
}

/** Manual command: sync now and report what landed. */
export async function syncAtlasNow(plugin: BeviaNavigatorPlugin): Promise<void> {
  const token = plugin.settings.token?.trim();
  if (!token) {
    new Notice("Add your Bevia token in settings to bring your Atlas into this vault.");
    return;
  }
  new Notice("Bevia is syncing your Atlas…");
  const { wrote, reaped, skipped, error } = await syncAtlasOnce(plugin);
  if (error === "no-token") {
    new Notice("Add your Bevia token in settings first.");
  } else if (error) {
    new Notice(`Atlas sync failed: ${error}`);
  } else if (wrote === 0 && reaped === 0) {
    new Notice("Your Atlas is up to date — nothing changed.");
  } else {
    const parts = [`${wrote} written`];
    if (reaped) parts.push(`${reaped} removed`);
    if (skipped) parts.push(`${skipped} skipped`);
    new Notice(`Atlas updated: ${parts.join(", ")}.`);
  }
}

/** Poll /vault-sync-status for the user-initiated "update my vault now"
 *  signal. Returns the latest requested_at (null if never pressed or on
 *  any error — a failed status check must never block the sync loop). */
async function fetchSyncSignal(
  baseUrl: string,
  token: string,
): Promise<string | null> {
  try {
    const res = await requestUrl({
      url: `${baseUrl}/functions/v1/vault-sync-status`,
      method: "POST",
      contentType: "application/json",
      headers: { Authorization: `Bearer ${token}` },
      body: "{}",
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const p = res.json as { requested_at?: string | null };
    return typeof p?.requested_at === "string" ? p.requested_at : null;
  } catch {
    return null;
  }
}

/** Handle for a running sync loop. */
export interface AtlasSyncHandle {
  stop(): void;
}

/** Start the background sync loop. No-op (returns a dead handle) when
 *  syncAtlas is off or there's no token.
 *
 *  Two cadences: a full mirror sync on the configured interval (default
 *  10 min), AND a fast vault-sync-status check every 20s so a user
 *  pressing "Update my vault now" on the web triggers an immediate sync
 *  instead of waiting out the interval. Pull-not-push preserved: the web
 *  only sets a flag; this client polls it and pulls itself (ADR-0054). */
export function startAtlasSync(plugin: BeviaNavigatorPlugin): AtlasSyncHandle {
  if (!plugin.settings.syncAtlas || !plugin.settings.token?.trim()) {
    return { stop: () => {} };
  }
  const minutes = Math.max(1, plugin.settings.syncPollMinutes || 10);
  const SIGNAL_POLL_MS = 20_000;
  let stopped = false;
  // Adopt the current signal at startup WITHOUT firing, so a stale flag
  // doesn't force a redundant sync every time Obsidian opens — only a new
  // press after startup triggers the fast path.
  let lastSignalActed: string | null = null;
  let primed = false;

  const fullTick = async () => {
    if (stopped) return;
    // A dead key never heals by retrying with the same string — stop
    // hammering the server until the user changes the token (which
    // restarts this loop with health reset to "unknown").
    if (plugin.tokenHealth === "invalid") return;
    await syncAtlasOnce(plugin);
  };
  void fullTick();

  const baseUrl = plugin.settings.baseUrl?.replace(/\/+$/, "") ?? "";
  const token = plugin.settings.token?.trim() ?? "";
  const signalTick = async () => {
    if (stopped) return;
    if (plugin.tokenHealth === "invalid") return;
    const sig = await fetchSyncSignal(baseUrl, token);
    if (sig === null) return;
    if (!primed) { lastSignalActed = sig; primed = true; return; }
    if (sig !== lastSignalActed) {
      lastSignalActed = sig;
      await syncAtlasOnce(plugin);
    }
  };
  void signalTick();

  const fullHandle = window.setInterval(() => { void fullTick(); }, minutes * 60_000);
  const signalHandle = window.setInterval(() => { void signalTick(); }, SIGNAL_POLL_MS);
  return {
    stop: () => {
      stopped = true;
      window.clearInterval(fullHandle);
      window.clearInterval(signalHandle);
    },
  };
}
