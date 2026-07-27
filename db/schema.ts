/**
 * Truestock — Drizzle schema (MySQL)
 *
 * Source of truth: docs/spec.md §8 (data model) and §11 (MySQL/pool notes).
 * Schema deltas agreed outside spec.md, tracked here until the doc catches up:
 *   - Product.waste_factor (CLAUDE.md "Schema delta not yet in docs/spec.md §8")
 *   - Product.shelf_life_days / CountLine.opened_at (this session — see comments below)
 *
 * MVP tables: User, Vendor, Product, ProductBarcode, ProductPar, Location,
 * Count, CountLine (spec §8), plus Session, Account, Verification — Better
 * Auth's own tables (see the big comment above `user` below for exactly what
 * that requires and why). Deferred tables (Invoice, InvoiceLine, Depletion,
 * RecipeComponent) are NOT built here, but every FK below uses a plain integer
 * primary key so those tables can reference product_id / count_id later without
 * a migration to this file.
 *
 * Precision conventions (documented once, applied consistently):
 *   - Per-unit cost columns: DECIMAL(10,4). Four decimal places because a unit
 *     cost is routinely derived from case_cost / case_size (e.g. $91.00 / 24 =
 *     $3.7917) and keg per-serving economics carry real sub-cent precision
 *     (see docs/catalog/draft-economics.csv). Rounding to 2dp at storage time
 *     would bake drift into every valuation that reads it back.
 *   - Aggregate/display money (Count.total_value): DECIMAL(12,2). It's a summed
 *     total for humans, not an input to further division, so 2dp is correct and
 *     12 total digits is comfortably beyond any real bar's inventory value.
 *   - Quantities that can be fractional (par_level, reorder_point): DECIMAL(10,2).
 *   - waste_factor: DECIMAL(4,3), per the CLAUDE.md delta — a 0.000–9.999 range
 *     is far more than the 0–1 fraction it actually holds, but keeps the type
 *     simple and leaves headroom rather than clamping at exactly 1.000.
 *   - Bottle/keg weights (empty_weight_g, full_weight_g): DECIMAL(8,2) — a full
 *     half-barrel keg is close to 70,000 g, so 8 total digits is required.
 *   - Every money/weight/quantity column is DECIMAL, never FLOAT/DOUBLE —
 *     floats would silently corrupt valuation math.
 */

