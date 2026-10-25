# Gate 2 — Architecture: Truestock Dual-Surface System Architecture

**Slug:** `ui-ux-redesign`  
**Author:** Software Factory Planning Specialist  
**Date:** 2026-08-23  
**Status:** APPROVED (Comprehensive 4-Gate Baseline)  
**Authoritative Sources:** `PROJECT.md`, `AGENTS.md`, `docs/spec.md`, `docs/design-system.md`, `middleware.ts`, `app/globals.css`

---

## 1. Architectural Fit & Stack Alignment

The Truestock application architecture operates on a modern, high-reliability stack deployed on Hostinger Cloud Startup running Node.js and MariaDB 11.8:

```
+-----------------------------------------------------------------------------------+
|                                  Client Surfaces                                  |
|  +-------------------------------------+  +------------------------------------+  |
|  |  Mobile Floor App (app/(count))     |  |  Desktop Back-Office (app/(office))|  |
|  |  - Hardcoded .dark theme (OLED)     |  |  - Daylight :root theme (Slate)    |  |
|  |  - 56px primary touch targets       |  |  - Collapsible OfficeRail (64-208px)|  |
|  |  - Offline IndexedDB write queue    |  |  - 57px TanStack Table v8 grids   |  |
|  |  - BarcodeDetector + WASM Polyfill  |  |  - Split-screen OCR review modal   |  |
|  +-------------------------------------+  +------------------------------------+  |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                        Security, Middleware & Edge Gateway                        |
|  - middleware.ts: Generates per-request UUID nonce (x-nonce)                      |
|  - Content-Security-Policy: script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'  |
|  - Cookie Engine: truestock_rail (1/0) for zero-FOUC server layout rendering      |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                     Next.js 16 App Router & Server Actions Layer                   |
|  - React Server Components (RSC) & Streaming SSR with per-request nonce           |
|  - Server Actions with Line 1 Authorization: requireRole() & requireSession()     |
|  - Invariant 8 Role Gating: Cost scrubbing at SQL & DTO generation boundaries      |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                     Domain Engine & Business Logic Layer (lib/)                   |
|  - lib/domain/counts.ts: Invariant 1 (Immutability), Inv 3 (Upsert), Inv 4 (Cases) |
|  - lib/domain/catalog.ts: Invariant 6 (Soft Delete), Inv 10 (Draft Waste Factor)  |
|  - lib/domain/users.ts: Invariant 11 (Atomic Session Revocation on Deactivation)  |
|  - lib/domain/invoices.ts: Phase 2.5 OCR extraction CAS workflow & Audit Packet   |
+-----------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                   Data Access & MariaDB 11.8 Database Layer (db/)                  |
|  - Drizzle ORM + mysql2 driver connected to MariaDB 11.8.8-MariaDB-log             |
|  - Connection Pool: 5-10 connections                                              |
|  - Tenant Isolation: Composite Foreign Keys (organization_id, id) (Invariant 9)   |
|  - Write Ledger: Append-only count_line_write with UUID client_line_id (Inv 5)    |
+-----------------------------------------------------------------------------------+
```

---

## 2. Dual-Surface Theming Strategy

Truestock enforces a strict dual-surface theming strategy implemented entirely through pure CSS custom properties and Tailwind CSS v4 `@theme inline` mappings in `app/globals.css`:

### 2.1 Surface Theme Mapping
1. **Mobile Floor App (`app/(count)/layout.tsx`):**
   - Hardcoded `className="dark flex min-h-dvh flex-col bg-background text-foreground touch-manipulation"`.
   - Never conditional on `prefers-color-scheme`, device settings, or cookies.
   - Dark OLED background (`--background: #0B0B0C`) eliminates battery drain and prevents glare in dim bar environments.
   - Detail header background (`--header: #121317`) uses a deep cool surface rather than white to prevent blinding flashes when held close to the face.
   - Primary button fill (`--primary: #F5F5F4` with `--primary-foreground: #0A0A0A`) inverts to bright near-white, guaranteeing that the primary action has the highest optical contrast against the dark background.
