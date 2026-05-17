import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireSession } from "./_helpers";

export const authenticate = mutation({
  args: { username: v.string(), passwordHash: v.string() },
  handler: async (ctx, { username, passwordHash }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", q => q.eq("username", username))
      .first();
    if (!user || user.passwordHash !== passwordHash || user.roles.includes("removed")) return null;
    const token = crypto.randomUUID();
    await ctx.db.insert("sessions", { userId: user._id, token, createdAt: Date.now() });
    return { _id: user._id, username: user.username, roles: user.roles, token };
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

export const getAllUsers = query({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users.map(u => ({ _id: u._id, username: u.username, roles: u.roles }));
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
      .withIndex("by_username", q => q.eq("username", args.username))
      .first();
    if (existing) throw new Error("USERNAME_TAKEN");
    const id = await ctx.db.insert("users", args);
    const user = await ctx.db.get(id);
    await ctx.db.insert("archive", {
      type: "user_joined",
      userId: id,
      userName: args.username,
      details: { roles: args.roles },
    });
    const token = crypto.randomUUID();
    await ctx.db.insert("sessions", { userId: id, token, createdAt: Date.now() });
    return { _id: user!._id, username: user!.username, roles: user!.roles, token };
  },
});

export const claimBootstrapAdmin = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const allUsers = await ctx.db.query("users").collect();
    const hasAdmin = allUsers.some(u => u.roles.includes("admin"));
    if (hasAdmin) throw new Error("ADMIN_EXISTS");
    const newRoles = user.roles.filter(r => r !== "crafter_pending");
    if (!newRoles.includes("admin")) newRoles.push("admin");
    await ctx.db.patch(user._id, { roles: newRoles });
    return { _id: user._id, username: user.username, roles: newRoles };
  },
});

export const approveRole = mutation({
  args: { sessionToken: v.string(), targetUserId: v.id("users"), pendingRole: v.string(), fullRole: v.string() },
  handler: async (ctx, { sessionToken, targetUserId, pendingRole, fullRole }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    if (!admin.roles.includes("admin")) throw new Error("Not authorized");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    const newRoles = target.roles.filter(r => r !== pendingRole);
    if (!newRoles.includes(fullRole)) newRoles.push(fullRole);
    await ctx.db.patch(targetUserId, { roles: newRoles });
    await ctx.db.insert("archive", {
      type: "role_approved",
      userId: admin._id,
      userName: admin.username,
      details: { targetUsername: target.username, role: fullRole },
    });
  },
});

export const denyRole = mutation({
  args: { sessionToken: v.string(), targetUserId: v.id("users"), pendingRole: v.string() },
  handler: async (ctx, { sessionToken, targetUserId, pendingRole }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    if (!admin.roles.includes("admin")) throw new Error("Not authorized");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    const newRoles = target.roles.filter(r => r !== pendingRole);
    await ctx.db.patch(targetUserId, { roles: newRoles });
    await ctx.db.insert("archive", {
      type: "role_denied",
      userId: admin._id,
      userName: admin.username,
      details: { targetUsername: target.username, role: pendingRole },
    });
  },
});

export const removeMember = mutation({
  args: { sessionToken: v.string(), targetUserId: v.id("users") },
  handler: async (ctx, { sessionToken, targetUserId }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    if (!admin.roles.includes("admin")) throw new Error("Not authorized");
    if (admin._id === targetUserId) throw new Error("Cannot remove yourself");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    await ctx.db.patch(targetUserId, { roles: ["removed"] });
    await ctx.db.insert("archive", {
      type: "member_removed",
      userId: admin._id,
      userName: admin.username,
      details: { targetUsername: target.username },
    });
  },
});

export const requestRole = mutation({
  args: { sessionToken: v.string(), role: v.string() },
  handler: async (ctx, { sessionToken, role }) => {
    const REQUESTABLE = ["crafter", "logistics", "provider"];
    if (!REQUESTABLE.includes(role)) throw new Error("Role not requestable");
    const user = await requireSession(ctx.db, sessionToken);
    const pendingRole = role === "provider" ? role : role + "_pending";
    if (user.roles.includes(role)) throw new Error("Already have this role");
    if (user.roles.includes(pendingRole)) throw new Error("Already requested");
    await ctx.db.patch(user._id, { roles: [...user.roles, pendingRole] });
  },
});

export const grantRole = mutation({
  args: { sessionToken: v.string(), targetUserId: v.id("users"), role: v.string() },
  handler: async (ctx, { sessionToken, targetUserId, role }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    if (!admin.roles.includes("admin")) throw new Error("Not authorized");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    const pendingRole = role + "_pending";
    const newRoles = target.roles.filter(r => r !== pendingRole && r !== role);
    newRoles.push(role);
    await ctx.db.patch(targetUserId, { roles: newRoles });
    await ctx.db.insert("archive", {
      type: "role_approved",
      userId: admin._id,
      userName: admin.username,
      details: { targetUsername: target.username, role },
    });
  },
});

export const revokeRole = mutation({
  args: { sessionToken: v.string(), targetUserId: v.id("users"), role: v.string() },
  handler: async (ctx, { sessionToken, targetUserId, role }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    if (!admin.roles.includes("admin")) throw new Error("Not authorized");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    const pendingRole = role + "_pending";
    const newRoles = target.roles.filter(r => r !== role && r !== pendingRole);
    await ctx.db.patch(targetUserId, { roles: newRoles });
    await ctx.db.insert("archive", {
      type: "role_denied",
      userId: admin._id,
      userName: admin.username,
      details: { targetUsername: target.username, role },
    });
  },
});

export const grantAdmin = mutation({
  args: { sessionToken: v.string(), targetUserId: v.id("users") },
  handler: async (ctx, { sessionToken, targetUserId }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    if (!admin.roles.includes("admin")) throw new Error("Not authorized");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    if (!target.roles.includes("admin")) {
      await ctx.db.patch(targetUserId, { roles: [...target.roles, "admin"] });
    }
    await ctx.db.insert("archive", {
      type: "admin_granted",
      userId: admin._id,
      userName: admin.username,
      details: { targetUsername: target.username },
    });
  },
});
