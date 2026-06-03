import { DatabaseReader } from "./_generated/server";
import { ConvexError } from "convex/values";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function requireSession(db: DatabaseReader, token: string) {
  const session = await db
    .query("sessions")
    .withIndex("by_token", q => q.eq("token", token))
    .first();
  if (!session) throw new ConvexError("SESSION_INVALID");
  if (Date.now() - session.createdAt > SESSION_TTL_MS) throw new ConvexError("SESSION_EXPIRED");
  const user = await db.get(session.userId);
  if (!user || user.roles.includes("removed")) throw new ConvexError("SESSION_INVALID");
  return user;
}

type WithRoles = { roles: string[] };

const APPROVED_ROLES = ["gatherer", "logistics", "crafter", "distributor", "admin"];

// A "pending" user holds none of the functional roles yet — no data access.
export function assertApproved(user: WithRoles) {
  if (!user.roles.some(r => APPROVED_ROLES.includes(r))) throw new ConvexError("Not authorized");
}

// Throw unless the user holds at least one of the allowed roles.
export function assertRole(user: WithRoles, allowed: string[]) {
  if (!user.roles.some(r => allowed.includes(r))) throw new ConvexError("Not authorized");
}

// Convenience: an approved (non-pending, non-removed) authenticated session.
export async function requireMember(db: DatabaseReader, token: string) {
  const user = await requireSession(db, token);
  assertApproved(user);
  return user;
}
