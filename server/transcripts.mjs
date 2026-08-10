// server/transcripts.mjs: TESTING ONLY conversation capture.
//
// Off by default (SAVE_TRANSCRIPTS=false). Turned on for the sibling test so
// RULES.md can be tuned against real kid conversations, then turned off and
// the directory deleted before any public launch, so the README claim
// ("raw conversations are not kept") stays true.
//
// Transcripts live at <dataDir>/transcripts/<kid>/<session>.json: outside
// every git repo, never committed, never readable by the agent.

import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths, config } from "./config.mjs";

export function saveTranscript(kidId, sessionId, payload) {
  if (!config.saveTranscripts) return null;
  const dir = paths.transcriptsDir(kidId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

export function listTranscripts() {
  const base = join(config.dataDir, "transcripts");
  if (!existsSync(base)) return [];
  const out = [];
  for (const kid of readdirSync(base)) {
    const dir = join(base, kid);
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      let meta = {};
      try {
        const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
        meta = { turns: parsed.turns, startedAt: parsed.startedAt, why: parsed.why, branch: parsed.branch };
      } catch { /* unreadable file still listed */ }
      out.push({ kidId: kid, sessionId: f.replace(/\.json$/, ""), ...meta });
    }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export function readTranscript(kidId, sessionId) {
  // Defend against path traversal in ids coming from a query string.
  if (!/^[\w-]+$/.test(kidId) || !/^[\w:-]+$/.test(sessionId)) return null;
  const file = join(paths.transcriptsDir(kidId), `${sessionId}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** Used before public launch: remove every captured transcript. */
export function purgeTranscripts() {
  const base = join(config.dataDir, "transcripts");
  if (existsSync(base)) rmSync(base, { recursive: true, force: true });
}
