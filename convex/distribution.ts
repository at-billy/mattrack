import { mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, assertRole } from "./_helpers";
import { assertLen } from "./_constants";

const CONTEXTS = ["request", "event"];

// stock row → a handover item line
function toItem(s: any) {
  return { stockId: s._id, name: s.name, kind: s.kind, qty: s.qty, unit: s.unit, qualityStep: s.qualityValue ?? undefined };
}

// stockIds locked inside an active (open/agreed) handover — so the same finished
// item can't be offered/requested twice at once.
async function lockedStockIds(ctx: any): Promise<Set<string>> {
  const hs = (await ctx.db.query("workorders").withIndex("by_kind", (q: any) => q.eq("kind", "handover")).collect())
    .filter((h: any) => h.status === "open" || h.status === "agreed");
  const set = new Set<string>();
  for (const h of hs) for (const it of h.items ?? []) set.add(it.stockId);
  return set;
}

// A crafter offers finished items to the distributors (open offer — any
// distributor can pick it up; nothing moves until both meet and confirm).
export const offerItems = mutation({
  args: { sessionToken: v.string(), stockIds: v.array(v.id("stock")) },
  handler: async (ctx, { sessionToken, stockIds }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["crafter", "admin"]);
    const locked = await lockedStockIds(ctx);
    const items: any[] = [];
    for (const sid of stockIds) {
      const s = await ctx.db.get(sid);
      if (!s || s.kind !== "item" || s.status !== "crafted") continue;
      if (s.heldBy !== user.username && !user.roles.includes("admin")) continue;
      if (locked.has(sid)) continue;
      items.push(s);
    }
    if (!items.length) throw new ConvexError("Nothing to offer (already offered, or not your finished items)");
    await ctx.db.insert("workorders", {
      kind: "handover", direction: "offer", status: "open",
      giverId: items[0].addedBy, giverName: items[0].heldBy,
      items: items.map(toItem),
      createdBy: user._id, createdByName: user.username,
    });
    return { offered: items.length };
  },
});

// A distributor requests specific finished items from one crafter's inventory
// (the crafter is notified and must agree).
export const requestItems = mutation({
  args: { sessionToken: v.string(), stockIds: v.array(v.id("stock")), location: v.string(), system: v.optional(v.string()) },
  handler: async (ctx, { sessionToken, stockIds, location, system }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["distributor", "admin"]);
    if (!location.trim()) throw new ConvexError("Stockpile location is required");
    const locked = await lockedStockIds(ctx);
    const items: any[] = [];
    for (const sid of stockIds) {
      const s = await ctx.db.get(sid);
      if (!s || s.kind !== "item" || s.status !== "crafted") continue;
      if (locked.has(sid)) continue;
      items.push(s);
    }
    if (!items.length) throw new ConvexError("Nothing to request (already in a handover, or not finished)");
    const givers = new Set(items.map(s => s.heldBy));
    if (givers.size !== 1) throw new ConvexError("Request items from one crafter at a time");
    const giverName = [...givers][0] as string;
    const giver = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", giverName)).first();
    await ctx.db.insert("workorders", {
      kind: "handover", direction: "request", status: "open",
      giverId: giver?._id, giverName,
      takerId: user._id, takerName: user.username,
      destLocation: location.trim(), destSystem: system?.trim() || undefined,
      items: items.map(toItem),
      createdBy: user._id, createdByName: user.username,
    });
    return { requested: items.length };
  },
});

// The counterpart agrees (mutual agreement): a distributor accepts an offer (and
// names their stockpile); the crafter accepts a request.
export const acceptHandover = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders"), location: v.optional(v.string()), system: v.optional(v.string()) },
  handler: async (ctx, { sessionToken, id, location, system }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const h = await ctx.db.get(id);
    if (!h || h.kind !== "handover") throw new ConvexError("Handover not found");
    if (h.status !== "open") throw new ConvexError("This handover is no longer open");
    const isAdmin = user.roles.includes("admin");
    if (h.direction === "offer") {
      assertRole(user, ["distributor", "admin"]);
      if (!location?.trim()) throw new ConvexError("Stockpile location is required");
      await ctx.db.patch(id, {
        takerId: user._id, takerName: user.username,
        destLocation: location.trim(), destSystem: system?.trim() || undefined,
        status: "agreed",
      });
    } else {
      // request → only the holding crafter (or admin) can agree
      if (!isAdmin && h.giverName !== user.username && h.giverId !== user._id) throw new ConvexError("Only the holding crafter can agree");
      assertRole(user, ["crafter", "admin"]);
      await ctx.db.patch(id, { status: "agreed" });
    }
  },
});

// After meeting in-game, the receiving distributor (the taker) confirms they got
// the items: they move into the distributor's stockpile and it's logged.
export const confirmHandover = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const h = await ctx.db.get(id);
    if (!h || h.kind !== "handover") throw new ConvexError("Handover not found");
    if (h.status !== "agreed") throw new ConvexError("Both sides must agree first");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && h.takerName !== user.username && h.takerId !== user._id) throw new ConvexError("Only the receiving distributor confirms receipt");
    if (!h.takerName) throw new ConvexError("No receiving distributor");
    let moved = 0;
    for (const it of h.items ?? []) {
      const s = await ctx.db.get(it.stockId);
      if (s && s.kind === "item" && s.status === "crafted" && s.heldBy === h.giverName) {
        await ctx.db.patch(it.stockId, {
          status: "with_distributor",
          heldBy: h.takerName,
          location: h.destLocation || s.location,
          system: h.destSystem || undefined,
        });
        moved++;
      }
    }
    await ctx.db.patch(id, { status: "done" });
    await ctx.db.insert("archive", {
      type: "items_taken",
      userId: user._id, userName: user.username,
      details: { count: moved, location: h.destLocation, from: h.giverName, to: h.takerName },
    });
    if (!moved) throw new ConvexError("Those items are no longer available");
    return { moved };
  },
});

// Either party (or admin) calls off a not-yet-completed handover. Nothing moved,
// so it's just removed.
export const cancelHandover = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const h = await ctx.db.get(id);
    if (!h || h.kind !== "handover") throw new ConvexError("Handover not found");
    if (h.status === "done") throw new ConvexError("Already completed");
    const isAdmin = user.roles.includes("admin");
    const mine = h.giverId === user._id || h.takerId === user._id || h.giverName === user.username || h.takerName === user.username || h.createdBy === user._id;
    if (!isAdmin && !mine) throw new ConvexError("Not authorized");
    await ctx.db.delete(id);
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
      userId: user._id, userName: user.username,
      details: { item: s.name, qty, recipient: recipient.trim(), context },
    });
    return { handed: qty };
  },
});
