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

  tasks: defineTable({
    title: v.string(),
    type: v.string(), // "gather" | "craft" | "deliver" | "other"
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
    priority: v.string(), // "urgent" | "high" | "normal" | "whenever"
    targetRoles: v.array(v.string()),
    slots: v.number(),
    status: v.string(), // "open" | "completed" | "cancelled"
    createdBy: v.id("users"),
    createdByName: v.string(),
    acceptees: v.array(v.object({
      userId: v.id("users"),
      userName: v.string(),
      status: v.string(), // "accepted" | "completed"
    })),
  }).index("by_status", ["status"]),

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

  sessions: defineTable({
    userId: v.id("users"),
    token: v.string(),
    createdAt: v.number(),
  }).index("by_token", ["token"]),

  lotteries: defineTable({
    title: v.string(),
    status: v.string(), // "draft" | "open" | "drawn" | "closed"
    createdBy: v.id("users"),
    createdByName: v.string(),
    items: v.array(v.object({
      id: v.string(),
      name: v.string(),
      type: v.string(),
      typeName: v.string(),
      grade: v.string(),
      size: v.number(),
      tier: v.string(),
      value: v.number(),
    })),
    packages: v.optional(v.array(v.object({
      pkgId: v.string(),
      totalValue: v.number(),
      items: v.array(v.object({
        id: v.string(),
        name: v.string(),
        type: v.string(),
        typeName: v.string(),
        grade: v.string(),
        size: v.number(),
        tier: v.string(),
        value: v.number(),
      })),
      // Legacy pick fields (backward compat)
      pickedBy: v.optional(v.id("users")),
      pickedByName: v.optional(v.string()),
      // New hat-throw fields
      interested: v.optional(v.array(v.object({ id: v.string(), name: v.string() }))),
      winner: v.optional(v.object({ id: v.string(), name: v.string() })),
    }))),
    // External (non-signed-up) participant names
    externalNames: v.optional(v.array(v.string())),
  }).index("by_status", ["status"]),

  archive: defineTable({
    type: v.string(),
    userId: v.id("users"),
    userName: v.string(),
    details: v.any(),
  }),
});
