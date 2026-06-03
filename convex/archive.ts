import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireSession, requireMember } from "./_helpers";

// Reactive feed: most-recent entries only. Bounds the live subscription payload
// regardless of how large the log grows. Older entries load on demand via loadOlder.
const ARCHIVE_RECENT_LIMIT = 200;

export const getAll = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    await requireMember(ctx.db, sessionToken);
    return await ctx.db.query("archive").order("desc").take(ARCHIVE_RECENT_LIMIT);
  },
});

// On-demand pagination for the Log page: fetch entries older than a given timestamp.
export const loadOlder = query({
  args: { sessionToken: v.string(), before: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { sessionToken, before, limit }) => {
    await requireMember(ctx.db, sessionToken);
    const n = Math.min(Math.max(limit ?? 200, 1), 500);
    return await ctx.db
      .query("archive")
      .order("desc")
      .filter(q => q.lt(q.field("_creationTime"), before))
      .take(n);
  },
});

export const removeLog = mutation({
  args: { sessionToken: v.string(), id: v.id("archive") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    await ctx.db.delete(id);
  },
});
