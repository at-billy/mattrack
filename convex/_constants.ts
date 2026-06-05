import { ConvexError } from "convex/values";

// ── Role taxonomy ──────────────────────────────────────────────────────────────
// Mattrack functional roles. A user can hold several at once; "admin" is special.
// A user with NONE of these is "pending" (signed up, awaiting approval).
export const ROLES = ["gatherer", "logistics", "crafter", "distributor", "admin"];
// Roles a user may request at sign-up and an admin may grant/revoke.
// "admin" is excluded — granted only via grantAdmin / claimBootstrapAdmin.
export const REQUESTABLE_ROLES = ["gatherer", "logistics", "crafter", "distributor"];
export const GRANTABLE_ROLES = REQUESTABLE_ROLES;

// Roles a workorder/task can target for visibility.
export const TASK_TARGET_ROLES = ["gatherer", "logistics", "crafter", "distributor", "admin"];

// ── Quality bands ───────────────────────────────────────────────────────────────
// Refined-material quality is graded in 8 bands (the in-game quality-% ranges).
// Each material carries a per-band value (0–1000) from the client's data. A stock
// row stores the band index (step 1..8); its value is looked up from the catalog.
export const QUALITY_BANDS = ["0–399", "400–599", "600–699", "700–799", "800–899", "900–949", "950–998", "999–1000"];
export const QUALITY_STEPS = QUALITY_BANDS.length; // 8

// ── Enums ──────────────────────────────────────────────────────────────────────
export const TASK_PRIORITIES = ["urgent", "high", "normal", "whenever"];
export const ITEM_CATEGORIES = ["fps_armor", "fps_weapon", "ship_component", "ship_weapon", "wikelo", "other"];

// ── Validation helpers ───────────────────────────────────────────────────────────
export function assertIn(value: string, allowed: string[], label: string) {
  if (!allowed.includes(value)) throw new ConvexError(`Invalid ${label}`);
}

export function assertSubset(values: string[], allowed: string[], label: string) {
  for (const v of values) if (!allowed.includes(v)) throw new ConvexError(`Invalid ${label}`);
}

export function assertLen(value: string, max: number, label: string) {
  if (value.length > max) throw new ConvexError(`${label} is too long`);
}

export function assertPositiveInt(n: number, label: string) {
  if (!Number.isInteger(n) || n <= 0) throw new ConvexError(`Invalid ${label}`);
}
