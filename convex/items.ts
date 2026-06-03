import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, requireMember } from "./_helpers";
import { ITEM_CATEGORIES, assertIn, assertLen, assertPositiveInt } from "./_constants";

export const getAll = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    await requireMember(ctx.db, sessionToken);
    return await ctx.db.query("items").collect();
  },
});

export const create = mutation({
  args: {
    sessionToken: v.string(),
    name: v.string(),
    category: v.string(),
    subcategory: v.optional(v.string()),
    description: v.optional(v.string()),
    quantity: v.number(),
    quality: v.optional(v.number()),
    location: v.string(),
    system: v.optional(v.string()),
    heldBy: v.optional(v.string()),
    compType: v.optional(v.string()),
    compGrade: v.optional(v.string()),
    compSize: v.optional(v.number()),
    compTier: v.optional(v.string()),
  },
  handler: async (ctx, { sessionToken, ...rest }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const canAdd = user.roles.some(r => ["admin", "command", "core", "member"].includes(r));
    if (!canAdd) throw new ConvexError("Not authorized");
    if (!rest.name.trim()) throw new ConvexError("Item name is required");
    assertLen(rest.name, 120, "item name");
    assertIn(rest.category, ITEM_CATEGORIES, "category");
    assertPositiveInt(rest.quantity, "quantity");
    if (!rest.location.trim()) throw new ConvexError("Location is required");
    assertLen(rest.location, 120, "location");
    if (rest.description) assertLen(rest.description, 1000, "description");
    if (rest.heldBy) assertLen(rest.heldBy, 120, "held by");

    // Auto-stack: only merge into an existing row when EVERY tag matches — including
    // the member who added it. Different members keep separate rows (preserves
    // attribution; billy's and Syila's identical drives no longer merge).
    const all = await ctx.db.query("items").withIndex("by_status", q => q.eq("status", "available")).collect();
    const match = all.find(i =>
      i.addedBy     === user._id &&
      i.name        === rest.name &&
      i.category    === rest.category &&
      (i.subcategory ?? null) === (rest.subcategory ?? null) &&
      (i.description ?? null) === (rest.description ?? null) &&
      (i.quality     ?? null) === (rest.quality     ?? null) &&
      i.location    === rest.location &&
      (i.system      ?? null) === (rest.system      ?? null) &&
      (i.heldBy      ?? null) === (rest.heldBy      ?? null) &&
      (i.compType    ?? null) === (rest.compType    ?? null) &&
      (i.compGrade   ?? null) === (rest.compGrade   ?? null) &&
      (i.compSize    ?? null) === (rest.compSize    ?? null) &&
      (i.compTier    ?? null) === (rest.compTier    ?? null)
    );

    if (match) {
      await ctx.db.patch(match._id, { quantity: match.quantity + rest.quantity });
      await ctx.db.insert("archive", {
        type: "item_added",
        userId: user._id,
        userName: user.username,
        details: { name: rest.name, category: rest.category, quantity: rest.quantity },
      });
      return match._id;
    }

    const id = await ctx.db.insert("items", {
      ...rest,
      addedBy: user._id,
      addedByName: user.username,
      status: "available",
    });
    await ctx.db.insert("archive", {
      type: "item_added",
      userId: user._id,
      userName: user.username,
      details: { name: rest.name, category: rest.category, quantity: rest.quantity },
    });
    return id;
  },
});

export const update = mutation({
  args: {
    sessionToken: v.string(),
    itemId: v.id("items"),
    name: v.optional(v.string()),
    category: v.optional(v.string()),
    subcategory: v.optional(v.string()),
    description: v.optional(v.string()),
    quantity: v.optional(v.number()),
    quality: v.optional(v.number()),
    location: v.optional(v.string()),
    system: v.optional(v.string()),
    heldBy: v.optional(v.string()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, { sessionToken, itemId, ...rest }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const canEditAny = user.roles.some(r => ["admin", "command"].includes(r));
    const canEditOwn = user.roles.some(r => ["core", "member"].includes(r));
    if (!canEditAny && !canEditOwn) throw new ConvexError("Not authorized");
    if (!canEditAny) {
      const item = await ctx.db.get(itemId);
      if (!item) throw new ConvexError("Item not found");
      if (item.addedBy !== user._id) throw new ConvexError("Not authorized — you can only edit items you added");
    }
    if (rest.category !== undefined) assertIn(rest.category, ITEM_CATEGORIES, "category");
    if (rest.quantity !== undefined) assertPositiveInt(rest.quantity, "quantity");
    if (rest.name !== undefined) { if (!rest.name.trim()) throw new ConvexError("Item name is required"); assertLen(rest.name, 120, "item name"); }
    if (rest.location !== undefined) { if (!rest.location.trim()) throw new ConvexError("Location is required"); assertLen(rest.location, 120, "location"); }
    if (rest.description !== undefined) assertLen(rest.description, 1000, "description");
    if (rest.status !== undefined) assertIn(rest.status, ["available", "handed_out", "used", "removed"], "status");
    const patch: Record<string, any> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) patch[k] = v;
    }
    await ctx.db.patch(itemId, patch);
  },
});

