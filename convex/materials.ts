import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const DEFAULT_CATALOG = [
  "Aluminum", "Steel", "Copper", "Titanium", "Carbon Fiber",
  "Oak Wood", "Pine Wood", "Walnut Wood", "Bamboo",
  "Granite", "Marble", "Ceramic", "Borosilicate Glass",
  "Cotton Fiber", "Kevlar", "Epoxy Resin", "Polyurethane", "Silicone",
  "Lithium", "Zinc", "Nickel", "Cobalt",
  "Leather", "Canvas", "Brass", "Bronze",
  "Polycarbonate", "Nylon", "PVC", "Acrylic", "Foam", "Cork",
];

export const getCatalog = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("materialCatalog").collect();
  },
});

export const seedCatalog = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("materialCatalog").first();
    if (existing) return;
    for (const name of DEFAULT_CATALOG) {
      await ctx.db.insert("materialCatalog", { name });
    }
  },
});

export const addToCatalog = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const exists = await ctx.db
      .query("materialCatalog")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (!exists) await ctx.db.insert("materialCatalog", { name });
  },
});

export const getAvailable = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("materialStock")
      .withIndex("by_status", (q) => q.eq("status", "available"))
      .collect();
  },
});

export const add = mutation({
  args: {
    materialName: v.string(),
    quality: v.number(),
    quantity: v.number(),
    location: v.string(),
    ownerId: v.id("users"),
    ownerName: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("materialStock", { ...args, status: "available" });
  },
});

export const remove = mutation({
  args: { id: v.id("materialStock"), userId: v.id("users") },
  handler: async (ctx, { id, userId }) => {
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Not found");
    if (item.ownerId !== userId) throw new Error("Not authorized");
    await ctx.db.patch(id, { status: "removed" });
    await ctx.db.insert("archive", {
      type: "material_removed",
      userId,
      userName: item.ownerName,
      details: { materialName: item.materialName, quantity: item.quantity, location: item.location },
    });
  },
});

export const executeCraft = mutation({
  args: {
    batches: v.array(
      v.object({ stockId: v.id("materialStock"), quantityUse: v.number() })
    ),
    itemName: v.string(),
    avgQuality: v.number(),
    userId: v.id("users"),
    userName: v.string(),
    materialsDetail: v.array(
      v.object({
        materialName: v.string(),
        quality: v.number(),
        quantityUsed: v.number(),
        location: v.string(),
        ownerName: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    for (const batch of args.batches) {
      const entry = await ctx.db.get(batch.stockId);
      if (!entry) continue;
      if (batch.quantityUse >= entry.quantity) {
        await ctx.db.patch(batch.stockId, { status: "used" });
      } else {
        await ctx.db.patch(batch.stockId, { quantity: entry.quantity - batch.quantityUse });
      }
    }
    await ctx.db.insert("archive", {
      type: "crafted",
      userId: args.userId,
      userName: args.userName,
      details: {
        itemName: args.itemName,
        avgQuality: args.avgQuality,
        materialsUsed: args.materialsDetail,
      },
    });
  },
});
