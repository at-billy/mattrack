import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireSession } from "./_helpers";

export const create = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const token = crypto.randomUUID();
    await ctx.db.insert("sessions", { userId, token, createdAt: Date.now() });
    return token;
  },
});

export const whoami = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    try {
      const user = await requireSession(ctx.db, token);
      return { _id: user._id, username: user.username, roles: user.roles };
    } catch {
      return null;
    }
  },
});

export const remove = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", q => q.eq("token", token))
      .first();
    if (session) await ctx.db.delete(session._id);
  },
});
