// Bevia Navigator — Reactivate workflow.
//
// The bridge from Atlas (museum) to Workspace (studio). When the user
// opens a landmark file in Obsidian and clicks "Reactivate this
// landmark," this module:
//   1. Reads the landmark_id from the current note's frontmatter
//   2. Calls /landmark-reactivation-bundle to fetch the substrate
//      context (concepts that emerged, related landmarks, opens)
//   3. Creates Workspace/<safeFilename>/00 - Index.md pre-populated
//      with origin landmark + emerged concepts + open questions
//      + space for the user's own work
//   4. Opens the Index file in Obsidian
//
// Doctrine (CLAUDE.md § Source-immutability per ADR-0138):
//   - The plugin NEVER modifies the source landmark file
//   - Workspace/ is the user's namespace forever — Bevia doesn't
//     write there outside this explicit user-initiated action
//   - The Index file just references the landmark via wikilink; the
//     user owns it from creation onward
//
// User-sketched architecture (2026-06-08):
//   "Atlas = Museum / Archive / Memory
//    Workspace = Studio / Workbench / Project Room
//    Reactivate = bridge between them"

import { App, Notice, TFile, TFolder, requestUrl } from "obsidian";
import type { BeviaClientConfig } from "./api";

interface ReactivationBundle {
  landmark: {
    id: string;
    title: string;
    narrative: string;
    decisions: string[];
    opens: string[];
    moves: Array<{ actor: string; move: string }>;
    participants: string[];
    primary_driver: string | null;
    landmark_type: string | null;
    date: string;
  };
  concepts: Array<{
    id: string;
    title: string;
    summary: string;
    verbatim_phrases: string[];
    concept_type: string;
  }>;
  related_landmarks: Array<{
    id: string;
    title: string;
    date: string | null;
    narrative_excerpt: string;
    shared_concept_titles: string[];
  }>;
  opens: string[];
}