2. **Desktop Back-Office Web App (`app/(office)/layout.tsx`):**
   - Defaults to `:root` Light daylight slate theme (`--background: #F7F7F5`, `--card: #FFFFFF`, `--foreground: #111111`).
   - Detail header (`--header: #0A0A0A`) utilizes crisp inverted contrast suitable for sunlit office environments.
   - Primary button (`--primary: #0A0A0A`) renders deep near-black with bright white text.

### 2.2 Frosted Glassmorphism Tokens
To provide visual depth without heavyweight drop shadows, frosted glass tokens are defined in `app/globals.css`:
- **Light Theme:**
  - `--glass-bg: rgba(255, 255, 255, 0.85)`
  - `--glass-border: rgba(226, 232, 240, 0.8)`
  - `--glass-header: rgba(255, 255, 255, 0.92)`
  - `--glass-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.05), 0 2px 6px -1px rgba(0, 0, 0, 0.03)`
- **Dark Theme:**
  - `--glass-bg: rgba(19, 20, 25, 0.72)`
  - `--glass-border: rgba(255, 255, 255, 0.08)`
  - `--glass-header: rgba(14, 15, 19, 0.85)`
  - `--glass-shadow: 0 12px 36px 0 rgba(0, 0, 0, 0.6)`
- **Filter Standard:** `backdrop-filter: blur(16px) saturate(180%)`.

### 2.3 Semantic Brand vs Status Color Invariant
- **Brand Blue (`--accent` / `--color-accent`):** `#2563EB` (Light) / `#60A5FA` (Dark). Reserved strictly for navigation tabs, active borders, focus rings (`--ring`), and the barcode scanner trigger. Brand blue is NEVER used to mean "in stock" or "good".
- **Status Green (`--success` / `--color-success`):** `#1F7A3D` (Light) / `#6FCF8E` (Dark). Reserved strictly for "in stock", completed count steps, and synced states.
- **Status Amber (`--warning` / `--color-warning`):** `#92600A` (Light) / `#F0B429` (Dark). Reserved strictly for "low stock", in-progress sessions, and pending write counts.
- **Status Red (`--negative` / `--color-negative`):** `#B8305A` (Light) / `#F0718A` (Dark). Reserved strictly for "out of stock / 86'd" and blocked steps.
- **Destructive Action Red (`--destructive`):** `#C4304F` (Light) / `#D33039` (Dark). Reserved strictly for destructive actions (Delete, Deactivate, Remove).

---

## 3. Component Topology & Route Architecture

```
app/
├── (count)/                                 # Mobile floor counting surface (hardcoded .dark)
│   ├── layout.tsx                           # Dark root layout + bottom CountTabBar
│   ├── count/
│   │   ├── page.tsx                         # Active count session card & resume flow
│   │   ├── preflight/
│   │   │   └── page.tsx                     # Hardware & camera scanner diagnostic
│   │   ├── [countId]/
│   │   │   ├── page.tsx                     # Session overview, timeline, immutable audit banner
│   │   │   └── scan/
│   │   │       └── page.tsx                 # Counting floor execution shell (hosts CountLeg)
│   │   ├── catalog/
│   │   │   └── page.tsx                     # Mobile catalog search lookup
│   │   └── account/
│   │       └── page.tsx                     # Mobile user profile & sign out
├── (office)/                                # Desktop back-office workspace (:root light)
│   ├── layout.tsx                           # Desktop shell + OfficeRail + OfficeBreadcrumb
│   └── office/
│       ├── page.tsx                         # Executive KPI dashboard
│       ├── catalog/
│       │   └── page.tsx                     # Catalog TanStack Table with inline editing
│       ├── locations/
│       │   └── page.tsx                     # Location management & count mode configuration
│       ├── invoices/
│       │   ├── page.tsx                     # Role-gated invoice archive & upload form
│       │   ├── [invoiceId]/
│       │   │   └── page.tsx                 # Split-screen OCR review modal (owner-only)
│       │   └── audit-packet/
│       │       └── page.tsx                 # Date-range regulatory ZIP export
│       ├── counts/
│       │   ├── page.tsx                     # Historical counts table with role-gated valuation
│       │   └── [countId]/
│       │       └── page.tsx                 # Count summary valuation & variance report
│       ├── reorder/
│       │   └── page.tsx                     # Par-level reorder lists with print scoping
│       ├── vendors/
│       │   └── page.tsx                     # Vendor directory & lead time management
│       └── users/
│           └── page.tsx                     # User access & atomic session revocation
```

