import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("craftItems").collect();
  },
});

export const add = mutation({
  args: {
    name: v.string(),
    requirements: v.array(
      v.object({ materialName: v.string(), quantity: v.number() })
    ),
    userId: v.id("users"),
    userName: v.string(),
  },
  handler: async (ctx, { name, requirements, userId, userName }) => {
    const id = await ctx.db.insert("craftItems", {
      name,
      requirements,
      createdBy: userId,
      createdByName: userName,
    });
    await ctx.db.insert("archive", {
      type: "item_created",
      userId,
      userName,
      details: { itemName: name, requirements },
    });
    return id;
  },
});
