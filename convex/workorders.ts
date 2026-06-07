import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, requireMember, assertRole } from "./_helpers";
import { QUALITY_STEPS } from "./_constants";

export const getAll = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    await requireMember(ctx.db, sessionToken);
    return await ctx.db.query("workorders").collect();
  },
});

// Accept a workorder (agree to do it — nothing moves until the accepter confirms).
//  • pickup (logistics): collect gathered materials from a gatherer.
//  • delivery (crafter): receive materials at base.
//  • move (logistics): collect finished goods from a crafter.
//  • distribution (distributor): receive finished goods — names their stockpile.
export const claim = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders"), location: v.optional(v.string()), system: v.optional(v.string()) },
  handler: async (ctx, { sessionToken, id, location, system }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    if (wo.status !== "open") throw new ConvexError("Workorder is not open");
    const base = { status: "claimed", claimedById: user._id, claimedByName: user.username } as const;

    // Admin can manage workorders (edit/delete) but cannot impersonate a transfer
    // party — claiming means you ARE the logistics/crafter/distributor receiving.
    if (wo.kind === "pickup") {
      assertRole(user, ["logistics"]);
      await ctx.db.patch(id, base);
    } else if (wo.kind === "delivery") {
      assertRole(user, ["crafter"]);
      await ctx.db.patch(id, base);
    } else if (wo.kind === "move") {
      assertRole(user, ["logistics"]);
      await ctx.db.patch(id, base);
    } else if (wo.kind === "distribution") {
      assertRole(user, ["distributor"]);
      if (!location?.trim()) throw new ConvexError("Stockpile location is required");
      await ctx.db.patch(id, { ...base, destLocation: location.trim(), destSystem: system?.trim() || undefined });
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
    await ctx.db.patch(id, { status: "open", claimedById: undefined, claimedByName: undefined, destLocation: undefined, destSystem: undefined });
  },
});

// The receiver confirms they met the holder and got the goods. That's when
// custody moves.
//  • delivery (crafter): materials → at_base (Levski), held by them.
//  • move (logistics): finished goods → in_transit (held by logi), and a
//    Distribution delivery is created for a distributor to receive.
//  • distribution (distributor): finished goods → with_distributor, held by them,
//    at their chosen stockpile.
export const complete = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo) throw new ConvexError("Workorder not found");
    // Completing a transfer means you physically received the goods — only the
    // claimer (the actual receiver) can confirm. Admin can unclaim/delete but
    // cannot confirm receipt on someone else's behalf.
    if (wo.claimedById !== user._id) throw new ConvexError("Not authorized — only the accepter can confirm receipt");
    const baseLoc = (await ctx.db.query("locationCatalog").collect()).find(l => l.isBase);

    if (wo.kind === "delivery") {
      for (const it of wo.items ?? []) {
        const s = await ctx.db.get(it.stockId);
        if (s && (s.status === "in_transit" || s.status === "reported")) {
          await ctx.db.patch(it.stockId, { status: "at_base", heldBy: user.username, location: baseLoc ? baseLoc.name : s.location, system: baseLoc ? baseLoc.system : s.system });
        }
      }
    } else if (wo.kind === "move") {
      // Logi collected finished goods from the crafter.
      for (const it of wo.items ?? []) {
        const s = await ctx.db.get(it.stockId);
        if (s && s.status === "crafted") await ctx.db.patch(it.stockId, { status: "in_transit", heldBy: user.username });
      }
      // Now create the Distribution delivery. If a distributor requested this
      // move, it's pre-assigned to them (they just confirm receipt); otherwise
      // it's open for any distributor.
      const dist: any = {
        kind: "distribution", status: "open",
        location: baseLoc ? baseLoc.name : wo.location,
        system: baseLoc ? baseLoc.system : wo.system,
        items: wo.items,
        note: `Finished goods inbound — collected by ${user.username}`,
        sourcePickupId: wo._id,
        createdBy: user._id, createdByName: user.username,
      };
      if (wo.takerId) {
        dist.status = "claimed"; dist.claimedById = wo.takerId; dist.claimedByName = wo.takerName;
        dist.destLocation = wo.destLocation; dist.destSystem = wo.destSystem;
      }
      await ctx.db.insert("workorders", dist);
    } else if (wo.kind === "distribution") {
      for (const it of wo.items ?? []) {
        const s = await ctx.db.get(it.stockId);
        if (s && (s.status === "in_transit" || s.status === "crafted")) {
          await ctx.db.patch(it.stockId, { status: "with_distributor", heldBy: user.username, location: wo.destLocation || s.location, system: wo.destSystem || undefined });
        }
      }
    } else {
      throw new ConvexError("This workorder isn't completed here");
    }
    await ctx.db.patch(id, { status: "done" });
    await ctx.db.insert("archive", {
      type: "workorder_completed",
      userId: user._id, userName: user.username,
      details: { kind: wo.kind, location: wo.location },
    });
  },
});

