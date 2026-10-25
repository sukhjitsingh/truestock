# Gate 1 — Product: Truestock UI/UX Redesign & Surface Modernization

**Slug:** `ui-ux-redesign`  
**Author:** Software Factory Planning Specialist  
**Date:** 2026-08-23  
**Status:** APPROVED (Comprehensive 4-Gate Baseline)  
**Authoritative Sources:** `PROJECT.md`, `AGENTS.md`, `docs/spec.md`, `docs/design-system.md`, `prototypes/mobile-app-redesign.html`

---

## 1. Problem Statement

Beverage and food inventory management in bars and restaurants suffers from an acute operational divide between two fundamentally different working environments:
1. **The Counting Floor:** A bar manager or staff counter navigates a dark, loud, fast-paced environment at 2:00 AM. They hold a cold, wet bottle in one hand and an Android smartphone in the other. Every tap must be unambiguous, large, and responsive. Ambiguous navigation chevrons, tiny tap targets, complex menus, modal confirmation popups, and blinding white screens cause physical fatigue, input errors, and skipped bottles.
2. **The Back Office:** A general manager or owner sits at a desk during daylight hours reviewing 97+ inventory items, cost valuations, supplier invoices, regulatory audit packets, and reorder lists across multiple browser tabs. Here, phone-sized interfaces feel wasteful and slow; managers require dense, sortable, paginated data grids, instant inline adjustments, split-screen document verification, and strict role-based data isolation so staff never see supplier costs or profit margins.

Prior iterations of the application exhibited UI contract drift:
- Chevrons sometimes indicated navigation and other times were purely decorative.
- Missing data was represented inconsistently across screens (`$0.00`, `Not entered`, `Unpriced`, `—`), creating confusion between unpriced items and zero-value items.
- Accidental overrides between `ADD` (increment) and `SET` (override) inputs caused silent inventory count corruptions.
- Location changes during scanning caused silent distribution errors where inventory totals were correct but assigned to the wrong bar station.
- Role-gated cost numbers were occasionally hidden via CSS rather than omitted from the rendered DOM, introducing compliance and data security risks.

The Truestock UI/UX Redesign resolves these problems by establishing an uncompromising **Dual-Surface Architecture**: a hardcoded OLED Dark floor app optimized for dim bars, and a high-density Daylight Slate web app optimized for desktop back-office administration, bound together by a unified, tokenized design system.

---

## 2. Target User Personas

### Persona 1: Marcus — The Nightly Floor Counter (Staff / Bar Lead)
- **Role:** `staff` or `manager`
- **Context & Environment:** 2:30 AM in a dimly lit bar, loud background music, wet hands, sticky bottles, tired eyes.
- **Hardware:** Android phone (Pixel / Galaxy) or iPhone, operated with one thumb while the other hand grips bottle necks.
- **Core Jobs to Be Done:**
  - Open active count session and verify hardware (camera scanner + local storage preflight).
  - Walk locked location legs (Speed Rail, Back Bar, Walk-In, Beer Cooler, Storeroom) without accidental station cross-contamination.
  - Scan barcodes rapidly; record open bottle fill levels in tenths (.1 to 1.0) with zero visual guesswork.
  - Count sealed cases and loose eaches with tactile steppers and instant before/after consequence visibility.
  - Capture stray bottles found in the wrong station without breaking the current counting leg.
- **Critical Frustrations Avoided:** No blinding white flashes, no modal confirmation dialogs on routine taps, no 32px hit boxes, no accidental double-counts, and no exposure to financial cost data.

### Persona 2: Elena — The Beverage Director & Owner (Owner / Executive)
- **Role:** `owner`
- **Context & Environment:** 10:00 AM at a sunlit office desk or on an iPad during supplier meetings.
- **Hardware:** MacBook / Windows desktop with mouse and keyboard, iPad Pro tablet.
- **Core Jobs to Be Done:**
  - Review live count progress, count-over-count valuation variance, and location rollups.
  - Audit product catalog with 57px dense rows, inline unit cost/case size editing, and bulk supplier assignment.
  - Review scanned supplier invoices side-by-side with OCR line item extraction; resolve math discrepancies and post costs atomically.
  - Export date-range compliance audit packets (Arizona DLLC regulatory ZIP archives).
  - Manage user permissions and deactivate departed staff with instant session revocation.
