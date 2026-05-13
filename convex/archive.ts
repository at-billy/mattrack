import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("archive").order("desc").collect();
  },
});

export const addLog = mutation({
  args: {
    type: v.string(),
    userId: v.id("users"),
    userName: v.string(),
    details: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("archive", args);
  },
});