// A crafter ships finished goods to logistics for distribution (the client's
// Move leg). Nothing moves yet — logistics collects, then delivers to a
// distributor.
export const createMove = mutation({
  args: { sessionToken: v.string(), stockIds: v.array(v.id("stock")) },
  handler: async (ctx, { sessionToken, stockIds }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["crafter", "admin"]);
    // stock already promised to a move/distribution can't be shipped again
    const locked = new Set<string>();
    for (const w of (await ctx.db.query("workorders").withIndex("by_kind", q => q.eq("kind", "move")).collect())) if (w.status !== "done") for (const it of w.items ?? []) locked.add(it.stockId);
    for (const w of (await ctx.db.query("workorders").withIndex("by_kind", q => q.eq("kind", "distribution")).collect())) if (w.status !== "done") for (const it of w.items ?? []) locked.add(it.stockId);
    const items: any[] = [];
    for (const sid of stockIds) {
      const s = await ctx.db.get(sid);
      if (!s || s.kind !== "item" || s.status !== "crafted") continue;
      if (s.heldBy !== user.username) continue; // can only ship what you physically hold
      if (locked.has(sid)) continue;
      items.push({ stockId: s._id, name: s.name, kind: s.kind, qty: s.qty, unit: s.unit, qualityStep: s.qualityValue ?? undefined });
    }
    if (!items.length) throw new ConvexError("Nothing to send (already shipping, or not your finished items)");
    const baseLoc = (await ctx.db.query("locationCatalog").collect()).find(l => l.isBase);
    await ctx.db.insert("workorders", {
      kind: "move", status: "open",
      location: baseLoc ? baseLoc.name : undefined,
      system: baseLoc ? baseLoc.system : undefined,
      items,
      giverName: user.username, // who logistics collects from
      note: `Finished goods to distribute — from ${user.username}`,
      createdBy: user._id, createdByName: user.username,
    });
    return { sent: items.length };
  },
});

