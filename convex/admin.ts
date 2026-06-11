import { mutation, internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireSession, assertRole } from "./_helpers";
import { verifyPassword, hashPassword } from "./_password";
import { assertNotLocked, recordFailure, clearThrottle } from "./_throttle";

// The made-up demo members the seeders create (password "demo1234"). Listed once
// so the seeder and the teardown agree on exactly who is demo data.
const DEMO_USERS = [
  { username: "kade", roles: ["gatherer"] },
  { username: "nira", roles: ["crafter"] },
  { username: "tovo", roles: ["crafter", "gatherer"] },
  { username: "vex",  roles: ["logistics"] },
  { username: "rin",  roles: ["distributor"] },
];

// Destructive reset for demos/presentations. Clears all transactional data —
// stock, work orders (incl. transfers in progress), the activity log, password
// reset requests, and finished lotteries (open/drawn/closed). KEEPS the catalog
// (materials, items, locations incl. the base), users + roles + logins, and any
// draft lotteries (the prepared prize pool). Admin-only, password-gated.
export const wipeForDemo = mutation({
  args: { sessionToken: v.string(), password: v.string() },
  handler: async (ctx, { sessionToken, password }) => {
    const user = await requireSession(ctx.db, sessionToken);
    assertRole(user, ["admin"]);
    const key = "wipe:" + user._id;
    const throttle = await assertNotLocked(ctx.db, key);
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) { await recordFailure(ctx.db, key, throttle); throw new ConvexError("Password is incorrect"); }
    await clearThrottle(ctx.db, key, throttle);

    const clear = async (table: "stock" | "workorders" | "archive" | "passwordResets") => {
      const rows = await ctx.db.query(table).collect();
      for (const r of rows) await ctx.db.delete(r._id);
      return rows.length;
    };
    const stock = await clear("stock");
    const workorders = await clear("workorders");
    const archive = await clear("archive");
    const passwordResets = await clear("passwordResets");

    // Lotteries: drop runs (open/drawn/closed), keep drafts (the prize pool).
    let lotteries = 0;
    for (const l of await ctx.db.query("lotteries").collect()) {
      if (l.status !== "draft") { await ctx.db.delete(l._id); lotteries++; }
    }

    return { stock, workorders, archive, passwordResets, lotteries };
  },
});

