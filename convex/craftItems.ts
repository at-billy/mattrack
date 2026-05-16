import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const remove = mutation({
  args: { id: v.id("craftItems"), adminId: v.id("users") },
  handler: async (ctx, { id, adminId }) => {
    const admin = await ctx.db.get(adminId);
    if (!admin || !admin.roles.includes("admin")) throw new Error("Not authorized");
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Not found");
    await ctx.db.delete(id);
    await ctx.db.insert("archive", {
      type: "item_deleted",
      userId: adminId,
      userName: admin.username,
      details: { itemName: item.name },
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("craftItems"),
    adminId: v.id("users"),
    name: v.string(),
    category: v.optional(v.string()),
    requirements: v.array(
      v.object({ materialName: v.string(), quantity: v.number(), unit: v.string() })
    ),
  },
  handler: async (ctx, { id, adminId, name, category, requirements }) => {
    const admin = await ctx.db.get(adminId);
    if (!admin || !admin.roles.includes("admin")) throw new Error("Not authorized");
    await ctx.db.patch(id, { name, category, requirements });
  },
});

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("craftItems").collect();
  },
});

export const add = mutation({
  args: {
    name: v.string(),
    category: v.optional(v.string()),
    requirements: v.array(
      v.object({ materialName: v.string(), quantity: v.number(), unit: v.string() })
    ),
    userId: v.id("users"),
    userName: v.string(),
  },
  handler: async (ctx, { name, category, requirements, userId, userName }) => {
    const id = await ctx.db.insert("craftItems", {
      name,
      category,
      requirements,
      createdBy: userId,
      createdByName: userName,
    });
    await ctx.db.insert("archive", {
      type: "item_created",
      userId,
      userName,
      details: { itemName: name, category, requirements },
    });
    return id;
  },
});
