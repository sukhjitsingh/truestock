# Gate 3 — Program Design: Truestock UI/UX Component & Module Specification

**Slug:** `ui-ux-redesign`  
**Author:** Software Factory Planning Specialist  
**Date:** 2026-08-23  
**Status:** APPROVED (Comprehensive 4-Gate Baseline)  
**Authoritative Sources:** `PROJECT.md`, `AGENTS.md`, `docs/spec.md`, `docs/design-system.md`, `prototypes/mobile-app-redesign.html`

---

## 1. Module Decomposition & File Map

```
/Users/moni/Claude_Workspace/truestock/
├── app/
│   ├── globals.css                               # Dual-theme tokens (:root & .dark), glassmorphism, typography
│   ├── (count)/
│   │   ├── layout.tsx                            # Root dark shell + CountTabBar
│   │   ├── count/
│   │   │   ├── page.tsx                          # Active session hub card
│   │   │   ├── preflight/page.tsx                # Hardware diagnostic & permissions check
│   │   │   ├── [countId]/page.tsx                # Session overview, progress meter, status timeline
│   │   │   ├── [countId]/scan/page.tsx           # Counting floor execution shell
│   │   │   ├── catalog/page.tsx                  # Mobile catalog search
│   │   │   └── account/page.tsx                  # Mobile account info & signout
│   ├── (office)/
│   │   ├── layout.tsx                            # Root light shell + OfficeRail + OfficeBreadcrumb
│   │   └── office/
│   │       ├── page.tsx                          # Executive KPI dashboard
│   │       ├── catalog/page.tsx                  # Catalog table with TanStack Table v8
│   │       ├── locations/page.tsx                # Location table & count mode editor
│   │       ├── invoices/page.tsx                 # Invoice archive & upload
│   │       ├── invoices/[invoiceId]/page.tsx     # Split-screen OCR review modal (owner-only)
│   │       ├── invoices/audit-packet/page.tsx    # Regulatory ZIP audit packet generator
│   │       ├── counts/page.tsx                   # Historical counts list
│   │       ├── counts/[countId]/page.tsx         # Count summary valuation & variance report
│   │       ├── reorder/page.tsx                  # Par-level reorder lists by supplier
│   │       ├── vendors/page.tsx                  # Vendor directory & lead times
│   │       └── users/page.tsx                    # User access & session revocation
├── components/
│   ├── count/
│   │   ├── count-leg.tsx                         # Core scanning engine & leg coordinator
│   │   ├── fill-entry.tsx                        # Tenths keypad & liquid gauge editor
│   │   ├── vial-display.tsx                      # Dynamic liquid bottle simulation visualizer
│   │   ├── quantity-entry.tsx                    # Cases & loose eaches steppers + live deltas
│   │   ├── barcode-scanner.tsx                   # BarcodeDetector camera scanner + WASM polyfill
│   │   ├── enroll-form.tsx                       # Fast 20-second scan-to-enroll form
│   │   ├── stray-bottle-modal.tsx                # Stray bottle alternate location escape hatch
│   │   ├── location-picker.tsx                   # Full-screen locked leg location selector
│   │   └── tab-bar.tsx                           # Mobile 4-tab bottom navigation
│   ├── office/
│   │   ├── office-rail.tsx                       # Collapsible 64px to 208px icon rail
│   │   ├── office-breadcrumb.tsx                 # Topbar breadcrumb (Truestock / <Section>)
│   │   ├── catalog-table.tsx                     # TanStack Table catalog with role gating
│   │   ├── locations-table.tsx                   # Locations table with shared table primitives
│   │   ├── vendors-list.tsx                      # Vendors table with shared table primitives
│   │   ├── users-list.tsx                        # Users table with atomic session revocation
│   │   ├── invoice-review-form.tsx               # Split-screen OCR review form with CAS transitions
│   │   ├── audit-packet.tsx                      # Async ZIP audit packet export component
│   │   └── reorder-vendor-block.tsx              # Reorder list vendor card with print scoping
│   └── ui/
│       ├── table.tsx                             # Shared accessible Table primitives & captions
│       ├── button.tsx                            # Button primitive with 56px/44px/36px floors
│       ├── null-value.tsx                        # 4-way absent value classification component
│       ├── money.tsx                             # Role-gated currency formatter
│       └── badge.tsx                             # Status pills (success, warning, negative)
└── lib/
    ├── domain/                                   # Core business logic & invariant enforcement
    │   ├── counts.ts                             # Invariants 1, 2, 3, 4, 5, 6
    │   ├── catalog.ts                            # Invariants 6, 8, 9, 10
    │   ├── users.ts                              # Invariant 11
    │   └── invoices.ts                           # Phase 2.5 OCR extraction & audit archive
    ├── ui-cookies.ts                             # Functional cookie constants (truestock_rail)
    └── count-queue.ts                            # IndexedDB offline write queue engine
```

