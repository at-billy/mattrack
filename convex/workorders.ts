import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, requireMember, assertRole } from "./_helpers";

export const getAll = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    await requireMember(ctx.db, sessionToken);
    return await ctx.db.query("workorders").collect();
  },
});

// Accept a workorder.
//  • pickup (logistics): stock reported → in_transit, and an automatic Delivery
//    workorder is created for crafters to receive the haul at base.
//  • delivery (crafter): the crafter signs on as the receiver.
export const claim = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    if (wo.status !== "open") throw new ConvexError("Workorder is not open");

    if (wo.kind === "pickup") {
      // Logistics agrees to collect — nothing moves yet. The gatherer still
      // holds the materials in-game; they move only when logi confirms receipt.
      assertRole(user, ["logistics", "admin"]);
      await ctx.db.patch(id, { status: "claimed", claimedById: user._id, claimedByName: user.username });
    } else if (wo.kind === "delivery") {
      assertRole(user, ["crafter", "admin"]);
      await ctx.db.patch(id, { status: "claimed", claimedById: user._id, claimedByName: user.username });
    } else {
      throw new ConvexError("This workorder cannot be accepted");
    }
  },
});

// Abandon an accepted workorder (the accepter or an admin) → back to open.
// Accepting no longer moves anything, so this just reopens the workorder.
export const unclaim = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && wo.claimedById !== user._id) throw new ConvexError("Not authorized");
    await ctx.db.patch(id, { status: "open", claimedById: undefined, claimedByName: undefined });
  },
});

// The crafter confirms they received a delivery (the taker confirms receipt) →
// materials move to at_base, held by them. (Pickups are completed via
// receivePickup, which also enters the confirmed stock.)
export const complete = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && wo.claimedById !== user._id) throw new ConvexError("Not authorized — only the accepter");
    if (wo.kind !== "delivery") throw new ConvexError("This workorder isn't completed here");
    for (const it of wo.items ?? []) {
      const s = await ctx.db.get(it.stockId);
      if (s && (s.status === "in_transit" || s.status === "reported")) {
        await ctx.db.patch(it.stockId, { status: "at_base", heldBy: user.username });
      }
    }
    await ctx.db.patch(id, { status: "done" });
    await ctx.db.insert("archive", {
      type: "workorder_completed",
      userId: user._id, userName: user.username,
      details: { kind: wo.kind, location: wo.location },
    });
  },
});

// A gatherer files a light intake: rough lines (type / what / how much) at one
// location, combined into a single open Pickup. No stock yet — logistics turns
// this into confirmed stock when they collect it.
const GATHER_TYPES = ["Mineable", "Salvage", "Loot"];
export const reportGather = mutation({
  args: {
    sessionToken: v.string(),
    location: v.string(),
    system: v.optional(v.string()),
    lines: v.array(v.object({ type: v.string(), what: v.string(), approxQty: v.number(), unit: v.optional(v.string()), note: v.optional(v.string()) })),
  },
  handler: async (ctx, { sessionToken, location, system, lines }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["gatherer", "admin"]);
    if (!location.trim()) throw new ConvexError("Where is it? Pick a location");
    if (!lines.length) throw new ConvexError("Add at least one line");
    const report = lines.map(l => {
      if (!GATHER_TYPES.includes(l.type)) throw new ConvexError("Type must be Mineable, Salvage or Loot");
      if (!l.what.trim()) throw new ConvexError("Say what it is");
      if (!(l.approxQty > 0)) throw new ConvexError("Rough amount must be greater than 0");
      return { type: l.type, what: l.what.trim().slice(0, 120), approxQty: l.approxQty, unit: (l.unit || "SCU").trim(), note: l.note?.trim() || undefined };
    });
    const id = await ctx.db.insert("workorders", {
      kind: "pickup", status: "open",
      location: location.trim(), system: system?.trim() || undefined,
      report,
      createdBy: user._id, createdByName: user.username,
    });
    await ctx.db.insert("archive", { type: "gather_reported", userId: user._id, userName: user.username, details: { count: report.length, location: location.trim() } });
    return id;
  },
});

