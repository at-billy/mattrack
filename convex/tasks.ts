import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, requireMember } from "./_helpers";
import {
  TASK_PRIORITIES, TASK_TARGET_ROLES, ITEM_CATEGORIES,
  assertIn, assertSubset, assertLen, assertPositiveInt,
} from "./_constants";

// Shared validation for a project's required-items list.
function validateRequiredItems(items?: { name: string; category: string; quantityNeeded: number }[]) {
  if (!items) return;
  for (const it of items) {
    assertLen(it.name, 120, "item name");
    assertIn(it.category, ITEM_CATEGORIES, "category");
    assertPositiveInt(it.quantityNeeded, "quantity");
  }
}

export const getAll = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    await requireMember(ctx.db, sessionToken);
    return await ctx.db.query("tasks").collect();
  },
});

export const create = mutation({
  args: {
    sessionToken: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    goal: v.optional(v.string()),
    priority: v.string(),
    targetRoles: v.array(v.string()),
    requiredItems: v.optional(v.array(v.object({
      name: v.string(),
      category: v.string(),
      quantityNeeded: v.number(),
    }))),
  },
  handler: async (ctx, { sessionToken, ...rest }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const canCreate = user.roles.some(r => ["admin", "command"].includes(r));
    if (!canCreate) throw new ConvexError("Not authorized");
    if (!rest.title.trim()) throw new ConvexError("Title is required");
    assertLen(rest.title, 200, "title");
    if (rest.description) assertLen(rest.description, 2000, "description");
    if (rest.goal) assertLen(rest.goal, 2000, "goal");
    assertIn(rest.priority, TASK_PRIORITIES, "priority");
    assertSubset(rest.targetRoles, TASK_TARGET_ROLES, "target role");
    validateRequiredItems(rest.requiredItems);
    const id = await ctx.db.insert("tasks", {
      ...rest,
      status: "open",
      createdBy: user._id,
      createdByName: user.username,
      members: [],
    });
    await ctx.db.insert("archive", {
      type: "task_created",
      userId: user._id,
      userName: user.username,
      details: { title: rest.title, priority: rest.priority },
    });
    return id;
  },
});

export const join = mutation({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { sessionToken, taskId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Project not found");
    if (task.status !== "open") throw new ConvexError("Project is not open");
    if (task.members.some(m => m.userId === user._id)) throw new ConvexError("Already joined");
    await ctx.db.patch(taskId, {
      members: [...task.members, { userId: user._id, userName: user.username }],
    });
  },
});

export const leave = mutation({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { sessionToken, taskId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Project not found");
    await ctx.db.patch(taskId, {
      members: task.members.filter(m => m.userId !== user._id),
    });
  },
});

export const close = mutation({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { sessionToken, taskId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const canClose = user.roles.some(r => ["admin", "command"].includes(r));
    if (!canClose) throw new ConvexError("Not authorized");
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Project not found");
    await ctx.db.patch(taskId, { status: "closed" });
    await ctx.db.insert("archive", {
      type: "task_closed",
      userId: user._id,
      userName: user.username,
      details: { title: task.title },
    });
  },
});

export const reopen = mutation({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { sessionToken, taskId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const canEdit = user.roles.some(r => ["admin", "command"].includes(r));
    if (!canEdit) throw new ConvexError("Not authorized");
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Project not found");
    await ctx.db.patch(taskId, { status: "open" });
  },
});

export const cancel = mutation({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { sessionToken, taskId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new ConvexError("Not authorized");
    await ctx.db.patch(taskId, { status: "cancelled" });
  },
});

