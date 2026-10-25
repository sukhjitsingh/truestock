# Gate 4 — Vertical Slices: Execution Plan & Verification Strategy

**Slug:** `ui-ux-redesign`  
**Author:** Software Factory Planning Specialist  
**Date:** 2026-08-23  
**Status:** APPROVED (Comprehensive 4-Gate Baseline)  
**Authoritative Sources:** `PROJECT.md`, `AGENTS.md`, `docs/spec.md`, `docs/design-system.md`, `prototypes/mobile-app-redesign.html`

---

## 1. Vertical Slice Strategy

The implementation follows the Software Factory discipline: every slice is a fully integrated vertical slice spanning tokens/markup, component interaction, and domain/action logic where applicable. No horizontal building (e.g. styling all screens before testing interactions).

```
+-----------------------------------------------------------------------------------+
| S1: Tracer Bullet — Design Tokens, Glassmorphism & UI Table Primitives            |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| S2: Mobile Counting Floor Core Loop & Liquid Bottle Vial Simulation               |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| S3: Cases/Eaches Steppers, Live Consequence Deltas & Rescan Live Region            |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| S4: Location Leg Locking & Stray Bottle Escape Hatch                              |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| S5: Desktop Back-Office Shell (OfficeRail 64-208px + Cookie, OfficeBreadcrumb)   |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| S6: Role-Gated TanStack Table & Office Management (Catalog, Locations, Users)      |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
| S7: Split-Screen Invoice OCR Review & Regulatory Audit Packet Export              |
+-----------------------------------------------------------------------------------+
```

---

## 2. Vertical Slice Catalog & Execution Sequence

### Slice 1 (Tracer Bullet): Design Tokens, Frosted Glass & Shared UI Primitives
- **Scope:**
  - Verify and refine pure CSS tokens in `app/globals.css` (`:root` Light & `.dark` OLED).
  - Configure frosted glass tokens (`--glass-bg`, `--glass-header`, `--glass-border`, `--glass-shadow`) and backdrop filters.
  - Establish shared accessible UI primitives: `components/ui/table.tsx` (`TableContainer`, `Table`, `TableCaption`, `SortableTableHead`, `TableRow`, `TableCell`), `components/ui/null-value.tsx` (4-way classification), `components/ui/button.tsx` (56px/44px/36px floors), and `components/ui/money.tsx`.
- **Target Files:** `app/globals.css`, `components/ui/table.tsx`, `components/ui/null-value.tsx`, `components/ui/money.tsx`, `components/ui/button.tsx`.
- **Verification Gate:** `bun test tests/null-value.test.ts tests/stock-cell.test.ts` passes; typecheck passes.

### Slice 2: Mobile Counting Floor Core Loop & Liquid Bottle Vial Simulation
- **Scope:**
  - Implement dynamic liquid fluid visualizer (`vial-display.tsx`) with smooth height transition.
  - Implement tenths touch gauge with continuous drag calculation and discrete tenths keypad (`.1` to `1.0`) in `fill-entry.tsx`.
  - Implement multi-bottle partial fills chip list supporting bottle inspection, adjustment, and deletion (`partial_fills` array).
  - Implement keg volume derivation in mL for `unitType === 'keg'` SKUs.
- **Target Files:** `components/count/fill-entry.tsx`, `components/count/vial-display.tsx`, `app/(count)/count/[countId]/scan/page.tsx`.
- **Verification Gate:** Verify fluid gauge animation, tenths snapping (`round(rel*10)/10`), and multi-bottle array math.

### Slice 3: Cases/Eaches Steppers, Live Consequence Deltas & Rescan Live Region
- **Scope:**
  - Implement separate Cases and Loose Eaches steppers with 56px touch floors (`QuantityEntry` in `quantity-entry.tsx`).
  - Implement segmented toggle (`ADD` vs `SET`) and real-time live delta button calculations (`ADD 3 EA / 12 → 15` vs `SET TO 3 EA / was 12 ea · −9`).
  - Implement re-scan card pulse animation (`flash-dup`) and `aria-live="polite"` screen reader announcement on duplicate barcode scans (Invariant 3).
  - Wire writes through IndexedDB write queue with UUID `client_line_id` idempotency (Invariant 5).