// Logistics collects a reported pickup and enters the confirmed manifest: exact
// material, quality and quantity. This creates the real (in_transit) stock held
// by logistics and the crafters' Delivery task, then closes the pickup.
export const receivePickup = mutation({
  args: {
    sessionToken: v.string(),
    id: v.id("workorders"),
    location: v.string(),
    system: v.optional(v.string()),
    lines: v.array(v.object({ name: v.string(), qualityStep: v.optional(v.number()), qty: v.number(), unit: v.optional(v.string()) })),
  },
  handler: async (ctx, { sessionToken, id, location, system, lines }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo || wo.kind !== "pickup") throw new ConvexError("Pickup not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && !user.roles.includes("logistics")) throw new ConvexError("Logistics only");
    if (!isAdmin && wo.claimedById !== user._id) throw new ConvexError("Accept the pickup first");
    if (wo.status !== "claimed") throw new ConvexError("Pickup must be accepted first");
    if (!location.trim()) throw new ConvexError("Location is required");
    if (!lines.length) throw new ConvexError("Enter at least one confirmed line");

    const items: any[] = [];
    for (const l of lines) {
      const mat = await ctx.db.query("materialCatalog").withIndex("by_name", q => q.eq("name", l.name.trim())).first();
      if (!mat) throw new ConvexError(`Unknown material: ${l.name}`);
      if (!(l.qty > 0)) throw new ConvexError(`Quantity must be greater than 0 for ${l.name}`);
      let qualityValue: number | undefined;
      if (l.qualityStep != null) { const qd = mat.qualities.find(x => x.step === l.qualityStep); qualityValue = qd ? qd.value : undefined; }
      const stockId = await ctx.db.insert("stock", {
        kind: "material", name: mat.name, category: mat.category,
        qualityStep: l.qualityStep, qualityValue,
        qty: l.qty, unit: l.unit || mat.unit,
        location: location.trim(), system: system?.trim() || undefined,
        heldBy: user.username, status: "in_transit",
        addedBy: user._id, addedByName: user.username,
      });
      items.push({ stockId, name: mat.name, kind: "material", qty: l.qty, unit: l.unit || mat.unit, qualityStep: l.qualityStep });
    }

    // Create/stack the crafters' Delivery task with the confirmed stock.
    const base = (await ctx.db.query("locationCatalog").collect()).find(l => l.isBase);
    const myOpen = (await ctx.db.query("workorders").withIndex("by_kind", q => q.eq("kind", "delivery")).collect())
      .find(d => d.status === "open" && d.createdBy === user._id);
    if (myOpen) {
      await ctx.db.patch(myOpen._id, { items: [...(myOpen.items ?? []), ...items] });
    } else {
      await ctx.db.insert("workorders", {
        kind: "delivery", status: "open",
        location: base ? base.name : wo.location,
        system: base ? base.system : wo.system,
        items,
        note: `Inbound to base — picked up by ${user.username}`,
        sourcePickupId: wo._id,
        createdBy: user._id, createdByName: user.username,
      });
    }
    await ctx.db.patch(id, { status: "done" });
    await ctx.db.insert("archive", { type: "workorder_completed", userId: user._id, userName: user.username, details: { kind: "pickup", location: location.trim(), count: items.length } });
    return { received: items.length };
  },
});

export const remove = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    const isAdmin = user.roles.includes("admin");
    if (!isAdmin && wo.createdBy !== user._id) throw new ConvexError("Not authorized");
    await ctx.db.delete(id);
  },
});

// ── Craft orders (step 6) ─────────────────────────────────────────────────────
const PRIORITIES = ["urgent", "high", "normal", "whenever"];
const r3 = (n: number) => Math.round(n * 1000) / 1000;