- **Critical Frustrations Avoided:** No multi-step wizard dialogs for simple edits, no layout shifting sidebars on page reload, no accidental leakage of wholesale costs to floor staff, and no silent calculation errors.

---

## 3. Product Scope Boundaries

### In-Scope (Phase 2 UI/UX Redesign & Surface Modernization)
1. **Design System & Token Architecture (`docs/design-system.md`):**
   - Pure CSS variables for Light Daylight (`:root`) and OLED Dark (`.dark`).
   - Frosted glassmorphism tokens (`--glass-bg`, `--glass-header`, `--glass-border`, `--glass-shadow`) with backdrop-filter blurs.
   - Standardized typography scale with global `tabular-nums` formatting.
   - Strict tap target floors: 56px primary counting floor (`--tap-primary`), 44px min touch floor (`--tap-min`), and 36px dense desktop control floor.
   - Strict separation: Brand Blue (`--accent`) for navigation and focus rings; Green/Amber/Red strictly for stock and count lifecycle status.
2. **Mobile Floor Counting Surface (`app/(count)`):**
   - Routes: `/count` (Hub), `/count/preflight` (Hardware diagnostic), `/count/[countId]` (Session overview & audit), `/count/[countId]/scan` (Counting floor execution), `/count/catalog` (Mobile product search), `/count/account` (Session info & signout).
   - Interactive liquid bottle vial simulation with continuous gauge and discrete tenths keypad (.1 to 1.0).
   - Multi-bottle partial fills chip list for staging multiple open containers in `partial_fills` JSON array.
   - Separate cases and loose eaches steppers with pack multipliers.
   - Live consequence deltas on submit button (`ADD 3 EA / 12 → 15` vs `SET TO 3 EA / was 12 ea · −9`).
   - Locked location leg flow with full-screen location picker and explicit "Finish section" transition.
   - Stray bottle escape hatch modal allowing isolated count into alternate location without mutating active leg.
   - Paired search + barcode scanner pinned to bottom thumb reach zone.
   - Re-scan pulse animation and `aria-live="polite"` screen reader announcement (Invariant 3).
3. **Desktop Back-Office Web Workspace (`app/(office)`):**
   - Routes: `/office` (Dashboard), `/office/catalog` (Catalog management), `/office/locations` (Location management & count modes), `/office/invoices` (Invoice archive), `/office/invoices/[invoiceId]` (Split-screen OCR review), `/office/invoices/audit-packet` (Compliance ZIP export), `/office/counts` (Historical counts), `/office/counts/[countId]` (Count summary & valuation), `/office/reorder` (Par-level reorder lists), `/office/vendors` (Vendor management), `/office/users` (User access & session revocation).
   - Collapsible `OfficeRail` (64px icon strip to 208px full navigation) with top-anchored chevron toggle and `truestock_rail` cookie persistence for flicker-free server rendering.
   - `OfficeBreadcrumb` topbar navigation (`Truestock / <Section>`).
   - Accessible TanStack Table v8 layout with 57px row tokens, `SortableTableHead`, `TableCaption`, and client-side pagination.
   - Invariant 8 Role-Gating: Call-time column omission strictly excluding unit costs and profit margins from the rendered HTML DOM for staff and managers.
   - Four-way absent value classification (`—` for structurally N/A, `Not entered` for pending inputs, `null` for role-gated, descriptive sentence for empty states).
   - Split-Screen Invoice OCR Review modal with CAS state lifecycle and math validation exception badges.
   - Asynchronous date-range regulatory Audit Packet ZIP export with 3000ms polling.
   - User management with atomic session revocation on deactivation (Invariant 11).
   - Location management with active write-path verification (Invariant 6).

### Out-of-Scope (Explicitly Deferred)
- **AI Fill Level Computer Vision:** No camera-based automatic bottle fill estimation or bottle photo uploads (deferred to Phase 7).
- **Toast POS Live Integration & PMIX Import:** Recipe depletion mapping and POS live variance syncing remain scheduled for Phase 4.
- **Multi-Tenant Org Switcher & Self-Serve Billing:** System remains strictly single-tenant-per-user seeded at organization creation.
- **Multi-Series Charting Palette (`--chart-2..5`):** Consuming `--chart-2` through `--chart-5` remains strictly prohibited until full colorblindness simulation and status-independence calculations are completed in Phase 4. Only `--chart-1` (Brand Blue) is active.
- **Leg Model Redesign:** The five-location locked leg workflow remains strictly preserved.