- **Target Files:** `components/count/quantity-entry.tsx`, `components/count/count-leg.tsx`, `lib/count-queue.ts`.
- **Verification Gate:** `bun test tests/count-queue-id.test.ts tests/rescan-guard.test.ts` passes; Invariants 3, 4, 5 verified.

### Slice 4: Location Leg Locking & Stray Bottle Escape Hatch
- **Scope:**
  - Implement locked location leg workflow requiring full-screen `LocationPicker` before scanning.
  - Lock active station pill in scan top bar (`loc-pill`).
  - Implement dedicated "Count a stray bottle elsewhere" modal (`stray-bottle-modal.tsx`) that records an item into an alternate location and immediately returns to the active leg without mutating session context.
  - Enforce write-path active location check rejecting retired stations with `LOCATION_RETIRED` (Invariant 6).
- **Target Files:** `components/count/count-leg.tsx`, `components/count/stray-bottle-modal.tsx`, `components/count/location-picker.tsx`.
- **Verification Gate:** Verify stray bottle scan writes to target location while keeping header locked to original leg.

### Slice 5: Desktop Back-Office Shell (`OfficeRail` & `OfficeBreadcrumb`)
- **Scope:**
  - Implement collapsible `OfficeRail` transitioning between 64px (`w-16`) and 208px (`w-52`) with top-anchored chevron toggle.
  - Wire functional cookie `truestock_rail=1/0` with server-side layout read to guarantee flicker-free first-frame SSR rendering.
  - Implement `OfficeBreadcrumb` displaying `Truestock / <Section>`, with full support for `/office/invoices`.
  - Implement Executive KPI Dashboard (`/office/page.tsx`).
- **Target Files:** `components/office/office-rail.tsx`, `components/office/office-breadcrumb.tsx`, `app/(office)/layout.tsx`, `app/(office)/office/page.tsx`.
- **Verification Gate:** Verify cookie persistence across page refreshes; verify topbar breadcrumb on all 9 office routes.

### Slice 6: Role-Gated TanStack Table & Office Management
- **Scope:**
  - Implement TanStack Table v8 in `CatalogTable` (`components/office/catalog-table.tsx`) with call-time column building that strictly omits unit costs and margins from the rendered HTML DOM for staff/managers (Invariant 8).
  - Implement inline cost editing for owners and case size editing for managers.
  - Refactor `LocationsTable` (`locations-table.tsx`), `VendorsList` (`vendors-list.tsx`), and `UsersList` (`users-list.tsx`) onto shared table primitives.
  - Enforce Invariant 6 (write-path location active checks) and Invariant 11 (atomic user session revocation on deactivation).
- **Target Files:** `components/office/catalog-table.tsx`, `components/office/locations-table.tsx`, `components/office/vendors-list.tsx`, `components/office/users-list.tsx`.
- **Verification Gate:** `bun test tests/role-gated-predicates.test.ts tests/user-management.test.ts tests/catalog.test.ts` passes; DOM cost exclusion verified.

### Slice 7: Split-Screen Invoice OCR Review & Regulatory Audit Packet Export
- **Scope:**
  - Implement split-screen Invoice OCR Review (`InvoiceReviewForm` in `invoice-review-form.tsx`) with header correction inputs, 7-column line items table, and math discrepancy badges.
  - Implement CAS status transitions (`needs_review` -> `reviewed` -> `approved`), atomically posting costs upon approval.
  - Implement date-range regulatory Audit Packet Export (`AuditPacket` in `audit-packet.tsx`) with 3000ms polling and presigned ZIP download link.
- **Target Files:** `components/office/invoice-review-form.tsx`, `components/office/audit-packet.tsx`, `app/(office)/office/invoices/[invoiceId]/page.tsx`, `app/(office)/office/invoices/audit-packet/page.tsx`.
- **Verification Gate:** `bun test tests/invoice-line-alerts.test.ts tests/calendar-date-format.test.ts` passes.