export const update = mutation({
  args: {
    sessionToken: v.string(),
    taskId: v.id("tasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    goal: v.optional(v.string()),
    priority: v.optional(v.string()),
    targetRoles: v.optional(v.array(v.string())),
    requiredItems: v.optional(v.array(v.object({
      name: v.string(),
      category: v.string(),
      quantityNeeded: v.number(),
    }))),
  },
  handler: async (ctx, { sessionToken, taskId, ...fields }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Project not found");
    const isAdmin = user.roles.some(r => ["admin", "command"].includes(r));
    const isCreator = task.createdBy === user._id;
    if (!isAdmin && !isCreator) throw new ConvexError("Not authorized");
    if (fields.title !== undefined) {
      if (!fields.title.trim()) throw new ConvexError("Title is required");
      assertLen(fields.title, 200, "title");
    }
    if (fields.description !== undefined) assertLen(fields.description, 2000, "description");
    if (fields.goal !== undefined) assertLen(fields.goal, 2000, "goal");
    if (fields.priority !== undefined) assertIn(fields.priority, TASK_PRIORITIES, "priority");
    if (fields.targetRoles !== undefined) assertSubset(fields.targetRoles, TASK_TARGET_ROLES, "target role");
    if (fields.requiredItems !== undefined) validateRequiredItems(fields.requiredItems);
    const patch: Record<string, any> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) patch[k] = v;
    }
    await ctx.db.patch(taskId, patch);
  },
});

export const remove = mutation({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { sessionToken, taskId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new ConvexError("Not authorized");
    await ctx.db.delete(taskId);
  },
});

// Shared allocation planner — used by BOTH the preview query and the mutation,
// so what the user sees is exactly what gets consumed (no drift).
function computeUsePlan(
  available: any[],
  requiredItems: { name: string; category: string; quantityNeeded: number }[],
) {
  return requiredItems.map(req => {
    const matching = available.filter(i => i.name === req.name && i.category === req.category);
    let needed = req.quantityNeeded;
    const sources: { itemId: any; location: string; system: string | null; take: number }[] = [];
    for (const item of matching) {
      if (needed <= 0) break;
      const take = Math.min(item.quantity, needed);
      sources.push({ itemId: item._id, location: item.location, system: item.system ?? null, take });
      needed -= take;
    }
    return {
      name: req.name,
      category: req.category,
      needed: req.quantityNeeded,
      consumed: req.quantityNeeded - needed,
      shortfall: needed,
      sources,
    };
  });
}

export const previewUseItems = query({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { sessionToken, taskId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.some(r => ["admin", "command"].includes(r))) throw new ConvexError("Not authorized");
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Project not found");
    if (!task.requiredItems?.length) return { plan: [], totalConsumed: 0 };
    const available = await ctx.db.query("items").withIndex("by_status", q => q.eq("status", "available")).collect();
    const plan = computeUsePlan(available, task.requiredItems);
    const totalConsumed = plan.reduce((s, p) => s + p.consumed, 0);
    return { plan, totalConsumed };
  },
});

export const useItems = mutation({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { sessionToken, taskId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.some(r => ["admin", "command"].includes(r))) throw new ConvexError("Not authorized");
    const task = await ctx.db.get(taskId);
    if (!task) throw new ConvexError("Project not found");
    if (task.status !== "open") throw new ConvexError("Project is not open");
    if (!task.requiredItems?.length) throw new ConvexError("No required items on this project");

    const available = await ctx.db.query("items").withIndex("by_status", q => q.eq("status", "available")).collect();
    const plan = computeUsePlan(available, task.requiredItems);
    const usedLog: { name: string; quantity: number }[] = [];

    for (const p of plan) {
      for (const src of p.sources) {
        const item = available.find(i => i._id === src.itemId);
        if (!item) continue;
        if (item.quantity <= src.take) {
          await ctx.db.patch(item._id, { status: "used", usedFor: task.title });
        } else {
          await ctx.db.patch(item._id, { quantity: item.quantity - src.take });
          await ctx.db.insert("items", {
            name: item.name, category: item.category,
            subcategory: item.subcategory, description: item.description,
            quantity: src.take, quality: item.quality, location: item.location,
            system: item.system, addedBy: item.addedBy, addedByName: item.addedByName,
            heldBy: item.heldBy, compType: item.compType, compGrade: item.compGrade,
            compSize: item.compSize, compTier: item.compTier,
            status: "used", usedFor: task.title,
          });
        }
        usedLog.push({ name: p.name, quantity: src.take });
      }
    }

    if (!usedLog.length) throw new ConvexError("No matching items found in inventory");
    await ctx.db.insert("archive", {
      type: "items_used_for_project",
      userId: user._id,
      userName: user.username,
      details: { taskTitle: task.title, items: usedLog },
    });
  },
});
