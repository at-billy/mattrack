import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    username: v.string(),
    passwordHash: v.string(),
    roles: v.array(v.string()),                      // approved: gatherer|logistics|crafter|distributor|admin (empty = pending)
    requestedRoles: v.optional(v.array(v.string())), // pending requests awaiting admin approval
  }).index("by_username", ["username"]),

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
      pickedBy: v.optional(v.id("users")),
      pickedByName: v.optional(v.string()),
      interested: v.optional(v.array(v.object({ id: v.string(), name: v.string() }))),
      winner: v.optional(v.object({ id: v.string(), name: v.string() })),
    }))),
    externalNames: v.optional(v.array(v.string())),
  }).index("by_status", ["status"]),

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

  archive: defineTable({
    type: v.string(),
    userId: v.id("users"),
    userName: v.string(),
    details: v.any(),
  }),

  // ── Reference databanks (admin-managed; seedable from game data) ──────────────
  // Material definitions. Each material carries the game's quality grid: 10 steps,
  // each with a value (0–1000). Values are per-material; placeholders for now.
  materialCatalog: defineTable({
    name: v.string(),
    type: v.string(),     // "Mineable" | "Salvage" | "Loot"
    category: v.string(), // e.g. "Ores", "FPS Mining"
    unit: v.string(),     // "SCU" | "UNIT"
    qualities: v.array(v.object({ step: v.number(), value: v.number() })), // steps 1..10
  }).index("by_name", ["name"]),

  // Craftable item definitions + their recipe (blueprint).
  itemCatalog: defineTable({
    name: v.string(),
    category: v.string(),
    recipe: v.array(v.object({
      materialName: v.string(),
      qty: v.number(),
      unit: v.string(),
    })),
  }).index("by_name", ["name"]),

  // Known locations.
  locationCatalog: defineTable({
    name: v.string(),
    system: v.optional(v.string()),
    isBase: v.boolean(), // the org's base / default destination for materials (currently Levski)
  }).index("by_name", ["name"]),

  // ── Stock / ledger — actual holdings that move through the pipeline ───────────
  stock: defineTable({
    kind: v.string(),                    // "material" | "item"
    name: v.string(),                    // catalog name (denormalized)
    category: v.string(),                // denormalized for filtering
    qualityStep: v.optional(v.number()), // materials: 1..10
    qualityValue: v.optional(v.number()),
    qty: v.number(),
    unit: v.string(),
    location: v.string(),
    system: v.optional(v.string()),
    heldBy: v.string(),                  // username currently holding it
    status: v.string(),                  // reported|in_transit|at_base|with_crafter|crafted|with_distributor|handed_out
    note: v.optional(v.string()),
    addedBy: v.id("users"),
    addedByName: v.string(),
  }).index("by_status", ["status"]),

  // ── Workorders — the pipeline spine (pickup now; transport/craft/move later) ──
  workorders: defineTable({
    kind: v.string(),                       // "pickup" | "delivery" (craft/distribution later)
    status: v.string(),                     // "open" | "claimed" | "done" | "cancelled"
    location: v.optional(v.string()),       // where the haul is (pickup source) / destination base
    system: v.optional(v.string()),
    note: v.optional(v.string()),
    sourcePickupId: v.optional(v.id("workorders")), // delivery → the pickup it came from
    // craft order (demand authored by admin)
    itemName: v.optional(v.string()),
    qtyNeeded: v.optional(v.number()),
    qtyDone: v.optional(v.number()),
    priority: v.optional(v.string()),               // urgent | high | normal | whenever
    maxCrafters: v.optional(v.number()),            // cap on how many crafters work it (blank = no cap)
    minQuality: v.optional(v.number()),             // legacy order-wide quality floor (kept for back-compat)
    maxQuality: v.optional(v.number()),             // legacy order-wide quality ceiling (kept for back-compat)
    // per-material quality windows (min/max band, 1..QUALITY_STEPS) for the
    // recipe's materials — blank min/max on an entry means "any" for that bound.
    matReqs: v.optional(v.array(v.object({
      materialName: v.string(),
      minQuality: v.optional(v.number()),
      maxQuality: v.optional(v.number()),
    }))),
    crafters: v.optional(v.array(v.object({ userId: v.id("users"), userName: v.string() }))), // who's on the job
    // handover (crafter ⇄ distributor; two real players must agree + meet)
    direction: v.optional(v.string()),              // "offer" (crafter→distributors) | "request" (distributor→crafter)
    giverId: v.optional(v.id("users")),
    giverName: v.optional(v.string()),
    takerId: v.optional(v.id("users")),
    takerName: v.optional(v.string()),
    destLocation: v.optional(v.string()),           // distributor's stockpile
    destSystem: v.optional(v.string()),
    // pickup: the gatherer's ROUGH report (no exact stock yet — logistics
    // turns this into confirmed stock at manifest time).
    report: v.optional(v.array(v.object({
      type: v.string(),                 // Mineable | Salvage | Loot
      what: v.string(),                 // rough free-text description
      approxQty: v.number(),
      unit: v.optional(v.string()),
      note: v.optional(v.string()),
    }))),
    // pickup: the selected stock rows to collect from this location
    items: v.optional(v.array(v.object({
      stockId: v.id("stock"),
      name: v.string(),
      kind: v.string(),
      qty: v.number(),
      unit: v.string(),
      qualityStep: v.optional(v.number()),
    }))),
    // claim (logistics)
    claimedById: v.optional(v.id("users")),
    claimedByName: v.optional(v.string()),
    createdBy: v.id("users"),
    createdByName: v.string(),
  }).index("by_status", ["status"]).index("by_kind", ["kind"]),
});