---

## 4. Complete Screen Inventory

| Surface | Route | Screen Name | Key Components & UX Mechanics | Target Persona |
|---|---|---|---|---|
| **Mobile Floor** | `/count` | Floor Hub | Active count session card, resume action, start count trigger, lines/units summary | Marcus (Staff/Manager) |
| **Mobile Floor** | `/count/preflight` | Hardware Diagnostic | `BarcodeDetector` API check, camera permission validator, IndexedDB storage check | Marcus (Staff/Manager) |
| **Mobile Floor** | `/count/[countId]` | Session Overview | DetailHeader, progress meter, status timeline, count line list, immutable closed banner (Inv 1) | Marcus / Elena |
| **Mobile Floor** | `/count/[countId]/scan` | Counting Execution | Location leg lock, liquid vial simulation, tenths keypad, cases/eaches steppers, live deltas, stray escape hatch, scanner+search | Marcus (Staff/Manager) |
| **Mobile Floor** | `/count/catalog` | Mobile Catalog Search | Type-ahead product search, category filters, pack size reference | Marcus (Staff/Manager) |
| **Mobile Floor** | `/count/account` | Mobile Account | User identity, current role display, sign out action | Marcus (Staff/Manager) |
| **Desktop Office** | `/office` | Executive Dashboard | KPI tiles (count in progress, last closed count, reorder pressure, catalog health, unpriced items for owner) | Elena (Owner) |
| **Desktop Office** | `/office/catalog` | Catalog Table | TanStack Table v8, role-gated cost columns, inline cost/case editing, category filter pills, bulk vendor assignment | Elena / Manager |
| **Desktop Office** | `/office/locations` | Locations Management | Location table, count mode toggle (Tenths vs Cases/Eaches), sort ordering, write-path active verification | Elena / Manager |
| **Desktop Office** | `/office/invoices` | Invoice Archive | Role-gated invoice table (`listInvoicesForOwner` vs `listInvoicesRedacted`), upload trigger, retention date badges | Elena (Owner) |
| **Desktop Office** | `/office/invoices/[id]` | Split-Screen Invoice Review | Side-by-side header metadata + line item review, math validation badges, product matcher, CAS lifecycle actions | Elena (Owner) |
| **Desktop Office** | `/office/invoices/audit-packet` | Audit Packet Export | Date-range picker (`dateFrom <= dateTo <= today`), async ZIP generation, 3000ms polling, 10-min presigned download link | Elena (Owner) |
| **Desktop Office** | `/office/counts` | Historical Counts | Counts listing, status pills, closer metadata, role-gated total valuation column | Elena / Manager |
| **Desktop Office** | `/office/counts/[countId]` | Count Valuation Summary | Total lines/units/valuation, cost exclusion banner, count-over-count delta comparison, category/location rollups | Elena (Owner) |
| **Desktop Office** | `/office/reorder` | Par-Level Reorder List | On-hand vs Par comparison, grouped by supplier, print scoping (`.print-scope-active`) | Elena / Manager |
| **Desktop Office** | `/office/vendors` | Vendors Management | Vendor listing, contact info, lead times, order minimums, explicit edit button | Elena (Owner) |
| **Desktop Office** | `/office/users` | Users Access Management | User listing, role assignment dropdown, atomic session revocation on deactivation (Inv 11) | Elena (Owner) |

---

## 5. Non-Negotiable Invariants Guardrails

The UI/UX Redesign strictly enforces all 11 core invariants defined in `AGENTS.md`:

1. **Invariant 1: Closed counts are immutable.**
   - Status `closed` renders an immutable, read-only audit view.
   - All editing controls, steppers, and scan triggers are stripped from the DOM.
   - Attempting to access `/count/[countId]/scan` for a closed count redirects immediately to the session summary.
2. **Invariant 2: Snapshot cost and case size onto count line.**
   - Historical count valuation reads `unit_cost_at_count` and `case_size_at_count`.
   - Current catalog cost updates never alter historical count lines.
3. **Invariant 3: `UNIQUE (count_id, product_id, location_id)` on CountLine.**
   - Re-scanning an already-counted product in the same location increments the existing line and highlights the row with a visual pulse (`flash-dup`) and fires an `aria-live="polite"` announcement. No duplicate rows are created.
