import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const authenticate = query({
  args: { username: v.string(), passwordHash: v.string() },
  handler: async (ctx, { username, passwordHash }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .first();
    if (!user || user.passwordHash !== passwordHash || user.roles.includes('removed')) return null;
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

// Bootstrap: grants admin to "billy" (or any user) only if zero admins currently exist
export const claimBootstrapAdmin = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const allUsers = await ctx.db.query("users").collect();
    const hasAdmin = allUsers.some(u => u.roles.includes("admin"));
    if (hasAdmin) throw new Error("ADMIN_EXISTS");
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");
    const newRoles = user.roles.filter(r => r !== "crafter_pending");
    if (!newRoles.includes("admin")) newRoles.push("admin");
    await ctx.db.patch(userId, { roles: newRoles });
    return { _id: user._id, username: user.username, roles: newRoles };
  },
});

// Generic: approve any pending role (pendingRole → fullRole)
export const approveRole = mutation({
  args: { adminId: v.id("users"), targetUserId: v.id("users"), pendingRole: v.string(), fullRole: v.string() },
  handler: async (ctx, { adminId, targetUserId, pendingRole, fullRole }) => {
    const admin = await ctx.db.get(adminId);
    if (!admin || !admin.roles.includes("admin")) throw new Error("Not authorized");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    const newRoles = target.roles.filter(r => r !== pendingRole);
    if (!newRoles.includes(fullRole)) newRoles.push(fullRole);
    await ctx.db.patch(targetUserId, { roles: newRoles });
    await ctx.db.insert("archive", {
      type: "role_approved",
      userId: adminId,
      userName: admin.username,
      details: { targetUsername: target.username, role: fullRole },
    });
  },
});

// Generic: deny any pending role application
export const denyRole = mutation({
  args: { adminId: v.id("users"), targetUserId: v.id("users"), pendingRole: v.string() },
  handler: async (ctx, { adminId, targetUserId, pendingRole }) => {
    const admin = await ctx.db.get(adminId);
    if (!admin || !admin.roles.includes("admin")) throw new Error("Not authorized");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    const newRoles = target.roles.filter(r => r !== pendingRole);
    await ctx.db.patch(targetUserId, { roles: newRoles });
    await ctx.db.insert("archive", {
      type: "role_denied",
      userId: adminId,
      userName: admin.username,
      details: { targetUsername: target.username, role: pendingRole },
    });
  },
});


// Admin removes a member (marks as removed, blocks login)
export const removeMember = mutation({
  args: { adminId: v.id("users"), targetUserId: v.id("users") },
  handler: async (ctx, { adminId, targetUserId }) => {
    const admin = await ctx.db.get(adminId);
    if (!admin?.roles.includes("admin")) throw new Error("Not authorized");
    if (adminId === targetUserId) throw new Error("Cannot remove yourself");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    await ctx.db.patch(targetUserId, { roles: ["removed"] });
    await ctx.db.insert("archive", {
      type: "member_removed",
      userId: adminId,
      userName: admin.username,
      details: { targetUsername: target.username },
    });
  },
});

// Member requests a role (adds _pending version for admin approval)
export const requestRole = mutation({
  args: { userId: v.id("users"), role: v.string() },
  handler: async (ctx, { userId, role }) => {
    const REQUESTABLE = ['crafter', 'logistics', 'provider'];
    if (!REQUESTABLE.includes(role)) throw new Error("Role not requestable");
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");
    const pendingRole = role === 'provider' ? role : role + '_pending';
    if (user.roles.includes(role)) throw new Error("Already have this role");
    if (user.roles.includes(pendingRole)) throw new Error("Already requested");
    await ctx.db.patch(userId, { roles: [...user.roles, pendingRole] });
  },
});

// Admin directly grants a role (bypasses pending)
export const grantRole = mutation({
  args: { adminId: v.id("users"), targetUserId: v.id("users"), role: v.string() },
  handler: async (ctx, { adminId, targetUserId, role }) => {
    const admin = await ctx.db.get(adminId);
    if (!admin?.roles.includes("admin")) throw new Error("Not authorized");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    const pendingRole = role + '_pending';
    const newRoles = target.roles.filter(r => r !== pendingRole && r !== role);
    newRoles.push(role);
    await ctx.db.patch(targetUserId, { roles: newRoles });
    await ctx.db.insert("archive", {
      type: "role_approved",
      userId: adminId,
      userName: admin.username,
      details: { targetUsername: target.username, role },
    });
  },
});

// Admin revokes a role from a member
export const revokeRole = mutation({
  args: { adminId: v.id("users"), targetUserId: v.id("users"), role: v.string() },
  handler: async (ctx, { adminId, targetUserId, role }) => {
    const admin = await ctx.db.get(adminId);
    if (!admin?.roles.includes("admin")) throw new Error("Not authorized");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    const pendingRole = role + '_pending';
    const newRoles = target.roles.filter(r => r !== role && r !== pendingRole);
    await ctx.db.patch(targetUserId, { roles: newRoles });
    await ctx.db.insert("archive", {
      type: "role_denied",
      userId: adminId,
      userName: admin.username,
      details: { targetUsername: target.username, role },
    });
  },
});

// Admin grants admin role to another user
export const grantAdmin = mutation({
  args: { adminId: v.id("users"), targetUserId: v.id("users") },
  handler: async (ctx, { adminId, targetUserId }) => {
    const admin = await ctx.db.get(adminId);
    if (!admin || !admin.roles.includes("admin")) throw new Error("Not authorized");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new Error("User not found");
    if (!target.roles.includes("admin")) {
      await ctx.db.patch(targetUserId, { roles: [...target.roles, "admin"] });
    }
    await ctx.db.insert("archive", {
      type: "admin_granted",
      userId: adminId,
      userName: admin.username,
      details: { targetUsername: target.username },
    });
  },
});
