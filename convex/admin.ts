import { mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, assertRole } from "./_helpers";
import { verifyPassword } from "./_password";

// Destructive reset for demos/presentations. Clears all transactional data —
// stock, work orders (incl. transfers in progress), the activity log, password
// reset requests, and finished lotteries (open/drawn/closed). KEEPS the catalog
// (materials, items, locations incl. the base), users + roles + logins, and any
// draft lotteries (the prepared prize pool). Admin-only, password-gated.
export const wipeForDemo = mutation({
  args: { sessionToken: v.string(), password: v.string() },
  handler: async (ctx, { sessionToken, password }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["admin"]);
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw new ConvexError("Password is incorrect");

    const clear = async (table: "stock" | "workorders" | "archive" | "passwordResets") => {
      const rows = await ctx.db.query(table).collect();
      for (const r of rows) await ctx.db.delete(r._id);
      return rows.length;
    };
    const stock = await clear("stock");
    const workorders = await clear("workorders");
    const archive = await clear("archive");
    const passwordResets = await clear("passwordResets");

    // Lotteries: drop runs (open/drawn/closed), keep drafts (the prize pool).
    let lotteries = 0;
    for (const l of await ctx.db.query("lotteries").collect()) {
      if (l.status !== "draft") { await ctx.db.delete(l._id); lotteries++; }
    }

    return { stock, workorders, archive, passwordResets, lotteries };
  },
});
