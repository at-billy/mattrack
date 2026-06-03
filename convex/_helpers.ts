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

// Pure recruits (sign-up state only) have no data access.
export function assertNotRecruit(user: WithRoles) {
  const isPureRecruit = user.roles.length === 1 && user.roles[0] === "recruit";
  if (isPureRecruit) throw new ConvexError("Not authorized");
}

// Throw unless the user holds at least one of the allowed roles.
export function assertRole(user: WithRoles, allowed: string[]) {
  if (!user.roles.some(r => allowed.includes(r))) throw new ConvexError("Not authorized");
}

// Convenience: a non-recruit, non-removed authenticated session.
export async function requireMember(db: DatabaseReader, token: string) {
  const user = await requireSession(db, token);
  assertNotRecruit(user);
  return user;
}
