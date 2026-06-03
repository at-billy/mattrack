import { ConvexError } from "convex/values";

// ── Role taxonomy ──────────────────────────────────────────────────────────────
// Rank roles (granted by admins via grantRole):
export const RANK_ROLES = ["member", "core", "command"];
// Function roles (requestable, then granted):
export const FUNCTION_ROLES = ["crafter", "logistics", "provider"];
// Roles an admin may grant/revoke through grantRole/revokeRole.
// Deliberately excludes "admin" (granted only via grantAdmin), "recruit" (sign-up state),
// "removed" (set only by removeMember) and any "*_pending" placeholder.
export const GRANTABLE_ROLES = [...RANK_ROLES, ...FUNCTION_ROLES];

// Roles a project can target for visibility.
export const TASK_TARGET_ROLES = ["member", "core", "command", "admin"];

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
