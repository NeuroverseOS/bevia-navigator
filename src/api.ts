// Bevia Navigator — API client (Bevia Local).
//
// Every network call in this file goes to the Bevia engine on the
// user's own machine (127.0.0.1, or a same-Wi-Fi private-LAN address
// the user typed in — local.ts refuses anything else). The plugin
// makes NO internet requests: the only external thing it ever does is
// open bevia.co/local in the user's browser when they click "Get
// Bevia Local".
//
// Two calls exist:
//   - postVaultNotes  → the engine's POST /intake/capture (the vault
//     is the free lane feeding the map)
//   - fetchMollyAsk   → the engine's POST /query (questions answered
//     from the map, grounded in the user's own notes)

import { BeviaApiError } from "./errors";
import { postLocalCapture, postLocalQuery } from "./local";

// Re-export so existing `import { BeviaApiError } from "./api"` sites keep
// working after the class moved to errors.ts (see errors.ts header).
export { BeviaApiError } from "./errors";

// ─── Vault intake (ADR-0203 — the Intake half, plugin producer) ────

export interface VaultIntakeNote {
  /** Vault-relative path. Obsidian's file.path is already relative, so
   *  the engine's canonical, vault-scoped source_ref is correct for free. */
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

/** Ships a batch of vault notes to the local engine so the user's own
 *  notes become part of their map. Each note becomes one capture
 *  against POST /intake/capture, shaped to the CaptureBody contract
 *  (capture-normalizer.ts). Field mapping:
 *
 *    thread_id       ← `vault:${vault_id}:${path}` — stable per note, so the
 *                      engine's own source_ref stamp (`${thread_id}::turn::0`)
 *                      dedupes re-sends; an edited note upserts the same row.
 *    conversation    ← ONE turn: { speaker: "user", text: note content
 *                      (title prepended as a first line when it isn't already
 *                      there), emitted_at: note mtime ISO (the note's real
 *                      "when"; the normalizer resolves occurred_at from it) }
 *    captured_at     ← now (fallback event time per the normalizer)
 *    source_platform ← "obsidian"
 *    source_kind     ← "vault_note"
 *
 *  The call READS the vault and POSTs; it never writes the vault. */
export async function postVaultNotes(
  body: { vault_id: string; notes: VaultIntakeNote[] },
): Promise<VaultIntakeResponse> {
  let moments = 0;
  const skipped: string[] = [];
  const capturedAt = new Date().toISOString();
  for (const note of body.notes) {
    const raw = note.content_text?.trim() ?? "";
    if (!raw) {
      skipped.push(`empty:${note.path}`);
      continue;
    }
    const title = note.title?.trim() ?? "";
    const text =
      title && !raw.startsWith(title) && !raw.startsWith(`# ${title}`)
        ? `${title}\n\n${raw}`
        : raw;
    const res = await postLocalCapture({
      thread_id: `vault:${body.vault_id}:${note.path}`,
      conversation: [{ speaker: "user", text, emitted_at: note.occurred_at }],
      source_platform: "obsidian",
      source_kind: "vault_note",
      captured_at: capturedAt,
    });
    moments += res.written;
    if (res.written === 0) skipped.push(note.path);
  }
  return { ok: true, moments, skipped, vault_id: body.vault_id };
}

// ── Ask Bevia (the two-voice panel) ──────────────────────────────────

export interface MollyAskEvidence {
  label: string;
  summary: string;
  recurrence_count: number;
  last_seen_at: string;
  what_changed: string | null;
  /** How strongly this territory matched the question (0..1). An
   *  ordering signal, never a verdict. */
  similarity?: number;
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
  /** True when no AI narration ran — `librarian` then carries the
   *  engine's deterministic grounded readout and `consultant` is
   *  empty. Render it as-is; never pretend it was narrated. */
  degraded?: boolean;
  /** How the matches were found (embedding | keyword). */
  method?: string;
}

/** Ask your map a question. The engine answers from the map on this
 *  machine — the Librarian retrieves from the user's own territories;
 *  the Consultant (when the engine has an AI key) thinks forward.
 *  Read-only: never modifies the vault. */
export async function fetchMollyAsk(message: string): Promise<MollyAskResponse> {
  const a = await postLocalQuery(message);
  if (!a.ok) {
    throw new BeviaApiError(a.error ?? "Your local engine couldn't answer that one.", 500);
  }
  return {
    ok: true,
    question: a.question,
    librarian: a.librarian,
    consultant: a.consultant,
    degraded: a.degraded,
    method: a.method,
    evidence: (a.evidence ?? []).map((e) => ({
      label: e.label,
      summary: e.summary,
      recurrence_count: e.recurrence_count,
      last_seen_at: e.last_seen_at ?? "",
      what_changed: null,
      similarity: e.similarity,
    })),
  };
}
