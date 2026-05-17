import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireSession } from "./_helpers";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("tasks").collect();
  },
});

export const create = mutation({
  args: {
    sessionToken: v.string(),
    title: v.string(),
    type: v.string(),
    description: v.optional(v.string()),
    materialName: v.optional(v.string()),
    itemName: v.optional(v.string()),
    quantity: v.optional(v.number()),
    unit: v.optional(v.string()),
    qualityMin: v.optional(v.number()),
    qualityMax: v.optional(v.number()),
    fromSystem: v.optional(v.string()),
    fromLocation: v.optional(v.string()),
    toSystem: v.optional(v.string()),
    toLocation: v.optional(v.string()),
    priority: v.string(),
    targetRoles: v.array(v.string()),
    slots: v.number(),
  },
  handler: async (ctx, { sessionToken, ...rest }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const canCreate = user.roles.includes("admin") || user.roles.includes("crafter");
    if (!canCreate) throw new Error("Not authorized");
    const id = await ctx.db.insert("tasks", {
      ...rest,
      status: "open",
      createdBy: user._id,
      createdByName: user.username,
      acceptees: [],
    });
    await ctx.db.insert("archive", {
      type: "task_created",
      userId: user._id,
      userName: user.username,
      details: { title: rest.title, type: rest.type, priority: rest.priority },
    });
    return id;
  },
});

export const accept = mutation({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { sessionToken, taskId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status !== "open") throw new Error("Task is not open");
    const canSee = user.roles.some(r => task.targetRoles.includes(r)) || user.roles.includes("admin");
    if (!canSee) throw new Error("Not authorized for this task");
    if (task.acceptees.some(a => a.userId === user._id)) throw new Error("Already accepted");
    const activeSlots = task.acceptees.filter(a => a.status !== "completed").length;
    if (activeSlots >= task.slots) throw new Error("No slots available");
    await ctx.db.patch(taskId, {
      acceptees: [...task.acceptees, { userId: user._id, userName: user.username, status: "accepted" }],
    });
    await ctx.db.insert("archive", {
      type: "task_accepted",
      userId: user._id,
      userName: user.username,
      details: { title: task.title },
    });
  },
});

export const complete = mutation({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { sessionToken, taskId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");
    const isAdmin = user.roles.includes("admin");
    const newAcceptees = task.acceptees.map(a =>
      a.userId === user._id ? { ...a, status: "completed" } : a
    );
    const allDone = newAcceptees.every(a => a.status === "completed");
    const newStatus = allDone ? "completed" : task.status;
    await ctx.db.patch(taskId, { acceptees: newAcceptees, status: newStatus });
    await ctx.db.insert("archive", {
      type: "task_completed",
      userId: user._id,
      userName: user.username,
      details: { title: task.title },
    });
  },
});

export const unaccept = mutation({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { sessionToken, taskId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");
    const newAcceptees = task.acceptees.filter(a => a.userId !== user._id);
    await ctx.db.patch(taskId, { acceptees: newAcceptees });
  },
});

export const cancel = mutation({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { sessionToken, taskId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    await ctx.db.patch(taskId, { status: "cancelled" });
  },
});

export const remove = mutation({
  args: { sessionToken: v.string(), taskId: v.id("tasks") },
  handler: async (ctx, { sessionToken, taskId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    await ctx.db.delete(taskId);
  },
});