4. **Invariant 4: Store cases and eaches separately.**
   - The counting interface provides discrete stepper controls for Cases (`sealed_case_qty`) and Loose Eaches (`sealed_each_qty`). Cases are never converted to eaches at entry time.
5. **Invariant 5: `client_line_id` (UUID) makes writes idempotent.**
   - Every write attempt creates a unique UUID `client_line_id` stored in IndexedDB and submitted to the append-only `count_line_write` ledger. Retried submissions roll back safely and return the existing line without duplication.
6. **Invariant 6: Soft deletion enforced on WRITE path for products and locations.**
   - Retiring a location or product sets `active = false`.
   - Server actions verify `active === true` before processing existing-line lookups or inserts. If a client attempts to count into a retired location, the write is rejected with `LOCATION_RETIRED`.
7. **Invariant 7: Authorization checked in every server action; forms use POST.**
   - Line 1 of every server action executes `requireRole()`.
   - All client-handled forms enforce `method="post"` to eliminate query-string credential leaks in the event of delayed hydration.
8. **Invariant 8: Cost and margin data is gated by role.**
   - Staff and Managers never receive cost or margin data in server DTOs.
   - TanStack Table `columns` arrays dynamically omit cost columns at call time. Cost DOM nodes are completely excluded from the HTML.
9. **Invariant 9: Tenant isolation scoped to organization.**
   - `Actor.organizationId` is re-read from the database session on every call. Cross-tenant lookups return `NotFound` without confirming row existence.
10. **Invariant 10: Draft depletion grossed up by waste factor.**
    - Keg sizes in mL (`size_ml`) and tenths calculations apply theoretical waste factors (`pour / (1 - waste_factor)`) without distorting physical count measurements.
11. **Invariant 11: Deactivating user revokes sessions in same transaction.**
    - Deactivating a user executes `UPDATE user SET active = false` AND `DELETE FROM session WHERE user_id = :userId` in a single atomic database transaction.

---

## 6. Acceptance Criteria

### Functional & UX Acceptance
1. **Liquid Vial & Tenths Keypad:** The liquid gauge provides smooth 0.1-increment fluid level visualization and updates instantly when tapping keypad buttons (.1–1.0) or quick buttons (Full, Half, Empty). Multi-bottle partial fills render as removable chips summing to line totals.
2. **Cases/Eaches Steppers & Consequence Deltas:** Steppers increment/decrement in whole integers. The submit button dynamically displays the exact before/after calculation (e.g. `ADD 3 EA / 12 → 15` or `SET TO 3 EA / was 12 ea · −9`).
3. **Locked Leg Flow & Stray Escape Hatch:** Active counting requires an explicit location selection that locks the header station pill. The stray bottle modal permits counting an item in an alternate station and immediately returns to the active leg.
4. **Collapsible OfficeRail & Breadcrumb:** Sidebar expands (208px) and collapses (64px) via top chevron toggle. `truestock_rail` cookie ensures zero layout shift on server rendering. Topbar breadcrumb displays `Truestock / <Section>` across all office routes including `/office/invoices`.
5. **Role-Gated Data Isolation (Invariant 8):** Inspecting the DOM of a Staff or Manager session on `/office/catalog`, `/office/counts`, or `/count/[countId]` confirms 0 occurrences of unit costs, profit margins, or unpriced placeholders.
6. **Shared UI Table Primitives:** All back-office tables (`catalog`, `locations`, `vendors`, `users`, `counts`, `invoices`) utilize the standardized `components/ui/table.tsx` primitives with 57px row heights, accessible captions, `scope="col"` headers, and `<NullValue>` elements.
7. **Invoice OCR Review & Audit Packet Export:** Split-screen invoice review displays header metadata and 7-column line items with math validation badges and CAS state workflow. Audit packet generates date-range ZIP archives with 3-second status polling and presigned download links.

### Technical & Quality Verification
- **Typecheck:** Clean run with zero errors (`bun run typecheck`).
- **Unit & Integration Tests:** 100% passing across pure unit tests and MariaDB 11.8 integration suite (`bun test`).
- **Production Build:** Next.js standalone build compiles cleanly with zero hydration or CSP errors (`bun run build`).
- **CSP Nonce Compliance:** Per-request nonce in `middleware.ts` functions seamlessly without inline script blocking.
