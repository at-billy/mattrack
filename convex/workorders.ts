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

// Accept a workorder.
//  • pickup (logistics): stock reported → in_transit, and an automatic Delivery
//    workorder is created for crafters to receive the haul at base.
//  • delivery (crafter): the crafter signs on as the receiver.
export const claim = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    if (wo.status !== "open") throw new ConvexError("Workorder is not open");

    if (wo.kind === "pickup") {
      assertRole(user, ["logistics", "admin"]);
      for (const it of wo.items ?? []) {
        const s = await ctx.db.get(it.stockId);
        if (s && s.status === "reported") await ctx.db.patch(it.stockId, { status: "in_transit" });
      }
      await ctx.db.patch(id, { status: "claimed", claimedById: user._id, claimedByName: user.username });
      // Auto-create the Delivery task for crafters to receive at base.
      await ctx.db.insert("workorders", {
        kind: "delivery",
        status: "open",
        location: wo.location,
        system: wo.system,
        items: wo.items,
        note: `Inbound to base — picked up by ${user.username}`,
        sourcePickupId: wo._id,
        createdBy: user._id,
        createdByName: user.username,
      });
    } else if (wo.kind === "delivery") {
      assertRole(user, ["crafter", "admin"]);
      await ctx.db.patch(id, { status: "claimed", claimedById: user._id, claimedByName: user.username });
    } else {
      throw new ConvexError("This workorder cannot be accepted");
    }
  },
});

// Abandon an accepted workorder (the accepter or an admin) → back to open.
//  • pickup: stock back to reported, and the (still-open) auto Delivery is removed.
//    Blocked once a crafter has already accepted the delivery.
//  • delivery: just reopens.
export const unclaim = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && wo.claimedById !== user._id) throw new ConvexError("Not authorized");

    if (wo.kind === "pickup") {
      const deliveries = (await ctx.db.query("workorders").withIndex("by_kind", q => q.eq("kind", "delivery")).collect())
        .filter(d => d.sourcePickupId === id && d.status !== "cancelled");
      if (deliveries.some(d => d.status !== "open")) {
        throw new ConvexError("A crafter is already receiving this — can't abandon");
      }
      for (const d of deliveries) await ctx.db.delete(d._id);
      for (const it of wo.items ?? []) {
        const s = await ctx.db.get(it.stockId);
        if (s && s.status === "in_transit") await ctx.db.patch(it.stockId, { status: "reported" });
      }
    }
    await ctx.db.patch(id, { status: "open", claimedById: undefined, claimedByName: undefined });
  },
});

// Complete a workorder (the accepter or an admin).
//  • delivery: the crafter has the materials → stock moves to at_base, held by them.
//  • pickup: just marks the logistics task done (the delivery handles the stock).
export const complete = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && wo.claimedById !== user._id) throw new ConvexError("Not authorized — only the accepter");
    if (wo.kind === "delivery") {
      for (const it of wo.items ?? []) {
        const s = await ctx.db.get(it.stockId);
        if (s && (s.status === "in_transit" || s.status === "reported")) {
          await ctx.db.patch(it.stockId, { status: "at_base", heldBy: user.username });
        }
      }
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
