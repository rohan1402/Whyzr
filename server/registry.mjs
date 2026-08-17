// server/registry.mjs: the kid registry.
//
// Lives at <dataDir>/registry.json, OUTSIDE every git repo. It holds
// nickname, age, hashed parent PIN, device-token hashes and usage counters.
// It is never committed and never readable by the agent (the guard hook
// confines the agent to its own repo, and the registry is not in one).
//
// Writes are atomic (write temp, rename) so a crash mid-write cannot corrupt
// the file, and serialized through a promise chain so concurrent requests
// cannot interleave a read-modify-write.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { paths, ensureDataDirs } from "./config.mjs";

const EMPTY = { kids: {}, global: { spendUsd: 0, day: null } };

let cache = null;
let writeChain = Promise.resolve();

export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
export const today = () => new Date().toISOString().slice(0, 10);

function load() {
  if (cache) return cache;
  ensureDataDirs();
  const p = paths.registry();
  if (!existsSync(p)) {
    cache = structuredClone(EMPTY);
    return cache;
  }
  try {
    cache = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(p, "utf8")) };
  } catch (err) {
    // A corrupt registry must not take the app down or silently wipe data:
    // keep the bad file for inspection and start clean.
    const backup = `${p}.corrupt-${Date.now()}`;
    try { renameSync(p, backup); } catch { /* best effort */ }
    console.error(`[registry] unreadable, moved to ${backup}: ${err.message}`);
    cache = structuredClone(EMPTY);
  }
  return cache;
}

function persist() {
  const p = paths.registry();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, p);
}

/** Serialized read-modify-write. The mutator receives the live registry. */
export function update(mutator) {
  const run = writeChain.then(() => {
    // Re-read from disk before mutating. The in-memory cache is a READ
    // optimisation, and this process is not the only writer:
    // scripts/delete-child.sh removes a row from a separate process. Mutating
    // a stale cache and persisting the whole thing silently RESURRECTS a
    // deleted child, which is exactly what happened: a child deleted while
    // the server was running came back on the next registry write, during
    // shutdown. The deletion script had already printed "Verified: nothing
    // remains", and it had been true when it said so.
    //
    // For a product whose deletion path is a promise to a parent, a delete
    // that silently undoes itself is the worst possible failure, so writes
    // are now always based on what is actually on disk.
    cache = null;
    const reg = load();
    const result = mutator(reg);
    persist();
    return result;
  });
  writeChain = run.catch((err) => {
    console.error(`[registry] update failed: ${err.message}`);
  });
  return run;
}

export function read() {
  return load();
}

export function getKid(id) {
  return load().kids[id] || null;
}

export function findKidByNickname(nickname) {
  const reg = load();
  const key = String(nickname || "").trim().toLowerCase();
  for (const [id, kid] of Object.entries(reg.kids)) {
    if ((kid.nickname || "").toLowerCase() === key) return { id, ...kid };
  }
  return null;
}

// No `branch` field: a child's branch is always child-<id>, derived by
// worktrees.mjs. Storing it invited the two to disagree, and back when age
// was a branch they did.
export function createKid({ nickname, age, band, pinHash }) {
  const id = randomUUID().slice(0, 8);
  return update((reg) => {
    reg.kids[id] = {
      nickname: String(nickname).slice(0, 40),
      age,
      band,
      pinHash: pinHash || null,
      createdAt: new Date().toISOString(),
      tokenHashes: [],
      usage: { day: today(), sessions: 0, tokens: 0, spendUsd: 0 },
    };
    return id;
  }).then(() => id);
}

/** Reset a kid's per-day counters when the date rolls over. */
export function rollDay(kid) {
  const d = today();
  if (kid.usage.day !== d) {
    kid.usage = { day: d, sessions: 0, tokens: 0, spendUsd: 0 };
  }
  return kid;
}
