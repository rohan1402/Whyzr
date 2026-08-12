// server/config.mjs: every knob in one place, read from env with safe
// defaults. Nothing secret is ever defaulted: WHYZR_CODE and ADMIN_KEY have
// no fallback value, and their absence changes behaviour explicitly (see
// LOCAL_DEV below) rather than silently permitting access.

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

// Load .env (gitignored) for local runs. Host env always wins.
const envPath = join(REPO_ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const bool = (name, fallback = false) => {
  const v = (process.env[name] || "").toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
};

export const config = {
  port: num("PORT", 3456),

  // Persistent volume. Everything here lives OUTSIDE every git repo:
  // registry, kid repos, transcripts. Never committed, never agent-readable.
  dataDir: process.env.WHYZR_DATA_DIR || join(REPO_ROOT, ".whyzr-data"),

  // Access. Note the distinction between UNSET and SET-BUT-EMPTY: an empty
  // WHYZR_CODE is a deploy typo, not permission to run without a gate.
  code: process.env.WHYZR_CODE ?? null,
  adminKey: process.env.ADMIN_KEY || null,

  // Session shape
  sessionMaxMs: num("WHYZR_SESSION_MINUTES", 20) * 60_000,
  maxTurnsPerSession: num("MAX_TURNS_PER_SESSION", 30),
  maxSessionsPerDay: num("MAX_SESSIONS_PER_DAY", 3),
  maxDailyTokensPerKid: num("MAX_DAILY_TOKENS", 400_000),
  // ~$0.009 per turn measured, so a full 30-turn session is about $0.25.
  // $1 covers 3 to 4 full sessions, which matches the 3-per-day kid cap.
  dailyBudgetUsd: Number(process.env.DAILY_BUDGET_USD || 1),

  // Testing only. Off by default so the README claim stays true in prod.
  saveTranscripts: bool("SAVE_TRANSCRIPTS", false),

  // Rate limiting (per IP, in-memory; fine for one small instance)
  rateWindowMs: num("RATE_WINDOW_MS", 60_000),
  rateMaxRequests: num("RATE_MAX_REQUESTS", 60),

  // How many trusted proxies sit in front of this app. X-Forwarded-For is
  // client-controlled, so it is only consulted when this is set (Railway and
  // Fly both put exactly one proxy in front: TRUST_PROXY_HOPS=1).
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS || 0),

  // M1 is a single-tester deployment. Refuse to mint more kids than this so a
  // leaked code cannot fill the volume with repos.
  // Two, not one. The product's central claim is that two children of the
  // same tutor diverge, and `git diff child-a child-b -- skills/` cannot be
  // run on a deployment that refuses to create child b. A cap of 1 made the
  // README tell readers to run a command the shipped defaults forbade.
  maxKids: num("MAX_KIDS", 2),
};

// Dev mode is an EXPLICIT opt-in, never an inference from a missing secret.
// Inferring it meant a deploy that set WHYZR_CODE to an empty string (or
// forgot it entirely) silently served the app with no gate at all.
export const LOCAL_DEV = bool("WHYZR_OPEN_DEV", false);

/**
 * Fail fast rather than fail open. Called by the SERVER at startup only:
 * importing this module must stay side-effect free so CLI tools (npm run
 * review) and the eval harness can read config without a code being set.
 *
 * Note the gate is already closed by default even without this check:
 * checkCode compares against a null code and rejects everything.
 */
export function assertServerConfig() {
  if (LOCAL_DEV) return;
  if (config.code === null) {
    console.error(
      "\nWHYZR_CODE is not set.\n" +
      "Set it to the access code testers will type, or set WHYZR_OPEN_DEV=1 to\n" +
      "run locally with no gate. Refusing to start ungated.\n"
    );
    process.exit(1);
  }
  if (config.code.trim().length < 6) {
    console.error("\nWHYZR_CODE is empty or too short (minimum 6 characters). Refusing to start.\n");
    process.exit(1);
  }
}

export const paths = {
  registry: () => join(config.dataDir, "registry.json"),
  kidsDir: () => join(config.dataDir, "kids"),
  kidRepo: (id) => join(config.dataDir, "kids", id),
  transcriptsDir: (id) => join(config.dataDir, "transcripts", id),
  // The agent repo: a clone of the source with every remote stripped. All
  // child branches and worktrees live here, never in the source repository,
  // so children's data can never be pushed to the public GitHub repo and
  // the developer's own origin stays intact.
  agentRepo: () => join(config.dataDir, "agent-repo"),
  // Session locks live outside every worktree so they cannot dirty git state.
  locksDir: () => join(config.dataDir, "locks"),
};

export function ensureDataDirs() {
  for (const d of [config.dataDir, paths.kidsDir(), paths.locksDir(), join(config.dataDir, "transcripts")]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}
