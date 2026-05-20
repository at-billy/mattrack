import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireSession } from "./_helpers";

const lotteryItemSchema = v.object({
  id: v.string(),
  name: v.string(),
  type: v.string(),
  typeName: v.string(),
  grade: v.string(),
  size: v.number(),
  tier: v.string(),
  value: v.number(),
});

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("lotteries").collect();
  },
});

export const create = mutation({
  args: {
    sessionToken: v.string(),
    title: v.string(),
  },
  handler: async (ctx, { sessionToken, title }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const id = await ctx.db.insert("lotteries", {
      title,
      status: "draft",
      createdBy: user._id,
      createdByName: user.username,
      items: [],
    });
    return id;
  },
});

export const updateTitle = mutation({
  args: {
    sessionToken: v.string(),
    lotteryId: v.id("lotteries"),
    title: v.string(),
  },
  handler: async (ctx, { sessionToken, lotteryId, title }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (lottery.status !== "draft") throw new Error("Can only modify draft lotteries");
    await ctx.db.patch(lotteryId, { title });
  },
});

export const addItem = mutation({
  args: {
    sessionToken: v.string(),
    lotteryId: v.id("lotteries"),
    item: lotteryItemSchema,
  },
  handler: async (ctx, { sessionToken, lotteryId, item }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (lottery.status !== "draft") throw new Error("Can only modify draft lotteries");
    await ctx.db.patch(lotteryId, { items: [...lottery.items, item] });
  },
});

