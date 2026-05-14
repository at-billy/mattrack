import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("tasks").collect();
  },
});

export const create = mutation({
  args: {
    adminId: v.id("users"),
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
  handler: async (ctx, { adminId, ...rest }) => {
    const admin = await ctx.db.get(adminId);
    if (!admin?.roles.includes("admin")) throw new Error("Not authorized");
    const id = await ctx.db.insert("tasks", {
      ...rest,
      status: "open",
      createdBy: adminId,
      createdByName: admin.username,
      acceptees: [],
    });
    await ctx.db.insert("archive", {
      type: "task_created",
      userId: adminId,
      userName: admin.username,
      details: { title: rest.title, type: rest.type, priority: rest.priority },
    });
    return id;
  },
});

export const accept = mutation({
  args: { taskId: v.id("tasks"), userId: v.id("users") },
  handler: async (ctx, { taskId, userId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");
    if (task.status !== "open") throw new Error("Task is not open");
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");
    const canSee = user.roles.some(r => task.targetRoles.includes(r)) || user.roles.includes("admin");
    if (!canSee) throw new Error("Not authorized for this task");
    if (task.acceptees.some(a => a.userId === userId)) throw new Error("Already accepted");
    const activeSlots = task.acceptees.filter(a => a.status !== "completed").length;
    if (activeSlots >= task.slots) throw new Error("No slots available");
    await ctx.db.patch(taskId, {
      acceptees: [...task.acceptees, { userId, userName: user.username, status: "accepted" }],
    });
    await ctx.db.insert("archive", {
      type: "task_accepted",
      userId,
      userName: user.username,
      details: { title: task.title },
    });
  },
});

export const complete = mutation({
  args: { taskId: v.id("tasks"), userId: v.id("users") },
  handler: async (ctx, { taskId, userId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");
    const isAdmin = user.roles.includes("admin");
    let newAcceptees = task.acceptees.map(a =>
      (a.userId === userId || isAdmin) ? { ...a, status: "completed" } : a
    );
    const allDone = newAcceptees.every(a => a.status === "completed");
    const newStatus = (isAdmin || allDone) ? "completed" : task.status;
    await ctx.db.patch(taskId, { acceptees: newAcceptees, status: newStatus });
    await ctx.db.insert("archive", {
      type: "task_completed",
      userId,
      userName: user.username,
      details: { title: task.title },
    });
  },
});

export const unaccept = mutation({
  args: { taskId: v.id("tasks"), userId: v.id("users") },
  handler: async (ctx, { taskId, userId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");
    const newAcceptees = task.acceptees.filter(a => a.userId !== userId);
    await ctx.db.patch(taskId, { acceptees: newAcceptees });
  },
});

export const cancel = mutation({
  args: { taskId: v.id("tasks"), adminId: v.id("users") },
  handler: async (ctx, { taskId, adminId }) => {
    const admin = await ctx.db.get(adminId);
    if (!admin?.roles.includes("admin")) throw new Error("Not authorized");
    await ctx.db.patch(taskId, { status: "cancelled" });
  },
});

export const remove = mutation({
  args: { taskId: v.id("tasks"), adminId: v.id("users") },
  handler: async (ctx, { taskId, adminId }) => {
    const admin = await ctx.db.get(adminId);
    if (!admin?.roles.includes("admin")) throw new Error("Not authorized");
    await ctx.db.delete(taskId);
  },
});