---

## 2. Detailed Screen-by-Screen UX Mechanics

### 2.1 Liquid Bottle Vial Simulation & Tenths Keypad (`components/count/fill-entry.tsx`, `vial-display.tsx`)
- **Fluid Visualizer:** Dynamic SVG/CSS bottle container rendered with `--glass-bg` and a continuous fluid column (`background: linear-gradient(180deg, var(--accent), #3b82f6)`). Transition smoothing: `transition: height 0.12s ease`.
- **Continuous Touch Drag Mechanics:** Counter can drag on the vertical gauge. The listener calculates:
  ```ts
  const rel = 1 - (clientY - rect.top) / rect.height;
  const clampedTenth = Math.max(0.0, Math.min(1.0, Math.round(rel * 10) / 10));
  ```
- **Discrete Tenths Keypad:** Ten 56px hit buttons (`.1` through `1.0`), plus rapid preset buttons (Full = `1.0`, Half = `0.5`, Empty = `0.0`).
- **Keg Volume Derivation:** When `unitType === 'keg'` and `sizeMl` is defined (e.g. 58,674 mL for a half-barrel), the display shows both fractional units and derived volume in mL (e.g. `0.7 units ≈ 41,072 mL`).
- **Multi-Bottle Partial Fills Chip List:** Displays existing open bottles in the current count line as chips (e.g. `[1] 30%`, `[2] 80%`). Counters can tap a chip to adjust its level or tap `remove-x` to splice it out, recalculating `totalUnits` immediately.

### 2.2 Cases & Loose Eaches Steppers with Live Deltas (`components/count/quantity-entry.tsx`)
- **Separate Storage Invariant (Invariant 4):** Independent 56px stepper controls (`+` / `-`) for **Cases** and **Loose Eaches**. Numeric inputs support direct keyboard entry (`inputMode="numeric"`).
- **Segmented Mode Toggle:** Explicit selection between `ADD (+)` and `SET (=)`.
- **Live Consequence Deltas:** Submit button text updates in real time to reflect the consequence of the action:
  - In `ADD` mode: `ADD 3 EA / 12 → 15`
  - In `SET` mode: `SET TO 3 EA / was 12 ea · −9`
  - Prevents blind overrides and eliminates the need for annoying confirmation modals.

### 2.3 Locked Location Leg Workflow & Stray Escape Hatch (`components/count/count-leg.tsx`, `stray-bottle-modal.tsx`)
- **Station Locking:** Upon entering the count screen, the counter is presented with a full-screen `LocationPicker`. Selecting a station (e.g. "Speed Rail") locks the station pill in the top header (`loc-pill`).
- **Finish Section Action:** Explicit bottom bar button to complete the current station and select the next leg.
- **Stray Bottle Escape Hatch:** A dedicated button (`Count a stray bottle elsewhere`) opens a modal allowing the counter to scan an out-of-place bottle into an alternate station (e.g. "Storeroom"). Submitting writes the line to the target location and immediately returns the counter to the active leg without mutating the locked session station.

