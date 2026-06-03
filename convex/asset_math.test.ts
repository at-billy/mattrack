import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

// Load all convex function modules (excludes files with extra dots, e.g. *.test.ts).
const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let counter = 0;
async function seedUserSession(t: any, roles: string[]) {
  counter += 1;
  const username = `user${counter}`;
  const token = `token${counter}`;
  const userId = await t.run(async (ctx: any) => {
    const id = await ctx.db.insert("users", { username, passwordHash: "x", roles });
    await ctx.db.insert("sessions", { userId: id, token, createdAt: Date.now() });
    return id;
  });
  return { userId, token };
}

const availableItems = (t: any) =>
  t.run(async (ctx: any) =>
    ctx.db.query("items").withIndex("by_status", (q: any) => q.eq("status", "available")).collect());

const itemsByStatus = (t: any, status: string) =>
  t.run(async (ctx: any) =>
    ctx.db.query("items").withIndex("by_status", (q: any) => q.eq("status", status)).collect());

const sum = (arr: any[], field = "quantity") => arr.reduce((s, x) => s + x[field], 0);

// ── Auto-stacking ────────────────────────────────────────────────────────────
describe("items.create auto-stacking", () => {
  test("identical available items merge into one stack", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["member"]);
    await t.mutation(api.items.create, { sessionToken: token, name: "Medpen", category: "other", quantity: 5, location: "Base" });
    await t.mutation(api.items.create, { sessionToken: token, name: "Medpen", category: "other", quantity: 3, location: "Base" });
    const items = await availableItems(t);
    expect(items.length).toBe(1);
    expect(items[0].quantity).toBe(8);
  });

  test("identical items added by DIFFERENT members do NOT merge", async () => {
    const t = convexTest(schema, modules);
    const a = await seedUserSession(t, ["member"]);
    const b = await seedUserSession(t, ["member"]);
    await t.mutation(api.items.create, { sessionToken: a.token, name: "ASD Secure Drive", category: "wikelo", quantity: 15, location: "New Babbage", system: "Stanton" });
    await t.mutation(api.items.create, { sessionToken: b.token, name: "ASD Secure Drive", category: "wikelo", quantity: 10, location: "New Babbage", system: "Stanton" });
    const items = await availableItems(t);
    expect(items.length).toBe(2);                 // separate rows per member
    expect(sum(items)).toBe(25);
  });

  test("items differing in any identity field do NOT merge", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["member"]);
    await t.mutation(api.items.create, { sessionToken: token, name: "Medpen", category: "other", quantity: 5, location: "Base A" });
    await t.mutation(api.items.create, { sessionToken: token, name: "Medpen", category: "other", quantity: 5, location: "Base B" });
    await t.mutation(api.items.create, { sessionToken: token, name: "Bandage", category: "other", quantity: 5, location: "Base A" });
    const items = await availableItems(t);
    expect(items.length).toBe(3);
  });
});

// ── Partial hand-out splitting ───────────────────────────────────────────────
describe("items.handOut splitting", () => {
  test("partial hand-out reduces source and creates a handed-out row", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["core"]);
    const id = await t.mutation(api.items.create, { sessionToken: token, name: "Helmet", category: "fps_armor", quantity: 10, location: "Base" });
    await t.mutation(api.items.handOut, { sessionToken: token, itemId: id, handedOutTo: "Bob", handedOutQty: 4 });

    const avail = await availableItems(t);
    expect(avail.length).toBe(1);
    expect(avail[0].quantity).toBe(6);

    const handed = await itemsByStatus(t, "handed_out");
    expect(handed.length).toBe(1);
    expect(handed[0].quantity).toBe(4);
    expect(handed[0].handedOutTo).toBe("Bob");
    expect(handed[0].heldBy).toBe("Bob");
  });

  test("full-quantity hand-out converts the row in place (no split)", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["core"]);
    const id = await t.mutation(api.items.create, { sessionToken: token, name: "Rifle", category: "fps_weapon", quantity: 3, location: "Base" });
    await t.mutation(api.items.handOut, { sessionToken: token, itemId: id, handedOutTo: "Ann", handedOutQty: 3 });

    expect((await availableItems(t)).length).toBe(0);
    const handed = await itemsByStatus(t, "handed_out");
    expect(handed.length).toBe(1);
    expect(handed[0].quantity).toBe(3);
  });

  test("hand-out rejects quantity greater than stock", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["core"]);
    const id = await t.mutation(api.items.create, { sessionToken: token, name: "Rifle", category: "fps_weapon", quantity: 2, location: "Base" });
    await expect(
      t.mutation(api.items.handOut, { sessionToken: token, itemId: id, handedOutTo: "Ann", handedOutQty: 5 }),
    ).rejects.toThrow();
  });
});

