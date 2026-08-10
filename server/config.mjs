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

  // Access. No default: if unset we are in local dev and the gate is open.
  code: process.env.WHYZR_CODE || null,
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
};

// With no code configured we are running on a developer's machine: the gate
// opens so local testing needs no secrets. In production the code is set, so
// this is never true.
export const LOCAL_DEV = config.code === null;

export const paths = {
  registry: () => join(config.dataDir, "registry.json"),
  kidsDir: () => join(config.dataDir, "kids"),
  kidRepo: (id) => join(config.dataDir, "kids", id),
  transcriptsDir: (id) => join(config.dataDir, "transcripts", id),
};

export function ensureDataDirs() {
  for (const d of [config.dataDir, paths.kidsDir(), join(config.dataDir, "transcripts")]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}
