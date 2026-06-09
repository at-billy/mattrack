import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession } from "./_helpers";
import { hashPassword, verifyPassword, isLegacyHash } from "./_password";
import { REQUESTABLE_ROLES, GRANTABLE_ROLES, assertIn } from "./_constants";
import { assertNotLocked, recordFailure, clearThrottle } from "./_throttle";

export const authenticate = mutation({
  args: { username: v.string(), password: v.string() },
  handler: async (ctx, { username, password }) => {
    const key = "login:" + username.trim().toLowerCase();
    const throttle = await assertNotLocked(ctx.db, key); // throws TOO_MANY_ATTEMPTS:<secs> when locked
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", q => q.eq("username", username.trim()))
      .first();
    if (!user || user.roles.includes("removed")) { await recordFailure(ctx.db, key, throttle); return null; }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) { await recordFailure(ctx.db, key, throttle); return null; }
    await clearThrottle(ctx.db, key, throttle);
    // Transparent upgrade: legacy SHA-256 records are re-hashed with PBKDF2 on first login.
    if (isLegacyHash(user.passwordHash)) {
      const upgraded = await hashPassword(password);
      await ctx.db.patch(user._id, { passwordHash: upgraded });
    }
    const token = crypto.randomUUID();
    await ctx.db.insert("sessions", { userId: user._id, token, createdAt: Date.now() });
    return { _id: user._id, username: user.username, roles: user.roles, token };
  },
});

export const getById = query({
  args: { sessionToken: v.string(), userId: v.id("users") },
  handler: async (ctx, { sessionToken, userId }) => {
    await requireSession(ctx.db, sessionToken);
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return { _id: user._id, username: user.username, roles: user.roles };
  },
});

export const getAllUsers = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    // Any authenticated user (incl. recruit) — needed for member names + bootstrap.
    // Only non-sensitive fields are returned; passwordHash is never projected.
    await requireSession(ctx.db, sessionToken);
    const users = await ctx.db.query("users").collect();
    return users.map(u => ({ _id: u._id, username: u.username, roles: u.roles, requestedRoles: u.requestedRoles ?? [] }));
  },
});

