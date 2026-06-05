import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, requireMember, assertRole } from "./_helpers";
import { assertLen, QUALITY_STEPS } from "./_constants";

const MAT_TYPES = ["Mineable", "Salvage", "Loot"];
const UNITS = ["SCU", "UNIT"];

async function requireAdmin(db: any, token: string) {
  const u = await requireSession(db, token);
  assertRole(u, ["admin"]);
  return u;
}

// Clean a material's quality grid: keep only real band values (step 1..8 with a
// finite value), dedupe by step, sort ascending. Bands a material can't reach
// (blank cells in the source data) are simply omitted rather than padded.
function normalizeQualities(input?: { step: number; value: number }[]) {
  const byStep: Record<number, number> = {};
  for (const q of input ?? []) {
    const s = Number(q.step);
    if (Number.isInteger(s) && s >= 1 && s <= QUALITY_STEPS && Number.isFinite(Number(q.value))) {
      byStep[s] = Number(q.value);
    }
  }
  return Object.keys(byStep)
    .map(Number)
    .sort((a, b) => a - b)
    .map(step => ({ step, value: byStep[step] }));
}

// ── Read (any approved user) ──────────────────────────────────────────────────
export const getAll = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    await requireMember(ctx.db, sessionToken);
    const [materials, items, locations] = await Promise.all([
      ctx.db.query("materialCatalog").collect(),
      ctx.db.query("itemCatalog").collect(),
      ctx.db.query("locationCatalog").collect(),
    ]);
    return { materials, items, locations };
  },
});

// ── Materials (admin) ─────────────────────────────────────────────────────────
export const upsertMaterial = mutation({
  args: {
    sessionToken: v.string(),
    id: v.optional(v.id("materialCatalog")),
    name: v.string(),
    type: v.string(),
    category: v.string(),
    unit: v.string(),
    qualities: v.optional(v.array(v.object({ step: v.number(), value: v.number() }))),
  },
  handler: async (ctx, { sessionToken, id, name, type, category, unit, qualities }) => {
    await requireAdmin(ctx.db, sessionToken);
    const nm = name.trim();
    if (!nm) throw new ConvexError("Name is required");
    assertLen(nm, 80, "name");
    if (!MAT_TYPES.includes(type)) throw new ConvexError("Invalid type");
    if (!UNITS.includes(unit)) throw new ConvexError("Invalid unit");
    assertLen(category, 60, "category");
    const data = { name: nm, type, category: category.trim(), unit, qualities: normalizeQualities(qualities) };
    if (id) { await ctx.db.patch(id, data); return id; }
    const dup = await ctx.db.query("materialCatalog").withIndex("by_name", q => q.eq("name", nm)).first();
    if (dup) throw new ConvexError("A material with that name already exists");
    return await ctx.db.insert("materialCatalog", data);
  },
});

export const deleteMaterial = mutation({
  args: { sessionToken: v.string(), id: v.id("materialCatalog") },
  handler: async (ctx, { sessionToken, id }) => {
    await requireAdmin(ctx.db, sessionToken);
    await ctx.db.delete(id);
  },
});

// ── Items / recipes (admin) ───────────────────────────────────────────────────
export const upsertItem = mutation({
  args: {
    sessionToken: v.string(),
    id: v.optional(v.id("itemCatalog")),
    name: v.string(),
    category: v.string(),
    recipe: v.array(v.object({ materialName: v.string(), qty: v.number(), unit: v.string() })),
  },
  handler: async (ctx, { sessionToken, id, name, category, recipe }) => {
    await requireAdmin(ctx.db, sessionToken);
    const nm = name.trim();
    if (!nm) throw new ConvexError("Name is required");
    assertLen(nm, 80, "name");
    assertLen(category, 60, "category");
    const cleanRecipe = recipe
      .map(r => ({ materialName: r.materialName.trim(), qty: Number(r.qty), unit: UNITS.includes(r.unit) ? r.unit : "SCU" }))
      .filter(r => r.materialName && r.qty > 0);
    const data = { name: nm, category: category.trim(), recipe: cleanRecipe };
    if (id) { await ctx.db.patch(id, data); return id; }
    const dup = await ctx.db.query("itemCatalog").withIndex("by_name", q => q.eq("name", nm)).first();
    if (dup) throw new ConvexError("An item with that name already exists");
    return await ctx.db.insert("itemCatalog", data);
  },
});