interface ReactivationResponse {
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

/** Read `landmark_id: <uuid>` from the active note's frontmatter via
 *  Obsidian's metadata cache. Returns null when the active file isn't
 *  a Bevia landmark. */
function extractLandmarkId(app: App, file: TFile): string | null {
  const cache = app.metadataCache.getFileCache(file);
  const frontmatter = cache?.frontmatter;
  if (!frontmatter) return null;
  const id = frontmatter["landmark_id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function fetchReactivationBundle(
  config: BeviaClientConfig,
  landmarkId: string,
): Promise<ReactivationBundle> {
  if (!config.token) {
    throw new Error(
      "Bevia token missing — open Settings → Bevia Navigator and paste your token.",
    );
  }
  const url = `${config.baseUrl.replace(/\/+$/, "")}/functions/v1/landmark-reactivation-bundle`;
  const res = await requestUrl({
    url,
    method: "POST",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ landmark_id: landmarkId }),
    throw: false,
  });
  if (res.status >= 400) {
    let detail = "";
    try {
      const j = res.json as ReactivationResponse;
      detail = j?.error ?? "";
    } catch {
      detail = res.text?.slice(0, 200) ?? "";
    }
    throw new Error(`Bevia returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const payload = res.json as ReactivationResponse;
  if (!payload?.ok || !payload.bundle) {
    throw new Error(payload?.error ?? "Empty reactivation bundle");
  }
  return payload.bundle;
}

function composeIndexBody(bundle: ReactivationBundle): string {
  const lines: string[] = [];
  const { landmark, concepts, related_landmarks, opens } = bundle;

  // Frontmatter — marks this as a Workspace index so future
  // automations can find it.
  lines.push("---");
  lines.push("workspace_kind: reactivation");
  lines.push(`origin_landmark_id: ${landmark.id}`);
  lines.push(`origin_landmark_title: ${JSON.stringify(landmark.title)}`);
  lines.push(`reactivated_at: ${new Date().toISOString()}`);
  // Provenance stamp: this scaffold is Bevia-composed (from server-side
  // summaries), so intake must not loop it back as user evidence. The
  // user's OWN notes in the Workspace carry no stamp and DO ship.
  lines.push("bevia_generated: true");
  lines.push("tags: [workspace, reactivation]");
  lines.push("---");
  lines.push("");

  // Title + framing
  lines.push(`# ${landmark.title}`);
  lines.push("");
  lines.push(
    "*A workspace in your atlas — a studio you opened from the landmark of the same name. " +
      "Atlas is read-only; this folder is yours to write in. The links below point back to " +
      "Bevia's record of the original event so you can refer to it anytime. " +
      "Nothing you write here flows back to Bevia unless you explicitly publish it.*",
  );
  lines.push("");

  // Origin landmark — wikilink back to the source
  lines.push("## The spark");
  lines.push("");
  lines.push(`From: [[${safeFilename(`${landmark.date}-${landmark.title}`)}|${landmark.title}]] · ${landmark.date}`);
  lines.push("");
  if (landmark.narrative && landmark.narrative.trim()) {
    lines.push("> " + landmark.narrative.trim().split("\n").join("\n> "));
    lines.push("");
  }

  // Concepts that emerged
  if (concepts.length > 0) {
    lines.push("## Concepts that emerged");
    lines.push("");
    lines.push("*Each of these is a separate file in Bevia/4 Map/Concepts/. Click any to see its full definition + verbatim phrases + provenance.*");
    lines.push("");
    for (const c of concepts) {
      lines.push(`- [[${safeFilename(c.title)}|${c.title}]] — *${c.concept_type}*`);
      if (c.summary && c.summary.trim()) {
        lines.push(`  ${c.summary.trim().split("\n").join(" ").slice(0, 200)}`);
      }
    }
    lines.push("");
  }

  // Open questions — what the landmark left unresolved
  if (opens.length > 0) {
    lines.push("## What was left open");
    lines.push("");
    lines.push("*Questions the original conversation surfaced but didn't resolve. Each one is a thread you could pull on.*");
    lines.push("");
    for (const o of opens) {
      lines.push(`- ${o.trim()}`);
    }
    lines.push("");
  }

  // Decisions — what the landmark committed
  if (landmark.decisions && landmark.decisions.length > 0) {
    lines.push("## What was decided");
    lines.push("");
    lines.push("*Commitments from the original event. These are the load-bearing claims this workspace inherits.*");
    lines.push("");
    for (const d of landmark.decisions) {
      lines.push(`- ${d.trim()}`);
    }
    lines.push("");
  }

  // Related landmarks — the cognitive neighborhood
  if (related_landmarks.length > 0) {
    lines.push("## Nearby in your atlas");
    lines.push("");
    lines.push("*Other landmarks that share concepts with this one — the surrounding cognitive context.*");
    lines.push("");
    for (const rl of related_landmarks) {
      const date = rl.date ? ` *(${rl.date})*` : "";
      const shared = rl.shared_concept_titles.length > 0
        ? ` — shared: ${rl.shared_concept_titles.slice(0, 3).join(", ")}`
        : "";
      lines.push(`- [[${safeFilename(`${rl.date}-${rl.title}`)}|${rl.title}]]${date}${shared}`);
    }
    lines.push("");
  }

  // User scratchpad — empty sections for the workspace work
  lines.push("---");
  lines.push("");
  lines.push("## My next steps");
  lines.push("");
  lines.push("*Write here. This is yours.*");
  lines.push("");
  lines.push("");
  lines.push("## Drafts and notes");
  lines.push("");
  lines.push("*Create new files in this folder for chapters, drafts, research, anything. They all stay yours.*");
  lines.push("");

  return lines.join("\n");
}

/** Top-level command. Reads landmark_id from active file, fetches
 *  bundle, creates Workspace folder + Index, opens it. */
export async function reactivateActiveLandmark(
  app: App,
  config: BeviaClientConfig,
): Promise<void> {
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
    bundle = await fetchReactivationBundle(config, landmarkId);
  } catch (err) {
    new Notice(`Couldn't fetch bundle: ${(err as Error).message}`);
    return;
  }

  const folderName = safeFilename(bundle.landmark.title);
  // Inside Bevia/5 Workspace — the ONE user-owned zone the whole product
  // promises to confine itself to. (A top-level Workspace/ folder broke
  // the "Bevia only writes under Bevia/" invariant every other surface
  // states, and split the user's studio across two roots.)
  const workspaceRoot = "Bevia/5 Workspace";
  const folderPath = `${workspaceRoot}/${folderName}`;
  const indexPath = `${folderPath}/00 - Index.md`;

  // Ensure the Workspace root exists, then the per-landmark folder.
  // Obsidian's createFolder throws if it already exists; we swallow
  // and continue.
  try {
    if (!app.vault.getAbstractFileByPath(workspaceRoot)) {
      await app.vault.createFolder(workspaceRoot);
    }
  } catch {
    // already exists
  }
  try {
    const subfolder = app.vault.getAbstractFileByPath(folderPath);
    if (!subfolder) {
      await app.vault.createFolder(folderPath);
    } else if (!(subfolder instanceof TFolder)) {
      new Notice(`${folderPath} exists but isn't a folder.`);
      return;
    }
  } catch {
    // already exists
  }

  // Write the Index file — but NEVER overwrite an existing one. The
  // Workspace is the user's studio: the index copy tells them the
  // scratchpad sections are theirs, so re-running Reactivate must not
  // clobber their edits. If it exists, just open it.
  const existing = app.vault.getAbstractFileByPath(indexPath);
  if (existing instanceof TFile) {
    await app.workspace.getLeaf(false).openFile(existing);
    new Notice(`Opened your existing workspace: ${folderName}/ (your edits kept).`);
    return;
  }
  await app.vault.create(indexPath, composeIndexBody(bundle));

  // Open the index in the active leaf so the user lands inside it.
  const indexFile = app.vault.getAbstractFileByPath(indexPath);
  if (indexFile instanceof TFile) {
    await app.workspace.getLeaf(false).openFile(indexFile);
    new Notice(`Reactivated: ${folderName}/`);
  }
}
