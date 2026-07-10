// Bevia Navigator — "Think More About This" (ADR-0192, Think mode).
//
// Sibling of reactivate.ts, one altitude up. Reactivate opens a
// Workspace from a single landmark; Think opens a *Thinking* workspace
// from a whole territory. When the user opens a territory file in
// Obsidian and runs "Think more about this," this module:
//   1. Reads theme_id (or territory_id) from the note's frontmatter
//   2. Calls /territory-research-dossier for the substrate context
//   3. Creates Workspace/Thinking/<territory>/00 - Research Dossier.md
//      pre-populated with the territory + its concepts + landmarks +
//      open research questions + a scratchpad
//   4. Opens it
//
// Same doctrine as Reactivate (ADR-0138): the source note is never
// modified; Workspace/ is the user's namespace forever; the dossier
// only references the atlas via wikilinks. Workspace/ sits OUTSIDE the
// sync mirror's MANAGED_PREFIXES, so the user's writing here is never
// reaped (ADR-0192 — worksites are intake zones, not mirror zones).

import { App, Notice, TFile, TFolder, requestUrl } from "obsidian";
import type { BeviaClientConfig } from "./api";

interface ResearchDossier {
  territory: {
    id: string;
    label: string;
    summary: string;
    concept_slugs: string[];
    recurrence_count: number;
    status: string;
    first_seen: string;
    last_seen: string;
  };
  concepts: Array<{ id: string; title: string; summary: string; concept_type: string }>;
  related_territories: Array<{ id: string; label: string; recurrence_count: number; shared_concepts: string[] }>;
  landmarks: Array<{ id: string; title: string; date: string; narrative_excerpt: string }>;
  research_questions: string[];
}

interface DossierResponse {
  ok: boolean;
  bundle?: ResearchDossier;
  error?: string;
}