### 3.1 Shell Layout Components
1. **`CountTabBar` (`components/count/tab-bar.tsx`):** Fixed 4-column bottom navigation on mobile (`Count`, `Catalog`, `Reports` [disabled], `Account`) enforcing 44px minimum touch targets (`min-h-tap-min`). Active tab renders filled icon with `text-foreground`; inactive renders line icon with `text-muted-foreground`.
2. **`OfficeRail` (`components/office/office-rail.tsx`):**
   - Width transition: 64px (`w-16`) collapsed to 208px (`w-52`) expanded.
   - Top-anchored toggle button with `ChevronIcon` rotating 180°.
   - Server-read cookie persistence: reads `truestock_rail=1/0` in `app/(office)/layout.tsx` to pass `defaultExpanded` directly to initial HTML render.
   - All navigation items reserve `border border-transparent` (44px target) to prevent 1px icon shifts when active border is applied.
3. **`OfficeBreadcrumb` (`components/office/office-breadcrumb.tsx`):** Top navigation displaying `<nav aria-label="Breadcrumb">` -> `Truestock / <Section>`, covering Counts, Catalog, Locations, Vendors, Invoices, Reorder, Users, and Dashboard.

---

## 4. State Management Architecture

### 4.1 Server Data Fetching & Mutations
- **React Server Components (RSC):** Fetch primary domain records directly from `lib/domain/*.ts` during SSR, applying organization tenant isolation (`Actor.organizationId`) and role-based data exclusion.
- **Server Actions (`app/actions/*.ts`):** Execute all mutations under transactional boundaries. Every action authenticates on line 1 via `requireRole()` and validates inputs via Zod schemas.

### 4.2 Client State & Data Tables
- **TanStack Table v8 (`@tanstack/react-table`):** Powers back-office grids (`CatalogTable`, `LocationsTable`, `VendorsList`, `UsersList`, `CountsTable`, `InvoicesTable`).
  - Table state (sorting, pagination, filtering) is maintained locally in React component state.
  - Column arrays are constructed dynamically at call time (`buildColumns(role)`), guaranteeing zero DOM leakage of role-gated cost properties.
- **TanStack Query (`@tanstack/react-query`):** Manages asynchronous background polling for long-running jobs (e.g. Audit Packet ZIP generation in `components/office/audit-packet.tsx`).

### 4.3 Mobile Floor Offline Write Queue (`lib/count-queue.ts`)
- Utilizes `idb` (IndexedDB) to persist count writes locally on the device.
- Write payload structure:
  ```ts
  interface QueuedCountWrite {
    clientLineId: string; // UUID v4 (Invariant 5)
    countId: number;
    productId: number;
    locationId: number;
    sealedCaseQty: number;
    sealedEachQty: number;
    partialFills: number[];
    mode: 'add' | 'set';
    timestamp: number;
  }
  ```
- **Sync Engine:** Automatically flushes queued writes sequentially when online. If a network drop occurs, pending writes remain safely stored in IndexedDB.
- **Visual Sync Status:** `SyncIndicator` in `components/count/count-leg.tsx` displays live state (`Synced` with green check vs `N pending` with amber warning) with `aria-live="polite"`.

---

## 5. Security & CSP Nonce Architecture

### 5.1 Per-Request Nonce & CSP Generation (`middleware.ts`)
Next.js App Router injects inline scripts for request identifiers (`self.__next_r`) and streaming RSC payloads (`self.__next_f.push`). To permit these scripts without opening the application to XSS or disabling CSP:

1. `middleware.ts` generates a cryptographically secure random UUID nonce on every request:
   ```ts
   const nonce = crypto.randomUUID();
   ```