export const deleteItem = mutation({
  args: { sessionToken: v.string(), id: v.id("itemCatalog") },
  handler: async (ctx, { sessionToken, id }) => {
    await requireAdmin(ctx.db, sessionToken);
    await ctx.db.delete(id);
  },
});

// ── Locations (admin) ─────────────────────────────────────────────────────────
export const upsertLocation = mutation({
  args: {
    sessionToken: v.string(),
    id: v.optional(v.id("locationCatalog")),
    name: v.string(),
    system: v.optional(v.string()),
    isBase: v.boolean(),
  },
  handler: async (ctx, { sessionToken, id, name, system, isBase }) => {
    await requireAdmin(ctx.db, sessionToken);
    const nm = name.trim();
    if (!nm) throw new ConvexError("Name is required");
    assertLen(nm, 80, "name");
    const data = { name: nm, system: system?.trim() || undefined, isBase };
    if (id) { await ctx.db.patch(id, data); return id; }
    const dup = await ctx.db.query("locationCatalog").withIndex("by_name", q => q.eq("name", nm)).first();
    if (dup) throw new ConvexError("A location with that name already exists");
    return await ctx.db.insert("locationCatalog", data);
  },
});

export const deleteLocation = mutation({
  args: { sessionToken: v.string(), id: v.id("locationCatalog") },
  handler: async (ctx, { sessionToken, id }) => {
    await requireAdmin(ctx.db, sessionToken);
    await ctx.db.delete(id);
  },
});

// ── Seed import (admin) — adds only names that don't exist yet ────────────────
export const importCatalog = mutation({
  args: {
    sessionToken: v.string(),
    materials: v.optional(v.array(v.object({ name: v.string(), type: v.string(), category: v.string(), unit: v.string(), qualities: v.optional(v.array(v.object({ step: v.number(), value: v.number() }))) }))),
    items: v.optional(v.array(v.object({ name: v.string(), category: v.string(), recipe: v.array(v.object({ materialName: v.string(), qty: v.number(), unit: v.string() })) }))),
    locations: v.optional(v.array(v.object({ name: v.string(), system: v.optional(v.string()), isBase: v.optional(v.boolean()) }))),
  },
  handler: async (ctx, { sessionToken, materials, items, locations }) => {
    const admin = await requireAdmin(ctx.db, sessionToken);
    let matAdded = 0, itemAdded = 0, locAdded = 0;
    for (const m of materials ?? []) {
      const nm = m.name.trim(); if (!nm) continue;
      const exists = await ctx.db.query("materialCatalog").withIndex("by_name", q => q.eq("name", nm)).first();
      if (exists) continue;
      await ctx.db.insert("materialCatalog", {
        name: nm,
        type: MAT_TYPES.includes(m.type) ? m.type : "Mineable",
        category: (m.category ?? "").trim(),
        unit: UNITS.includes(m.unit) ? m.unit : "SCU",
        qualities: normalizeQualities(m.qualities),
      });
      matAdded++;
    }
    for (const it of items ?? []) {
      const nm = it.name.trim(); if (!nm) continue;
      const exists = await ctx.db.query("itemCatalog").withIndex("by_name", q => q.eq("name", nm)).first();
      if (exists) continue;
      const recipe = (it.recipe ?? [])
        .map(r => ({ materialName: r.materialName.trim(), qty: Number(r.qty), unit: UNITS.includes(r.unit) ? r.unit : "SCU" }))
        .filter(r => r.materialName && r.qty > 0);
      await ctx.db.insert("itemCatalog", { name: nm, category: (it.category ?? "").trim(), recipe });
      itemAdded++;
    }
    for (const l of locations ?? []) {
      const nm = l.name.trim(); if (!nm) continue;
      const exists = await ctx.db.query("locationCatalog").withIndex("by_name", q => q.eq("name", nm)).first();
      if (exists) continue;
      await ctx.db.insert("locationCatalog", {
        name: nm,
        system: l.system?.trim() || undefined,
        isBase: !!l.isBase,
      });
      locAdded++;
    }
    await ctx.db.insert("archive", {
      type: "catalog_imported",
      userId: admin._id,
      userName: admin.username,
      details: { materials: matAdded, items: itemAdded, locations: locAdded },
    });
    return { matAdded, itemAdded, locAdded };
  },
});