export const signUp = mutation({
  args: {
    username: v.string(),
    password: v.string(),
    requestedRoles: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    // Validate username server-side: trim, length, charset. Never trust client formatting.
    const username = args.username.trim();
    if (username.length < 2 || username.length > 32) throw new ConvexError("USERNAME_INVALID");
    if (!/^[A-Za-z0-9 _.\-]+$/.test(username)) throw new ConvexError("USERNAME_INVALID");
    if (args.password.length < 6) throw new ConvexError("PASSWORD_TOO_SHORT");

    const existing = await ctx.db
      .query("users")
      .withIndex("by_username", q => q.eq("username", username))
      .first();
    if (existing) throw new ConvexError("USERNAME_TAKEN");

    // Hash server-side with PBKDF2 + per-user salt. The raw password is never stored.
    const passwordHash = await hashPassword(args.password);
    // New accounts hold NO approved roles (pending). They request roles, an admin approves.
    const requestedRoles = [...new Set(args.requestedRoles ?? [])].filter(r => REQUESTABLE_ROLES.includes(r));
    const id = await ctx.db.insert("users", { username, passwordHash, roles: [], requestedRoles });
    const user = await ctx.db.get(id);
    await ctx.db.insert("archive", {
      type: "user_joined",
      userId: id,
      userName: username,
      details: { requestedRoles },
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
    if (allUsers.some(u => u.roles.includes("admin"))) throw new ConvexError("ADMIN_EXISTS");
    // Bootstrap is for a genuinely fresh install only: the claimer must be the
    // sole active account. Once others have joined, a zero-admin state can't be
    // self-claimed by just any logged-in user — recovery is via grantAdmin or
    // a server-side (CLI) action instead. This blocks privilege escalation if
    // the admin count ever drops to zero with members present.
    const active = allUsers.filter(u => !u.roles.includes("removed"));
    if (active.length > 1) throw new ConvexError("BOOTSTRAP_LOCKED");
    const newRoles = [...user.roles];
    if (!newRoles.includes("admin")) newRoles.push("admin");
    await ctx.db.patch(user._id, { roles: newRoles });
    return { _id: user._id, username: user.username, roles: newRoles };
  },
});

// Approve a requested role: move it from requestedRoles → roles.
export const approveRole = mutation({
  args: { sessionToken: v.string(), targetUserId: v.id("users"), role: v.string() },
  handler: async (ctx, { sessionToken, targetUserId, role }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    if (!admin.roles.includes("admin")) throw new ConvexError("Not authorized");
    assertIn(role, GRANTABLE_ROLES, "role");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new ConvexError("User not found");
    const roles = target.roles.includes(role) ? target.roles : [...target.roles, role];
    const requestedRoles = (target.requestedRoles ?? []).filter(r => r !== role);
    await ctx.db.patch(targetUserId, { roles, requestedRoles });
    await ctx.db.insert("archive", {
      type: "role_approved",
      userId: admin._id,
      userName: admin.username,
      details: { targetUsername: target.username, role },
    });
  },
});

// Deny a requested role: drop it from requestedRoles.
export const denyRole = mutation({
  args: { sessionToken: v.string(), targetUserId: v.id("users"), role: v.string() },
  handler: async (ctx, { sessionToken, targetUserId, role }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    if (!admin.roles.includes("admin")) throw new ConvexError("Not authorized");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new ConvexError("User not found");
    const requestedRoles = (target.requestedRoles ?? []).filter(r => r !== role);
    await ctx.db.patch(targetUserId, { requestedRoles });
    await ctx.db.insert("archive", {
      type: "role_denied",
      userId: admin._id,
      userName: admin.username,
      details: { targetUsername: target.username, role },
    });
  },
});

export const removeMember = mutation({
  args: { sessionToken: v.string(), targetUserId: v.id("users") },
  handler: async (ctx, { sessionToken, targetUserId }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    if (!admin.roles.includes("admin")) throw new ConvexError("Not authorized");
    if (admin._id === targetUserId) throw new ConvexError("Cannot remove yourself");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new ConvexError("User not found");
    await ctx.db.patch(targetUserId, { roles: ["removed"], requestedRoles: [] });
    await ctx.db.insert("archive", {
      type: "member_removed",
      userId: admin._id,
      userName: admin.username,
      details: { targetUsername: target.username },
    });
  },
});

export const restoreMember = mutation({
  args: { sessionToken: v.string(), targetUserId: v.id("users") },
  handler: async (ctx, { sessionToken, targetUserId }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    if (!admin.roles.includes("admin")) throw new ConvexError("Not authorized");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new ConvexError("User not found");
    if (!target.roles.includes("removed")) throw new ConvexError("User is not removed");
    // Bring them back as pending (no roles) — admin re-grants as needed.
    await ctx.db.patch(targetUserId, { roles: [], requestedRoles: [] });
    await ctx.db.insert("archive", {
      type: "member_restored",
      userId: admin._id,
      userName: admin.username,
      details: { targetUsername: target.username },
    });
  },
});

export const changePassword = mutation({
  args: { sessionToken: v.string(), currentPassword: v.string(), newPassword: v.string() },
  handler: async (ctx, { sessionToken, currentPassword, newPassword }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const key = "pw:" + user._id;
    const throttle = await assertNotLocked(ctx.db, key);
    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) { await recordFailure(ctx.db, key, throttle); throw new ConvexError("CURRENT_PASSWORD_WRONG"); }
    await clearThrottle(ctx.db, key, throttle);
    if (newPassword.length < 6) throw new ConvexError("PASSWORD_TOO_SHORT");
    await ctx.db.patch(user._id, { passwordHash: await hashPassword(newPassword) });
    // Security: invalidate this user's OTHER sessions on a password change.
    const sessions = await ctx.db.query("sessions").collect();
    for (const s of sessions) {
      if (s.userId === user._id && s.token !== sessionToken) await ctx.db.delete(s._id);
    }
  },
});

// A signed-in user requests an additional role (goes to requestedRoles).
export const requestRole = mutation({
  args: { sessionToken: v.string(), role: v.string() },
  handler: async (ctx, { sessionToken, role }) => {
    if (!REQUESTABLE_ROLES.includes(role)) throw new ConvexError("Role not requestable");
    const user = await requireSession(ctx.db, sessionToken);
    if (user.roles.includes(role)) throw new ConvexError("Already have this role");
    const requested = user.requestedRoles ?? [];
    if (requested.includes(role)) throw new ConvexError("Already requested");
    await ctx.db.patch(user._id, { requestedRoles: [...requested, role] });
  },
});

// Admin grants a role directly (also clears any matching pending request).
export const grantRole = mutation({
  args: { sessionToken: v.string(), targetUserId: v.id("users"), role: v.string() },
  handler: async (ctx, { sessionToken, targetUserId, role }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    if (!admin.roles.includes("admin")) throw new ConvexError("Not authorized");
    assertIn(role, GRANTABLE_ROLES, "role"); // never "admin"/"removed"/junk
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new ConvexError("User not found");
    const roles = target.roles.includes(role) ? target.roles : [...target.roles, role];
    const requestedRoles = (target.requestedRoles ?? []).filter(r => r !== role);
    await ctx.db.patch(targetUserId, { roles, requestedRoles });
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
    if (!admin.roles.includes("admin")) throw new ConvexError("Not authorized");
    assertIn(role, GRANTABLE_ROLES, "role"); // cannot revoke "admin" here
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new ConvexError("User not found");
    const roles = target.roles.filter(r => r !== role);
    const requestedRoles = (target.requestedRoles ?? []).filter(r => r !== role);
    await ctx.db.patch(targetUserId, { roles, requestedRoles });
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
    if (!admin.roles.includes("admin")) throw new ConvexError("Not authorized");
    const target = await ctx.db.get(targetUserId);
    if (!target) throw new ConvexError("User not found");
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
