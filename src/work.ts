// Bevia Navigator — "Work On This" (ADR-0192, Work mode).
//
// The production sibling of Reactivate/Think. Where Think opens a space
// to *explore* a territory, Work opens a space to *build* from a
// landmark — draft the chapter, write the proposal, ship the thing.
//
// It reuses the existing /landmark-reactivation-bundle EF (same
// substrate; different orientation) and composes a production workspace:
// the kernel, the concepts, a deterministic draft outline, the decision
// record, and the user's own build area. Same doctrine as Reactivate
// (ADR-0138): source note never modified; Workspace/ is the user's
// forever; it sits outside the sync mirror's MANAGED_PREFIXES.

import { App, Notice, TFile, TFolder, requestUrl } from "obsidian";
import { LOCAL_UNAVAILABLE } from "./errors";
import { isLocalMode } from "./local";
import type { BeviaClientConfig } from "./api";

interface ReactivationBundle {
  landmark: {
    id: string;
    title: string;
    narrative: string;
    decisions: string[];
    opens: string[];
    participants: string[];
    landmark_type: string | null;
    date: string;
  };
  concepts: Array<{ id: string; title: string; summary: string; concept_type: string }>;
  related_landmarks: Array<{ id: string; title: string; date: string | null; shared_concept_titles: string[] }>;
  opens: string[];
}

interface BundleResponse {
  ok: boolean;
  bundle?: ReactivationBundle;
  error?: string;
}

