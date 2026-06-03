import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    username: v.string(),
    passwordHash: v.string(),
    roles: v.array(v.string()), // "recruit" | "member" | "core" | "command" | "admin"
  }).index("by_username", ["username"]),

  sessions: defineTable({
    userId: v.id("users"),
    token: v.string(),
    createdAt: v.number(),
  }).index("by_token", ["token"]),

  // Navy inventory — all items the org has
  items: defineTable({
    name: v.string(),
    category: v.string(),           // "fps_armor" | "fps_weapon" | "ship_component" | "ship_weapon" | "wikelo"
    subcategory: v.optional(v.string()), // fps_armor: "standard_issue" | "standard_heavy"
    description: v.optional(v.string()),
    quantity: v.number(),
    quality: v.optional(v.number()),
    location: v.string(),
    system: v.optional(v.string()),
    addedBy: v.id("users"),
    addedByName: v.string(),
    heldBy: v.optional(v.string()),
    // Handout fields
    handedOutTo: v.optional(v.string()),
    handedOutQty: v.optional(v.number()),
    // Wikelo used fields
    usedFor: v.optional(v.string()),
    // Ship component metadata
    compType: v.optional(v.string()),   // "COOL" | "POWR" | "QDRV" | "SHLD"
    compGrade: v.optional(v.string()),  // "Mil" | "Civ" | "Ind" | "Cmp" | "Sth"
    compSize: v.optional(v.number()),   // 0-3
    compTier: v.optional(v.string()),   // "A" | "B" | "C"
    status: v.string(),                 // "available" | "handed_out" | "used" | "removed"
  }).index("by_status", ["status"]),

  // Projects / tasks
  tasks: defineTable({
    title: v.string(),
    description: v.optional(v.string()),
    goal: v.optional(v.string()),
    priority: v.string(),           // "urgent" | "high" | "normal" | "whenever"
    targetRoles: v.array(v.string()),
    status: v.string(),             // "open" | "closed" | "cancelled"
    createdBy: v.id("users"),
    createdByName: v.string(),
    members: v.array(v.object({
      userId: v.id("users"),
      userName: v.string(),
    })),
    requiredItems: v.optional(v.array(v.object({
      name: v.string(),
      category: v.string(),
      quantityNeeded: v.number(),
    }))),
  }).index("by_status", ["status"]),

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
      pickedBy: v.optional(v.id("users")),
      pickedByName: v.optional(v.string()),
      interested: v.optional(v.array(v.object({ id: v.string(), name: v.string() }))),
      winner: v.optional(v.object({ id: v.string(), name: v.string() })),
    }))),
    externalNames: v.optional(v.array(v.string())),
  }).index("by_status", ["status"]),

  // Recruit application forms
  applications: defineTable({
    userId: v.id("users"),
    userName: v.string(),
    handles: v.string(),   // Q1: Discord + SC handles
    whyJoin: v.string(),   // Q2: why join + how heard
    role: v.string(),      // Q3: what they want to do
    status: v.string(),    // "pending" | "reviewed"
  }).index("by_userId", ["userId"]),

  // Admin-mediated password resets (no email — admin verifies identity out-of-band)
  passwordResets: defineTable({
    userId: v.id("users"),
    username: v.string(),
    status: v.string(),               // "pending" | "issued"
    codeHash: v.optional(v.string()), // PBKDF2 hash of the one-time code
    expiresAt: v.optional(v.number()),
    attempts: v.number(),             // wrong-code attempts (rate limit)
    issuedByName: v.optional(v.string()),
  }).index("by_userId", ["userId"]).index("by_status", ["status"]),

  // Logistics move tasks
  logistics: defineTable({
    status: v.string(), // "open" | "completed"
    createdBy: v.id("users"),
    createdByName: v.string(),
    destinationSystem: v.optional(v.string()),
    destinationLocation: v.string(),
    storedBy: v.string(), // who will store the items at destination
    items: v.array(v.object({
      itemId: v.id("items"),
      name: v.string(),
      category: v.string(),
      fromSystem: v.optional(v.string()),
      fromLocation: v.string(),
    })),
    completedBy: v.optional(v.id("users")),
    completedByName: v.optional(v.string()),
  }).index("by_status", ["status"]),

  archive: defineTable({
    type: v.string(),
    userId: v.id("users"),
    userName: v.string(),
    details: v.any(),
  }),
});