export const removeItem = mutation({
  args: {
    sessionToken: v.string(),
    lotteryId: v.id("lotteries"),
    itemId: v.string(),
  },
  handler: async (ctx, { sessionToken, lotteryId, itemId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (lottery.status !== "draft") throw new Error("Can only modify draft lotteries");
    await ctx.db.patch(lotteryId, { items: lottery.items.filter(i => i.id !== itemId) });
  },
});

export const updateItemValue = mutation({
  args: {
    sessionToken: v.string(),
    lotteryId: v.id("lotteries"),
    itemId: v.string(),
    value: v.number(),
  },
  handler: async (ctx, { sessionToken, lotteryId, itemId, value }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (lottery.status !== "draft") throw new Error("Can only modify draft lotteries");
    await ctx.db.patch(lotteryId, {
      items: lottery.items.map(i => i.id === itemId ? { ...i, value } : i),
    });
  },
});

export const generatePackages = mutation({
  args: {
    sessionToken: v.string(),
    lotteryId: v.id("lotteries"),
    packageCount: v.number(),
  },
  handler: async (ctx, { sessionToken, lotteryId, packageCount }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (lottery.status !== "draft") throw new Error("Can only generate packages for draft lotteries");
    if (lottery.items.length === 0) throw new Error("No items in lottery");
    if (packageCount < 2 || packageCount > 20) throw new Error("Package count must be between 2 and 20");

    // Sort items by value descending for optimal greedy distribution
    const sorted = [...lottery.items].sort((a, b) => b.value - a.value);

    // Initialize packages
    const packages: Array<{
      pkgId: string;
      totalValue: number;
      items: typeof sorted;
      pickedBy?: string;
      pickedByName?: string;
    }> = [];
    for (let i = 0; i < packageCount; i++) {
      packages.push({ pkgId: `pkg_${i + 1}`, totalValue: 0, items: [] });
    }

    // Greedy: assign each item to the package with the lowest current total value
    for (const item of sorted) {
      const minPkg = packages.reduce((min, p) => p.totalValue < min.totalValue ? p : min, packages[0]);
      minPkg.items.push(item);
      minPkg.totalValue += item.value;
    }

    await ctx.db.patch(lotteryId, { packages });
  },
});

export const openLottery = mutation({
  args: {
    sessionToken: v.string(),
    lotteryId: v.id("lotteries"),
  },
  handler: async (ctx, { sessionToken, lotteryId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (!lottery.packages?.length) throw new Error("Generate packages first");
    if (lottery.status !== "draft") throw new Error("Lottery must be in draft status to open");
    // Clear winners only — keep entries (interested) and external names
    const packages = (lottery.packages ?? []).map(p => {
      const { winner: _w, ...rest } = p as any;
      return rest;
    });
    await ctx.db.patch(lotteryId, { status: "open", packages });
  },
});

export const pickPackage = mutation({
  args: {
    sessionToken: v.string(),
    lotteryId: v.id("lotteries"),
    pkgId: v.string(),
  },
  handler: async (ctx, { sessionToken, lotteryId, pkgId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (lottery.status !== "open") throw new Error("Lottery is not open for picking");

    const packages = lottery.packages ?? [];

    // Check if user already picked
    if (packages.some(p => p.pickedBy === user._id)) throw new Error("You already picked a package");

    const pkg = packages.find(p => p.pkgId === pkgId);
    if (!pkg) throw new Error("Package not found");
    if (pkg.pickedBy) throw new Error("This package is already taken");

    const newPackages = packages.map(p =>
      p.pkgId === pkgId ? { ...p, pickedBy: user._id, pickedByName: user.username } : p
    );
    await ctx.db.patch(lotteryId, { packages: newPackages });
  },
});

export const closeLottery = mutation({
  args: {
    sessionToken: v.string(),
    lotteryId: v.id("lotteries"),
  },
  handler: async (ctx, { sessionToken, lotteryId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (lottery.status !== "open" && lottery.status !== "drawn") throw new Error("Lottery must be open or drawn to close");
    await ctx.db.patch(lotteryId, { status: "closed" });
  },
});

export const backToDraft = mutation({
  args: {
    sessionToken: v.string(),
    lotteryId: v.id("lotteries"),
  },
  handler: async (ctx, { sessionToken, lotteryId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    // Clear winners/picks only — keep entries (interested) and external names
    const packages = (lottery.packages ?? []).map(p => {
      const { pickedBy: _pb, pickedByName: _pbn, winner: _w, ...rest } = p as any;
      return rest;
    });
    await ctx.db.patch(lotteryId, { status: "draft", packages });
  },
});

export const remove = mutation({
  args: {
    sessionToken: v.string(),
    lotteryId: v.id("lotteries"),
  },
  handler: async (ctx, { sessionToken, lotteryId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    await ctx.db.delete(lotteryId);
  },
});

export const addExternalName = mutation({
  args: { sessionToken: v.string(), lotteryId: v.id("lotteries"), name: v.string() },
  handler: async (ctx, { sessionToken, lotteryId, name }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (lottery.status !== "open") throw new Error("Can only add names to open lotteries");
    const existing = lottery.externalNames ?? [];
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Name cannot be empty");
    if (existing.some(n => n.toLowerCase() === trimmed.toLowerCase())) throw new Error("Name already added");
    await ctx.db.patch(lotteryId, { externalNames: [...existing, trimmed] });
  },
});

export const bulkAddExternalNames = mutation({
  args: { sessionToken: v.string(), lotteryId: v.id("lotteries"), names: v.array(v.string()) },
  handler: async (ctx, { sessionToken, lotteryId, names }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (lottery.status !== "open") throw new Error("Can only add names to open lotteries");
    const existing = new Set((lottery.externalNames ?? []).map((n: string) => n.toLowerCase()));
    const toAdd = names
      .map((n: string) => n.trim())
      .filter((n: string) => n.length > 0 && !existing.has(n.toLowerCase()));
    if (toAdd.length === 0) throw new Error("No new names to add (all duplicates or empty)");
    await ctx.db.patch(lotteryId, { externalNames: [...(lottery.externalNames ?? []), ...toAdd] });
    return toAdd.length;
  },
});

export const removeExternalName = mutation({
  args: { sessionToken: v.string(), lotteryId: v.id("lotteries"), name: v.string() },
  handler: async (ctx, { sessionToken, lotteryId, name }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (lottery.status !== "open") throw new Error("Can only modify open lotteries");
    const existing = lottery.externalNames ?? [];
    // Also remove this person's hat throws from all packages
    const packages = (lottery.packages ?? []).map(p => ({
      ...p,
      interested: (p.interested ?? []).filter((i: { id: string; name: string }) => i.id !== `ext_${name}`),
    }));
    await ctx.db.patch(lotteryId, {
      externalNames: existing.filter(n => n !== name),
      packages,
    });
  },
});

export const throwHat = mutation({
  args: {
    sessionToken: v.string(),
    lotteryId: v.id("lotteries"),
    pkgId: v.string(),
    externalName: v.optional(v.string()),
  },
  handler: async (ctx, { sessionToken, lotteryId, pkgId, externalName }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (lottery.status !== "open") throw new Error("Lottery is not open");

    let participantId: string;
    let participantName: string;

    if (externalName) {
      if (!user.roles.includes("admin")) throw new Error("Only admins can throw hat for external names");
      const ext = lottery.externalNames ?? [];
      if (!ext.includes(externalName)) throw new Error("External name not found in lottery");
      participantId = `ext_${externalName}`;
      participantName = externalName;
    } else {
      participantId = user._id;
      participantName = user.username;
    }

    const packages = lottery.packages ?? [];
    const pkg = packages.find(p => p.pkgId === pkgId);
    if (!pkg) throw new Error("Package not found");

    const interested = pkg.interested ?? [];
    if (interested.some((i: { id: string; name: string }) => i.id === participantId)) throw new Error("Already interested in this package");

    const newPackages = packages.map(p =>
      p.pkgId === pkgId
        ? { ...p, interested: [...(p.interested ?? []), { id: participantId, name: participantName }] }
        : p
    );
    await ctx.db.patch(lotteryId, { packages: newPackages });
  },
});

export const removeHat = mutation({
  args: {
    sessionToken: v.string(),
    lotteryId: v.id("lotteries"),
    pkgId: v.string(),
    participantId: v.string(),
  },
  handler: async (ctx, { sessionToken, lotteryId, pkgId, participantId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (lottery.status !== "open") throw new Error("Lottery is not open");

    const isOwn = participantId === user._id || participantId === `ext_${user.username}`;
    if (!isOwn && !user.roles.includes("admin")) throw new Error("Not authorized");

    const packages = (lottery.packages ?? []).map(p =>
      p.pkgId === pkgId
        ? { ...p, interested: (p.interested ?? []).filter((i: { id: string; name: string }) => i.id !== participantId) }
        : p
    );
    await ctx.db.patch(lotteryId, { packages });
  },
});

export const runDraw = mutation({
  args: { sessionToken: v.string(), lotteryId: v.id("lotteries") },
  handler: async (ctx, { sessionToken, lotteryId }) => {
    const user = await requireSession(ctx.db, sessionToken);
    if (!user.roles.includes("admin")) throw new Error("Not authorized");
    const lottery = await ctx.db.get(lotteryId);
    if (!lottery) throw new Error("Lottery not found");
    if (lottery.status !== "open") throw new Error("Lottery must be open to run draw");

    const packages = [...(lottery.packages ?? [])].map(p => ({ ...p, interested: [...(p.interested ?? [])] }));

    // Sort packages: most entries first; tiebreak by highest single item value
    packages.sort((a, b) => {
      const entriesA = (a.interested ?? []).length;
      const entriesB = (b.interested ?? []).length;
      if (entriesB !== entriesA) return entriesB - entriesA;
      const topA = Math.max(0, ...(a.items ?? []).map((i: any) => i.value));
      const topB = Math.max(0, ...(b.items ?? []).map((i: any) => i.value));
      return topB - topA;
    });

    const winners = new Set<string>();

    for (const pkg of packages) {
      const eligible = (pkg.interested ?? []).filter((i: { id: string; name: string }) => !winners.has(i.id));
      if (eligible.length === 0) continue;
      const winner = eligible[Math.floor(Math.random() * eligible.length)];
      (pkg as any).winner = winner;
      winners.add(winner.id);
    }

    await ctx.db.patch(lotteryId, { packages, status: "drawn" });
  },
});