// ── MG Scrip -> Wikelo Favor conversion ──────────────────────────────────────
describe("items.convertMgScrip", () => {
  test("converts at 50:1, leaves the remainder, stacks the favors", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["member"]);
    const id = await t.mutation(api.items.create, { sessionToken: token, name: "MG Scrip", category: "wikelo", quantity: 120, location: "Vault" });
    await t.mutation(api.items.convertMgScrip, { sessionToken: token, itemId: id, favors: 2 });

    const avail = await availableItems(t);
    const scrip = avail.find((i: any) => i.name === "MG Scrip");
    const favor = avail.find((i: any) => i.name === "Wikelo Favor");
    expect(scrip.quantity).toBe(20);          // 120 - 2*50
    expect(favor.quantity).toBe(2);
    expect(favor.location).toBe("Vault");      // inherits source location
  });

  test("removes the scrip row when fully consumed", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["member"]);
    const id = await t.mutation(api.items.create, { sessionToken: token, name: "MG Scrip", category: "wikelo", quantity: 100, location: "Vault" });
    await t.mutation(api.items.convertMgScrip, { sessionToken: token, itemId: id, favors: 2 });
    const avail = await availableItems(t);
    expect(avail.find((i: any) => i.name === "MG Scrip")).toBeUndefined();
    expect(avail.find((i: any) => i.name === "Wikelo Favor").quantity).toBe(2);
  });

  test("rejects converting more than affordable, and non-MG-Scrip items", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["member"]);
    const scrip = await t.mutation(api.items.create, { sessionToken: token, name: "MG Scrip", category: "wikelo", quantity: 60, location: "V" });
    await expect(t.mutation(api.items.convertMgScrip, { sessionToken: token, itemId: scrip, favors: 2 })).rejects.toThrow();
    const other = await t.mutation(api.items.create, { sessionToken: token, name: "Carinite", category: "wikelo", quantity: 100, location: "V" });
    await expect(t.mutation(api.items.convertMgScrip, { sessionToken: token, itemId: other, favors: 1 })).rejects.toThrow();
  });
});

// ── Project allocation (tasks.useItems) ──────────────────────────────────────
describe("tasks.useItems allocation", () => {
  test("consumes exactly N across multiple stacks, splitting the last one", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["admin"]);
    // Two non-merging stacks of the same item (different locations): 3 + 4 = 7
    await t.mutation(api.items.create, { sessionToken: token, name: "Wikelo Favor", category: "wikelo", quantity: 3, location: "Hangar" });
    await t.mutation(api.items.create, { sessionToken: token, name: "Wikelo Favor", category: "wikelo", quantity: 4, location: "Vault" });

    const taskId = await t.mutation(api.tasks.create, {
      sessionToken: token, title: "Build", priority: "normal", targetRoles: ["member"],
      requiredItems: [{ name: "Wikelo Favor", category: "wikelo", quantityNeeded: 5 }],
    });
    await t.mutation(api.tasks.useItems, { sessionToken: token, taskId });

    const avail = await availableItems(t);
    const used = await itemsByStatus(t, "used");
    expect(sum(avail)).toBe(2);   // 7 - 5
    expect(sum(used)).toBe(5);    // exactly N consumed

    const archive = await t.run(async (ctx: any) => ctx.db.query("archive").collect());
    expect(archive.some((a: any) => a.type === "items_used_for_project")).toBe(true);
  });

  test("previewUseItems reports the plan + shortfall without mutating", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["admin"]);
    await t.mutation(api.items.create, { sessionToken: token, name: "Wikelo Favor", category: "wikelo", quantity: 3, location: "Hangar" });
    await t.mutation(api.items.create, { sessionToken: token, name: "Wikelo Favor", category: "wikelo", quantity: 1, location: "Vault" });
    const taskId = await t.mutation(api.tasks.create, {
      sessionToken: token, title: "Build", priority: "normal", targetRoles: ["member"],
      requiredItems: [{ name: "Wikelo Favor", category: "wikelo", quantityNeeded: 6 }],
    });

    const preview = await t.query(api.tasks.previewUseItems, { sessionToken: token, taskId });
    expect(preview.totalConsumed).toBe(4);          // only 4 in stock
    expect(preview.plan[0].consumed).toBe(4);
    expect(preview.plan[0].shortfall).toBe(2);      // 6 needed - 4 available
    expect(preview.plan[0].sources.length).toBe(2); // drawn from both stacks

    // Preview must not consume anything
    expect(sum(await availableItems(t))).toBe(4);
    expect((await itemsByStatus(t, "used")).length).toBe(0);
  });

  test("errors when no inventory matches the required item", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["admin"]);
    const taskId = await t.mutation(api.tasks.create, {
      sessionToken: token, title: "Build", priority: "normal", targetRoles: ["member"],
      requiredItems: [{ name: "Nonexistent", category: "wikelo", quantityNeeded: 1 }],
    });
    await expect(
      t.mutation(api.tasks.useItems, { sessionToken: token, taskId }),
    ).rejects.toThrow();
  });
});

// ── Authorization & validation gates ─────────────────────────────────────────
describe("authorization & validation", () => {
  test("recruit cannot create items", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["recruit"]);
    await expect(
      t.mutation(api.items.create, { sessionToken: token, name: "X", category: "other", quantity: 1, location: "Base" }),
    ).rejects.toThrow();
  });

  test("member cannot use items for a project (admin/command only)", async () => {
    const t = convexTest(schema, modules);
    const { token: adminTok } = await seedUserSession(t, ["admin"]);
    await t.mutation(api.items.create, { sessionToken: adminTok, name: "Wikelo Favor", category: "wikelo", quantity: 3, location: "Hangar" });
    const taskId = await t.mutation(api.tasks.create, {
      sessionToken: adminTok, title: "Build", priority: "normal", targetRoles: ["member"],
      requiredItems: [{ name: "Wikelo Favor", category: "wikelo", quantityNeeded: 1 }],
    });
    const { token: memberTok } = await seedUserSession(t, ["member"]);
    await expect(
      t.mutation(api.tasks.useItems, { sessionToken: memberTok, taskId }),
    ).rejects.toThrow();
  });

  test("invalid item category is rejected", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["member"]);
    await expect(
      t.mutation(api.items.create, { sessionToken: token, name: "X", category: "weapons_lol", quantity: 1, location: "Base" }),
    ).rejects.toThrow();
  });

  test("non-positive quantity is rejected", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedUserSession(t, ["member"]);
    await expect(
      t.mutation(api.items.create, { sessionToken: token, name: "X", category: "other", quantity: 0, location: "Base" }),
    ).rejects.toThrow();
  });
});
