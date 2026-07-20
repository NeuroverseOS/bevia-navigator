// Bevia — vault intake producer (ADR-0203, the Intake half, plugin side).
//
// Walks the vault's markdown files and ships user-authored notes to
// /vault-intake so the user's own notes become substrate — the same
// Pass-0 → compile pipeline as every other source. Honors the source
// rule absolutely: it READS the vault and POSTs; it never writes a note.
//
// Tail-guard (ADR-0203 R1) is mirrored here on the producer for
// efficiency — we don't ship Bevia's own output (Bevia/) or a
// bevia_managed-stamped note back as intake. The server enforces the same
// guard authoritatively (shouldIngestVaultFile); this is defense in depth.
//
// Dedup scope (ADR-0203 R2): a stable per-vault id generated once and
// stored in settings. Obsidian's file.path is already vault-relative, so
// the server's canonical, vault-scoped source_ref is correct for free.

import { Notice, TFile } from "obsidian";
import type BeviaNavigatorPlugin from "./main";
import { postVaultNotes, type VaultIntakeNote } from "./api";

const BATCH_SIZE = 100;
const MIN_TEXT_LEN = 100;
const BEVIA_PREFIXES = ["Bevia/"];

/** Stable per-vault id for the dedup scope. Generated once, persisted in
 *  plugin settings (per-vault by construction). */
export async function getOrCreateVaultId(
  plugin: BeviaNavigatorPlugin,
): Promise<string> {
  const existing = plugin.settings.vaultId;
  if (existing && existing.length > 0) return existing;
  const id = globalThis.crypto?.randomUUID?.() ??
    `vault-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  plugin.settings.vaultId = id;
  await plugin.saveSettings();
  return id;
}

/** True for Bevia's own materialized output — never ship it back as intake. */
function isBeviaOwned(path: string): boolean {
  return BEVIA_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p));
}

/** Walk the vault and send user-authored notes to Bevia as intake.
 *  Returns a summary. Never modifies the vault. */
export async function sendVaultToBevia(
  plugin: BeviaNavigatorPlugin,
): Promise<{ sent: number; skipped: number; batches: number }> {
  const token = plugin.settings.token?.trim() ?? "";
  if (plugin.settings.localMode) {
    // Bevia Local: intake goes to the local engine (postVaultNotes
    // reroutes to POST /intake/capture) — the cloud token is not needed,
    // but the vault must be paired.
    if (!plugin.settings.localToken?.trim()) {
      new Notice(
        "Bevia Local is on but this vault isn't paired yet — open Settings → Bevia Local and connect with the code from the desktop app.",
      );
      return { sent: 0, skipped: 0, batches: 0 };
    }
  } else if (!token) {
    new Notice("Bevia: paste your token in Settings → Bevia Navigator first.");
    return { sent: 0, skipped: 0, batches: 0 };
  }

  const vaultId = await getOrCreateVaultId(plugin);
  const files = plugin.app.vault.getMarkdownFiles();
  const config = { baseUrl: plugin.settings.baseUrl, token };

  let sent = 0;
  let skipped = 0;
  let batches = 0;
  let batch: VaultIntakeNote[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    batches += 1;
    const resp = await postVaultNotes(config, { vault_id: vaultId, notes: batch });
    sent += resp.moments;
    batch = [];
  };

  new Notice(`Bevia: scanning ${files.length} notes…`);

  for (const file of files) {
    if (!(file instanceof TFile)) continue;
    // R1 tail-guard mirror: never ship Bevia's own output back as intake —
    // with ONE carve-out (founder direction 2026-07-05): the "## Yours"
    // section of an idea note is USER-authored, not Bevia output. A user
    // annotating their own returning idea is the strongest signal a
    // capture lane can carry. Only the Yours text ships; the managed
    // body above the marker never re-enters the substrate.
    // Bevia/5 Workspace is the USER'S zone — their new notes land there by
    // default (routeNewNotesToWorkspace) and their workspace writing is
    // exactly the evidence intake exists to carry. It falls through to the
    // normal path below; the bevia_generated frontmatter check catches the
    // Bevia-composed scaffolds (workspace indexes / dossiers) so only the
    // user's own writing ships. Without this carve-out, every note a user
    // created in Obsidian was silently invisible to their own map.
    const isUserWorkspace = file.path.startsWith("Bevia/5 Workspace/");
    if (isBeviaOwned(file.path) && !isUserWorkspace) {
      if (file.path.startsWith("Bevia/2 Ideas/")) {
        try {
          const raw = await plugin.app.vault.cachedRead(file);
          const idx = raw.indexOf("\n## Yours");
          const yours = idx === -1 ? "" : raw.slice(idx + "\n## Yours".length).trim();
          if (yours.length >= 20) {
            batch.push({
              path: file.path,
              content_text: `My note on the idea "${file.basename}":\n\n${yours}`,
              title: `${file.basename} — your note`,
              occurred_at: new Date(file.stat.mtime).toISOString(),
            });
            if (batch.length >= BATCH_SIZE) await flush();
            continue;
          }
        } catch {
          /* unreadable — fall through to skip */
        }
      }
      skipped += 1;
      continue;
    }
    const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter as
      | Record<string, unknown>
      | undefined;
    // Mirror of the server guard's isBeviaProvenancedNote (echo audit
    // 2026-07-20): the stamp the materializers ACTUALLY emit is
    // bevia_schema_version / mapped_by — the booleans alone missed
    // Bevia-composed notes moved out of Bevia/ or living in Workspace.
    if (
      fm &&
      (fm["bevia_managed"] === true ||
        fm["bevia_generated"] === true ||
        (typeof fm["bevia_schema_version"] === "string" && fm["bevia_schema_version"].length > 0) ||
        typeof fm["bevia_schema_version"] === "number" ||
        fm["mapped_by"] === "Bevia")
    ) {
      skipped += 1;
      continue;
    }

    let content = "";
    try {
      content = await plugin.app.vault.cachedRead(file);
    } catch {
      skipped += 1;
      continue;
    }
    if (content.length < MIN_TEXT_LEN) {
      skipped += 1;
      continue;
    }

    batch.push({
      path: file.path, // already vault-relative — canonical source_ref for free
      content_text: content,
      title: file.basename,
      occurred_at: new Date(file.stat.mtime).toISOString(),
    });

    if (batch.length >= BATCH_SIZE) {
      try {
        await flush();
      } catch (e) {
        new Notice(`Bevia vault intake error: ${(e as Error).message}`);
        return { sent, skipped, batches };
      }
    }
  }

  try {
    await flush();
  } catch (e) {
    new Notice(`Bevia vault intake error: ${(e as Error).message}`);
    return { sent, skipped, batches };
  }

  new Notice(`Bevia: sent ${sent} notes (${skipped} skipped) from this vault.`);
  return { sent, skipped, batches };
}
