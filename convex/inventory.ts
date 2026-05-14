import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("craftedInventory").collect();
  },
});

export const add = mutation({
  args: {
    itemName: v.string(),
    itemId: v.optional(v.id("craftItems")),
    category: v.optional(v.string()),
    quantity: v.number(),
    avgQuality: v.number(),
    craftedBy: v.id("users"),
    craftedByName: v.string(),
    system: v.string(),
    location: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("craftedInventory", {
      ...args,
      status: "available",
    });
  },
});

export const handOut = mutation({
  args: {
    id: v.id("craftedInventory"),
    quantity: v.number(),
    handedOutTo: v.string(),
    handedOutBy: v.id("users"),
    handedOutByName: v.string(),
  },
  handler: async (ctx, { id, quantity, handedOutTo, handedOutBy, handedOutByName }) => {
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Not found");
    if (item.status !== "available") throw new Error("Item not available");
    if (quantity <= 0) throw new Error("Quantity must be greater than 0");
    if (quantity > item.quantity) throw new Error("Quantity exceeds available stock");

    const actor = await ctx.db.get(handedOutBy);
    const canHandOut = actor?.roles.includes("crafter") || actor?.roles.includes("admin");
    if (!canHandOut) throw new Error("Not authorized — crafter or admin role required");

    if (quantity === item.quantity) {
      // Hand out entire stock entry
      await ctx.db.patch(id, { status: "handed_out", handedOutTo, handedOutBy, handedOutByName });
    } else {
      // Partial handout: reduce existing, create new handed_out entry
      await ctx.db.patch(id, { quantity: item.quantity - quantity });
      await ctx.db.insert("craftedInventory", {
        itemName: item.itemName,
        itemId: item.itemId,
        category: item.category,
        quantity,
        avgQuality: item.avgQuality,
        craftedBy: item.craftedBy,
        craftedByName: item.craftedByName,
        system: item.system,
        location: item.location,
        status: "handed_out",
        handedOutTo,
        handedOutBy,
        handedOutByName,
      });
    }

    await ctx.db.insert("archive", {
      type: "item_handed_out",
      userId: handedOutBy,
      userName: handedOutByName,
      details: {
        itemName: item.itemName,
        category: item.category,
        quantity,
        avgQuality: item.avgQuality,
        handedOutTo,
      },
    });
  },
});

export const remove = mutation({
  args: { id: v.id("craftedInventory"), adminId: v.id("users") },
  handler: async (ctx, { id, adminId }) => {
    const admin = await ctx.db.get(adminId);
    if (!admin || !admin.roles.includes("admin")) throw new Error("Not authorized");
    await ctx.db.delete(id);
  },
});