function safeFilename(label: string): string {
  return label
    .replace(/[\/\\:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

/** Read theme_id / territory_id from the active note's frontmatter. */
function extractTerritoryId(app: App, file: TFile): string | null {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!fm) return null;
  const id = fm["theme_id"] ?? fm["territory_id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function fetchDossier(config: BeviaClientConfig, territoryId: string): Promise<ResearchDossier> {
  if (!config.token) {
    throw new Error("Bevia token missing — open Settings → Bevia Navigator and paste your token.");
  }
  const url = `${config.baseUrl.replace(/\/+$/, "")}/functions/v1/territory-research-dossier`;
  const res = await requestUrl({
    url,
    method: "POST",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ territory_id: territoryId }),
    throw: false,
  });
  if (res.status >= 400) {
    let detail = "";
    try { detail = (res.json as DossierResponse)?.error ?? ""; } catch { detail = res.text?.slice(0, 200) ?? ""; }
    throw new Error(`Bevia returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const payload = res.json as DossierResponse;
  if (!payload?.ok || !payload.bundle) throw new Error(payload?.error ?? "Empty research dossier");
  return payload.bundle;
}

function composeDossierBody(bundle: ResearchDossier): string {
  const { territory, concepts, related_territories, landmarks, research_questions } = bundle;
  const lines: string[] = [];

  lines.push("---");
  lines.push("workspace_kind: thinking");
  // Provenance stamp — Bevia-composed scaffold; intake must not loop it
  // back as user evidence (the user's own Workspace notes carry no stamp).
  lines.push("bevia_generated: true");
  lines.push("thinking_subject: territory");
  lines.push(`subject_id: ${territory.id}`);
  lines.push(`subject_label: ${JSON.stringify(territory.label)}`);
  lines.push(`opened_at: ${new Date().toISOString()}`);
  lines.push("tags: [workspace, thinking]");
  lines.push("---");
  lines.push("");

  lines.push(`# Thinking — ${territory.label}`);
  lines.push("");
  lines.push(
    "*A thinking space you opened from this territory. The Atlas is read-only; this folder is " +
      "yours to write in. Links point back to Bevia's record so you can refer to it anytime. " +
      "Nothing you write here flows back to Bevia unless you explicitly publish it.*",
  );
  lines.push("");

  lines.push("## The territory");
  lines.push("");
  if (territory.summary?.trim()) {
    lines.push("> " + territory.summary.trim().split("\n").join("\n> "));
    lines.push("");
  }
  const span = territory.first_seen && territory.last_seen ? ` · ${territory.first_seen} → ${territory.last_seen}` : "";
  lines.push(`*${territory.recurrence_count} recurrences · ${territory.status}${span}*`);
  lines.push("");

  if (concepts.length > 0) {
    lines.push("## Concepts that live here");
    lines.push("");
    for (const c of concepts) {
      lines.push(`- [[${safeFilename(c.title)}|${c.title}]] — *${c.concept_type}*`);
      if (c.summary?.trim()) lines.push(`  ${c.summary.trim().split("\n").join(" ").slice(0, 200)}`);
    }
    lines.push("");
  }

  if (research_questions.length > 0) {
    lines.push("## Open questions to pull on");
    lines.push("");
    lines.push("*Threads this territory left unresolved. Each is somewhere your thinking could go next.*");
    lines.push("");
    for (const q of research_questions) lines.push(`- [ ] ${q}`);
    lines.push("");
  }

  if (landmarks.length > 0) {
    lines.push("## Key moments that formed this");
    lines.push("");
    for (const l of landmarks) {
      const date = l.date ? ` *(${l.date})*` : "";
      lines.push(`- [[${safeFilename(`${l.date}-${l.title}`)}|${l.title}]]${date}`);
      if (l.narrative_excerpt) lines.push(`  ${l.narrative_excerpt}`);
    }
    lines.push("");
  }

  if (related_territories.length > 0) {
    lines.push("## Nearby territories");
    lines.push("");
    lines.push("*Regions that share concepts with this one — where thinking here might connect.*");
    lines.push("");
    for (const rt of related_territories) {
      const shared = rt.shared_concepts.length > 0 ? ` — shared: ${rt.shared_concepts.slice(0, 3).join(", ")}` : "";
      lines.push(`- [[${safeFilename(rt.label)}|${rt.label}]]${shared}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## My thinking");
  lines.push("");
  lines.push("*Write here. This is yours. Pull on a question, follow a connection, see where it goes.*");
  lines.push("");

  return lines.join("\n");
}

export async function thinkAboutActiveTerritory(app: App, config: BeviaClientConfig): Promise<void> {
  const activeFile = app.workspace.getActiveFile();
  if (!activeFile) {
    new Notice("Open a territory file first.");
    return;
  }
  const territoryId = extractTerritoryId(app, activeFile);
  if (!territoryId) {
    new Notice(
      "This file doesn't look like a Bevia territory — no theme_id in frontmatter. " +
        "Open a file under Bevia/4 Map/Territories/ and try again.",
    );
    return;
  }

  let bundle: ResearchDossier;
  try {
    bundle = await fetchDossier(config, territoryId);
  } catch (err) {
    new Notice(`Couldn't open a thinking space: ${(err as Error).message}`);
    return;
  }

  const folderName = safeFilename(bundle.territory.label);
  // Inside Bevia/5 Workspace — the one user-owned zone (see reactivate.ts).
  const workspaceRoot = "Bevia/5 Workspace";
  const folderPath = `${workspaceRoot}/Thinking/${folderName}`;
  const indexPath = `${folderPath}/00 - Research Dossier.md`;

  for (const dir of [workspaceRoot, `${workspaceRoot}/Thinking`, folderPath]) {
    try {
      if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
    } catch {
      // already exists
    }
  }
  const existingFolder = app.vault.getAbstractFileByPath(folderPath);
  if (existingFolder && !(existingFolder instanceof TFolder)) {
    new Notice(`${folderPath} exists but isn't a folder.`);
    return;
  }

  // Never overwrite an existing dossier — the copy tells the user the
  // scratchpad is theirs, so re-running Think must not clobber it.
  const existing = app.vault.getAbstractFileByPath(indexPath);
  if (existing instanceof TFile) {
    await app.workspace.getLeaf(false).openFile(existing);
    new Notice(`Opened your existing thinking space: ${folderName}/ (your edits kept).`);
    return;
  }
  await app.vault.create(indexPath, composeDossierBody(bundle));

  const indexFile = app.vault.getAbstractFileByPath(indexPath);
  if (indexFile instanceof TFile) {
    await app.workspace.getLeaf(false).openFile(indexFile);
    new Notice(`Thinking space opened: ${folderPath}/`);
  }
}