---

## 3. Automated Test Targets & Quality Gates

### 3.1 Host Unit Test Suite (`bun test`)
```bash
bun test tests/bottle-sizes.test.ts \
         tests/calendar-date-format.test.ts \
         tests/cost-input-format.test.ts \
         tests/count-queue-id.test.ts \
         tests/dev-origins.test.ts \
         tests/invoice-line-alerts.test.ts \
         tests/null-value.test.ts \
         tests/reorder-format.test.ts \
         tests/rescan-guard.test.ts \
         tests/role-gated-predicates.test.ts \
         tests/seed-csv-parser.test.ts \
         tests/stock-cell.test.ts \
         tests/subcategories.test.ts
```

### 3.2 Database Integration Test Suite (MariaDB 11.8 in Docker)
```bash
bun run test:docker --timeout 30000
```
Covers all 31 database test suites including `count-write-path`, `location-write-path`, `user-write-path`, `catalog-write-path`, `vendor-write-path`, `invoice-approval-path`, `audit-packet`.

### 3.3 TypeScript & Build Gates
```bash
# Typecheck
bun run typecheck

# Production Build
bun run build
```

---

## 4. Invariant Audit Checkpoints

| Invariant | Audit Method | Expected Outcome |
|---|---|---|
| **Inv 1: Immutability** | Attempt write or scan on `closed` count session | Write rejected with `ClosedCountError`; route redirects to session summary. |
| **Inv 2: Snapshot Cost** | Alter catalog unit cost after closing count | Historical count valuation remains fixed to snapshot value. |
| **Inv 3: Upsert Line** | Scan identical barcode twice in same location | Existing row increments and flashes green (`flash-dup`); zero duplicate rows inserted. |
| **Inv 4: Separate Cases/Eaches** | Input 2 cases and 5 eaches | Stored separately in `sealed_case_qty` and `sealed_each_qty`. |
| **Inv 5: Ledger Idempotency** | Replay submission with same `client_line_id` | Duplicate ledger insert rolls back cleanly; returns committed line. |
| **Inv 6: Write-Path Active Check** | Attempt count write into retired location | Blocked on write path with `DomainError("LOCATION_RETIRED")`. |
| **Inv 7: Authz & POST Forms** | Inspect forms & server actions | All forms use `method="post"`; actions execute `requireRole()` on line 1. |
| **Inv 8: Role-Gating** | Inspect DOM of Staff/Manager session on catalog/counts | Unit cost, extended value, and margin HTML elements completely omitted. |
| **Inv 9: Tenant Isolation** | Cross-tenant record lookup query | Returns `NotFound` without revealing record existence. |
| **Inv 10: Draft Waste Factor** | Check keg depletion formulas | Depletion grossed up by `pour / (1 - waste_factor)`. |
| **Inv 11: Session Revocation** | Deactivate user account | `user.active = false` and `DELETE FROM session` committed in single transaction. |
| **CSP Nonce Compliance** | Inspect browser console on `/count` and `/office` | Zero CSP inline script violations; App Router scripts hydrate cleanly. |

---

## 5. Challenger Stress-Testing Scenarios

1. **Rapid Barcode Burst Test:** Scan 10 barcodes in 5 seconds; verify all writes queue into IndexedDB and process sequentially without dropouts.
2. **Offline-to-Online Transition Test:** Disable network in browser DevTools, record 5 count lines, re-enable network; verify `SyncIndicator` updates from `5 pending` to `Synced` with 0 duplicates.
3. **OfficeRail Rapid Toggle & Refresh Test:** Expand sidebar to 208px, hard refresh (`Cmd+Shift+R`); verify sidebar paints expanded on first frame with zero layout shift or snapping.
4. **Manager DOM Inspection Test:** Sign in as `manager`, open `/office/catalog` and `/count/[countId]`; inspect DOM with querySelector to confirm 0 cost-related elements exist.
