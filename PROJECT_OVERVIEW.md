# Mattrack — Project Overview

The org's **material pipeline**, tracked end-to-end. Replaces the scattered
spreadsheets with one system built on the navytrack foundation (auth, hardened
backend, inventory/table UI, workorders, theming, front page).

## The loop

```
GATHER ─▶ [Pickup WO] ─▶ LOGISTICS ─▶ CRAFT ─▶ [Move WO] ─▶ LOGISTICS ─▶ DISTRIBUTE
(report)   pickup + manifest + haul to Levski   (consume mats,   haul finished    stockpile +
                                                 produce items)   goods            handout / FRCoin event
  • Materials path → target is ALWAYS Levski; the manifest/bookkeeping happens at Logistics.
  • Items path → already-finished goods skip crafting (source ─▶ logi ─▶ distribute).
  • ADMIN sits over the loop: priority, role approval, catalog/blueprint management, events.
```

## Roles (request on signup → admin approves → multiple allowed)

A user with **no approved roles is "pending"** (sees only their own status). The
first account can **claim bootstrap admin**.

| Capability | Gatherer | Logistics | Crafter | Distributor | Admin |
|---|---|---|---|---|---|
| Submit gather intake → auto Pickup WO | ✓ | | | | ✓ |
| View stock / "who holds what" | own | ✓ | ✓ | ✓ | ✓ |
| Claim transport WO, mark handover, security flag | | ✓ | | | ✓ |
| Manifest entry (rough → confirmed stock) | | ✓ | | | ✓ |
| Claim craft WO, consume mats, produce items | | | ✓ | | ✓ |
| Borrow-request between crafters | | | ✓ | | ✓ |
| Create Move-finished WO | | ✓ | ✓ | | ✓ |
| Handout to person / FRCoin event + log | | | | ✓ | ✓ |
| Manage catalogs (materials/items/recipes/locations) | | | | | ✓ |
| Approve role requests / manage users | | | | | ✓ |
| Set priority / author craft demand | | | | | ✓ |

## Data model

**Reference layer (admin-managed databanks; seedable from the old mattrack export):**
- `materialCatalog` — `{name, type (Mineable/Salvage/Loot), category (Ores/FPS Mining/…), unit (SCU/UNIT), qualities:[{step:1..10, value:0..1000}]}`. The step→value map is per-material (X@3=387, Y@3=314). UI lists them expanded ("Hadanite · Q3 · 387").
- `itemCatalog` — `{name, category, recipe:[{materialName, qty, unit}]}`. Recipe = the blueprint; added manually.
- `locationCatalog` — `{name, system?, isLevski}`.

**Operational layer:**
- `stock` — `{kind (material|item), refName, qualityStep?, qualityValue?, qty, unit, location, heldBy, status}`. Status lifecycle: reported → in-transit → at-Levski → with-crafter → crafted → with-distributor → handed-out.
- `workorders` — `{kind (pickup|transport|craft|move), priority, claimedBy[], source{owner,location}, target{owner,location}, items[], securityRequested, status}`. Materials transport defaults target = Levski.
- `handouts` — `{recipient, items[], context (person|frcoin_event), byDistributor, ts}`. (FRCoin balances stay on Discord; we only log the handout.)
- `users` — `{username, passwordHash, roles[], requestedRoles[]}`. `sessions`, `archive` reused.

**Crafted item quality** = quantity-weighted average of the consumed materials' quality values.

## Out of scope (handled on Discord)
- FRCoin balances/currency (we only log handouts).
- Security/escort roster (we only keep a "security requested" reminder flag on transport WOs).

## Build order
1. **Roles** — 5 roles, request-on-signup, multi-role, admin approval. ✅ done
2. **Catalogs** — materials (+ quality steps), items (+ recipes), locations; admin CRUD + seed import. ✅ done
3. **Stock/ledger** — references catalogs, lifecycle states, rough→confirmed quantities. ✅ done
4. **Gatherer intake** → auto Pickup WO. ✅ done
5. **Logistics** — pickup accept → auto Delivery task for crafters → receive at base. ✅ done
6. **Craft WOs** — recipe-driven consume → produce, availability/priority. ✅ done
7. **Distribution** — distributor pulls crafted items → stockpile → hand out (request/event) + log. ✅ done
8. **Pipeline overview** — the MAT front page now reads the live pipeline as editorial headlines. ✅ done

## Seed data (from the old mattrack backup)
- 39 materials (`name, category, unit`) — missing salvage + quality steps (to add).
- 8 blueprints (`name, category, recipe`).
- Extracted to `seed/catalog-seed.json`.
