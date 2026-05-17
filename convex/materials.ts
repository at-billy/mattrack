import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireSession } from "./_helpers";

const DEFAULT_CATALOG = [
  // Ores — SCU
  { name: "Agricium",      category: "Ores", unit: "SCU" },
  { name: "Aluminium",     category: "Ores", unit: "SCU" },
  { name: "Aslarite",      category: "Ores", unit: "SCU" },
  { name: "Beryl",         category: "Ores", unit: "SCU" },
  { name: "Bexalite",      category: "Ores", unit: "SCU" },
  { name: "Borase",        category: "Ores", unit: "SCU" },
  { name: "Copper",        category: "Ores", unit: "SCU" },
  { name: "Corundum",      category: "Ores", unit: "SCU" },
  { name: "Gold",          category: "Ores", unit: "SCU" },
  { name: "Hephaestanite", category: "Ores", unit: "SCU" },
  { name: "Ice",           category: "Ores", unit: "SCU" },
  { name: "Iron",          category: "Ores", unit: "SCU" },
  { name: "Laranite",      category: "Ores", unit: "SCU" },
  { name: "Lindinium",     category: "Ores", unit: "SCU" },
  { name: "Ouratite",      category: "Ores", unit: "SCU" },
  { name: "Quantainium",   category: "Ores", unit: "SCU" },
  { name: "Quartz",        category: "Ores", unit: "SCU" },
  { name: "Riccite",       category: "Ores", unit: "SCU" },
  { name: "Savrilium",     category: "Ores", unit: "SCU" },
  { name: "Silicon",       category: "Ores", unit: "SCU" },
  { name: "Stileron",      category: "Ores", unit: "SCU" },
  { name: "Taranite",      category: "Ores", unit: "SCU" },
  { name: "Tin",           category: "Ores", unit: "SCU" },
  { name: "Titanium",      category: "Ores", unit: "SCU" },
  { name: "Torite",        category: "Ores", unit: "SCU" },
  { name: "Tungsten",      category: "Ores", unit: "SCU" },
  // Vehicle Mining — SCU
  { name: "Beradom",       category: "Vehicle Mining", unit: "SCU" },
  { name: "Carinite",      category: "Vehicle Mining", unit: "SCU" },
  { name: "Feynmaline",    category: "Vehicle Mining", unit: "SCU" },
  { name: "Glacosite",     category: "Vehicle Mining", unit: "SCU" },
  // FPS Mining — UNIT (gems)
  { name: "Aphorite",      category: "FPS Mining", unit: "UNIT" },
  { name: "Carinite",      category: "FPS Mining", unit: "UNIT" },
  { name: "Carinite Pure", category: "FPS Mining", unit: "UNIT" },
  { name: "Dolivine",      category: "FPS Mining", unit: "UNIT" },
  { name: "Hadanite",      category: "FPS Mining", unit: "UNIT" },
  { name: "Jaclium",       category: "FPS Mining", unit: "UNIT" },
  { name: "Janalite",      category: "FPS Mining", unit: "UNIT" },
  { name: "Sadaryx",       category: "FPS Mining", unit: "UNIT" },
  { name: "Saldynium",     category: "FPS Mining", unit: "UNIT" },
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
    for (const entry of DEFAULT_CATALOG) {
      await ctx.db.insert("materialCatalog", entry);
    }
  },
});

export const addToCatalog = mutation({
  args: { name: v.string(), category: v.string(), unit: v.string() },
  handler: async (ctx, args) => {
    const exists = await ctx.db
      .query("materialCatalog")
      .withIndex("by_name", q => q.eq("name", args.name))
      .first();
    if (!exists) await ctx.db.insert("materialCatalog", args);
  },
});

export const getAvailable = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("materialStock")
      .withIndex("by_status", q => q.eq("status", "available"))
      .collect();
  },
});

export const add = mutation({
  args: {
    sessionToken: v.string(),
    materialName: v.string(),
    category: v.string(),
    unit: v.string(),
    quality: v.number(),
    quantity: v.number(),
    system: v.string(),
    location: v.string(),
  },
  handler: async (ctx, { sessionToken, ...data }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const id = await ctx.db.insert("materialStock", {
      ...data,
      ownerId: user._id,
      ownerName: user.username,
      status: "available",
    });
    await ctx.db.insert("archive", {
      type: "material_added",
      userId: user._id,
      userName: user.username,
      details: {
        materialName: data.materialName,
        category: data.category,
        unit: data.unit,
        quality: data.quality,
        quantity: data.quantity,
        system: data.system,
        location: data.location,
      },
    });
    return id;
  },
});

export const remove = mutation({
  args: { sessionToken: v.string(), id: v.id("materialStock") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Not found");
    const isAdmin = user.roles.includes("admin");
    if (item.ownerId !== user._id && !isAdmin) throw new Error("Not authorized");
    await ctx.db.patch(id, { status: "removed" });
    await ctx.db.insert("archive", {
      type: "material_removed",
      userId: user._id,
      userName: user.username,
      details: {
        materialName: item.materialName,
        unit: item.unit,
        quantity: item.quantity,
        system: item.system,
        location: item.location,
      },
    });
  },
});

export const move = mutation({
  args: {
    sessionToken: v.string(),
    id: v.id("materialStock"),
    toSystem: v.string(),
    toLocation: v.string(),
    partialQty: v.optional(v.number()),
  },
  handler: async (ctx, { sessionToken, id, toSystem, toLocation, partialQty }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Not found");
    const isAdmin = user.roles.includes("admin");
    if (item.ownerId !== user._id && !isAdmin) throw new Error("Not authorized");

    const movedQty = (partialQty && partialQty < item.quantity) ? partialQty : item.quantity;

    if (movedQty < item.quantity) {
      await ctx.db.patch(id, { quantity: item.quantity - movedQty });
      await ctx.db.insert("materialStock", {
        materialName: item.materialName,
        category: item.category,
        unit: item.unit,
        quality: item.quality,
        quantity: movedQty,
        system: toSystem,
        location: toLocation,
        ownerId: item.ownerId,
        ownerName: item.ownerName,
        status: "available",
      });
    } else {
      await ctx.db.patch(id, { system: toSystem, location: toLocation });
    }

    await ctx.db.insert("archive", {
      type: "material_moved",
      userId: user._id,
      userName: user.username,
      details: {
        materialName: item.materialName,
        quantity: movedQty,
        unit: item.unit,
        quality: item.quality,
        fromSystem: item.system,
        fromLocation: item.location,
        toSystem,
        toLocation,
      },
    });
  },
});

export const executeCraft = mutation({
  args: {
    sessionToken: v.string(),
    batches: v.array(
      v.object({ stockId: v.id("materialStock"), quantityUse: v.number() })
    ),
    itemName: v.string(),
    avgQuality: v.number(),
    materialsDetail: v.array(
      v.object({
        materialName: v.string(),
        unit: v.string(),
        quality: v.number(),
        quantityUsed: v.number(),
        system: v.string(),
        location: v.string(),
        ownerName: v.string(),
      })
    ),
  },
  handler: async (ctx, { sessionToken, batches, itemName, avgQuality, materialsDetail }) => {
    const user = await requireSession(ctx.db, sessionToken);
    for (const batch of batches) {
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
      userId: user._id,
      userName: user.username,
      details: { itemName, avgQuality, materialsUsed: materialsDetail },
    });
  },
});
