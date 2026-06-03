import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, assertRole } from "./_helpers";
import { hashPassword, verifyPassword } from "./_password";

const CODE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ATTEMPTS = 5;
// Unambiguous alphabet (no I/O/0/1) — easier to relay over Discord.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s; // 8 chars, ~40 bits
}

// ── PUBLIC: a locked-out user asks for a reset. No enumeration — always "succeeds". ──
export const request = mutation({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const uname = username.trim();
    if (!uname) return;
    const user = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", uname)).first();
    if (!user || user.roles.includes("removed")) return; // silent: don't reveal existence
    // One active request per user — clear any prior, create a fresh pending one.
    const prior = await ctx.db.query("passwordResets").withIndex("by_userId", q => q.eq("userId", user._id)).collect();
    for (const p of prior) await ctx.db.delete(p._id);
    await ctx.db.insert("passwordResets", {
      userId: user._id, username: user.username, status: "pending", attempts: 0,
    });
  },
});

// ── ADMIN: list reset requests (never expose code hashes). ──
export const list = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["admin"]);
    const rows = await ctx.db.query("passwordResets").collect();
    return rows.map(r => ({
      _id: r._id, _creationTime: r._creationTime, username: r.username,
      status: r.status, expiresAt: r.expiresAt, issuedByName: r.issuedByName,
    }));
  },
});

// ── ADMIN: generate a one-time code; returns plaintext ONCE for the admin to relay. ──
export const issueCode = mutation({
  args: { sessionToken: v.string(), resetId: v.id("passwordResets") },
  handler: async (ctx, { sessionToken, resetId }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    assertRole(admin, ["admin"]);
    const reset = await ctx.db.get(resetId);
    if (!reset) throw new ConvexError("Request not found");
    const code = generateCode();
    await ctx.db.patch(resetId, {
      status: "issued",
      codeHash: await hashPassword(code),
      expiresAt: Date.now() + CODE_TTL_MS,
      attempts: 0,
      issuedByName: admin.username,
    });
    await ctx.db.insert("archive", {
      type: "password_reset_issued", userId: admin._id, userName: admin.username,
      details: { targetUsername: reset.username },
    });
    return { code, expiresAt: Date.now() + CODE_TTL_MS };
  },
});

// ── ADMIN: dismiss a request. ──
export const dismiss = mutation({
  args: { sessionToken: v.string(), resetId: v.id("passwordResets") },
  handler: async (ctx, { sessionToken, resetId }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    assertRole(admin, ["admin"]);
    await ctx.db.delete(resetId);
  },
});

// ── PUBLIC: user completes the reset with the code. ──
export const complete = mutation({
  args: { username: v.string(), code: v.string(), newPassword: v.string() },
  handler: async (ctx, { username, code, newPassword }) => {
    const uname = username.trim();
    const user = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", uname)).first();
    if (!user) throw new ConvexError("RESET_INVALID");
    const reset = await ctx.db.query("passwordResets").withIndex("by_userId", q => q.eq("userId", user._id)).first();
    if (!reset || reset.status !== "issued" || !reset.codeHash || !reset.expiresAt) throw new ConvexError("RESET_INVALID");
    if (Date.now() > reset.expiresAt) { await ctx.db.delete(reset._id); throw new ConvexError("RESET_EXPIRED"); }
    if (reset.attempts >= MAX_ATTEMPTS) { await ctx.db.delete(reset._id); throw new ConvexError("RESET_TOO_MANY"); }

    const ok = await verifyPassword(code.trim().toUpperCase(), reset.codeHash);
    if (!ok) {
      await ctx.db.patch(reset._id, { attempts: reset.attempts + 1 });
      throw new ConvexError("RESET_CODE_WRONG");
    }
    if (newPassword.length < 6) throw new ConvexError("PASSWORD_TOO_SHORT");

    await ctx.db.patch(user._id, { passwordHash: await hashPassword(newPassword) });
    await ctx.db.delete(reset._id);
    // Invalidate ALL of the user's sessions (they were locked out / possibly compromised).
    for (const s of await ctx.db.query("sessions").collect()) {
      if (s.userId === user._id) await ctx.db.delete(s._id);
    }
    await ctx.db.insert("archive", {
      type: "password_reset_completed", userId: user._id, userName: user.username,
      details: { username: user.username },
    });
  },
});