// One-shot demo seeder (run from CLI: `npx convex run admin:seedDemo`). Internal
// so it needs no session — it attributes authored data to the existing admin.
// Creates neutral demo members and a believable mid-flight pipeline, with log
// entries, so the app looks in real use for a client demo. Safe to re-run after
// a wipe; it skips the transactional seed if stock already exists.
export const seedDemo = internalMutation({
  args: { confirm: v.optional(v.string()) },
  handler: async (ctx, { confirm }) => {
    // Explicit opt-in so this can never run by accident on the live deployment.
    if (confirm !== "seed") throw new ConvexError('Refusing to seed demo data — pass confirm:"seed" to run');
    const admin = (await ctx.db.query("users").collect()).find(u => (u.roles || []).includes("admin"));
    if (!admin) throw new ConvexError("No admin user found to attribute demo data to");

    // ── Demo members (idempotent) — password "demo1234" ──
    const demoPw = await hashPassword("demo1234");
    const demoUsers = DEMO_USERS;
    const idByName: Record<string, any> = { [admin.username]: admin._id };
    for (const du of demoUsers) {
      const existing = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", du.username)).first();
      if (existing) { idByName[du.username] = existing._id; continue; }
      const id = await ctx.db.insert("users", { username: du.username, passwordHash: demoPw, roles: du.roles, requestedRoles: [] });
      idByName[du.username] = id;
      await ctx.db.insert("archive", { type: "user_joined", userId: id, userName: du.username, details: {} });
      await ctx.db.insert("archive", { type: "role_approved", userId: admin._id, userName: admin.username, details: { targetUsername: du.username, role: du.roles[0] } });
    }

    // Don't double-seed the pipeline if it's already populated.
    if ((await ctx.db.query("stock").take(1)).length > 0) {
      return { seededUsers: demoUsers.length, pipeline: "skipped (stock already present)" };
    }

    const base = (await ctx.db.query("locationCatalog").collect()).find(l => l.isBase);
    const baseName = base ? base.name : "Levski";
    const baseSys = base ? base.system : undefined;

    const mats = await ctx.db.query("materialCatalog").collect();
    const matByName: Record<string, any> = {}; for (const m of mats) matByName[m.name] = m;
    const allItems = (await ctx.db.query("itemCatalog").collect()).filter(it => (it.recipe || []).length > 0);
    // pick 3 items whose recipe materials all exist (so they're truly craftable)
    const orderItems = (allItems.filter(it => (it.recipe || []).every((r: any) => matByName[r.materialName])).slice(0, 3));
    const items = orderItems.length ? orderItems : allItems.slice(0, 3);

    const qOf = (m: any) => { const qs = (m && m.qualities) || []; if (!qs.length) return { step: undefined, value: undefined }; const mid = qs[Math.floor(qs.length / 2)]; return { step: mid.step, value: mid.value }; };
    const addStock = (o: any) => ctx.db.insert("stock", Object.assign({ addedBy: idByName[o.heldBy] || admin._id, addedByName: o.heldBy }, o));

    // 1) At-base materials held by nira, enough to actually craft the open orders
    for (const it of items) {
      for (const r of (it.recipe || [])) {
        const m = matByName[r.materialName]; const q = qOf(m);
        await addStock({ kind: "material", name: r.materialName, category: (m && m.category) || "", qualityStep: q.step, qualityValue: q.value, qty: Math.max(40, r.qty * 8), unit: (m && m.unit) || "SCU", location: baseName, system: baseSys, heldBy: "nira", status: "at_base" });
      }
    }

    // 2) In-transit materials (vex carrying) + an open delivery for crafters to receive
    const deliverItems: any[] = [];
    for (const m of mats.slice(0, 3)) {
      const q = qOf(m);
      const id = await addStock({ kind: "material", name: m.name, category: m.category, qualityStep: q.step, qualityValue: q.value, qty: 60, unit: m.unit, location: baseName, system: baseSys, heldBy: "vex", status: "in_transit" });
      deliverItems.push({ stockId: id, name: m.name, kind: "material", qty: 60, unit: m.unit, qualityStep: q.step });
    }
    await ctx.db.insert("workorders", { kind: "delivery", status: "open", location: baseName, system: baseSys, items: deliverItems, note: "Inbound to base, picked up by vex", createdBy: idByName["vex"], createdByName: "vex" });

    // 3) Crafted items (off the bench, held by nira) + a move out to logistics
    const craftedIds: any[] = [];
    for (const it of items.slice(0, 2)) {
      const id = await addStock({ kind: "item", name: it.name, category: it.category || "", qualityValue: 720, qty: 3, unit: "UNIT", location: baseName, system: baseSys, heldBy: "nira", status: "crafted" });
      craftedIds.push({ id, name: it.name });
      await ctx.db.insert("archive", { type: "item_crafted", userId: idByName["nira"], userName: "nira", details: { item: it.name, count: 3, quality: 720 } });
    }
    if (craftedIds[0]) {
      await ctx.db.insert("workorders", { kind: "move", status: "open", location: baseName, system: baseSys, items: [{ stockId: craftedIds[0].id, name: craftedIds[0].name, kind: "item", qty: 3, unit: "UNIT" }], giverName: "nira", note: "Finished goods to distribute, from nira", createdBy: idByName["nira"], createdByName: "nira" });
    }

    // 4) Distributor stockpile + one handed-out (history)
    for (const it of items.slice(0, 2)) {
      await addStock({ kind: "item", name: it.name, category: it.category || "", qualityValue: 760, qty: 5, unit: "UNIT", location: baseName, system: baseSys, heldBy: "rin", status: "with_distributor" });
    }
    if (items[0]) {
      await addStock({ kind: "item", name: items[0].name, category: items[0].category || "", qualityValue: 700, qty: 2, unit: "UNIT", location: baseName, system: baseSys, heldBy: "rin", status: "handed_out", note: "to Echo Squad (event)" });
      await ctx.db.insert("archive", { type: "item_handed_out", userId: idByName["rin"], userName: "rin", details: { qty: 2, item: items[0].name, recipient: "Echo Squad", context: "event" } });
    }

    // 5) An open pickup (kade reported a haul)
    await ctx.db.insert("workorders", { kind: "pickup", status: "open", location: "Daymar", report: [
      { type: "Mineable", what: mats[0] ? mats[0].name : "Iron", approxQty: 120, unit: "SCU" },
      { type: "Mineable", what: mats[1] ? mats[1].name : "Tin", approxQty: 60, unit: "SCU" },
    ], createdBy: idByName["kade"], createdByName: "kade" });
    await ctx.db.insert("archive", { type: "gather_reported", userId: idByName["kade"], userName: "kade", details: { count: 2, location: "Daymar" } });
    await ctx.db.insert("archive", { type: "workorder_completed", userId: idByName["vex"], userName: "vex", details: { kind: "pickup", location: "Daymar", count: 3 } });

    // 6) Open craft orders (one urgent), attributed to the admin
    const prios = ["urgent", "normal", "high"];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const qtyNeeded = 10 + i * 5; const qtyDone = i === 0 ? 4 : 0;
      await ctx.db.insert("workorders", {
        kind: "craft", status: "open", itemName: it.name, qtyNeeded, qtyDone, priority: prios[i % prios.length],
        maxCrafters: i === 1 ? 3 : undefined,
        crafters: qtyDone > 0 ? [{ userId: idByName["nira"], userName: "nira" }] : [],
        createdBy: admin._id, createdByName: admin.username,
      });
      await ctx.db.insert("archive", { type: "workorder_created", userId: admin._id, userName: admin.username, details: { kind: "craft", item: it.name, qty: qtyNeeded } });
    }

    // 7) A little extra log colour
    await ctx.db.insert("archive", { type: "stock_added", userId: idByName["nira"], userName: "nira", details: { name: mats[0] ? mats[0].name : "Iron", qty: 200, unit: "SCU", kind: "material" } });

    return { seededUsers: demoUsers.length, orders: items.length, craftedMoves: craftedIds.length, items: items.map(i => i.name) };
  },
});

