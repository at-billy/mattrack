import { DatabaseWriter } from "./_generated/server";
import { ConvexError } from "convex/values";

// Brute-force throttle for password checks. Per-key (e.g. "login:<username>").
// Policy: every THRESHOLD consecutive failures triggers an escalating lockout
// (60s → 5m → 15m → 1h, capped). The consecutive counter resets after WINDOW_MS
// of no failures, and a success clears the record entirely.
const THRESHOLD = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_LADDER_S = [60, 300, 900, 3600]; // seconds; last value repeats (cap 1h)

type Row = { _id: any; key: string; fails: number; lockedUntil?: number; lastFailAt?: number };

async function find(db: DatabaseWriter, key: string): Promise<Row | null> {
  return (await db.query("authThrottle").withIndex("by_key", q => q.eq("key", key)).first()) as Row | null;
}

// Throw if the key is currently locked. Returns the row so callers can reuse it.
export async function assertNotLocked(db: DatabaseWriter, key: string): Promise<Row | null> {
  const row = await find(db, key);
  if (row?.lockedUntil && row.lockedUntil > Date.now()) {
    const secs = Math.ceil((row.lockedUntil - Date.now()) / 1000);
    throw new ConvexError(`TOO_MANY_ATTEMPTS:${secs}`);
  }
  return row;
}

// Record a failed attempt; apply an escalating lock once THRESHOLD is hit.
export async function recordFailure(db: DatabaseWriter, key: string, existing?: Row | null) {
  const now = Date.now();
  const row = existing !== undefined ? existing : await find(db, key);
  const fresh = !row || !row.lastFailAt || (now - row.lastFailAt) > WINDOW_MS;
  const fails = fresh ? 1 : row!.fails + 1;
  let lockedUntil = row?.lockedUntil;
  if (fails % THRESHOLD === 0) {
    const cycle = Math.floor(fails / THRESHOLD) - 1;
    lockedUntil = now + LOCK_LADDER_S[Math.min(cycle, LOCK_LADDER_S.length - 1)] * 1000;
  }
  if (row) await db.patch(row._id, { fails, lockedUntil, lastFailAt: now });
  else await db.insert("authThrottle", { key, fails, lockedUntil, lastFailAt: now });
}

// Clear the record on a successful auth.
export async function clearThrottle(db: DatabaseWriter, key: string, existing?: Row | null) {
  const row = existing !== undefined ? existing : await find(db, key);
  if (row) await db.delete(row._id);
}