import {
  mysqlTable,
  int,
  varchar,
  text,
  boolean,
  decimal,
  json,
  timestamp,
  datetime,
  date,
  mysqlEnum,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums — exactly as spec'd (docs/spec.md §8)
// ---------------------------------------------------------------------------

export const userRoleEnum = ["owner", "manager", "staff"] as const;
export const productUnitTypeEnum = ["bottle", "can", "keg"] as const;
export const barcodePackLevelEnum = ["each", "case"] as const;
export const countTypeEnum = ["full", "spot", "monthly_close"] as const;
/**
 * How a location is counted. CLAUDE.md: "the input-mode switch [is] explicit —
 * Speed Rail and Back Bar are tenths, Storeroom is quantities only, and that
 * is driven entirely by location."
 *
 * It lives on `location` as a column because it is a property of the place,
 * not of the screen. The alternative was matching location names in the
 * frontend, which is how three screens end up with three different opinions
 * about whether the Wine Rack takes fill levels.
 *
 *  - `tenths`   — open bottles are the point here; the fill pad is the primary
 *                 input. Sealed quantities are still reachable, because a
 *                 back bar legitimately holds a backup bottle behind the open
 *                 one.
 *  - `quantity` — sealed backstock only. No fill UI at all, per "quantities
 *                 only": offering a fill pad in the storeroom invites someone
 *                 to tap a level on a sealed case.
 */
export const locationCountModeEnum = ["tenths", "quantity"] as const;
export const countStatusEnum = [
  "draft",
  "in_progress",
  "submitted",
  "reviewed",
  "closed",
] as const;

// Reusable audit-timestamp pair. Only added to tables where spec §8 doesn't
// already define purpose-built lifecycle timestamps (Count has started_at /
// closed_at; CountLine has counted_at) — adding generic created/updated
// columns there would be redundant with those.
const auditColumns = {
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
};

// ---------------------------------------------------------------------------
// User, Session, Account, Verification — Better Auth's own tables
// ---------------------------------------------------------------------------
// Organization — the tenant boundary
// ---------------------------------------------------------------------------
// Added 2026-07-27, deliberately BEFORE the first migration was ever applied.
// Retrofitting tenancy onto a live database is a data migration plus a
// re-audit of every invariant; doing it while `drizzle/` is still regenerated
// in place costs a day.
//
// "Organization" and not "location": `location` already means Speed Rail /
// Back Bar / Storeroom — a place *inside* one venue. Overloading it would be
// genuinely confusing in a codebase where the active location is a
// correctness concern.
//
// One organization per user (`user.organization_id`). A user belonging to
// several organizations — a multi-unit operator, or a bookkeeper serving
// three bars — is a later, ADDITIVE change: a membership table plus an
// org-switcher in the session. What could not be added later cheaply is
// tenant isolation of the *data*, which is what this is.
//
// A single organization may later hold several venues; if that happens, add a
// nullable `venue_id` to `location` and `count`. Nothing here forecloses it.
export const organization = mysqlTable(
  "organization",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    // URL-safe handle, for a future per-tenant subdomain or path segment.
    slug: varchar("slug", { length: 100 }).notNull(),
    // Same rule as product: never hard-delete a tenant. Two years of invoices
    // and immutable closed counts hang off this row (spec §10).
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => [uniqueIndex("organization_slug_unique").on(table.slug)],
);

// ---------------------------------------------------------------------------
// RESOLVED 2026-07-24 (coordinator decision; database agent verified against
// the installed library before writing this): Better Auth owns `user`,
// `session`, `account`, `verification`. Credential password hashes live on
// `account.password` (Better Auth's credential provider, providerId
// "credential"), NOT on `user` — there is no `password_hash` column here
// anymore. `role` and `active` are Truestock's own additions to `user`
// (Better Auth passes unknown fields through as `additionalFields`).
//
// Field shapes below are taken directly from `getAuthTables()` in
// @better-auth/core@1.6.25 (node_modules/@better-auth/core/dist/db/get-tables.mjs),
// matching the installed `better-auth@1.6.25` / `@better-auth/drizzle-adapter@1.6.25`.
// Column TS property names (id, name, email, emailVerified, image, createdAt,
// updatedAt, expiresAt, token, ipAddress, userAgent, userId, accountId,
// providerId, accessToken, refreshToken, idToken, accessTokenExpiresAt,
// refreshTokenExpiresAt, scope, password, identifier, value) match Better
// Auth's defaults exactly, so the backend agent can point the Drizzle
// adapter at this schema with zero field-name remapping. Underlying SQL
// column names are snake_case for consistency with the rest of this file —
// the adapter resolves fields by the Drizzle table's JS property key, not
// the raw SQL column name, so that's a safe, adapter-invisible choice.
//
// CRITICAL, load-bearing config the backend agent MUST set when constructing
// the Better Auth instance — this schema only works with it:
//
//     advanced: { database: { generateId: "serial" } }
//
// Not `useNumberId` (that option does not exist in this version — verified
// by reading the source, not assumed). "serial" is what tells Better Auth
// to let MySQL's AUTO_INCREMENT generate every id below instead of
// generating its own string id client-side; the drizzle adapter then reads
// the inserted id back via `LAST_INSERT_ID()`
// (node_modules/@better-auth/drizzle-adapter/dist/index.mjs). Leaving this
// unset (or using `false` instead of `"serial"`) still lets MySQL generate
// the id, but skips the `LAST_INSERT_ID()` fast path and falls back to
// best-effort row matching by unique columns, which the adapter itself
// warns is unreliable — don't do that when `"serial"` is right there.
export const user = mysqlTable(
  "user",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: varchar("image", { length: 2048 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
    // Truestock additions (docs/spec.md §8), not part of Better Auth's core
    // schema — passed through as additionalFields.
    role: mysqlEnum("role", userRoleEnum).notNull().default("staff"),
    active: boolean("active").notNull().default(true),
    // The tenant this account belongs to. NOT NULL and no default on purpose:
    // a user with no organization could pass `requireRole` and then query
    // with an undefined tenant filter, which is the one failure mode this
    // column exists to make impossible. Every creation path must name an
    // organization explicitly — today that means scripts/create-user.ts,
    // since public sign-up is disabled.
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
  },
  (table) => [
    // Email stays GLOBALLY unique rather than per-organization. Better Auth
    // resolves a credential sign-in by email alone — it has no organization
    // to scope by at that point — so a per-tenant email index would let two
    // tenants register the same address and make sign-in ambiguous. One
    // address, one account, one tenant.
    uniqueIndex("user_email_unique").on(table.email),
    index("user_active_idx").on(table.active),
    index("user_organization_id_idx").on(table.organizationId),
  ],
);

export const session = mysqlTable(
  "session",
  {
    id: int("id").autoincrement().primaryKey(),
    // datetime, not timestamp: this is an app-computed future instant (session
    // expiry), not "now on this server." MySQL's TIMESTAMP silently converts
    // through the connection's time_zone on both write and read; DATETIME
    // stores exactly what's given. Same reasoning as CountLine.openedAt's
    // date-string decision elsewhere in this file — don't let MySQL's
    // timezone conversion touch a value that isn't "now."
    expiresAt: datetime("expires_at").notNull(),
    token: varchar("token", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
    ipAddress: varchar("ip_address", { length: 45 }), // long enough for IPv6
    userAgent: text("user_agent"),
    userId: int("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("session_token_unique").on(table.token),
    index("session_user_id_idx").on(table.userId),
  ],
);

export const account = mysqlTable(
  "account",
  {
    id: int("id").autoincrement().primaryKey(),
    accountId: varchar("account_id", { length: 255 }).notNull(),
    providerId: varchar("provider_id", { length: 255 }).notNull(),
    userId: int("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    // datetime — see session.expiresAt above; same "not a 'now' timestamp"
    // reasoning applies to both OAuth token expiries.
    accessTokenExpiresAt: datetime("access_token_expires_at"),
    refreshTokenExpiresAt: datetime("refresh_token_expires_at"),
    scope: text("scope"),
    // The credential provider's password hash lives here, not on `user`.
    // 255 comfortably fits bcrypt/scrypt/argon2 output.
    password: varchar("password", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = mysqlTable(
  "verification",
  {
    id: int("id").autoincrement().primaryKey(),
    identifier: varchar("identifier", { length: 255 }).notNull(),
    value: text("value").notNull(),
    // datetime — see session.expiresAt above.
    expiresAt: datetime("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// ---------------------------------------------------------------------------
// Vendor
// ---------------------------------------------------------------------------
export const vendor = mysqlTable(
  "vendor",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 255 }).notNull(),
    contact: varchar("contact", { length: 255 }),
    orderMethod: varchar("order_method", { length: 255 }),
    leadTimeDays: int("lead_time_days"),
    ...auditColumns,
  },
  (table) => [index("vendor_organization_id_idx").on(table.organizationId)],
);

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------
export const location = mysqlTable(
  "location",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 100 }).notNull(),
    sortOrder: int("sort_order").notNull().default(0),
    // See `locationCountModeEnum`. Defaults to `tenths` because that mode is
    // a superset — it also permits sealed quantities — so a location added
    // later without an explicit mode can still record everything, rather
    // than silently losing the ability to record open bottles.
    countMode: mysqlEnum("count_mode", locationCountModeEnum).notNull().default("tenths"),
    // Not in spec §8's column list, but locations.csv carries real operational
    // notes (e.g. "Count first — all open bottles, tenths"; "Test WiFi in
    // here."). Nullable, additive, doesn't touch any invariant — dropping it
    // would just throw away seed data the spreadsheet already gives us.
    notes: text("notes"),
    ...auditColumns,
  },
  // Per-organization, not global. Every bar has a "Storeroom"; the second
  // tenant to seed one must not collide with the first.
  (table) => [
    uniqueIndex("location_organization_name_unique").on(table.organizationId, table.name),
  ],
);

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------
export const product = mysqlTable(
  "product",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 255 }).notNull(),
    brand: varchar("brand", { length: 255 }),
    // category/subcategory are free text, not enums — spec §8 only spec's
    // enums for role/unit_type/pack_level/count type&status. The catalog's
    // real values (Spirits/Beer/Wine/Liqueur/NA, with varied subcategories)
    // don't form a small closed set worth hardcoding yet.
    category: varchar("category", { length: 100 }).notNull(),
    subcategory: varchar("subcategory", { length: 100 }),
    unitType: mysqlEnum("unit_type", productUnitTypeEnum).notNull(),
    // Part of the (name, size_ml) natural key, not just a display field — a
    // 750ml and a 1.75L "handle" of the same brand are different SKUs with
    // different case sizes and costs (CLAUDE.md's own handle example). name
    // alone is not unique across the catalog.
    sizeMl: int("size_ml").notNull(),
    caseSize: int("case_size"),
    vendorId: int("vendor_id").references(() => vendor.id, {
      onDelete: "set null",
    }),
    currentUnitCost: decimal("current_unit_cost", { precision: 10, scale: 4 }),
    emptyWeightG: decimal("empty_weight_g", { precision: 8, scale: 2 }),
    fullWeightG: decimal("full_weight_g", { precision: 8, scale: 2 }),
    // CLAUDE.md schema delta: fraction of volume assumed lost to pour waste,
    // spill, and foam — currently only meaningful for draft beer (kegs).
    // Seeded at 0.100 for the 9 keg products, 0.000 everywhere else.
    wasteFactor: decimal("waste_factor", { precision: 4, scale: 3 })
      .notNull()
      .default("0.000"),
    // Decided this session (not in spec.md yet): how many days after opening
    // a product is expected to be discarded. No UI, no discard-date
    // computation, no read path in the MVP — the column exists purely so
    // adding shelf-life tracking later is a UI change, not a migration +
    // recount. Nullable; NULL means "no shelf-life policy defined."
    shelfLifeDays: int("shelf_life_days"),
    // Invariant 6: never hard-deleted. Soft-delete via this flag; history
    // (CountLine, ProductBarcode, ProductPar) keeps referencing the row.
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (table) => [
    // The real natural key, scoped to the tenant. Also what db/seed.ts
    // upserts on — enforced here so an app-layer bug can't silently create a
    // duplicate "Coors Light" 355ml alongside the existing one. Every bar
    // stocks Tito's 750ml, so this cannot be global.
    uniqueIndex("product_organization_name_size_ml_unique").on(
      table.organizationId,
      table.name,
      table.sizeMl,
    ),
    index("product_vendor_id_idx").on(table.vendorId),
    // Catalog screens and the reorder list filter on active constantly; the
    // counting flow itself only ever shows active products.
    index("product_active_idx").on(table.active),
    index("product_category_idx").on(table.category),
  ],
);

// ---------------------------------------------------------------------------
// ProductBarcode — one-to-many against Product (invariant 7)
// ---------------------------------------------------------------------------
export const productBarcode = mysqlTable(
  "product_barcode",
  {
    id: int("id").autoincrement().primaryKey(),
    // Denormalized from `product` so the unique index below can be scoped to
    // the tenant. A unique index cannot span a join, so resolving this any
    // other way would have meant keeping the barcode globally unique.
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    productId: int("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    barcode: varchar("barcode", { length: 64 }).notNull(),
    // UPC-A, EAN-13, CODE-128, etc. Free text — the BarcodeDetector API
    // reports format strings we don't want to hardcode an enum against.
    format: varchar("format", { length: 20 }),
    packLevel: mysqlEnum("pack_level", barcodePackLevelEnum).notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // THE hot-path index: barcode scan → product resolution is the single
    // most latency-sensitive read in the app (per the build brief). Unique
    // *within an organization* because two products sharing a barcode would
    // make scan resolution ambiguous — a correctness bug, not a UX one.
    //
    // Scoping this to the tenant is the single most important constraint
    // change in the multi-tenant conversion. A global unique on `barcode`
    // means the first bar to scan-enroll a Tito's UPC owns that code for
    // EVERY tenant, and every other bar's scan-to-enroll fails on a
    // duplicate key — breaking the interaction the whole catalog depends on
    // (spec §12), for everyone but the first customer.
    //
    // Organization first in the index so it also serves tenant-filtered
    // lookups, which is every lookup.
    uniqueIndex("product_barcode_organization_barcode_unique").on(
      table.organizationId,
      table.barcode,
    ),
    index("product_barcode_product_id_idx").on(table.productId),
  ],
);

// ---------------------------------------------------------------------------
// ProductPar — invariant 8: location_id nullable, null = one par overall
// ---------------------------------------------------------------------------
export const productPar = mysqlTable(
  "product_par",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    productId: int("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    locationId: int("location_id").references(() => location.id, {
      onDelete: "restrict",
    }),
    parLevel: decimal("par_level", { precision: 10, scale: 2 }).notNull(),
    reorderPoint: decimal("reorder_point", { precision: 10, scale: 2 }),
    // MySQL unique indexes treat NULL as distinct from every other NULL, so a
    // plain UNIQUE(product_id, location_id) would silently allow multiple
    // "overall" (location_id IS NULL) par rows for the same product — which
    // breaks the "null means ONE par for the product overall" reading of
    // invariant 8. This generated column collapses NULL to a sentinel (0,
    // which no real location can ever have — ids start at 1) so a unique
    // index on (product_id, location_scope) enforces "at most one par per
    // product+location, and at most one overall par per product" at the
    // database level, not just in application code.
    locationScope: int("location_scope").generatedAlwaysAs(
      (): SQL => sql`ifnull(${productPar.locationId}, 0)`,
      { mode: "stored" },
    ),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex("product_par_product_location_scope_unique").on(
      table.productId,
      table.locationScope,
    ),
    index("product_par_location_id_idx").on(table.locationId),
  ],
);

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------
export const count = mysqlTable(
  "count",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    type: mysqlEnum("type", countTypeEnum).notNull(),
    status: mysqlEnum("status", countStatusEnum).notNull().default("draft"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    closedAt: timestamp("closed_at"),
    openedBy: int("opened_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    closedBy: int("closed_by").references(() => user.id, {
      onDelete: "restrict",
    }),
    // Null until the count is valued (reviewed/closed) — never recomputed
    // from live product data afterward; see CountLine's snapshot columns.
    totalValue: decimal("total_value", { precision: 12, scale: 2 }),
    notes: text("notes"),
  },
  (table) => [
    index("count_status_idx").on(table.status),
    index("count_opened_by_idx").on(table.openedBy),
    index("count_closed_by_idx").on(table.closedBy),
    // Every counts-list and active-count read filters by tenant then orders
    // by recency, so the index carries both.
    index("count_organization_started_at_idx").on(table.organizationId, table.startedAt),
    // Not for lookups — this exists so `count_line` can carry a COMPOSITE
    // foreign key on (organization_id, count_id). MySQL requires the
    // referenced columns of an FK to be indexed. See count_line below.
    uniqueIndex("count_organization_id_id_unique").on(table.organizationId, table.id),
  ],
);

// ---------------------------------------------------------------------------
// CountLine — the invariant-heaviest table
// ---------------------------------------------------------------------------
export const countLine = mysqlTable(
  "count_line",
  {
    id: int("id").autoincrement().primaryKey(),
    // Denormalized from `count`. Not a convenience: it is what lets the
    // composite foreign key below make cross-tenant drift structurally
    // impossible, rather than something every query has to remember to join
    // for. See the table-level constraints.
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    // No single-column FK here — the composite one below covers it and
    // carries the same ON DELETE CASCADE. Two overlapping FKs on the same
    // column would just be a second thing to keep in sync.
    countId: int("count_id").notNull(),
    productId: int("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    locationId: int("location_id")
      .notNull()
      .references(() => location.id, { onDelete: "restrict" }),
    // Invariant 3/4: sealed cases and sealed loose units are stored as
    // observed, never pre-multiplied into a single total. Whole units only —
    // a partially-consumed case is represented as eaches, not a fractional
    // case count.
    // NOT DB-enforced: these must be >= 0, and each partial_fills entry must
    // be in [0, 1] — MySQL has no CHECK-on-JSON-array-contents and a plain
    // CHECK(sealed_case_qty >= 0) would still miss the array case. Validate
    // with Zod at the server-action boundary before these ever reach here.
    sealedCaseQty: int("sealed_case_qty").notNull().default(0),
    sealedEachQty: int("sealed_each_qty").notNull().default(0),
    // Invariant 5: array of decimal fill fractions for open bottles, e.g.
    // [0.3, 0.8]. Stored as observed — one entry per open bottle — so a
    // single bottle can be corrected without recounting the whole line.
    partialFills: json("partial_fills").$type<number[]>().notNull().default([]),
    // Invariant 2 requires the snapshot to be taken, not that it be non-null.
    // Nullable (coordinator decision, 2026-07-24): 88 of 97 seeded products
    // have no current_unit_cost and all 97 have no case_size, so requiring
    // NOT NULL here would make counting nearly every product impossible
    // without writing a sentinel — and a silent 0.0000 is exactly the
    // plausible-but-wrong failure mode CLAUDE.md warns about. NULL means
    // "this product had no cost / case size recorded at the moment it was
    // counted" — a true statement about the count, not a zero.
    //
    // Rules for anything that reads these (valuation, reports — not
    // enforced by the database, application must honor them):
    //   - NULL must never be coerced to 0. A NULL unit_cost_at_count line is
    //     excluded from total_value, not summed as $0.
    //   - Count/valuation screens must surface a distinct "N lines counted
    //     but unpriced" figure alongside the total, so an unpriced line is
    //     visibly missing rather than invisibly zeroed.
    //   - Once a product's cost is entered later, existing closed count
    //     lines stay NULL. They are not retroactively priced — that would
    //     re-value a historical count from current product data, which is
    //     exactly what invariant 2 exists to prevent.
    unitCostAtCount: decimal("unit_cost_at_count", {
      precision: 10,
      scale: 4,
    }),
    caseSizeAtCount: int("case_size_at_count"),
    countedBy: int("counted_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    countedAt: timestamp("counted_at").notNull().defaultNow(),
    // Decided this session: when this specific bottle/keg was opened.
    // Nullable — most lines are sealed backstock and never get a value here.
    // DATE (not a full timestamp) because shelf-life policy operates in
    // whole days. No discard-date computation or UI reads this in the MVP;
    // it exists so shelf-life tracking is a later UI change, not a
    // migration + recount (see Product.shelfLifeDays above).
    //
    // mode: "string" deliberately. Drizzle's default DATE mode round-trips
    // through `new Date(driverValue)`, and a bare "YYYY-MM-DD" string is
    // parsed as UTC midnight by the JS Date constructor — displayed in a
    // non-UTC server timezone (e.g. Arizona), that reads back as the
    // previous day. A DATE column has no timezone; treating it as a plain
    // calendar string end-to-end (paired with mysql2's `dateStrings: ['DATE']`
    // in db/index.ts) sidesteps that conversion instead of getting it right
    // by luck. Reads/writes as "2026-07-24", never a JS Date object.
    openedAt: date("opened_at", { mode: "string" }),
    // No client_line_id column here anymore (removed 2026-07-25, coordinator
    // code review). It used to live here as a single mutable column,
    // overwritten on every increment — which only ever remembered the most
    // recent write and let an out-of-order retry silently double-apply.
    // The idempotency key now lives per-write in `countLineWrite` below,
    // which is the actual fix; see that table's comment for the full story
    // and docs/spec.md §8 for the write-up. "The last write applied to this
    // row" is still answerable — it's `count_line_write` ordered by
    // `applied_at`/`id` for this `count_line_id` — it's just not
    // denormalized onto this row anymore, on purpose: a copy here with no
    // enforced constraint of its own would just be a second, driftable
    // source of truth for a question the ledger already answers correctly.
  },
  (table) => [
    // Invariant 1: scanning the same product in the same location within a
    // count increments this row; it never inserts a second one.
    uniqueIndex("count_line_count_product_location_unique").on(
      table.countId,
      table.productId,
      table.locationId,
    ),
    index("count_line_product_id_idx").on(table.productId),
    index("count_line_location_id_idx").on(table.locationId),
    index("count_line_counted_by_idx").on(table.countedBy),
    // Tenant integrity, enforced by the database rather than trusted to every
    // future query. This composite FK makes it IMPOSSIBLE to insert a line
    // whose organization_id differs from its count's — the row simply won't
    // write. Without it, `organization_id` here would be a denormalized copy
    // that could silently drift, which is the usual reason denormalizing a
    // tenant key is a bad idea; the constraint is what makes it a good one.
    foreignKey({
      columns: [table.organizationId, table.countId],
      foreignColumns: [count.organizationId, count.id],
      name: "count_line_organization_count_fk",
    }).onDelete("cascade"),
    // Referenced by count_line_write's own composite FK — see that table.
    uniqueIndex("count_line_organization_id_id_unique").on(table.organizationId, table.id),
  ],
);

// ---------------------------------------------------------------------------
// CountLineWrite — append-only idempotency ledger for CountLine increments
// ---------------------------------------------------------------------------
// THE BUG this table fixes (coordinator code review, 2026-07-25):
// count_line.client_line_id used to be a single mutable column, overwritten
// on every increment to a line. A count line gets incremented many times
// over a count's life — every scan of the same product+location adds to the
// existing row, per invariant 1 — so "the last write's id" can only ever
// catch a retry of the *immediately preceding* write. It can't catch a
// retry of an *earlier* one: write A applies, its ack is lost, write B
// applies and overwrites the stored client_line_id with B's, then A is
// retried off the IndexedDB queue on reconnect. The stored id is now B's,
// A's retry doesn't match it, the equality check passes, and A re-applies —
// a silent second increment of A's partial_fills. The total still looks
// plausible. That's invariant 5 quietly violated by invariant 4's own
// mechanism being too small to do its job — exactly the failure mode
// CLAUDE.md names as this app's worst.
//
// The fix: every individual write (increment) gets its own permanent row
// here, keyed by that write's client_line_id, UNIQUE. A duplicate-key
// violation on insert IS the "this write was already applied" signal — the
// database enforces idempotency, not a column that can only remember one
// thing at a time.
//
// REQUIRED WRITE ORDER, inside one transaction (this is not optional — the
// FK below cannot be satisfied any other way, and idempotency depends on
// both writes sharing a transaction):
//   1. Insert-or-increment the count_line row first. MySQL
//      `INSERT ... ON DUPLICATE KEY UPDATE` against the invariant-1 unique
//      key (count_id, product_id, location_id) is the natural fit: it
//      creates the line on a product+location's first write and increments
//      it on every write after that. This step is what guarantees
//      count_line.id exists — whether the row is brand new or already
//      existed — and count_line_write.count_line_id cannot be populated
//      before it runs.
//   2. Insert the ledger row second, referencing the count_line.id resolved
//      in step 1, carrying this write's client_line_id and the delta it
//      applied.
// If step 2 hits the unique constraint on client_line_id (a replay), the
// transaction rolls back — undoing step 1's increment along with it. Net
// effect of a replayed write: zero, exactly. An application-level pre-check
// (SELECT count_line_write before opening the transaction) is a reasonable
// fast-path to skip the work early, but it is NOT the correctness
// mechanism — a race between two concurrent retries would still be caught
// by the unique index and the transaction rollback even if both passed the
// pre-check. The database is the actual enforcement; the pre-check is only
// an optimization.
//
// Append-only by design: nothing in this app ever updates or deletes a row
// here — there is deliberately no updated_at column, and application code
// must never issue an UPDATE or DELETE against this table. It is both the
// idempotency mechanism and an audit trail (spec §10): summing every
// write's delta for a count_line reconstructs its current state from
// scratch, independent of count_line's own mutable aggregate columns, and
// answers "what actually happened, in what order, by whom" — which is the
// story spec §10's audit requirements need and a single aggregate row can't
// tell on its own.
export const countLineWrite = mysqlTable(
  "count_line_write",
  {
    id: int("id").autoincrement().primaryKey(),
    // Same reasoning as count_line's: denormalized, but held true by the
    // composite foreign key at the bottom of this table rather than by
    // convention.
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    // Covered by the composite FK below (which carries the cascade), so no
    // separate single-column FK here.
    countLineId: int("count_line_id").notNull(),
    // Denormalized from count_line.count_id so audit queries ("every write
    // in count X") can filter this table directly instead of joining
    // through count_line first. Can't legitimately diverge from
    // countLine.countId — a count_line belongs to exactly one count for its
    // whole life — and is set once, at insert, in the same transaction that
    // resolved countLineId. Same cascade lifecycle as countLineId: both
    // ultimately depend on the count row existing.
    countId: int("count_id")
      .notNull()
      .references(() => count.id, { onDelete: "cascade" }),
    writtenBy: int("written_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    appliedAt: timestamp("applied_at").notNull().defaultNow(),
    // The delta THIS write contributed — never the line's running total.
    // Same "store what was observed, don't pre-aggregate" reasoning as
    // count_line's own sealed_case_qty/sealed_each_qty/partial_fills.
    sealedCaseDelta: int("sealed_case_delta").notNull().default(0),
    sealedEachDelta: int("sealed_each_delta").notNull().default(0),
    // The partial_fills entries this specific write contributed (a write
    // may add zero, one, or several open-bottle readings at once) — not
    // the line's full partial_fills array.
    partialFillsDelta: json("partial_fills_delta")
      .$type<number[]>()
      .notNull()
      .default([]),
    // The idempotency key. This UNIQUE index is the entire mechanism
    // described above — everything else in this table exists to make the
    // ledger useful for audit/debugging, not just a dedupe set.
    clientLineId: varchar("client_line_id", { length: 36 }).notNull(),
  },
  (table) => [
    // DELIBERATELY GLOBAL, not per-organization — the one unique index in
    // this conversion that must NOT be scoped to the tenant.
    //
    // client_line_id is a client-generated UUIDv4, already globally unique by
    // construction, and this index is the idempotency mechanism itself. If it
    // were scoped to (organization_id, client_line_id), a replayed write
    // would still be caught — but the constraint would now depend on the
    // retry carrying the *same* organization_id as the original. That is one
    // more thing that has to be right for a silent double-count not to
    // happen, in exchange for nothing: two tenants colliding on a v4 UUID is
    // not a real event. Keep the narrower, stronger guarantee.
    uniqueIndex("count_line_write_client_line_id_unique").on(table.clientLineId),
    index("count_line_write_count_line_id_idx").on(table.countLineId),
    index("count_line_write_count_id_idx").on(table.countId),
    index("count_line_write_written_by_idx").on(table.writtenBy),
    // Tenant integrity — see count_line's equivalent.
    foreignKey({
      columns: [table.organizationId, table.countLineId],
      foreignColumns: [countLine.organizationId, countLine.id],
      name: "count_line_write_organization_line_fk",
    }).onDelete("cascade"),
  ],
);