// Top up the admin account so they can personally walk crafting + distribution
// in a live demo: grants every functional role, and (once) gives the admin their
// own at-base materials for the open orders, a few crafted items to Send, and a
// stockpile to Hand Out. Run via `npx convex run admin:seedAdminDemo`.
export const seedAdminDemo = internalMutation({
  args: { confirm: v.optional(v.string()) },
  handler: async (ctx, { confirm }) => {
    if (confirm !== "seed") throw new ConvexError('Refusing to seed admin demo inventory — pass confirm:"seed" to run');
    const admin = (await ctx.db.query("users").collect()).find(u => (u.roles || []).includes("admin"));
    if (!admin) throw new ConvexError("No admin user found");
    const me = admin.username;

    // Every functional role, so all nav sections + actions are available.
    const roles = Array.from(new Set([...(admin.roles || []), "crafter", "distributor", "logistics", "gatherer"]));
    await ctx.db.patch(admin._id, { roles });

    const base = (await ctx.db.query("locationCatalog").collect()).find(l => l.isBase);
    const baseName = base ? base.name : "Levski";
    const baseSys = base ? base.system : undefined;
    const mats = await ctx.db.query("materialCatalog").collect();
    const matByName: Record<string, any> = {}; for (const m of mats) matByName[m.name] = m;
    const itemsCat = await ctx.db.query("itemCatalog").collect();
    const itemByName: Record<string, any> = {}; for (const it of itemsCat) itemByName[it.name] = it;
    const qOf = (m: any) => { const qs = (m && m.qualities) || []; if (!qs.length) return { step: undefined, value: undefined }; const mid = qs[Math.floor(qs.length / 2)]; return { step: mid.step, value: mid.value }; };
    const addStock = (o: any) => ctx.db.insert("stock", Object.assign({ addedBy: admin._id, addedByName: me }, o));

    // Idempotent: skip inventory if the admin already holds at-base stock.
    const mineAtBase = (await ctx.db.query("stock").withIndex("by_status", q => q.eq("status", "at_base")).collect()).filter(s => s.heldBy === me);
    if (mineAtBase.length > 0) return { rolesNow: roles, seededInventory: false };

    const craftOrders = (await ctx.db.query("workorders").withIndex("by_kind", q => q.eq("kind", "craft")).collect()).filter(w => w.status === "open");

    // 1) Admin's own at-base materials for every open order's recipe → can Craft.
    const seeded = new Set<string>();
    for (const o of craftOrders) {
      const it = itemByName[o.itemName || ""]; if (!it) continue;
      for (const r of (it.recipe || [])) {
        if (seeded.has(r.materialName)) continue; seeded.add(r.materialName);
        const m = matByName[r.materialName]; const q = qOf(m);
        await addStock({ kind: "material", name: r.materialName, category: (m && m.category) || "", qualityStep: q.step, qualityValue: q.value, qty: Math.max(60, r.qty * 10), unit: (m && m.unit) || "SCU", location: baseName, system: baseSys, heldBy: me, status: "at_base" });
      }
    }
    // 2) A couple finished items the admin holds → can Send to logistics.
    const someItem = (craftOrders[0] && craftOrders[0].itemName) || (itemsCat[0] && itemsCat[0].name) || "Item";
    const someCat = (itemByName[someItem] && itemByName[someItem].category) || "";
    await addStock({ kind: "item", name: someItem, category: someCat, qualityValue: 740, qty: 4, unit: "UNIT", location: baseName, system: baseSys, heldBy: me, status: "crafted" });
    // 3) Admin's own distributor stockpile → can Hand Out.
    await addStock({ kind: "item", name: someItem, category: someCat, qualityValue: 780, qty: 6, unit: "UNIT", location: baseName, system: baseSys, heldBy: me, status: "with_distributor" });

    return { rolesNow: roles, seededInventory: true };
  },
});

