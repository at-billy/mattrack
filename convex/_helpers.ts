import { DatabaseReader } from "./_generated/server";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function requireSession(db: DatabaseReader, token: string) {
  const session = await db
    .query("sessions")
    .withIndex("by_token", q => q.eq("token", token))
    .first();
  if (!session) throw new Error("SESSION_INVALID");
  if (Date.now() - session.createdAt > SESSION_TTL_MS) throw new Error("SESSION_EXPIRED");
  const user = await db.get(session.userId);
  if (!user || user.roles.includes("removed")) throw new Error("SESSION_INVALID");
  return user;
}
