import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireSession } from "./_helpers";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("craftedInventory").collect();
  },
});

export const add = mutation({
  args: {
    sessionToken: v.string(),
    itemName: v.string(),
    itemId: v.optional(v.id("craftItems")),
    category: v.optional(v.string()),
    quantity: v.number(),
    avgQuality: v.number(),
    system: v.string(),
    location: v.string(),
  },
  handler: async (ctx, { sessionToken, ...data }) => {
    const user = await requireSession(ctx.db, sessionToken);
    return await ctx.db.insert("craftedInventory", {
      ...data,
      craftedBy: user._id,
      craftedByName: user.username,
      status: "available",
    });
  },
});

export const handOut = mutation({
  args: {
    sessionToken: v.string(),
    id: v.id("craftedInventory"),
    quantity: v.number(),
    handedOutTo: v.string(),
  },
  handler: async (ctx, { sessionToken, id, quantity, handedOutTo }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const canHandOut = user.roles.includes("crafter") || user.roles.includes("logistics") || user.roles.includes("admin");
    if (!canHandOut) throw new Error("Not authorized — crafter, logistics, or admin role required");

    const item = await ctx.db.get(id);
    if (!item) throw new Error("Not found");
    if (item.status !== "available") throw new Error("Item not available");
    if (quantity <= 0) throw new Error("Quantity must be greater than 0");
    if (quantity > item.quantity) throw new Error("Quantity exceeds available stock");

    if (quantity === item.quantity) {
      await ctx.db.patch(id, {
        status: "handed_out",
        handedOutTo,
        handedOutBy: user._id,
        handedOutByName: user.username,
      });
    } else {
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
        handedOutBy: user._id,
        handedOutByName: user.username,
      });
    }

    await ctx.db.insert("archive", {
      type: "item_handed_out",
      userId: user._id,
      userName: user.username,
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
  args: { sessionToken: v.string(), id: v.id("craftedInventory") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    await ctx.db.delete(id);
  },
});