### 2.4 Rescan Line Increment & Screen Reader Alert (Invariant 3)
- When a barcode is scanned that already exists in the active `(count_id, product_id, location_id)`, the existing row pulses with a green/accent glow (`flash-dup` animation).
- An off-screen live region (`aria-live="polite"`) announces: `"Updated {Product Name} in {Location}: now {Quantity} units"`.

### 2.5 Collapsible OfficeRail & Topbar Breadcrumb (`components/office/office-rail.tsx`, `office-breadcrumb.tsx`)
- **Widths:** 64px (`w-16`) collapsed; 208px (`w-52`) expanded.
- **Top-Anchored Toggle:** Chevron toggle button pinned at top of rail (prevents collisions with `<nextjs-portal>` dev overlays and browser status bubbles).
- **Server Cookie Persistence:**
  ```ts
  document.cookie = `truestock_rail=${expanded ? 1 : 0}; path=/; max-age=31536000; SameSite=Lax`;
  ```
  `app/(office)/layout.tsx` reads `cookies().get("truestock_rail")` during SSR to render the rail at correct width on the first frame.
- **OfficeBreadcrumb:** `<nav aria-label="Breadcrumb">` displaying `Truestock / <Section>`, explicitly supporting `/office/invoices` alongside Counts, Catalog, Locations, Vendors, Reorder, and Users.

### 2.6 Role-Gated TanStack Table Columns (Invariant 8)
- Dynamic column construction at call time:
  ```ts
  export function buildCatalogColumns(canSeeCost: boolean, canManage: boolean): ColumnDef<ProductSummary>[] {
    const cols: ColumnDef<ProductSummary>[] = [
      productNameColumn,
      categoryColumn,
      onHandUnitsColumn,
    ];
    if (canSeeCost) {
      cols.push(unitCostColumn);
      cols.push(totalValueColumn);
    }
    if (canManage) {
      cols.push(caseSizeColumn);
      cols.push(editActionColumn);
    }
    return cols;
  }
  ```
- Guaranteed zero DOM presence of cost figures for non-owners.

### 2.7 Standardized Table Primitives & 4-Way Null Value Vocabulary
- Refactor `locations-table.tsx`, `vendors-list.tsx`, and `users-list.tsx` to adopt `TableContainer`, `Table`, `TableCaption`, `SortableTableHead`, `TableRow`, `TableCell`.
- **Four-Way Null Value Classification (`<NullValue>`):**
  1. `type="not-applicable"` -> Renders `—` (em dash) (e.g. `case_size` on liquor).
  2. `type="not-entered"` -> Renders `Not entered` in muted text (e.g. unpriced item).
  3. `type="role-gated"` -> Renders `null` (nothing rendered in DOM).
  4. `type="empty-state"` -> Renders descriptive sentence in empty table body.

