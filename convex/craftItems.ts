import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireSession } from "./_helpers";

export const update = mutation({
  args: {
    sessionToken: v.string(),
    id: v.id("craftItems"),
    name: v.string(),
    category: v.optional(v.string()),
    requirements: v.array(
      v.object({ materialName: v.string(), quantity: v.number(), unit: v.string() })
    ),
  },
  handler: async (ctx, { sessionToken, id, name, category, requirements }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    await ctx.db.patch(id, { name, category, requirements });
  },
});

export const remove = mutation({
  args: { sessionToken: v.string(), id: v.id("craftItems") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const item = await ctx.db.get(id);
    if (!item) throw new Error("Not found");
    await ctx.db.delete(id);
    await ctx.db.insert("archive", {
      type: "item_deleted",
      userId: user._id,
      userName: user.username,
      details: { itemName: item.name },
    });
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
    sessionToken: v.string(),
    name: v.string(),
    category: v.optional(v.string()),
    requirements: v.array(
      v.object({ materialName: v.string(), quantity: v.number(), unit: v.string() })
    ),
  },
  handler: async (ctx, { sessionToken, name, category, requirements }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const id = await ctx.db.insert("craftItems", {
      name,
      category,
      requirements,
      createdBy: user._id,
      createdByName: user.username,
    });
    await ctx.db.insert("archive", {
      type: "item_created",
      userId: user._id,
      userName: user.username,
      details: { itemName: name, category, requirements },
    });
    return id;
  },
});