2. Constructs the strict CSP header:
   ```ts
   const cspHeader = [
     `default-src 'self'`,
     `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
     `style-src 'self' 'unsafe-inline'`,
     `img-src 'self' data: blob:`,
     `font-src 'self'`,
     `connect-src 'self'`,
     `frame-ancestors 'none'`,
     `base-uri 'self'`,
     `form-action 'self'`,
   ].join('; ');
   ```
3. Stamps `x-nonce` on the request headers and `Content-Security-Policy` on the response headers.
4. Root layouts (`app/layout.tsx`) read the `x-nonce` header and apply it to Next.js `<Script>` and hydration root tags.
5. **Invariant Rule:** CSP is NEVER declared in `next.config.ts`'s static `headers()`.

### 5.2 Form Submission Security (Invariant 7)
All client-side form components (`EnrollForm`, `LocationEditForm`, `VendorEditForm`, `InvoiceUploadForm`, `LoginForm`) enforce explicit `method="post"`. This guarantees that if JavaScript hydration is delayed or fails, the browser defaults to an HTTP POST (yielding a 405) rather than falling back to an HTTP GET that would serialize form values (passwords, tokens) into the URL query string.

---

## 6. Data Contracts & Role-Gated DTOs

### 6.1 Role-Gated Domain DTOs (Invariant 8)
Domain functions in `lib/domain/counts.ts` and `lib/domain/catalog.ts` strip cost fields before returning DTOs to non-owners:

```ts
export interface CountLineRow {
  id: number;
  productId: number;
  productName: string;
  productSku: string;
  locationId: number;
  locationName: string;
  sealedCaseQty: number;
  sealedEachQty: number;
  partialFills: number[];
  unitType: 'bottle' | 'keg' | 'can' | 'pack';
  sizeMl: number | null;
  caseSizeAtCount: number | null;
  // Cost fields are OPTIONAL and strictly undefined for staff/manager
  unitCostAtCount?: number;
  extendedValue?: number;
}

export interface ProductSummary {
  id: number;
  name: string;
  sku: string;
  category: string;
  subcategory: string | null;
  sizeMl: number | null;
  caseSize: number | null;
  onHandUnits: number;
  parLevel: number | null;
  vendorName: string | null;
  active: boolean;
  // Strictly undefined for non-owners
  currentUnitCost?: number;
}
```

### 6.2 Keypad & Stepper Event Contracts

#### `FillEntryProps` (`components/count/fill-entry.tsx`)
```ts
export interface FillEntryProps {
  productId: number;
  productName: string;
  sizeMl: number | null;
  unitType: 'bottle' | 'keg' | 'can' | 'pack';
  existingFills: number[];
  onSaveFills: (fills: number[]) => Promise<void>;
  onCancel: () => void;
}
```

#### `QuantityEntryProps` (`components/count/quantity-entry.tsx`)
```ts
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
```

---

## 7. Architectural Decisions Record (ADR) Summary

| Decision | Chosen Solution | Rationale | Alternatives Rejected |
|---|---|---|---|
| **Theme Switching** | Hardcoded `.dark` on mobile `(count)`; `:root` light on desktop `(office)` | Matches physical user environments (dim bar vs sunlit office) with zero component branching. | OS `prefers-color-scheme` (causes glare in dark bars if phone is in light mode). |
| **Sidebar Collapse** | `truestock_rail` cookie read in server layout | Eliminates layout shift (FOUC) on SSR page loads. | `localStorage` (causes visible 64px to 208px snapping after client hydration). |
| **Role Gating** | Call-time TanStack column omission & server DTO scrubbing | Guarantees cost numbers never exist in client memory or DOM. | `columnVisibility` API (leaves cost values in client memory/DOM). |
| **Idempotency** | Append-only `count_line_write` ledger with UUID `client_line_id` | Guarantees retried network writes roll back safely without duplicate rows. | Client timestamp deduping (vulnerable to clock drift). |
| **Row Edit Affordance** | Explicit `<button>` with subject name (`Edit Speed Rail`) | Guarantees keyboard accessibility and prevents target reflow misclicks. | Clickable `<tr>` row (inaccessible, screen reader disorientation). |
