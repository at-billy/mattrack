import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    username: v.string(),
    email: v.string(),
    passwordHash: v.string(),
    roles: v.array(v.string()),
  }).index("by_username", ["username"]),

  materialCatalog: defineTable({
    name: v.string(),
  }).index("by_name", ["name"]),

  materialStock: defineTable({
    materialName: v.string(),
    quality: v.number(),
    quantity: v.number(),
    location: v.string(),
    ownerId: v.id("users"),
    ownerName: v.string(),
    status: v.string(), // "available" | "used" | "removed"
  }).index("by_status", ["status"]),

  craftItems: defineTable({
    name: v.string(),
    requirements: v.array(
      v.object({ materialName: v.string(), quantity: v.number() })
    ),
    createdBy: v.id("users"),
    createdByName: v.string(),
  }),

  archive: defineTable({
    type: v.string(),
    userId: v.id("users"),
    userName: v.string(),
    details: v.any(),
  }),
});