// Admin authors a craft order (demand): make N of an item, at a priority.
export const createCraftOrder = mutation({
  args: { sessionToken: v.string(), itemName: v.string(), qtyNeeded: v.number(), priority: v.string() },
  handler: async (ctx, a) => {
    const user = await requireSession(ctx.db, a.sessionToken);
    assertRole(user, ["admin"]);
    const item = await ctx.db.query("itemCatalog").withIndex("by_name", q => q.eq("name", a.itemName.trim())).first();
    if (!item) throw new ConvexError("Unknown item");
    if (!(a.qtyNeeded > 0)) throw new ConvexError("Quantity must be greater than 0");
    if (!PRIORITIES.includes(a.priority)) throw new ConvexError("Invalid priority");
    const id = await ctx.db.insert("workorders", {
      kind: "craft", status: "open",
      itemName: item.name, qtyNeeded: a.qtyNeeded, qtyDone: 0, priority: a.priority,
      createdBy: user._id, createdByName: user.username,
    });
    await ctx.db.insert("archive", { type: "workorder_created", userId: user._id, userName: user.username, details: { kind: "craft", item: item.name, qty: a.qtyNeeded } });
    return id;
  },
});

// A crafter crafts `count` units toward an order: consume their At-Base materials
// per the recipe, then produce the item. Output quality = qty-weighted average of
// the consumed materials' quality values.
export const craftItem = mutation({
  args: { sessionToken: v.string(), orderId: v.id("workorders"), count: v.number() },
  handler: async (ctx, { sessionToken, orderId, count }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["crafter", "admin"]);
    if (!(count > 0)) throw new ConvexError("Count must be greater than 0");
    const order = await ctx.db.get(orderId);
    if (!order || order.kind !== "craft") throw new ConvexError("Not a craft order");
    if (order.status !== "open") throw new ConvexError("Order is not open");
    const remaining = (order.qtyNeeded ?? 0) - (order.qtyDone ?? 0);
    if (remaining <= 0) throw new ConvexError("Order is already fulfilled");
    if (count > remaining) count = remaining;

    const item = await ctx.db.query("itemCatalog").withIndex("by_name", q => q.eq("name", order.itemName!)).first();
    if (!item || !item.recipe?.length) throw new ConvexError("This item has no recipe");

    // The crafter's own At-Base material stock.
    const myMats = (await ctx.db.query("stock").withIndex("by_status", q => q.eq("status", "at_base")).collect())
      .filter(s => s.kind === "material" && s.heldBy === user.username);

    for (const r of item.recipe) {
      const have = myMats.filter(s => s.name === r.materialName).reduce((sum, s) => sum + s.qty, 0);
      if (have + 1e-9 < r.qty * count) throw new ConvexError(`Not enough ${r.materialName}: need ${r3(r.qty * count)}, you hold ${r3(have)}`);
    }

    // Consume lowest-quality first; accumulate qty-weighted quality.
    let qtySum = 0, weighted = 0;
    for (const r of item.recipe) {
      let need = r.qty * count;
      const rows = myMats.filter(s => s.name === r.materialName)
        .sort((a, b) => (a.qualityValue ?? a.qualityStep ?? 0) - (b.qualityValue ?? b.qualityStep ?? 0));
      for (const s of rows) {
        if (need <= 1e-9) break;
        const take = Math.min(s.qty, need);
        need -= take;
        const qv = s.qualityValue ?? s.qualityStep ?? 0;
        qtySum += take; weighted += take * qv;
        const left = r3(s.qty - take);
        if (left <= 1e-9) await ctx.db.delete(s._id);
        else await ctx.db.patch(s._id, { qty: left });
      }
    }
    const outQuality = qtySum > 0 ? Math.round(weighted / qtySum) : undefined;

    const base = (await ctx.db.query("locationCatalog").collect()).find(l => l.isBase);
    await ctx.db.insert("stock", {
      kind: "item", name: item.name, category: item.category ?? "",
      qualityValue: outQuality, qty: count, unit: "UNIT",
      location: base ? base.name : "Base", system: base ? base.system : undefined,
      heldBy: user.username, status: "crafted",
      addedBy: user._id, addedByName: user.username,
    });

    const newDone = (order.qtyDone ?? 0) + count;
    await ctx.db.patch(orderId, { qtyDone: newDone, status: newDone >= (order.qtyNeeded ?? 0) ? "done" : "open" });
    await ctx.db.insert("archive", { type: "item_crafted", userId: user._id, userName: user.username, details: { item: item.name, count, quality: outQuality } });
    return { crafted: count, quality: outQuality };
  },
});
