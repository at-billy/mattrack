import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, assertRole } from "./_helpers";

export const getAll = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["admin"]);
    return await ctx.db.query("applications").collect();
  },
});

export const remove = mutation({
  args: { sessionToken: v.string(), applicationId: v.id("applications") },
  handler: async (ctx, { sessionToken, applicationId }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    if (!admin.roles.includes("admin")) throw new ConvexError("Not authorized");
    await ctx.db.delete(applicationId);
  },
});

export const markReviewed = mutation({
  args: { sessionToken: v.string(), applicationId: v.id("applications") },
  handler: async (ctx, { sessionToken, applicationId }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    if (!admin.roles.includes("admin")) throw new ConvexError("Not authorized");
    await ctx.db.patch(applicationId, { status: "reviewed" });
  },
});