function safeFilename(label: string): string {
  return label
    .replace(/[\/\\:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function extractLandmarkId(app: App, file: TFile): string | null {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  const id = fm?.["landmark_id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function fetchBundle(config: BeviaClientConfig, landmarkId: string): Promise<ReactivationBundle> {
  if (isLocalMode()) throw new Error(LOCAL_UNAVAILABLE); // leg 2: cloud-only
  if (!config.token) {
    throw new Error("Bevia token missing — open Settings → Bevia Navigator and paste your token.");
  }
  const url = `${config.baseUrl.replace(/\/+$/, "")}/functions/v1/landmark-reactivation-bundle`;
  const res = await requestUrl({
    url,
    method: "POST",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ landmark_id: landmarkId }),
    throw: false,
  });
  if (res.status >= 400) {
    let detail = "";
    try { detail = (res.json as BundleResponse)?.error ?? ""; } catch { detail = res.text?.slice(0, 200) ?? ""; }
    throw new Error(`Bevia returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const payload = res.json as BundleResponse;
  if (!payload?.ok || !payload.bundle) throw new Error(payload?.error ?? "Empty bundle");
  return payload.bundle;
}

/** A deterministic starting outline composed from what the landmark
 *  already carries — no LLM. The user rewrites it; it just removes the
 *  blank-page problem. */
function draftOutline(bundle: ReactivationBundle): string[] {
  const sections: string[] = ["Opening — what this is about"];
  if (bundle.concepts.length > 0) {
    sections.push(`Background — ${bundle.concepts.slice(0, 3).map((c) => c.title).join(", ")}`);
  }
  if (bundle.landmark.decisions.length > 0) sections.push("The argument — what was decided and why");
  if (bundle.opens.length > 0) sections.push("Open threads — what's still unresolved");
  sections.push("Conclusion — where this leaves us");
  return sections;
}

function composeWorkspaceBody(bundle: ReactivationBundle): string {
  const { landmark, concepts, opens } = bundle;
  const lines: string[] = [];

  lines.push("---");
  lines.push("workspace_kind: working");
  // Provenance stamp — Bevia-composed scaffold; intake must not loop it
  // back as user evidence (the user's own Workspace notes carry no stamp).
  lines.push("bevia_generated: true");
  lines.push("working_subject: landmark");
  lines.push(`subject_id: ${landmark.id}`);
  lines.push(`subject_label: ${JSON.stringify(landmark.title)}`);
  lines.push(`opened_at: ${new Date().toISOString()}`);
  lines.push("tags: [workspace, working]");
  lines.push("---");
  lines.push("");

  lines.push(`# Working — ${landmark.title}`);
  lines.push("");
  lines.push(
    "*A production space you opened from this landmark. Build here — draft, outline, write. " +
      "The Atlas is read-only; this folder is yours. Nothing flows back to Bevia unless you " +
      "explicitly publish it.*",
  );
  lines.push("");

  lines.push("## The kernel");
  lines.push("");
  lines.push(`From: [[${safeFilename(`${landmark.date}-${landmark.title}`)}|${landmark.title}]] · ${landmark.date}`);
  lines.push("");
  if (landmark.narrative?.trim()) {
    lines.push("> " + landmark.narrative.trim().split("\n").join("\n> "));
    lines.push("");
  }

  if (concepts.length > 0) {
    lines.push("## Core concepts");
    lines.push("");
    for (const c of concepts) lines.push(`- [[${safeFilename(c.title)}|${c.title}]] — *${c.concept_type}*`);
    lines.push("");
  }

  lines.push("## Draft outline");
  lines.push("");
  lines.push("*A starting skeleton from what the landmark already carries. Rewrite freely.*");
  lines.push("");
  for (const s of draftOutline(bundle)) {
    lines.push(`### ${s}`);
    lines.push("");
  }

  if (landmark.decisions.length > 0) {
    lines.push("## Decision record");
    lines.push("");
    for (const d of landmark.decisions) lines.push(`- ${d.trim()}`);
    lines.push("");
  }

  if (opens.length > 0) {
    lines.push("## Still open");
    lines.push("");
    for (const o of opens) lines.push(`- [ ] ${o.trim()}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## My work");
  lines.push("");
  lines.push("*Draft here, or create new files in this folder for chapters and sections. All yours.*");
  lines.push("");

  return lines.join("\n");
}

export async function workOnActiveLandmark(app: App, config: BeviaClientConfig): Promise<void> {
  const activeFile = app.workspace.getActiveFile();
  if (!activeFile) {
    new Notice("Open a landmark file first.");
    return;
  }
  const landmarkId = extractLandmarkId(app, activeFile);
  if (!landmarkId) {
    new Notice(
      "This file doesn't look like a Bevia landmark — no landmark_id in frontmatter. " +
        "Open a file under Bevia/4 Map/Landmarks/ and try again.",
    );
    return;
  }

  let bundle: ReactivationBundle;
  try {
    bundle = await fetchBundle(config, landmarkId);
  } catch (err) {
    new Notice(`Couldn't open a working space: ${(err as Error).message}`);
    return;
  }

  const folderName = safeFilename(bundle.landmark.title);
  // Inside Bevia/5 Workspace — the one user-owned zone (see reactivate.ts).
  const workspaceRoot = "Bevia/5 Workspace";
  const folderPath = `${workspaceRoot}/Working/${folderName}`;
  const indexPath = `${folderPath}/00 - Production Workspace.md`;

  for (const dir of [workspaceRoot, `${workspaceRoot}/Working`, folderPath]) {
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

  // Never overwrite an existing workspace — the copy tells the user the
  // scratchpad is theirs, so re-running Work must not clobber it.
  const existing = app.vault.getAbstractFileByPath(indexPath);
  if (existing instanceof TFile) {
    await app.workspace.getLeaf(false).openFile(existing);
    new Notice(`Opened your existing working space: ${folderName}/ (your edits kept).`);
    return;
  }
  await app.vault.create(indexPath, composeWorkspaceBody(bundle));

  const indexFile = app.vault.getAbstractFileByPath(indexPath);
  if (indexFile instanceof TFile) {
    await app.workspace.getLeaf(false).openFile(indexFile);
    new Notice(`Working space opened: ${folderPath}/`);
  }
}
