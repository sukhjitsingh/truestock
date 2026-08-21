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
 *
 * Primary-key widths (schema audit 2026-07-27, finding F1):
 *   - `count`, `count_line`, `count_line_write` — and every column that
 *     references them — use BIGINT. These scale with *scan volume*, not with
 *     tenant or catalog size: `count_line_write` takes a row per write, so at
 *     ~20-30k rows/tenant/year a large multi-tenant outcome crosses INT's
 *     2.1B ceiling within a decade. Widening them while the migration is
 *     unapplied is a type change; doing it once the ledger holds hundreds of
 *     millions of rows is an online table rebuild on the append-only audit
 *     trail spec §10 requires to stay available.
 *   - Everything else stays INT. `organization`, `user`, `vendor`,
 *     `location`, `product`, `product_barcode`, `product_par` scale with
 *     tenant and catalog count (10,000 tenants x 100 products = 1M rows) and
 *     never approach the ceiling. Widening them would cost index size and
 *     memory for no benefit.
 *   - `mode: "number"` throughout, not `"bigint"` — ids stay JS `number` in
 *     TypeScript (exact to 2^53, far beyond any real row count), so this is
 *     a storage change with no ripple into `Actor`, action signatures, or
 *     component props.
 */

import {
  mysqlTable,
  int,
  bigint,
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
//
// Defined in db/enums.ts and re-exported here so this stays the one import
// server-side code needs. They live in their own Drizzle-free module because
// lib/validation/* is shared with client components and needs them as values
// — importing them from here shipped the whole schema to the browser. See the
// header of db/enums.ts for the failure that caused.
// ---------------------------------------------------------------------------

import {
  userRoleEnum,
  productUnitTypeEnum,
  barcodePackLevelEnum,
  countTypeEnum,
  locationCountModeEnum,
  countStatusEnum,
  invoiceStatusEnum,
  invoiceSourceEnum,
  extractionJobStatusEnum,
  extractionPhaseEnum,
  pdfTypeEnum,
  invoiceLineTypeEnum,
  invoiceLineUomEnum,
  invoiceMatchMethodEnum,
  countLineWriteTypeEnum,
  auditPacketStatusEnum,
  auditPacketSourceTableEnum,
} from "./enums";

export {
  userRoleEnum,
  productUnitTypeEnum,
  barcodePackLevelEnum,
  countTypeEnum,
  locationCountModeEnum,
  countStatusEnum,
  invoiceStatusEnum,
  invoiceSourceEnum,
  extractionJobStatusEnum,
  extractionPhaseEnum,
  pdfTypeEnum,
  invoiceLineTypeEnum,
  invoiceLineUomEnum,
  invoiceMatchMethodEnum,
  countLineWriteTypeEnum,
  auditPacketStatusEnum,
  auditPacketSourceTableEnum,
};

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
    // Nothing sweeps expired sessions yet, so this table grows by one row per
    // login, forever, across every tenant. Not a performance problem at 3-5
    // users per tenant — but without this index the eventual
    // `DELETE FROM session WHERE expires_at < NOW()` is a full table scan on
    // the table it is trying to keep small. Free on an empty table, so it
    // goes in now; the periodic sweep job itself is an ops TODO recorded in
    // docs/open-items.md. Schema audit 2026-07-27 (F4).
    index("session_expires_at_idx").on(table.expiresAt),
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
  (table) => [
    index("vendor_organization_id_idx").on(table.organizationId),
    // Not for lookups — the target of `product`'s composite tenant FK, and
    // MySQL requires an FK's referenced columns to be indexed. Same role as
    // `count_organization_id_id_unique`. Added by the 2026-07-27 schema audit
    // (finding B1).
    uniqueIndex("vendor_organization_id_id_unique").on(table.organizationId, table.id),
  ],
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
    // Invariant 6's sibling: never hard-deleted, only deactivated. Mirrors
    // `product.active` exactly (Gate 2 Decision 2, 2026-08-12). A retired
    // location's name stays taken — see `location_organization_name_unique`
    // below, deliberately left unfiltered by this column (Decision 1).
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  // Per-organization, not global. Every bar has a "Storeroom"; the second
  // tenant to seed one must not collide with the first.
  (table) => [
    uniqueIndex("location_organization_name_unique").on(table.organizationId, table.name),
    // Target of `product_par`'s composite tenant FK — see `vendor`'s
    // equivalent. Schema audit 2026-07-27 (B1).
    uniqueIndex("location_organization_id_id_unique").on(table.organizationId, table.id),
    // Mirrors `product_organization_active_idx` — the management screen and
    // scan-picker both filter organization_id together with active.
    index("location_organization_active_idx").on(table.organizationId, table.active),
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
    // No single-column FK — the composite tenant FK at the bottom of this
    // table covers it. Nullable: a product need not have a vendor.
    vendorId: int("vendor_id"),
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
    //
    // Organization-first (schema audit 2026-07-27, F2). These were bare
    // single-column indexes on `active` / `category`. Every real call site —
    // `searchProducts` in lib/domain/catalog.ts — filters `organization_id`
    // *together with* one of these, and a boolean or a handful of category
    // values has terrible standalone selectivity across all tenants combined,
    // so the optimizer would never pick them: they cost index maintenance on
    // every write while never being the access path for the query they exist
    // to serve. Tenant-first makes the same index serve both predicates, the
    // way `vendor_organization_id_idx` and
    // `product_barcode_organization_barcode_unique` already do.
    index("product_organization_active_idx").on(table.organizationId, table.active),
    index("product_organization_category_idx").on(table.organizationId, table.category),
    // Target of product_barcode's and product_par's composite tenant FKs.
    uniqueIndex("product_organization_id_id_unique").on(table.organizationId, table.id),
    // Tenant integrity for a client-supplied id — the same treatment
    // `count_line.count_id` already had, extended here by the 2026-07-27
    // schema audit (B1). A plain FK proves the vendor row exists, not whose
    // it is, so without this a product could permanently reference another
    // tenant's vendor. The application also checks ownership explicitly
    // (`assertVendorOwned`, lib/domain/catalog.ts) so the failure is a clean
    // NotFound rather than a raw FK violation; this constraint is what makes
    // it impossible rather than merely checked.
    //
    // ON DELETE RESTRICT, not SET NULL as the single-column FK used to be:
    // MySQL's SET NULL would have to null BOTH referencing columns, and
    // `organization_id` is NOT NULL, so the constraint cannot be created that
    // way. RESTRICT matches every other tenant-scoped FK in this file, and
    // nothing in the codebase hard-deletes a vendor — there is no delete path
    // for one at all — so this changes no behaviour that exists.
    //
    // A NULL `vendor_id` skips the check entirely (SQL MATCH SIMPLE: an FK
    // with any NULL component is not enforced), which is exactly right for a
    // product with no vendor.
    foreignKey({
      columns: [table.organizationId, table.vendorId],
      foreignColumns: [vendor.organizationId, vendor.id],
      name: "product_organization_vendor_fk",
    }).onDelete("restrict"),
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
    // No single-column FK — the composite tenant FK below covers it.
    productId: int("product_id").notNull(),
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
    // Tenant integrity — see `product`'s equivalent. Dormant today (every
    // barcode is created with the product id from the row inserted in the
    // same transaction), but the "attach another barcode to an existing
    // product" feature in docs/open-items.md would supply a client id, and
    // that is the moment this stops being theoretical. Schema audit
    // 2026-07-27 (B1).
    foreignKey({
      columns: [table.organizationId, table.productId],
      foreignColumns: [product.organizationId, product.id],
      name: "product_barcode_organization_product_fk",
    }).onDelete("restrict"),
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
    // Neither carries a single-column FK — the composite tenant FKs below
    // cover both.
    productId: int("product_id").notNull(),
    locationId: int("location_id"),
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
    // Tenant integrity — see `product`'s equivalent. Nothing writes this
    // table yet, so both constraints are pre-emptive: the par-management
    // screen named in docs/open-items.md is precisely a feature that takes a
    // client-supplied product_id and location_id. Closing it now costs one
    // migration; closing it after that screen ships costs a data audit.
    // Schema audit 2026-07-27 (B1).
    foreignKey({
      columns: [table.organizationId, table.productId],
      foreignColumns: [product.organizationId, product.id],
      name: "product_par_organization_product_fk",
    }).onDelete("restrict"),
    // A NULL location_id means "one par for the product overall" and skips
    // this check entirely (MATCH SIMPLE), which is the intended reading of
    // the nullable column — see `locationScope` above.
    foreignKey({
      columns: [table.organizationId, table.locationId],
      foreignColumns: [location.organizationId, location.id],
      name: "product_par_organization_location_fk",
    }).onDelete("restrict"),
  ],
);

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------
export const count = mysqlTable(
  "count",
  {
    // BIGINT — see the primary-key widths note in the file header (F1).
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
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
    // Organization-first for the same reason as product's — see F2 there.
    // `getActiveCount` always filters organization_id together with status.
    index("count_organization_status_idx").on(table.organizationId, table.status),
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
    // BIGINT — see the primary-key widths note in the file header (F1).
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
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
    // BIGINT to match `count.id` — an FK's columns must match the referenced
    // column's type exactly.
    countId: bigint("count_id", { mode: "number" }).notNull(),
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
    // BIGINT — this is THE table F1 is about: one row per write attempt,
    // append-only, never pruned. See the file header.
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    // Same reasoning as count_line's: denormalized, but held true by the
    // composite foreign key at the bottom of this table rather than by
    // convention.
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    // Covered by the composite FK below (which carries the cascade), so no
    // separate single-column FK here. BIGINT to match `count_line.id`.
    countLineId: bigint("count_line_id", { mode: "number" }).notNull(),
    // Denormalized from count_line.count_id so audit queries ("every write
    // in count X") can filter this table directly instead of joining
    // through count_line first. Can't legitimately diverge from
    // countLine.countId — a count_line belongs to exactly one count for its
    // whole life — and is set once, at insert, in the same transaction that
    // resolved countLineId. Same cascade lifecycle as countLineId: both
    // ultimately depend on the count row existing.
    countId: bigint("count_id", { mode: "number" })
      .notNull()
      .references(() => count.id, { onDelete: "cascade" }),
    writtenBy: int("written_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    appliedAt: timestamp("applied_at").notNull().defaultNow(),
    // open-items.md #2. Discriminates the two shapes a row in this table can
    // take — see countLineWriteTypeEnum in db/enums.ts for the full
    // reasoning. NOT NULL, default 'scan': every row that existed before
    // this column was added genuinely was a scan/increment/quantity
    // correction (editCountLineFills wrote no ledger row until this
    // change), so the default backfills existing rows correctly with no
    // separate data migration.
    writeType: mysqlEnum("write_type", countLineWriteTypeEnum).notNull().default("scan"),
    // The delta THIS write contributed — never the line's running total.
    // Same "store what was observed, don't pre-aggregate" reasoning as
    // count_line's own sealed_case_qty/sealed_each_qty/partial_fills.
    sealedCaseDelta: int("sealed_case_delta").notNull().default(0),
    sealedEachDelta: int("sealed_each_delta").notNull().default(0),
    // The partial_fills entries this specific write contributed (a write
    // may add zero, one, or several open-bottle readings at once) — not
    // the line's full partial_fills array. Meaningless on `fill_correction`
    // rows (stays its default `[]` there — see writeType and
    // partialFillsBefore/After below); only `scan` rows compose by summing
    // this column.
    partialFillsDelta: json("partial_fills_delta")
      .$type<number[]>()
      .notNull()
      .default([]),
    // open-items.md #2. `editCountLineFills` REPLACES the whole
    // partial_fills array rather than appending to it, so it has no delta
    // representation in partialFillsDelta's additive shape (see writeType
    // above). These two columns carry the full state transition instead,
    // captured under the SAME row lock used for the update in
    // lib/domain/counts.ts's editCountLineFills. Both NULL on `scan` rows —
    // irrelevant there, since partialFillsDelta already answers "what did
    // this write contribute" for that write type.
    //
    // Rationale (audit-trail self-containment): "who changed this bottle's
    // fill level, and when" — the open item's own framing — should be
    // answerable by reading ONE row of this ledger directly, not by
    // replaying every prior write to reconstruct state at that point in
    // time. Storing both before and after on the correction row itself is
    // what makes that true.
    //
    // MariaDB has no native JSON type — `json` here is a `longtext` alias
    // with a validity check (see db/README.md). mysql2 still parses it back
    // into an array on read, same guarantee count_line.partial_fills and
    // extraction_job.pages_needing_ocr rely on; that's a driver behaviour,
    // not a schema one, so it's covered by a test rather than assumed.
    partialFillsBefore: json("partial_fills_before").$type<number[]>(),
    partialFillsAfter: json("partial_fills_after").$type<number[]>(),
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

// ---------------------------------------------------------------------------
// Invoice — Phase 2.5, Slice 1 (OCR invoice automation)
// ---------------------------------------------------------------------------
// docs/plans/phase-2.5-invoice-automation/02-architecture.md §2 is the spec.
// Only `invoice` and `extraction_job` were built in Slice 1. `invoice_line`
// (Slice 2), `vendor_alias` (Slice 3), `product_cost_history` (Slice 4) and
// `audit_packet` / `audit_packet_file` (Slice 5, at the end of this file)
// have since been added.
//
// [AR-4] The status machine (uploaded → processing → needs_review →
// reviewed → approved | rejected) is declared as data in
// `lib/domain/invoices.ts` (`INVOICE_TRANSITIONS`), not here — this table
// only fixes the closed set of values via `invoiceStatusEnum`.
// `approved` is terminal: nothing transitions out of it, so a correction to
// an approved invoice is a new record, never a status edit (mirrors
// invariant 1's "closed counts are immutable").
//
// Money columns are DECIMAL(10,4), same precision as
// `product.current_unit_cost` — see the file header's precision
// conventions — so a per-unit cost derived from an invoice line round-trips
// exactly as a string with no float drift.
export const invoice = mysqlTable(
  "invoice",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    // No single-column FK — the composite tenant FK below covers it.
    // Nullable: the upload form may not have a vendor picked yet.
    vendorId: int("vendor_id"),
    status: mysqlEnum("status", invoiceStatusEnum).notNull().default("uploaded"),
    source: mysqlEnum("source", invoiceSourceEnum).notNull(),
    // ---------------------------------------------------------------------
    // File identity — declared by the client when the upload is REQUESTED,
    // then verified against what actually landed on disk.
    // ---------------------------------------------------------------------
    //
    // Points into INVOICE_STORAGE_DIR, never `public/` [AR-1]. Long enough
    // for a deep per-org/per-year path; not a URL.
    //
    // Nullable only because the storage key is `{org}/{invoiceId}.{ext}` and
    // `id` is an autoincrement — it does not exist until the row does. The
    // insert and the follow-up UPDATE that sets this run in one transaction,
    // so a committed row always has a path. NULL is preferred over inserting
    // `''` and updating: an empty string is a value the file route would have
    // to special-case, and if the transaction were ever refactored apart it
    // would resolve to the storage root itself rather than failing.
    filePath: varchar("file_path", { length: 1024 }),
    // Both DECLARED at upload-request time, both re-derived from the bytes
    // that actually landed and compared in `confirmUploadAction`. Comparing a
    // value against itself would make the verification decorative, so these
    // are written once, at request time, and never rewritten from the file.
    // A mismatch leaves `extraction_job.status = awaiting_upload`, so a
    // truncated or swapped upload is never extracted [AR-6].
    fileSha256: varchar("file_sha256", { length: 64 }).notNull(),
    fileSizeBytes: int("file_size_bytes").notNull(),

    // ---------------------------------------------------------------------
    // Everything below is READ OFF THE DOCUMENT, so none of it exists until
    // extraction has run (Slice 2). All nullable, deliberately.
    // ---------------------------------------------------------------------
    //
    // The alternative — NOT NULL with a placeholder written at upload — puts
    // a fabricated invoice date, invoice number and $0.00 totals on a row
    // that the archive list renders as though they were read off the
    // document. That is the plausible-but-wrong default AGENTS.md names as
    // this app's worst failure mode: nothing looks broken, and the numbers
    // are invented. NULL renders as "—" and is the truth.
    //
    // The consequence is a constraint the DATABASE cannot express: these must
    // be non-null before the invoice reaches `reviewed`. Enforced in the
    // domain layer, on the CAS transition, with an adversarial test — a
    // nullable column with no such guard would let an invoice be approved
    // with no total and write a NULL cost downstream.
    pageCount: int("page_count"),
    // DATE, not TIMESTAMP — an invoice date is a calendar day printed on a
    // document, not a moment in time. mode: "string" + db/index.ts's
    // `dateStrings: ["DATE"]` keeps it a plain "YYYY-MM-DD" end to end, same
    // reasoning as count_line.openedAt (see that column's comment above).
    invoiceDate: date("invoice_date", { mode: "string" }),
    dueDate: date("due_date", { mode: "string" }),
    invoiceNumber: varchar("invoice_number", { length: 100 }),
    totalGross: decimal("total_gross", { precision: 10, scale: 4 }),
    totalDiscount: decimal("total_discount", { precision: 10, scale: 4 }),
    totalNet: decimal("total_net", { precision: 10, scale: 4 }),
    // ISO 4217 code (e.g. "USD"). Free text, not an enum — same reasoning as
    // product.category: a small but not worth hardcoding closed set.
    currency: varchar("currency", { length: 3 }),
    // Derived from `invoice_date` via `computeRetentionUntil` — invoice_date
    // + 3 years, spec §10's "2 years minimum (3 is safer)" resolved upward
    // because this is the date before which an invoice must never be deleted
    // and deleting a legally-required record early is unrecoverable (see that
    // function's comment). So it cannot be known before the date is. DATE —
    // the retention sweep operates on whole days, same as the other three
    // date columns above.
    retentionUntil: date("retention_until", { mode: "string" }),
    // A moment in time (when the CAS to `approved` happened), so TIMESTAMP —
    // unlike the calendar dates above.
    approvedAt: timestamp("approved_at"),
    approvedBy: int("approved_by").references(() => user.id, { onDelete: "restrict" }),
    // Phase 2.5, Slice 2. `rejectInvoiceAction` requires a reason; 04-slices.md
    // names the requirement but never names where it's stored, so this closes
    // that gap. Nullable — every OTHER status never has one, and NOT NULL
    // would force a placeholder string onto every non-rejected invoice.
    // Free text, not an enum: a rejection reason is written by a human
    // (the owner) explaining what's wrong with a specific document, not a
    // small closed set of categories.
    rejectionReason: text("rejection_reason"),
    ...auditColumns,
  },
  (table) => [
    // Target of extraction_job's, invoice_line's (and later
    // product_cost_history's) composite tenant FK. Same role as
    // `vendor_organization_id_id_unique` / `count_organization_id_id_unique`.
    uniqueIndex("invoice_organization_id_id_unique").on(table.organizationId, table.id),
    // Review queue: filter by tenant + status, ordered by recency.
    index("invoice_organization_status_invoice_date_idx").on(
      table.organizationId,
      table.status,
      table.invoiceDate,
    ),
    // Archive screen: filter by tenant + vendor, ordered by recency.
    index("invoice_organization_vendor_invoice_date_idx").on(
      table.organizationId,
      table.vendorId,
      table.invoiceDate,
    ),
    // Retention sweep: every invoice whose retention window has lapsed, per
    // tenant.
    index("invoice_organization_retention_until_idx").on(
      table.organizationId,
      table.retentionUntil,
    ),
    // Tenant integrity for a client-supplied id [AR-2] — the upload form
    // supplies vendor_id from a picker, so without this an invoice could be
    // filed against another tenant's vendor and every archive/audit-packet
    // query downstream would report it under that vendor's name.
    //
    // ON DELETE RESTRICT, not SET NULL: organization_id is NOT NULL, so
    // MySQL can't null just one column of the pair — same reasoning as
    // `product_organization_vendor_fk` above. A NULL vendor_id skips the
    // check entirely (MATCH SIMPLE), which is correct for an invoice with no
    // vendor picked yet.
    foreignKey({
      columns: [table.organizationId, table.vendorId],
      foreignColumns: [vendor.organizationId, vendor.id],
      name: "invoice_organization_vendor_fk",
    }).onDelete("restrict"),
  ],
);

// ---------------------------------------------------------------------------
// ExtractionJob — Phase 2.5, Slice 1
// ---------------------------------------------------------------------------
// [AR-6] ONE state machine: awaiting_upload → queued → running → done | failed.
// See `extractionJobStatusEnum` in db/enums.ts for the full history of why
// this is written down in exactly one place.
//
// A job is created `awaiting_upload`, not `queued` — the invoice row and job
// row exist before the client has uploaded the file, so a job claimable at
// creation would get picked up by the cron before the object exists and fail
// as what looks like OCR flakiness. `confirmUploadAction` moves it to
// `queued` only after verifying the stored object's byte length and SHA-256
// match what was declared at upload.
//
// `claimNextJob` is an atomic conditional update
// (`SET status='running', claimed_at=NOW(), claimed_by=:worker
//   WHERE status='queued' ORDER BY id LIMIT 1`) — zero rows affected means
// another worker won the race, not an error. `reapStuckJobs` is the missing
// edge back out of `running`: a job whose claimed_at is older than the
// 10-minute timeout (`DEFAULT_STALE_AFTER_MS`, lib/domain/extraction.ts)
// returns to `queued` with retry_count incremented, or to `failed` with
// error_message = 'worker timeout' once retry_count reaches 3.
// Reclaiming is safe because extraction writes invoice_line drafts keyed by
// (invoice_id, line_number) — idempotent by construction, and nothing
// downstream (review, approval) has run yet.
//
// `phase` and `pdf_type` are observability only, never a claim predicate —
// the claim query only ever looks at `status`.
export const extractionJob = mysqlTable(
  "extraction_job",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    // No single-column FK — the composite tenant FK below covers it.
    invoiceId: int("invoice_id").notNull(),
    status: mysqlEnum("status", extractionJobStatusEnum).notNull().default("awaiting_upload"),
    phase: mysqlEnum("phase", extractionPhaseEnum),
    pdfType: mysqlEnum("pdf_type", pdfTypeEnum),
    // MariaDB has no native JSON type — `json` here is a `longtext` alias
    // with a validity check (see db/README.md). mysql2 still parses it back
    // into an array on read, same guarantee count_line.partial_fills relies
    // on; that's a driver behaviour, not a schema one, so it's covered by a
    // test rather than assumed. Nullable — most jobs never need OCR pages.
    pagesNeedingOcr: json("pages_needing_ocr").$type<number[]>(),
    errorMessage: text("error_message"),
    // Phase 2.5, Slice 2 — extraction pipeline / OCR provenance and cost
    // tracking. Added to this EXISTING table rather than a second job table
    // (the research doc's draft `invoice_extraction_job` does not exist and
    // must not be created — see this table's own header comment). All eight
    // are nullable: they only ever get set once a job actually runs the
    // Claude Vision path, and a text-based PDF processed via pdf-inspector
    // never calls the model at all, so provider/model/token/cost columns
    // stay NULL for the common case rather than being coerced to 0/''.
    //
    // `provider` / `modelId` / `promptVersion` are free text, not enums —
    // same reasoning as `product.category`: which OCR provider or prompt
    // version ran is an operational detail that will change faster than a
    // migration should gate it, not a small closed set worth hardcoding.
    provider: varchar("provider", { length: 32 }),
    modelId: varchar("model_id", { length: 64 }),
    promptVersion: varchar("prompt_version", { length: 32 }),
    // The raw structured response from the vision call, kept verbatim for
    // audit/debugging — same "store what was observed" reasoning as
    // count_line_write's deltas. Same MariaDB JSON-is-longtext caveat as
    // `pages_needing_ocr` above.
    rawResponse: json("raw_response"),
    inputTokens: int("input_tokens"),
    outputTokens: int("output_tokens"),
    // DECIMAL(10,6): a single-invoice Claude Vision call costs fractions of
    // a cent to a few cents, and 4dp (this file's usual money precision)
    // would round that to zero. 6dp keeps real precision on a value this
    // small; nothing here divides it further the way unit costs are divided,
    // so it doesn't need product.current_unit_cost's 10,4.
    costUsd: decimal("cost_usd", { precision: 10, scale: 6 }),
    // A short machine-matchable code (e.g. "ANTHROPIC_RATE_LIMIT",
    // "PDF_UNREADABLE") for the reaper and any future retry-classification
    // logic to branch on, alongside — never instead of — the free-text
    // `error_message` below, which stays the human-readable detail (and is
    // NEVER exposed to a non-owner: it can quote invoice text).
    errorCode: varchar("error_code", { length: 64 }),
    claimedAt: timestamp("claimed_at"),
    // Worker id (hostname/pid-ish string) — makes a stuck job diagnosable.
    // Not a FK: workers aren't a database entity.
    claimedBy: varchar("claimed_by", { length: 255 }),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    // Bounded by reapStuckJobs at 3 attempts before the job moves to
    // `failed` — see the table comment above.
    retryCount: int("retry_count").notNull().default(0),
    ...auditColumns,
  },
  (table) => [
    // Target of a later slice's composite tenant FKs, if any child table
    // ever needs one. Same role as every other `*_organization_id_id_unique`
    // in this file.
    uniqueIndex("extraction_job_organization_id_id_unique").on(table.organizationId, table.id),
    // THE claim-query index. Deliberately NOT organization-scoped: the
    // cron's `UPDATE ... WHERE status='queued' ORDER BY id LIMIT 1` is a
    // system worker claiming across ALL tenants, not a user-scoped read, so
    // an organization-first index would never be the one the optimizer
    // picks for it.
    index("extraction_job_status_id_idx").on(table.status, table.id),
    // Tenant integrity [AR-2] — an invoice_id supplied by a later slice's
    // resend/retry flow is client-adjacent, so this makes a cross-tenant
    // attachment a database error (1452) rather than a silent misfile.
    // ON DELETE RESTRICT: nothing hard-deletes an invoice (mirrors
    // invariant 6's soft-delete discipline), so there is no cascade this
    // needs to follow.
    foreignKey({
      columns: [table.organizationId, table.invoiceId],
      foreignColumns: [invoice.organizationId, invoice.id],
      name: "extraction_job_organization_invoice_fk",
    }).onDelete("restrict"),
  ],
);

// ---------------------------------------------------------------------------
// InvoiceLine — Phase 2.5, Slice 2 (extraction drafts)
// ---------------------------------------------------------------------------
// docs/plans/phase-2.5-invoice-automation/04-slices.md, Slice 2. Based on
// docs/invoice-automation-research.md's `invoice_line` draft, with three
// corrections applied (the research doc predates the 2026-08-14 adversarial
// review and disagrees with the live schema/docs in these places):
//   1. The draft's `productId` is `matchedProductId` here — it disambiguates
//      from unrelated `productId` columns elsewhere in this file and matches
//      04-slices.md's own prose and named tests.
//   2. `rawGross` / `rawDiscount` / `rawNet` are added — the "per-line
//      gross/discount/net editable" data the review screen (04-slices.md)
//      requires, which the research draft's `unitCost`/`extendedCost` alone
//      don't represent (a supplier discount printed per-line is neither).
//   3. `exceptionFlags` is added — the "confidence, exception_flags json"
//      04-slices.md calls for. EXACTLY four flag strings exist in this
//      slice: "price jump", "duplicate", "doesn't add up", "unmatched item".
//      No others — the discount/negative-net badges are Slice 4.
//
// One row per extracted line, written once by the extraction pipeline and
// then editable by the owner on the review screen (never by manager/staff —
// this whole table is supplier cost data, gated by `canSeeCost()`).
// `lineNumber` is the pipeline's own idempotency key: reclaiming a
// `running` job that already wrote drafts (see `extractionJob`'s reaper
// comment) re-writes the same (invoiceId, lineNumber) rows rather than
// duplicating them.
export const invoiceLine = mysqlTable(
  "invoice_line",
  {
    id: int("id").autoincrement().primaryKey(),
    // Denormalized from `invoice` so the unique index below can be
    // tenant-scoped and every read filters on it without a join — same
    // pattern as `productBarcode.organizationId`.
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    // Single-column FK, matching the research draft's CASCADE. In practice
    // this never fires — nothing in the app hard-deletes an invoice (mirrors
    // invariant 6's soft-delete discipline, same reasoning as
    // `extraction_job_organization_invoice_fk`'s RESTRICT below) — but it is
    // kept as the draft specified it rather than silently dropped.
    invoiceId: int("invoice_id")
      .notNull()
      .references(() => invoice.id, { onDelete: "cascade" }),
    lineNumber: int("line_number").notNull(),
    rawText: text("raw_text"), // verbatim OCR/text-extract output, for audit

    lineType: mysqlEnum("line_type", invoiceLineTypeEnum).notNull().default("unknown"),

    vendorItemCode: varchar("vendor_item_code", { length: 64 }),
    description: varchar("description", { length: 512 }),
    packDescription: varchar("pack_description", { length: 64 }), // "12/750ML"

    quantity: decimal("quantity", { precision: 12, scale: 3 }),
    uom: mysqlEnum("uom", invoiceLineUomEnum),
    // Parsed from packDescription. NULL means "not determinable," never 1 —
    // same "don't coerce an unknown into a plausible-looking number" rule as
    // count_line's unpriced-line handling.
    packSize: int("pack_size"),
    unitCost: decimal("unit_cost", { precision: 10, scale: 4 }), // as billed
    extendedCost: decimal("extended_cost", { precision: 12, scale: 2 }),

    // Correction 2: the review screen's actual editable fields. Distinct
    // from unitCost/extendedCost above (the derived per-unit/extended cost
    // used for matching and downstream valuation) — these three are the raw
    // as-printed figures a human confirms or corrects on the review screen.
    // DECIMAL(12,2): line-level money, not a per-unit cost fed into further
    // division, so this file's aggregate-money precision applies (see the
    // file header's precision conventions), not product.current_unit_cost's
    // 10,4.
    rawGross: decimal("raw_gross", { precision: 12, scale: 2 }),
    rawDiscount: decimal("raw_discount", { precision: 12, scale: 2 }),
    rawNet: decimal("raw_net", { precision: 12, scale: 2 }),

    // Correction 3: exactly the four exception badges 04-slices.md names —
    // "price jump", "duplicate", "doesn't add up", "unmatched item" — never
    // more, never fewer, in this slice. A JSON array (not four booleans)
    // because a line can carry more than one at once, and the review
    // screen's badge row just maps the array to badges. Same MariaDB
    // JSON-is-longtext caveat as extraction_job.pages_needing_ocr above.
    exceptionFlags: json("exception_flags").$type<string[]>(),

    // No single-column FK — matched_product_id is client-supplied (a human
    // picks it on the review screen), so it goes through
    // reviewInvoiceAction's OWN batched ownership check [AR-2] before
    // anything is written, same as every other client-supplied id in this
    // file. ON DELETE RESTRICT: nothing hard-deletes a product either
    // (invariant 6) — a match must never be silently orphaned.
    matchedProductId: int("matched_product_id").references(() => product.id, {
      onDelete: "restrict",
    }),
    matchMethod: mysqlEnum("match_method", invoiceMatchMethodEnum).notNull().default("unmatched"),
    matchConfidence: decimal("match_confidence", { precision: 4, scale: 3 }),

    // Phase 2.5, Slice 3. Set by lib/domain/matching.ts:matchLinesToProducts
    // (an internal domain function that already has orgId/vendorId resolved
    // from THIS invoice's own tenant-scoped row), never taken directly from
    // a client payload — unlike matchedProductId above, which IS
    // client-supplied on the review screen and is deliberately a bare FK for
    // that reason. Same reasoning applies here, so this stays a bare
    // single-column FK too, not a composite tenant FK: matchLinesToProducts
    // can only ever resolve an alias id via a query it has already scoped to
    // (organizationId, vendorId) — see vendorAlias's own unique index below
    // — so there is no code path that could hand this column another
    // tenant's alias id the way a raw client payload could.
    //
    // ON DELETE SET NULL, not RESTRICT like reviewedBy's FK to `user` a few
    // lines down. reviewedBy points at `user`, which (invariant 11) is only
    // ever deactivated, never deleted, so RESTRICT there is a backstop that
    // never actually fires. vendor_alias has no such soft-delete flag, and
    // correcting a bad mapping (wrong product picked, or a vendor_item_code
    // that turns out to be shared by two different products) is exactly the
    // kind of row a human may need to delete outright rather than upsert.
    // SET NULL means that correction is never blocked by every invoice_line
    // that ever matched through the alias — affected lines just revert to
    // unmatched-by-alias; matchMethod/matchedProductId above are untouched
    // by this FK, so each line's own audit record survives regardless.
    matchedVendorAliasId: int("matched_vendor_alias_id").references(() => vendorAlias.id, {
      onDelete: "set null",
    }),
    extractionConfidence: decimal("extraction_confidence", { precision: 4, scale: 3 }),

    reviewedBy: int("reviewed_by").references(() => user.id, { onDelete: "restrict" }),
    reviewedAt: timestamp("reviewed_at"),
    ...auditColumns,
  },
  (table) => [
    // Invariant-shaped: one row per (invoice, line number). Also the
    // pipeline's re-claim idempotency key — see the table comment above.
    uniqueIndex("invoice_line_invoice_lineno_unique").on(table.invoiceId, table.lineNumber),
    // Product-cost-history and catalog-facing lookups: "every invoice line
    // that ever matched this product."
    index("invoice_line_organization_matched_product_idx").on(
      table.organizationId,
      table.matchedProductId,
    ),
    // Slice 3: "which lines matched through this alias" — audit/debugging,
    // same role as the matched-product index above.
    index("invoice_line_organization_matched_vendor_alias_idx").on(
      table.organizationId,
      table.matchedVendorAliasId,
    ),
    // Vendor-code matching (Slice 3) and manual lookup by the code printed
    // on the invoice.
    index("invoice_line_organization_vendor_item_code_idx").on(
      table.organizationId,
      table.vendorItemCode,
    ),
    // Slice 4: target of `product_cost_history`'s composite tenant FK on
    // `source_invoice_line_id`. Same role as every other
    // `*_organization_id_id_unique` in this file (vendor, location, product,
    // count, count_line, invoice, extraction_job) — added here now that a
    // child table finally needs to reference an invoice_line row by id.
    uniqueIndex("invoice_line_organization_id_id_unique").on(table.organizationId, table.id),
    // Tenant integrity [AR-2] — mirrors extraction_job's own composite FK
    // exactly. A cross-tenant invoice_id here would let one tenant's
    // extraction drafts (and later, the review screen's writes) attach to
    // another tenant's invoice.
    //
    // ON DELETE RESTRICT, matching extraction_job_organization_invoice_fk's
    // reasoning: nothing hard-deletes an invoice, so this is a backstop, not
    // a path anything exercises. It coexists safely with the sibling
    // single-column CASCADE above rather than deadlocking against it —
    // verified empirically against MariaDB 11.8 (a raw `DELETE FROM invoice`
    // with a matching invoice_line row cascaded the child row and succeeded,
    // rather than the RESTRICT constraint blocking it): InnoDB applies the
    // CASCADE action first, so by the time the RESTRICT constraint is
    // checked no matching row remains for it to block on.
    foreignKey({
      columns: [table.organizationId, table.invoiceId],
      foreignColumns: [invoice.organizationId, invoice.id],
      name: "invoice_line_organization_invoice_fk",
    }).onDelete("restrict"),
  ],
);

// ---------------------------------------------------------------------------
// VendorAlias — Phase 2.5, Slice 3 (matching persistence)
// ---------------------------------------------------------------------------
// docs/plans/phase-2.5-invoice-automation/04-slices.md, Slice 3: "the 'fix
// once' memory — vendor-alias upsert — persists across invoices." One row
// per (organization, vendor, the vendor's OWN item code) mapping to one of
// OUR products; `lib/domain/matching.ts:findAlias` / `upsertAlias` are the
// only things that read/write it (not built in this migration).
//
// The composite tenant FK on vendorId below is the specific fix named by
// the 2026-08-14 adversarial review's second pass (00-status.md): "the
// `vendor_alias` had no tenant foreign key at all — and it is the one table
// whose bad rows persist and re-apply to every future invoice from that
// vendor." Every other client-adjacent id in this file gets an AR-2
// ownership check because a wrong value corrupts one write; a wrong alias
// row corrupts every future review of that vendor's invoices until a human
// happens to notice, which is a strictly worse failure to leave open.
//
// Referenced by invoiceLine.matchedVendorAliasId — see that column's
// comment for why that FK is bare (not composite) and ON DELETE SET NULL.
export const vendorAlias = mysqlTable(
  "vendor_alias",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    // No single-column FK — the composite tenant FK below covers it, same
    // pattern as count_line.countId / invoice_line.invoiceId. This is the
    // AR-2 fix itself: a bare vendor_id FK only proves the vendor row
    // exists, not that it belongs to this organization, and this table's
    // whole purpose is to be trusted, unattended, on every future invoice.
    vendorId: int("vendor_id").notNull(),
    // The code printed on the VENDOR's own invoice/catalog for this item —
    // not our internal product id. This plus (organizationId, vendorId) is
    // the upsert key (unique index below).
    vendorItemCode: varchar("vendor_item_code", { length: 64 }).notNull(),
    // Bare FK, not composite — matching invoice_line.matchedProductId's own
    // precedent: this id is supplied by a human picking a product on the
    // review screen's "map to product" action, so it goes through that
    // action's OWN ownership check before upsertAlias ever writes it here,
    // the same way reviewInvoiceAction batch-checks matched_product_id
    // [AR-2], rather than through a DB-level composite FK. NOT NULL: unlike
    // invoice_line (a draft that starts unmatched and gets a product later),
    // a vendor_alias row's entire reason to exist is the mapping — there is
    // no unmapped state for this table. ON DELETE RESTRICT: invariant 6,
    // products are never hard-deleted, so this never actually fires; kept
    // for consistency with every other product FK in this file.
    productId: int("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    // How many times this mapping has been confirmed, expressed as a
    // 0.000-1.000 confidence (same scale as invoice_line.matchConfidence,
    // so the review UI can format both with one rule) rather than a raw
    // count. This migration only sets the starting value — the increment
    // rule is advisory for whoever builds lib/domain/matching.ts, not
    // enforced by the schema:
    //   - 0.500 on first creation (upsertAlias's INSERT branch) — one human
    //     confirmation is a real signal, but not yet proven to generalize
    //     to the NEXT invoice from this vendor.
    //   - Each later confirmation (upsertAlias's UPDATE branch — the same
    //     vendor_item_code auto-matches again and a human leaves it as-is,
    //     or explicitly re-confirms it) should move the value toward 1.000
    //     without ever reaching or exceeding it, e.g.
    //     `confidence = 1 - 1 / (timesConfirmed + 1)` — so the column keeps
    //     meaning "how many times has this been confirmed," never "was it
    //     ever confirmed."
    matchConfidence: decimal("match_confidence", { precision: 4, scale: 3 })
      .notNull()
      .default("0.500"),
    ...auditColumns,
  },
  (table) => [
    // The upsert key — 04-slices.md, verbatim: "unique on (organization_id,
    // vendor_id, vendor_item_code)". Also serves as the index for
    // findAlias(orgId, vendorId, vendorItemCode) and for any
    // (organizationId) / (organizationId, vendorId)-only query, since both
    // are left prefixes of this index — a separate index on either would be
    // redundant (and is deliberately not added).
    uniqueIndex("vendor_alias_organization_vendor_item_code_unique").on(
      table.organizationId,
      table.vendorId,
      table.vendorItemCode,
    ),
    // "Every alias mapped to this product" — a catalog-facing lookup, same
    // role as invoice_line's own matched-product index.
    index("vendor_alias_organization_product_idx").on(table.organizationId, table.productId),
    // Tenant integrity [AR-2] — the fix the second-pass adversarial review
    // named specifically for this table. ON DELETE RESTRICT: nothing
    // hard-deletes a vendor (mirrors product/location/invariant 6's
    // discipline), so this is a backstop, matching every sibling
    // composite tenant FK in this file (product's own FK to vendor, above).
    foreignKey({
      columns: [table.organizationId, table.vendorId],
      foreignColumns: [vendor.organizationId, vendor.id],
      name: "vendor_alias_organization_vendor_fk",
    }).onDelete("restrict"),
  ],
);

// ---------------------------------------------------------------------------
// ProductCostHistory — Phase 2.5, Slice 4 (cost flow)
// ---------------------------------------------------------------------------
// docs/plans/phase-2.5-invoice-automation/04-slices.md, Slice 4: when the
// owner approves an invoice, `lib/domain/cost-derivation.ts:deriveUnitCost`
// computes a per-unit cost for each matched product/deposit-free line, and
// that write is recorded here BEFORE `product.current_unit_cost` is updated
// — same INSERT-then-UPDATE order as every other snapshot-before-mutate
// pattern in this file (count_line's unit_cost_at_count is the closest
// analogue: never re-derive a historical value from current product data).
//
// Append-only, like `count_line_write` — no `updated_at`, no soft-delete
// flag, and application code must never UPDATE or DELETE a row here. Unlike
// count_line_write, there is no separate `created_at`: `effective_at` IS the
// row's timestamp (the instant the approving transaction ran), so a second
// column recording the same instant a second time would just be a driftable
// copy of it.
//
// [AR-4] `UNIQUE(source_invoice_line_id)` is the idempotency BACKSTOP, not
// the primary mechanism — the primary mechanism is the CAS on
// `invoice.status` (reviewed -> approved) in `approveInvoiceAction`, which
// returns success without re-entering the cost-writing loop at all on a
// replay. This constraint exists so a bug in that CAS still fails loudly
// (1062, transaction rollback) instead of silently doubling a product's cost
// history. Deliberately a PLAIN unique, not scoped to organization_id — a
// `source_invoice_line_id` already identifies exactly one row in a
// tenant-scoped table (`invoice_line`), so there is nothing left for a
// per-tenant scope to add, same reasoning as `count_line_write`'s global
// `client_line_id` unique.
export const productCostHistory = mysqlTable(
  "product_cost_history",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    // None of the three ids below carry a single-column FK — each is covered
    // by its own composite tenant FK at the bottom of this table, same
    // pattern as count_line.countId / invoice_line.invoiceId /
    // vendor_alias.vendorId. All three are resolved server-side inside
    // `approveInvoiceAction`'s own transaction (never taken raw from a
    // client payload the way invoice_line.matchedProductId is), but the
    // composite FK is still the correct shape here: it's what lets this
    // table reference product/invoice/invoice_line "for THIS organization"
    // without a join, matching every other cross-table reference in this
    // file rather than being a special case.
    productId: int("product_id").notNull(),
    sourceInvoiceId: int("source_invoice_id").notNull(),
    sourceInvoiceLineId: int("source_invoice_line_id").notNull(),
    // Same precision as product.current_unit_cost — this IS the value
    // written there, snapshotted at the moment it took effect.
    unitCost: decimal("unit_cost", { precision: 10, scale: 4 }).notNull(),
    // NULL only for a product's first-ever recorded cost (nothing to chain
    // from). Read with `SELECT current_unit_cost ... FOR UPDATE` inside the
    // same transaction that writes this row [AR-5] — reading it outside the
    // transaction would let two invoices approved close together for the
    // same product both record the same stale "previous" cost, breaking the
    // A->B, B->C chain `previous_unit_cost_chains` asserts rather than two
    // jumps from the same baseline.
    previousUnitCost: decimal("previous_unit_cost", { precision: 10, scale: 4 }),
    // The moment this cost took effect — i.e. when the approving transaction
    // ran. Doubles as this row's own creation timestamp; see the table
    // comment above for why there is no separate created_at.
    effectiveAt: timestamp("effective_at").notNull().defaultNow(),
    // The user who approved the invoice this cost was derived from.
    // Deliberately NOT NULL, unlike invoice.approvedBy's nullable shape —
    // approvedBy is nullable because it lives on a row (`invoice`) that
    // exists BEFORE approval happens; this column lives on a row that only
    // ever gets created DURING an approval, by the owner performing it, so
    // "who did this" is always known at insert time. Same reasoning as
    // count_line_write.writtenBy (also NOT NULL) over count.closedBy (nullable,
    // same "row predates the action" shape as approvedBy). The FK
    // itself — int referencing user.id, ON DELETE RESTRICT — is the exact
    // pattern approvedBy uses; only the nullability differs, deliberately.
    createdBy: int("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (table) => [
    uniqueIndex("product_cost_history_source_invoice_line_id_unique").on(
      table.sourceInvoiceLineId,
    ),
    // "This product's price history" — the read a future cost-history screen
    // makes, same role as vendor_alias_organization_product_idx /
    // invoice_line_organization_matched_product_idx above.
    index("product_cost_history_organization_product_idx").on(
      table.organizationId,
      table.productId,
    ),
    // Tenant integrity [AR-2] — same reasoning as every other composite
    // tenant FK in this file. ON DELETE RESTRICT: nothing hard-deletes a
    // product (invariant 6), so this is a backstop, not a path anything
    // exercises.
    foreignKey({
      columns: [table.organizationId, table.productId],
      foreignColumns: [product.organizationId, product.id],
      name: "product_cost_history_organization_product_fk",
    }).onDelete("restrict"),
    // ON DELETE RESTRICT: nothing hard-deletes an invoice (approved is
    // terminal, never removed) — same reasoning as
    // extraction_job_organization_invoice_fk / invoice_line_organization_invoice_fk.
    foreignKey({
      columns: [table.organizationId, table.sourceInvoiceId],
      foreignColumns: [invoice.organizationId, invoice.id],
      name: "product_cost_history_organization_invoice_fk",
    }).onDelete("restrict"),
    // ON DELETE RESTRICT: an invoice_line only ever disappears via its
    // parent invoice's CASCADE (see invoice_line's own table comment on why
    // that coexists safely with a sibling RESTRICT), and nothing in this app
    // deletes an approved invoice's lines out from under its own cost
    // history — a RESTRICT here is a correctness backstop against exactly
    // that.
    foreignKey({
      columns: [table.organizationId, table.sourceInvoiceLineId],
      foreignColumns: [invoiceLine.organizationId, invoiceLine.id],
      name: "product_cost_history_organization_invoice_line_fk",
    }).onDelete("restrict"),
  ],
);

// ---------------------------------------------------------------------------
// AuditPacket — Phase 2.5, Slice 5 (audit packet / two-year retention export)
// ---------------------------------------------------------------------------
// docs/plans/phase-2.5-invoice-automation/04-slices.md, "Slice 5 — Audit
// Packet (Phase E)"; docs/plans/phase-2.5-invoice-automation/02-architecture.md
// §6/§7 is the schema sketch this table implements, with one deliberate
// narrowing — see `auditPacketSourceTableEnum` in db/enums.ts.
//
// The owner requests a date range → `createAuditPacketAction` writes this row
// `building` → a background job (`buildAuditPacketJob`) assembles a ZIP of
// every invoice and count in that range, for that tenant, and a manifest of
// per-file SHA-256 hashes → the row moves to `ready` with a 10-minute
// download window. Same "row exists before the work is done" shape as
// `extraction_job`'s `awaiting_upload`, so the client can poll a real id
// from the moment the request is accepted.
//
// [AR-3] Every query the background job runs is scoped to
// `orgId = packet.organization_id`, read from THIS row — the job is handed
// only a packetId, never an organization from a caller. See
// `audit_packet_file`'s table comment for why that discipline has to live in
// application code for this feature specifically.
export const auditPacket = mysqlTable(
  "audit_packet",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    status: mysqlEnum("status", auditPacketStatusEnum).notNull().default("building"),
    // The REQUESTED range, as calendar days — "give me every invoice and
    // count from March" is a date-range question, not a moment-in-time one,
    // same reasoning as invoice.invoiceDate over a TIMESTAMP. mode: "string"
    // + db/index.ts's `dateStrings: ["DATE"]` keeps these plain
    // "YYYY-MM-DD" end to end.
    dateFrom: date("date_from", { mode: "string" }).notNull(),
    dateTo: date("date_to", { mode: "string" }).notNull(),
    // Points into wherever the ZIP is stored (mirrors invoice.filePath's own
    // storage-key reasoning), never `public/` [AR-1]. Nullable because the
    // storage key is derived from this row's own `id` and the job hasn't run
    // yet at insert time — NULL until `status` reaches `ready`, same "id
    // doesn't exist until the row does" shape as invoice.filePath, not an
    // empty-string placeholder the download route would have to special-case.
    filePath: varchar("file_path", { length: 1024 }),
    // SHA-256 of the whole ZIP (not a per-file hash — those live on
    // audit_packet_file below), set alongside filePath when the job finishes.
    fileSha256: varchar("file_sha256", { length: 64 }),
    // {fileCount, totalSha256} today per 04-slices.md's flow E; shaped as an
    // extensible per-file array so a future UI can render the manifest
    // without re-deriving it from audit_packet_file. MariaDB has no native
    // JSON type — `json` here is a `longtext` alias with a validity check
    // (see db/README.md). mysql2 still parses it back into an object on
    // read, same driver guarantee `extraction_job.rawResponse` and
    // `count_line.partial_fills` rely on; that's a driver behaviour, not a
    // schema one, so it's covered by a test rather than assumed. Nullable —
    // set once, when `status` reaches `ready`.
    manifestJson: json("manifest_json").$type<{
      fileCount: number;
      totalSha256: string;
      files: Array<{
        path: string;
        sourceTable: (typeof auditPacketSourceTableEnum)[number];
        sourceId: number;
        sha256: string;
      }>;
    }>(),
    // Set to now() + 10min the moment `status` becomes `ready` — the
    // download-link TTL 04-slices.md's acceptance criteria require, enforced
    // server-side at request time in `getAuditPacketAction`, never inferred
    // from the URL alone. NULL until then; stays set (not cleared) once the
    // packet expires — `status` moving to `expired` is what a stale
    // `expires_at` gets read as, not a reason to blank the timestamp that
    // proves when it lapsed.
    expiresAt: timestamp("expires_at"),
    // When the background job finished (success or failure) — distinct from
    // `expires_at` (when the download link stops working) and from
    // `auditColumns.updatedAt` (bumped by ANY row change, including the
    // building -> ready transition itself, so it can't answer "how long did
    // this job take" on its own). NULL while `status = building`.
    completedAt: timestamp("completed_at"),
    // The owner who requested this export — both the ownership check
    // `getAuditPacketAction` runs (AR-2: another org's owner requesting this
    // packetId gets NotFound, not a download URL) and the email recipient
    // flow E sends the signed link to. NOT NULL: a packet is always created
    // by exactly one `createAuditPacketAction` call, by the owner making it,
    // so — same reasoning as `product_cost_history.createdBy` over
    // `invoice.approvedBy` — "who requested this" is always known at insert
    // time, unlike columns that describe an action which may not have
    // happened yet.
    createdBy: int("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    ...auditColumns,
  },
  (table) => [
    // Target of audit_packet_file's composite tenant FK below. Same role as
    // every other `*_organization_id_id_unique` in this file.
    uniqueIndex("audit_packet_organization_id_id_unique").on(table.organizationId, table.id),
    // The office UI's list/poll query: "this org's packets, filtered by
    // status" (e.g. the badge that flips processing -> ready).
    index("audit_packet_organization_status_idx").on(table.organizationId, table.status),
  ],
);

// ---------------------------------------------------------------------------
// AuditPacketFile — Phase 2.5, Slice 5 (manifest line items)
// ---------------------------------------------------------------------------
// One row per file the background job put in the ZIP — the durable manifest
// that backs `audit_packet.manifest_json`'s summary and lets a future screen
// list exactly what an export contained without re-opening the archive.
// Append-only, like `count_line_write` and `product_cost_history`: a build
// only ever inserts into this table, never updates or deletes a row, so
// there is no `updated_at` alongside `created_at`.
//
// **`source_id` is polymorphic and therefore cannot be FK-guarded [AR-3].**
// Depending on `source_table` it points into `invoice.id` or `count.id` —
// two different tables with two different id sequences — so the database
// cannot enforce that the referenced row belongs to `organization_id` the
// way it can everywhere else in this file (compare
// `product_cost_history`'s three FK-guarded ids, all of which point into
// exactly one table each). This is the one place in the audit-packet path
// where tenant scoping rests on application code rather than a constraint —
// precisely where AR-3's original leak lived (a source query with no
// `organization_id` predicate at all). The compensating controls, both
// required and not belt-and-braces:
//   1. Every source query in `buildAuditPacketJob` filters on
//      `orgId = packet.organization_id`, read from the `audit_packet` row
//      itself, never from a caller-supplied value.
//   2. Before the packet is marked `ready`, the job asserts every row it is
//      about to write here shares exactly one distinct `organization_id` —
//      a cheap backstop that turns a future regression (a query that loses
//      its predicate) into a failed build instead of a silent cross-tenant
//      ZIP.
export const auditPacketFile = mysqlTable(
  "audit_packet_file",
  {
    id: int("id").autoincrement().primaryKey(),
    organizationId: int("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    // No single-column FK — the composite tenant FK below covers it, same
    // shape as invoice_line.invoiceId / product_cost_history's three ids.
    auditPacketId: int("audit_packet_id").notNull(),
    sourceTable: mysqlEnum("source_table", auditPacketSourceTableEnum).notNull(),
    // Polymorphic; NOT FK-guarded. See the table comment above for why and
    // for the two compensating controls that stand in for a constraint here.
    sourceId: int("source_id").notNull(),
    // The path WITHIN the zip archive (e.g. "invoices/42/original.pdf"), not
    // a disk path — the disk/storage path for the source file already lives
    // on `invoice.file_path`; this is where the job placed a copy of it
    // inside the archive it's building.
    filePath: varchar("file_path", { length: 1024 }).notNull(),
    // Per-file SHA-256, independent of `audit_packet.file_sha256` (the whole
    // ZIP's hash) — this is what lets a future integrity check verify one
    // archived document without re-hashing the entire export.
    sha256: varchar("sha256", { length: 64 }).notNull(),
    // Append-only — see table comment above for why there is no updatedAt.
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // The manifest-assembly read: "every file this packet contains."
    index("audit_packet_file_organization_packet_idx").on(
      table.organizationId,
      table.auditPacketId,
    ),
    // Tenant integrity [AR-2] — same reasoning as every other composite
    // tenant FK in this file. ON DELETE RESTRICT: nothing hard-deletes an
    // audit_packet row (append-only export history, same discipline as
    // product/invoice/count), so this is a backstop, not a path anything
    // exercises.
    foreignKey({
      columns: [table.organizationId, table.auditPacketId],
      foreignColumns: [auditPacket.organizationId, auditPacket.id],
      name: "audit_packet_file_organization_packet_fk",
    }).onDelete("restrict"),
  ],
);