// A distributor pulls: asks logistics to move a crafter's finished item to their
// stockpile. Creates a Move pre-bound to the distributor — logistics collects
// from the crafter, then the resulting Distribution delivery is already theirs.
export const requestMove = mutation({
  args: { sessionToken: v.string(), stockId: v.id("stock"), location: v.string(), system: v.optional(v.string()) },
  handler: async (ctx, { sessionToken, stockId, location, system }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["distributor", "admin"]);
    if (!location.trim()) throw new ConvexError("Stockpile location is required");
    const s = await ctx.db.get(stockId);
    if (!s || s.kind !== "item" || s.status !== "crafted") throw new ConvexError("Can only request finished items");
    for (const kind of ["move", "distribution"]) {
      for (const w of (await ctx.db.query("workorders").withIndex("by_kind", q => q.eq("kind", kind)).collect())) {
        if (w.status !== "done" && (w.items ?? []).some(it => it.stockId === stockId)) throw new ConvexError("That item is already being moved");
      }
    }
    const baseLoc = (await ctx.db.query("locationCatalog").collect()).find(l => l.isBase);
    await ctx.db.insert("workorders", {
      kind: "move", status: "open",
      location: baseLoc ? baseLoc.name : s.location,
      system: baseLoc ? baseLoc.system : s.system,
      items: [{ stockId: s._id, name: s.name, kind: s.kind, qty: s.qty, unit: s.unit, qualityStep: s.qualityValue ?? undefined }],
      giverName: s.heldBy,                 // logistics collects from this crafter
      takerId: user._id, takerName: user.username,
      destLocation: location.trim(), destSystem: system?.trim() || undefined,
      note: `${s.name} requested by ${user.username} → ${location.trim()}`,
      createdBy: user._id, createdByName: user.username,
    });
    return { ok: true };
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
    if (!user.roles.includes("logistics")) throw new ConvexError("Logistics only");
    if (wo.claimedById !== user._id) throw new ConvexError("Accept the pickup first");
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

// Admin authors a craft order (demand): make N of an item, at a priority, with
// an optional cap on how many crafters work it and an optional quality window
// (min/max, 1..10) for the materials that may be used.
export const createCraftOrder = mutation({
  args: {
    sessionToken: v.string(), itemName: v.string(), qtyNeeded: v.number(), priority: v.string(),
    maxCrafters: v.optional(v.number()),
    matReqs: v.optional(v.array(v.object({
      materialName: v.string(), minQuality: v.optional(v.number()), maxQuality: v.optional(v.number()),
    }))),
  },
  handler: async (ctx, a) => {
    const user = await requireSession(ctx.db, a.sessionToken);
    assertRole(user, ["admin"]);
    const item = await ctx.db.query("itemCatalog").withIndex("by_name", q => q.eq("name", a.itemName.trim())).first();
    if (!item) throw new ConvexError("Unknown item");
    if (!(a.qtyNeeded > 0)) throw new ConvexError("Quantity must be greater than 0");
    if (!PRIORITIES.includes(a.priority)) throw new ConvexError("Invalid priority");
    if (a.maxCrafters != null && (!Number.isInteger(a.maxCrafters) || a.maxCrafters < 1)) throw new ConvexError("Crafters cap must be 1 or more");

    // Validate per-material quality windows against the recipe.
    const qOk = (q?: number) => q == null || (Number.isInteger(q) && q >= 1 && q <= QUALITY_STEPS);
    const recipeNames = new Set((item.recipe ?? []).map(r => r.materialName));
    const matReqs = (a.matReqs ?? [])
      .map(m => ({ materialName: m.materialName.trim(), minQuality: m.minQuality ?? undefined, maxQuality: m.maxQuality ?? undefined }))
      .filter(m => m.materialName && (m.minQuality != null || m.maxQuality != null));
    for (const m of matReqs) {
      if (!recipeNames.has(m.materialName)) throw new ConvexError(`${m.materialName} is not in this item's recipe`);
      if (!qOk(m.minQuality) || !qOk(m.maxQuality)) throw new ConvexError(`Quality band must be between 1 and ${QUALITY_STEPS}`);
      if (m.minQuality != null && m.maxQuality != null && m.minQuality > m.maxQuality) throw new ConvexError(`${m.materialName}: min quality can't exceed max quality`);
    }

    const id = await ctx.db.insert("workorders", {
      kind: "craft", status: "open",
      itemName: item.name, qtyNeeded: a.qtyNeeded, qtyDone: 0, priority: a.priority,
      maxCrafters: a.maxCrafters ?? undefined,
      matReqs: matReqs.length ? matReqs : undefined,
      crafters: [],
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
  args: {
    sessionToken: v.string(), orderId: v.id("workorders"), count: v.number(),
    location: v.optional(v.string()), // override default base location
    system: v.optional(v.string()),
  },
  handler: async (ctx, { sessionToken, orderId, count, location, system }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["crafter", "admin"]);
    if (!(count > 0)) throw new ConvexError("Count must be greater than 0");
    const order = await ctx.db.get(orderId);
    if (!order || order.kind !== "craft") throw new ConvexError("Not a craft order");
    if (order.status !== "open") throw new ConvexError("Order is not open");
    const remaining = (order.qtyNeeded ?? 0) - (order.qtyDone ?? 0);
    if (remaining <= 0) throw new ConvexError("Order is already fulfilled");
    if (count > remaining) count = remaining;

    // Crafter cap: only so many distinct crafters may work the order.
    const crafters = order.crafters ?? [];
    const isMember = crafters.some(c => c.userId === user._id || c.userName === user.username);
    if (order.maxCrafters != null && !isMember && crafters.length >= order.maxCrafters) {
      throw new ConvexError(`This order is full (${order.maxCrafters} crafter${order.maxCrafters === 1 ? "" : "s"})`);
    }

    const item = await ctx.db.query("itemCatalog").withIndex("by_name", q => q.eq("name", order.itemName!)).first();
    if (!item || !item.recipe?.length) throw new ConvexError("This item has no recipe");

    // Each recipe material has its own quality window: prefer the order's
    // per-material req, fall back to the legacy order-wide window, else any.
    const matQ = (s: any) => s.qualityStep ?? s.qualityValue ?? 0;
    const windowFor = (materialName: string) => {
      const req = (order.matReqs ?? []).find(m => m.materialName === materialName);
      const minQ = req?.minQuality ?? order.minQuality ?? 1;
      const maxQ = req?.maxQuality ?? order.maxQuality ?? QUALITY_STEPS;
      return { minQ, maxQ };
    };
    const qLabel = (materialName: string) => {
      const { minQ, maxQ } = windowFor(materialName);
      return (minQ > 1 || maxQ < QUALITY_STEPS) ? ` at Q${minQ}–${maxQ}` : "";
    };
    // The crafter's own At-Base material stock (filtered per-material below).
    const allMine = (await ctx.db.query("stock").withIndex("by_status", q => q.eq("status", "at_base")).collect())
      .filter(s => s.kind === "material" && s.heldBy === user.username);
    const matsFor = (materialName: string) => {
      const { minQ, maxQ } = windowFor(materialName);
      return allMine.filter(s => s.name === materialName && matQ(s) >= minQ && matQ(s) <= maxQ);
    };

    for (const r of item.recipe) {
      const have = matsFor(r.materialName).reduce((sum, s) => sum + s.qty, 0);
      if (have + 1e-9 < r.qty * count) throw new ConvexError(`Not enough ${r.materialName}${qLabel(r.materialName)}: need ${r3(r.qty * count)}, you hold ${r3(have)}`);
    }

    // Consume lowest-quality first; accumulate qty-weighted quality.
    let qtySum = 0, weighted = 0;
    for (const r of item.recipe) {
      let need = r.qty * count;
      const rows = matsFor(r.materialName)
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
    const useLoc = location?.trim() || (base ? base.name : "Base");
    const useSys = system?.trim() || (base ? base.system : undefined);
    await ctx.db.insert("stock", {
      kind: "item", name: item.name, category: item.category ?? "",
      qualityValue: outQuality, qty: count, unit: "UNIT",
      location: useLoc, system: useSys,
      heldBy: user.username, status: "crafted",
      addedBy: user._id, addedByName: user.username,
    });

    const newDone = (order.qtyDone ?? 0) + count;
    const newCrafters = isMember ? crafters : [...crafters, { userId: user._id, userName: user.username }];
    await ctx.db.patch(orderId, { qtyDone: newDone, status: newDone >= (order.qtyNeeded ?? 0) ? "done" : "open", crafters: newCrafters });
    await ctx.db.insert("archive", { type: "item_crafted", userId: user._id, userName: user.username, details: { item: item.name, count, quality: outQuality } });
    return { crafted: count, quality: outQuality };
  },
});

// ── Borrow between crafters (a crafter→crafter material transfer) ──────────────
// Same two-party meet as every transfer: the borrower requests a holder's
// At-Base material; the holder (lender) accepts; the borrower confirms receipt
// and it becomes the borrower's stock.
export const requestBorrow = mutation({
  args: { sessionToken: v.string(), stockId: v.id("stock"), qty: v.number() },
  handler: async (ctx, { sessionToken, stockId, qty }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["crafter", "admin"]);
    const s = await ctx.db.get(stockId);
    if (!s || s.kind !== "material" || s.status !== "at_base") throw new ConvexError("You can only borrow At-Base materials");
    if (s.heldBy === user.username) throw new ConvexError("That material is already yours");
    if (!(qty > 0) || qty > s.qty + 1e-9) throw new ConvexError("Invalid quantity");
    const lender = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", s.heldBy)).first();
    await ctx.db.insert("workorders", {
      kind: "borrow", status: "open",
      location: s.location, system: s.system,
      items: [{ stockId: s._id, name: s.name, kind: "material", qty: r3(qty), unit: s.unit, qualityStep: s.qualityStep }],
      giverName: s.heldBy, giverId: lender?._id,
      note: `Borrow ${r3(qty)} ${s.unit} ${s.name} from ${s.heldBy}`,
      createdBy: user._id, createdByName: user.username,
    });
    await ctx.db.insert("archive", { type: "borrow_requested", userId: user._id, userName: user.username, details: { item: s.name, qty: r3(qty), from: s.heldBy } });
    return { ok: true };
  },
});

// The holder (lender) agrees to lend.
export const acceptBorrow = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo || wo.kind !== "borrow") throw new ConvexError("Borrow not found");
    if (wo.status !== "open") throw new ConvexError("This borrow is no longer open");
    // Only the actual holder (lender) can agree to lend — admin cannot accept on
    // their behalf.
    if (wo.giverName !== user.username && wo.giverId !== user._id) throw new ConvexError("Only the holder can agree to lend this");
    await ctx.db.patch(id, { status: "claimed", claimedById: user._id, claimedByName: user.username });
  },
});

