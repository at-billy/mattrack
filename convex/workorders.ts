import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, requireMember, assertRole } from "./_helpers";
import { assertLen } from "./_constants";

const MAT_TYPES = ["Mineable", "Salvage", "Loot"];

export const getAll = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    await requireMember(ctx.db, sessionToken);
    return await ctx.db.query("workorders").collect();
  },
});

// Gatherer intake → a Pickup workorder. Minimal admin: who has it, where,
// roughly how much, and the type. Logistics will claim + manifest it later.
export const createPickup = mutation({
  args: {
    sessionToken: v.string(),
    holder: v.string(),
    location: v.string(),
    system: v.optional(v.string()),
    matType: v.string(),
    roughQty: v.number(),
    unit: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const user = await requireSession(ctx.db, a.sessionToken);
    assertRole(user, ["gatherer", "admin"]);
    if (!a.holder.trim()) throw new ConvexError("Who has the mats is required");
    if (!a.location.trim()) throw new ConvexError("Location is required");
    if (!MAT_TYPES.includes(a.matType)) throw new ConvexError("Invalid type");
    if (!(a.roughQty > 0)) throw new ConvexError("Rough quantity must be greater than 0");
    if (a.note) assertLen(a.note, 500, "note");
    const id = await ctx.db.insert("workorders", {
      kind: "pickup",
      status: "open",
      matType: a.matType,
      roughQty: a.roughQty,
      unit: a.unit?.trim() || "SCU",
      holder: a.holder.trim(),
      location: a.location.trim(),
      system: a.system?.trim() || undefined,
      note: a.note?.trim() || undefined,
      createdBy: user._id,
      createdByName: user.username,
    });
    await ctx.db.insert("archive", {
      type: "workorder_created",
      userId: user._id,
      userName: user.username,
      details: { kind: "pickup", matType: a.matType, roughQty: a.roughQty, location: a.location.trim() },
    });
    return id;
  },
});

// Logistics claims a pickup ("put your name on it").
export const claim = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["logistics", "admin"]);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    if (wo.status !== "open") throw new ConvexError("Workorder is not open");
    await ctx.db.patch(id, { status: "claimed", claimedById: user._id, claimedByName: user.username });
  },
});

// Release a claim (the claimer or an admin).
export const unclaim = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && wo.claimedById !== user._id) throw new ConvexError("Not authorized");
    await ctx.db.patch(id, { status: "open", claimedById: undefined, claimedByName: undefined });
  },
});

// Mark a pickup done (logistics/admin). Step 5 replaces this with the manifest
// flow that turns the rough haul into itemised stock.
export const complete = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["logistics", "admin"]);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    await ctx.db.patch(id, { status: "done" });
    await ctx.db.insert("archive", {
      type: "workorder_completed",
      userId: user._id,
      userName: user.username,
      details: { kind: wo.kind, location: wo.location },
    });
  },
});

// Cancel (the creator or an admin).
export const cancel = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && wo.createdBy !== user._id) throw new ConvexError("Not authorized");
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