// Launch teardown: removes the made-up demo members (and their sessions + auth
// throttle rows) so the demo's weak "demo1234" logins don't survive into
// production. Run Wipe first to clear demo stock/work orders/log, then run this:
// `npx convex run admin:clearDemo '{"confirm":"remove-demo"}'`. Real accounts
// (admin etc.) are never touched. Does not alter the admin's roles.
export const clearDemo = internalMutation({
  args: { confirm: v.string() },
  handler: async (ctx, { confirm }) => {
    if (confirm !== "remove-demo") throw new ConvexError('Refusing to remove demo accounts — pass confirm:"remove-demo" to run');
    let users = 0, sessions = 0, throttles = 0;
    const allSessions = await ctx.db.query("sessions").collect();
    for (const du of DEMO_USERS) {
      const u = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", du.username)).first();
      if (!u) continue;
      for (const s of allSessions) if (s.userId === u._id) { await ctx.db.delete(s._id); sessions++; }
      for (const key of [`login:${du.username.toLowerCase()}`, `pw:${u._id}`, `wipe:${u._id}`]) {
        const t = await ctx.db.query("authThrottle").withIndex("by_key", q => q.eq("key", key)).first();
        if (t) { await ctx.db.delete(t._id); throttles++; }
      }
      await ctx.db.delete(u._id);
      users++;
    }
    return { removedUsers: users, removedSessions: sessions, clearedThrottles: throttles };
  },
});

// Bulk import of stock from a migrated spreadsheet (admin-only). Rows are
// already completed/validated in the UI; the server re-checks the essentials:
// the material/item name must exist in the catalog, the holder must be a current
// member, qty > 0, and a location is present. Inserts one stock row each.
export const importStock = mutation({
  args: {
    sessionToken: v.string(),
    rows: v.array(v.object({
      kind: v.string(),                 // "material" | "item"
      name: v.string(),
      qty: v.number(),
      unit: v.optional(v.string()),
      location: v.string(),
      system: v.optional(v.string()),
      heldBy: v.string(),
      status: v.string(),               // material -> at_base, item -> crafted
      qualityStep: v.optional(v.number()),
      qualityValue: v.optional(v.number()),
    })),
  },
  handler: async (ctx, { sessionToken, rows }) => {
    const admin = await requireSession(ctx.db, sessionToken);
    assertRole(admin, ["admin"]);
    const lower = (s: string) => (s || "").trim().toLowerCase();
    const matBy = new Map((await ctx.db.query("materialCatalog").collect()).map(m => [lower(m.name), m]));
    const itemBy = new Map((await ctx.db.query("itemCatalog").collect()).map(it => [lower(it.name), it]));
    const userBy = new Map((await ctx.db.query("users").collect()).filter(u => !u.roles.includes("removed")).map(u => [lower(u.username), u]));
    const OK_STATUS = ["at_base", "in_transit", "crafted", "with_distributor"];

    let created = 0;
    for (const r of rows) {
      if (!(r.qty > 0)) throw new ConvexError(`Quantity must be greater than 0 (${r.name})`);
      if (!r.location.trim()) throw new ConvexError(`Location is required (${r.name})`);
      if (!OK_STATUS.includes(r.status)) throw new ConvexError(`Bad status for ${r.name}`);
      const holder = userBy.get(lower(r.heldBy));
      if (!holder) throw new ConvexError(`Unknown holder: ${r.heldBy}`);
      let name: string, category: string, unit: string;
      if (r.kind === "material") {
        const m = matBy.get(lower(r.name));
        if (!m) throw new ConvexError(`Unknown material: ${r.name}`);
        name = m.name; category = m.category || ""; unit = (r.unit && r.unit.trim()) || m.unit;
      } else if (r.kind === "item") {
        const it = itemBy.get(lower(r.name));
        if (!it) throw new ConvexError(`Unknown item: ${r.name}`);
        name = it.name; category = it.category || ""; unit = (r.unit && r.unit.trim()) || "UNIT";
      } else throw new ConvexError("Invalid kind");
      await ctx.db.insert("stock", {
        kind: r.kind, name, category,
        qualityStep: r.kind === "material" ? (r.qualityStep ?? undefined) : undefined,
        qualityValue: r.qualityValue ?? undefined,
        qty: r.qty, unit,
        location: r.location.trim(), system: r.system?.trim() || undefined,
        heldBy: holder.username, status: r.status,
        addedBy: admin._id, addedByName: admin.username,
      });
      created++;
    }
    return { created };
  },
});
