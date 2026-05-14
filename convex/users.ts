import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const authenticate = query({
  args: { username: v.string(), passwordHash: v.string() },
  handler: async (ctx, { username, passwordHash }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .first();
    if (!user || user.passwordHash !== passwordHash) return null;
    return { _id: user._id, username: user.username, roles: user.roles };
  },
});

export const getById = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return { _id: user._id, username: user.username, roles: user.roles };
  },
});

export const signUp = mutation({
  args: {
    username: v.string(),
    passwordHash: v.string(),
    roles: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .first();
    if (existing) throw new Error("USERNAME_TAKEN");
    const id = await ctx.db.insert("users", args);
    const user = await ctx.db.get(id);
    return { _id: user!._id, username: user!.username, roles: user!.roles };
  },
});

export const addRole = mutation({
  args: { userId: v.id("users"), role: v.string() },
  handler: async (ctx, { userId, role }) => {
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");
    if (!user.roles.includes(role)) {
      await ctx.db.patch(userId, { roles: [...user.roles, role] });
    }
  },
});