### 2.8 Split-Screen Invoice OCR Review & Audit Packet Export (`components/office/invoice-review-form.tsx`, `audit-packet.tsx`)
- **Split-Screen OCR Review:**
  - Left/Top pane: Header details (Date, Invoice #, Vendor, Total Gross, Total Net). Editable in `needs_review` status.
  - Right/Bottom pane: 7-column line items table with matched product selectors and discount adjustments.
  - Math validation badges: Highlights discrepancies between line totals and invoice net (`Math discrepancy`).
  - CAS Status Transitions: `needs_review` -> `reviewed` -> `approved` (atomically posts costs to catalog).
- **Regulatory Audit Packet Export:**
  - Date-range validation (`dateFrom <= dateTo <= today`).
  - Dispatches `createAuditPacketAction` and initiates TanStack Query polling loop (every 3000ms).
  - Renders 10-minute expiring presigned ZIP download link upon `status === 'ready'`.

### 2.9 User Management & Session Revocation (Invariant 11)
- User table with role selector (Owner, Manager, Staff).
- Active toggle: Deactivating a user executes a single transaction updating `user.active = false` and deleting all active `session` rows.

---

## 3. Component Types & Signatures

```ts
// components/count/fill-entry.tsx
export interface FillEntryProps {
  productId: number;
  productName: string;
  sizeMl: number | null;
  unitType: 'bottle' | 'keg' | 'can' | 'pack';
  existingFills: number[];
  onSaveFills: (fills: number[]) => Promise<void>;
  onCancel: () => void;
}

// components/count/quantity-entry.tsx
export interface QuantityEntryProps {
  productId: number;
  productName: string;
  caseSize: number | null;
  existingCaseQty: number;
  existingEachQty: number;
  onCommitQuantity: (delta: {
    caseQty: number;
    eachQty: number;
    mode: 'add' | 'set';
  }) => Promise<void>;
  onCancel: () => void;
}

// components/count/stray-bottle-modal.tsx
export interface StrayBottleModalProps {
  isOpen: boolean;
  activeLocationId: number;
  locations: { id: number; name: string }[];
  onClose: () => void;
  onRecordStray: (targetLocationId: number, product: ProductSummary) => void;
}

// components/office/office-rail.tsx
export interface OfficeRailProps {
  defaultExpanded: boolean;
  userRole: 'owner' | 'manager' | 'staff';
}

// components/ui/null-value.tsx
export interface NullValueProps {
  type: 'not-applicable' | 'not-entered' | 'role-gated';
  className?: string;
}

// components/ui/money.tsx
export interface MoneyProps {
  cents?: number;
  currency?: string;
  className?: string;
}
```

---

## 4. Error Recovery & Edge Cases

| Failure Scenario | Observed Risk | Recovery / Mitigation |
|---|---|---|
| **Network Drop During Floor Count** | Write request fails mid-count | IndexedDB queue saves write locally with UUID `client_line_id`. `SyncIndicator` updates to `N pending`. Background worker automatically replays writes upon reconnection. |
| **Concurrent Scan Race Condition** | Two counters scan the same bottle simultaneously | Unique constraint on `(count_id, product_id, location_id)` triggers `ER_DUP_ENTRY`. Domain handler catches error and executes line increment update on the winning row. |
| **Counting in Retired Location** | Location deactivated while counter is mid-session | Server action verifies `location.active === true` before lookup/insert (Invariant 6). Rejects write with `DomainError("LOCATION_RETIRED")` and prompts counter to select an active location. |
| **Unpriced Catalog Item in Count** | Count valuation fails or coerces to $0.00 | Cost snapshot captures `NULL`. Valuation engine excludes line from total and increments `excludedLineCount`. UI renders an unpriced exclusion banner without distorting financial valuation. |
| **Delayed JavaScript Hydration** | User clicks submit before React hydration attaches | Form specifies `method="post"`, degrading safely to HTTP POST (405) instead of leaking query parameters via GET. |
| **Camera Permission Denied** | Counter cannot activate barcode scanner | Interface displays clear camera error state with a fallback to the permanently paired type-ahead search picker. |

---

## 5. Accessibility Specifications (WCAG AA / AAA)

1. **Color Contrast:**
   - Body copy achieves 17.6:1 in Light Theme (`#111111` on `#F7F7F5`) and 18.0:1 in Dark Theme (`#F5F5F4` on `#0B0B0C`).
   - Muted secondary text achieves 5.33:1 in Light Theme (`#6B6B6B` on `#FFFFFF`) and 7.45:1 in Dark Theme (`#A8A8A5` on `#17181A`).
   - Functional borders achieve > 3.3:1 against white and card backgrounds.
2. **Focus Visibility:**
   - Global `:focus-visible` ring (`2px solid var(--ring)`, 2px offset). Zero bare `outline: none` permitted anywhere.
3. **Table Accessibility:**
   - All data tables carry `<caption className="sr-only">` announcing table purpose and active row count.
   - All header cells declare `scope="col"` and sortable headers maintain live `aria-sort="ascending"|"descending"|"none"`.
4. **Live Regions:**
   - Re-scan increments and background sync state changes utilize `aria-live="polite"` to alert screen reader users without interrupting speech.
5. **Target Sizing:**
   - Mobile counting elements enforce 56px floor (`--tap-primary`).
   - Navigation and identity controls enforce 44px floor (`--tap-min`).
   - Dense desktop table controls enforce 36px minimum floor (`h-9`).