export const handOut = mutation({
  args: {
    sessionToken: v.string(),
    itemId: v.id("items"),
    handedOutTo: v.string(),
    handedOutQty: v.number(),
  },
  handler: async (ctx, { sessionToken, itemId, handedOutTo, handedOutQty }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const canEdit = user.roles.some(r => ["admin", "command", "core"].includes(r));
    if (!canEdit) throw new ConvexError("Not authorized");
    const item = await ctx.db.get(itemId);
    if (!item) throw new ConvexError("Item not found");
    if (handedOutQty <= 0 || handedOutQty > item.quantity) throw new ConvexError("Invalid quantity");

    if (handedOutQty === item.quantity) {
      // Hand out entire item
      await ctx.db.patch(itemId, { status: "handed_out", handedOutTo, handedOutQty, heldBy: handedOutTo });
    } else {
      // Partial handout: reduce original quantity, create new handed-out record
      await ctx.db.patch(itemId, { quantity: item.quantity - handedOutQty });
      await ctx.db.insert("items", {
        name: item.name,
        category: item.category,
        subcategory: item.subcategory,
        description: item.description,
        quantity: handedOutQty,
        quality: item.quality,
        location: item.location,
        system: item.system,
        addedBy: item.addedBy,
        addedByName: item.addedByName,
        heldBy: handedOutTo,
        handedOutTo,
        handedOutQty,
        compType: item.compType,
        compGrade: item.compGrade,
        compSize: item.compSize,
        compTier: item.compTier,
        status: "handed_out",
      });
    }
    await ctx.db.insert("archive", {
      type: "item_handed_out",
      userId: user._id,
      userName: user.username,
      details: { name: item.name, category: item.category, handedOutTo, handedOutQty },
    });
  },
});

export const markUsed = mutation({
  args: {
    sessionToken: v.string(),
    itemId: v.id("items"),
    usedFor: v.string(),
  },
  handler: async (ctx, { sessionToken, itemId, usedFor }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const canEdit = user.roles.some(r => ["admin", "command"].includes(r));
    if (!canEdit) throw new ConvexError("Not authorized");
    const item = await ctx.db.get(itemId);
    if (!item) throw new ConvexError("Item not found");
    if (!["wikelo", "other"].includes(item.category)) throw new ConvexError("Only Wikelo and Other items can be marked as used");
    await ctx.db.patch(itemId, { status: "used", usedFor });
    await ctx.db.insert("archive", {
      type: "item_used",
      userId: user._id,
      userName: user.username,
      details: { name: item.name, usedFor },
    });
  },
});

// One-off conversion: MG Scrip -> Wikelo Favor at 50 : 1 (whole favors only).
export const convertMgScrip = mutation({
  args: { sessionToken: v.string(), itemId: v.id("items"), favors: v.number() },
  handler: async (ctx, { sessionToken, itemId, favors }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.some(r => ["admin", "command", "core", "member"].includes(r))) throw new ConvexError("Not authorized");
    if (!Number.isInteger(favors) || favors < 1) throw new ConvexError("Invalid amount");
    const RATE = 50;
    const item = await ctx.db.get(itemId);
    if (!item) throw new ConvexError("Item not found");
    if (item.name !== "MG Scrip" || item.category !== "wikelo") throw new ConvexError("Only MG Scrip can be converted");
    if (item.status !== "available") throw new ConvexError("Item is not available");
    const cost = favors * RATE;
    if (cost > item.quantity) throw new ConvexError("Not enough MG Scrip");

    // Spend the scrip (delete the row if fully consumed).
    if (cost === item.quantity) await ctx.db.delete(itemId);
    else await ctx.db.patch(itemId, { quantity: item.quantity - cost });

    // Add favors to a matching available Wikelo Favor (same location/holder), else create one.
    const available = await ctx.db.query("items").withIndex("by_status", q => q.eq("status", "available")).collect();
    const match = available.find(i =>
      i.name === "Wikelo Favor" && i.category === "wikelo" &&
      i.location === item.location &&
      (i.system ?? null) === (item.system ?? null) &&
      (i.heldBy ?? null) === (item.heldBy ?? null)
    );
    if (match) {
      await ctx.db.patch(match._id, { quantity: match.quantity + favors });
    } else {
      await ctx.db.insert("items", {
        name: "Wikelo Favor", category: "wikelo", quantity: favors,
        location: item.location, system: item.system,
        addedBy: item.addedBy, addedByName: item.addedByName, heldBy: item.heldBy,
        status: "available",
      });
    }

    await ctx.db.insert("archive", {
      type: "item_converted",
      userId: user._id,
      userName: user.username,
      details: { from: "MG Scrip", to: "Wikelo Favor", used: cost, made: favors },
    });
  },
});

export const remove = mutation({
  args: { sessionToken: v.string(), itemId: v.id("items") },
  handler: async (ctx, { sessionToken, itemId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const canDeleteAny = user.roles.some(r => ["admin", "command"].includes(r));
    const canDeleteOwn = user.roles.some(r => ["core", "member"].includes(r));
    if (!canDeleteAny && !canDeleteOwn) throw new ConvexError("Not authorized");
    const item = await ctx.db.get(itemId);
    if (!item) throw new ConvexError("Item not found");
    if (!canDeleteAny && item.addedBy !== user._id) throw new ConvexError("Not authorized — you can only remove items you added");
    await ctx.db.delete(itemId);
    await ctx.db.insert("archive", {
      type: "item_removed",
      userId: user._id,
      userName: user.username,
      details: { name: item.name, category: item.category },
    });
  },
});
