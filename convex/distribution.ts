import { mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, assertRole } from "./_helpers";
import { assertLen } from "./_constants";

const CONTEXTS = ["request", "event"];

// A distributor pulls finished (crafted) items into their stockpile at a chosen
// location: status crafted → with_distributor, held by them.
export const takeToStockpile = mutation({
  args: { sessionToken: v.string(), stockIds: v.array(v.id("stock")), location: v.string(), system: v.optional(v.string()) },
  handler: async (ctx, { sessionToken, stockIds, location, system }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["distributor", "admin"]);
    if (!location.trim()) throw new ConvexError("Stockpile location is required");
    let taken = 0;
    for (const sid of stockIds) {
      const s = await ctx.db.get(sid);
      if (!s || s.kind !== "item" || s.status !== "crafted") continue;
      await ctx.db.patch(sid, {
        status: "with_distributor",
        heldBy: user.username,
        location: location.trim(),
        system: system?.trim() || undefined,
      });
      taken++;
    }
    if (!taken) throw new ConvexError("Nothing to take");
    await ctx.db.insert("archive", {
      type: "items_taken",
      userId: user._id,
      userName: user.username,
      details: { count: taken, location: location.trim() },
    });
    return { taken };
  },
});

// A distributor hands out items from their stockpile: status → handed_out, logged
// with the recipient and context (request | event). Supports partial quantities.
export const handOut = mutation({
  args: {
    sessionToken: v.string(),
    stockId: v.id("stock"),
    qty: v.number(),
    recipient: v.string(),
    context: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { sessionToken, stockId, qty, recipient, context, note }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["distributor", "admin"]);
    const s = await ctx.db.get(stockId);
    if (!s || s.status !== "with_distributor") throw new ConvexError("Item is not in a stockpile");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && s.heldBy !== user.username) throw new ConvexError("Not your stockpile");
    if (!(qty > 0) || qty > s.qty) throw new ConvexError("Invalid quantity");
    if (!recipient.trim()) throw new ConvexError("Recipient is required");
    assertLen(recipient, 120, "recipient");
    if (!CONTEXTS.includes(context)) throw new ConvexError("Invalid context");
    if (note) assertLen(note, 300, "note");

    const handoutNote = `to ${recipient.trim()} (${context})${note ? " — " + note.trim() : ""}`;
    if (qty === s.qty) {
      await ctx.db.patch(stockId, { status: "handed_out", note: handoutNote });
    } else {
      // Partial: reduce the stockpile row, create a handed-out record for the rest.
      await ctx.db.patch(stockId, { qty: s.qty - qty });
      await ctx.db.insert("stock", {
        kind: s.kind, name: s.name, category: s.category,
        qualityValue: s.qualityValue, qty, unit: s.unit,
        location: s.location, system: s.system,
        heldBy: user.username, status: "handed_out", note: handoutNote,
        addedBy: user._id, addedByName: user.username,
      });
    }
    await ctx.db.insert("archive", {
      type: "item_handed_out",
      userId: user._id,
      userName: user.username,
      details: { item: s.name, qty, recipient: recipient.trim(), context },
    });
    return { handed: qty };
  },
});
