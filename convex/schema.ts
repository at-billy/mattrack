import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    username: v.string(),
    passwordHash: v.string(),
    roles: v.array(v.string()),
  }).index("by_username", ["username"]),

  materialCatalog: defineTable({
    name: v.string(),
    category: v.string(), // "Ores" | "Gems"
    unit: v.string(),     // "SCU" | "UNIT"
  }).index("by_name", ["name"]),

  materialStock: defineTable({
    materialName: v.string(),
    category: v.string(),
    unit: v.string(),     // "SCU" | "UNIT"
    quality: v.number(),
    quantity: v.number(),
    system: v.string(),   // "Stanton" | "Pyro" | "Nyx"
    location: v.string(),
    ownerId: v.id("users"),
    ownerName: v.string(),
    status: v.string(),   // "available" | "used" | "removed"
  }).index("by_status", ["status"]),

  craftItems: defineTable({
    name: v.string(),
    category: v.optional(v.string()), // "fps_armour" | "fps_weapon" | "ship_component" | "ship_weapon"
    requirements: v.array(
      v.object({ materialName: v.string(), quantity: v.number(), unit: v.string() })
    ),
    createdBy: v.id("users"),
    createdByName: v.string(),
  }),

  craftedInventory: defineTable({
    itemName: v.string(),
    itemId: v.optional(v.id("craftItems")),
    category: v.optional(v.string()),
    quantity: v.number(),
    avgQuality: v.number(),
    craftedBy: v.id("users"),
    craftedByName: v.string(),
    system: v.string(),
    location: v.string(),
    status: v.string(), // "available" | "handed_out"
    handedOutTo: v.optional(v.string()),
    handedOutBy: v.optional(v.id("users")),
    handedOutByName: v.optional(v.string()),
  }).index("by_status", ["status"]),

  archive: defineTable({
    type: v.string(),
    userId: v.id("users"),
    userName: v.string(),
    details: v.any(),
  }),
});
