import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, requireMember, assertRole } from "./_helpers";

export const getAll = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    await requireMember(ctx.db, sessionToken);
    return await ctx.db.query("workorders").collect();
  },
});

// Create pickup workorders from selected "reported" stock rows. Rows are grouped
// by location → one pickup WO per location. The picked rows move to "in_transit".
export const createPickupFromStock = mutation({
  args: { sessionToken: v.string(), stockIds: v.array(v.id("stock")) },
  handler: async (ctx, { sessionToken, stockIds }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["gatherer", "admin"]);
    if (!stockIds.length) throw new ConvexError("Select at least one stock entry");

    // Load + validate (must exist and be 'reported').
    const rows = [];
    for (const sid of stockIds) {
      const s = await ctx.db.get(sid);
      if (!s) continue;
      if (s.status !== "reported") throw new ConvexError(`"${s.name}" is not in Reported status`);
      rows.push(s);
    }
    if (!rows.length) throw new ConvexError("No eligible stock to pick up");

    // Group by location.
    const byLoc: Record<string, typeof rows> = {};
    for (const s of rows) (byLoc[s.location] ??= []).push(s);

    let created = 0;
    for (const [location, group] of Object.entries(byLoc)) {
      const items = group.map(s => ({
        stockId: s._id, name: s.name, kind: s.kind, qty: s.qty, unit: s.unit, qualityStep: s.qualityStep,
      }));
      await ctx.db.insert("workorders", {
        kind: "pickup",
        status: "open",
        location,
        system: group[0].system,
        items,
        createdBy: user._id,
        createdByName: user.username,
      });
      for (const s of group) await ctx.db.patch(s._id, { status: "in_transit" });
      created++;
    }
    await ctx.db.insert("archive", {
      type: "workorder_created",
      userId: user._id,
      userName: user.username,
      details: { kind: "pickup", count: created, items: rows.length },
    });
    return { created, items: rows.length };
  },
});

// Accept a pickup (logistics/admin): "put your name on it" — its stock goes
// reported → in_transit so everyone sees it's being moved.
export const claim = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["logistics", "admin"]);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    if (wo.status !== "open") throw new ConvexError("Workorder is not open");
    for (const it of wo.items ?? []) {
      const s = await ctx.db.get(it.stockId);
      if (s && s.status === "reported") await ctx.db.patch(it.stockId, { status: "in_transit" });
    }
    await ctx.db.patch(id, { status: "claimed", claimedById: user._id, claimedByName: user.username });
  },
});

// Abandon an accepted pickup (the accepter or an admin): release it back to open
// and its stock back to reported.
export const unclaim = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && wo.claimedById !== user._id) throw new ConvexError("Not authorized");
    for (const it of wo.items ?? []) {
      const s = await ctx.db.get(it.stockId);
      if (s && s.status === "in_transit") await ctx.db.patch(it.stockId, { status: "reported" });
    }
    await ctx.db.patch(id, { status: "open", claimedById: undefined, claimedByName: undefined });
  },
});

// Complete a pickup (the accepter or an admin): the haul reached the base, so its
// stock moves to at_base.
export const complete = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && wo.claimedById !== user._id) throw new ConvexError("Not authorized");
    for (const it of wo.items ?? []) {
      const s = await ctx.db.get(it.stockId);
      if (s && (s.status === "in_transit" || s.status === "reported")) await ctx.db.patch(it.stockId, { status: "at_base" });
    }
    await ctx.db.patch(id, { status: "done" });
    await ctx.db.insert("archive", {
      type: "workorder_completed",
      userId: user._id,
      userName: user.username,
      details: { kind: wo.kind, location: wo.location },
    });
  },
});

// Logistics selects pickups and moves them: mark done, record who did it, and
// move each pickup's stock to "at_base".
export const pickedUp = mutation({
  args: { sessionToken: v.string(), ids: v.array(v.id("workorders")) },
  handler: async (ctx, { sessionToken, ids }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["logistics", "admin"]);
    if (!ids.length) throw new ConvexError("Select at least one pickup");
    let moved = 0;
    for (const id of ids) {
      const wo = await ctx.db.get(id);
      if (!wo || wo.kind !== "pickup" || wo.status === "done" || wo.status === "cancelled") continue;
      for (const it of wo.items ?? []) {
        const s = await ctx.db.get(it.stockId);
        if (s && (s.status === "reported" || s.status === "in_transit")) await ctx.db.patch(it.stockId, { status: "at_base" });
      }
      await ctx.db.patch(id, { status: "done", claimedById: user._id, claimedByName: user.username });
      moved++;
    }
    await ctx.db.insert("archive", {
      type: "workorder_completed",
      userId: user._id,
      userName: user.username,
      details: { kind: "pickup", count: moved },
    });
    return { moved };
  },
});

// Cancel (the creator or an admin): release the picked stock back to reported.
export const cancel = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && wo.createdBy !== user._id) throw new ConvexError("Not authorized");
    for (const it of wo.items ?? []) {
      const s = await ctx.db.get(it.stockId);
      if (s && s.status === "in_transit") await ctx.db.patch(it.stockId, { status: "reported" });
    }
    await ctx.db.patch(id, { status: "cancelled" });
  },
});

export const remove = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && wo.createdBy !== user._id) throw new ConvexError("Not authorized");
    await ctx.db.delete(id);
  },
});
