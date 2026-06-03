import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, requireMember } from "./_helpers";
import { assertLen } from "./_constants";

export const STOCK_STATUSES = ["reported", "in_transit", "at_base", "with_crafter", "crafted", "with_distributor", "handed_out"];
const KINDS = ["material", "item"];

function validate(a: any) {
  if (!KINDS.includes(a.kind)) throw new ConvexError("Invalid kind");
  if (!a.name?.trim()) throw new ConvexError("Name is required");
  assertLen(a.name, 120, "name");
  if (typeof a.qty !== "number" || !(a.qty > 0)) throw new ConvexError("Quantity must be greater than 0");
  if (!a.unit?.trim()) throw new ConvexError("Unit is required");
  if (!a.location?.trim()) throw new ConvexError("Location is required");
  if (!a.heldBy?.trim()) throw new ConvexError("Held-by is required");
  if (!STOCK_STATUSES.includes(a.status)) throw new ConvexError("Invalid status");
  if (a.note) assertLen(a.note, 500, "note");
}

export const getAll = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    await requireMember(ctx.db, sessionToken);
    return await ctx.db.query("stock").collect();
  },
});

export const create = mutation({
  args: {
    sessionToken: v.string(),
    kind: v.string(),
    name: v.string(),
    category: v.string(),
    qualityStep: v.optional(v.number()),
    qualityValue: v.optional(v.number()),
    qty: v.number(),
    unit: v.string(),
    location: v.string(),
    system: v.optional(v.string()),
    heldBy: v.string(),
    status: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { sessionToken, ...rest }) => {
    const user = await requireMember(ctx.db, sessionToken);
    validate(rest);
    const id = await ctx.db.insert("stock", {
      kind: rest.kind,
      name: rest.name.trim(),
      category: rest.category.trim(),
      qualityStep: rest.kind === "material" ? rest.qualityStep : undefined,
      qualityValue: rest.kind === "material" ? rest.qualityValue : undefined,
      qty: rest.qty,
      unit: rest.unit,
      location: rest.location.trim(),
      system: rest.system?.trim() || undefined,
      heldBy: rest.heldBy.trim(),
      status: rest.status,
      note: rest.note?.trim() || undefined,
      addedBy: user._id,
      addedByName: user.username,
    });
    await ctx.db.insert("archive", {
      type: "stock_added",
      userId: user._id,
      userName: user.username,
      details: { name: rest.name.trim(), qty: rest.qty, unit: rest.unit, kind: rest.kind },
    });
    return id;
  },
});

export const update = mutation({
  args: {
    sessionToken: v.string(),
    id: v.id("stock"),
    qty: v.optional(v.number()),
    qualityStep: v.optional(v.number()),
    qualityValue: v.optional(v.number()),
    location: v.optional(v.string()),
    system: v.optional(v.string()),
    heldBy: v.optional(v.string()),
    status: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { sessionToken, id, ...patch }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const row = await ctx.db.get(id);
    if (!row) throw new ConvexError("Stock not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && row.addedBy !== user._id) throw new ConvexError("Not authorized — you can only edit stock you added");
    if (patch.qty !== undefined && !(patch.qty > 0)) throw new ConvexError("Quantity must be greater than 0");
    if (patch.status !== undefined && !STOCK_STATUSES.includes(patch.status)) throw new ConvexError("Invalid status");
    if (patch.location !== undefined && !patch.location.trim()) throw new ConvexError("Location is required");
    if (patch.heldBy !== undefined && !patch.heldBy.trim()) throw new ConvexError("Held-by is required");
    if (patch.note !== undefined && patch.note) assertLen(patch.note, 500, "note");
    const clean: Record<string, any> = {};
    for (const [k, vv] of Object.entries(patch)) {
      if (vv === undefined) continue;
      clean[k] = typeof vv === "string" ? (k === "system" || k === "note" ? (vv.trim() || undefined) : vv.trim()) : vv;
    }
    await ctx.db.patch(id, clean);
  },
});

export const remove = mutation({
  args: { sessionToken: v.string(), id: v.id("stock") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const row = await ctx.db.get(id);
    if (!row) throw new ConvexError("Stock not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && row.addedBy !== user._id) throw new ConvexError("Not authorized — you can only remove stock you added");
    await ctx.db.delete(id);
    await ctx.db.insert("archive", {
      type: "stock_removed",
      userId: user._id,
      userName: user.username,
      details: { name: row.name, qty: row.qty, unit: row.unit },
    });
  },
});