// The borrower confirms they met the lender and got it → material moves to them.
export const confirmBorrow = mutation({
  args: { sessionToken: v.string(), id: v.id("workorders") },
  handler: async (ctx, { sessionToken, id }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const wo = await ctx.db.get(id);
    if (!wo || wo.kind !== "borrow") throw new ConvexError("Borrow not found");
    if (wo.status !== "claimed") throw new ConvexError("The holder must agree first");
    // Only the borrower (the person who made the request) confirms receipt — they
    // are the one who physically received the materials and must confirm that.
    if (wo.createdBy !== user._id) throw new ConvexError("Only the borrower confirms receipt");
    let moved = 0;
    for (const it of wo.items ?? []) {
      const s = await ctx.db.get(it.stockId);
      if (!s || s.kind !== "material" || s.heldBy !== wo.giverName) continue;
      const take = Math.min(it.qty, s.qty);
      if (take <= 1e-9) continue;
      const left = r3(s.qty - take);
      if (left <= 1e-9) await ctx.db.delete(s._id);
      else await ctx.db.patch(s._id, { qty: left });
      // heldBy is set to user.username (the borrower pressing Confirm) — explicit
      // and correct; matches wo.createdByName but avoids stale denormalized name.
      await ctx.db.insert("stock", {
        kind: "material", name: s.name, category: s.category,
        qualityStep: s.qualityStep, qualityValue: s.qualityValue,
        qty: r3(take), unit: s.unit, location: s.location, system: s.system,
        heldBy: user.username, status: "at_base",
        addedBy: user._id, addedByName: user.username,
      });
      moved += take;
    }
    if (!moved) throw new ConvexError("That material is no longer available to borrow");
    await ctx.db.patch(id, { status: "done" });
    await ctx.db.insert("archive", { type: "borrow_completed", userId: user._id, userName: user.username, details: { item: (wo.items?.[0]?.name) || "", qty: r3(moved), from: wo.giverName } });
    return { moved: r3(moved) };
  },
});
