# Handlebar — Product Spec (Planning Draft v0.1)

*Beverage inventory for a single bar. Get a handle on your bar.*

**Status:** Planning. Name and MVP scope locked (§12). No code yet.
**Repo:** `handlebar` · **Host:** `handlebar.<yourdomain>` · **Database:** `handlebar`
**Owner:** Sukhjit
**Context:** Single bar/restaurant, Arizona. 50–200 bottles per full count. Web app, Chrome on Android. Toast POS. Hostinger Cloud Startup.
**Date:** July 2026

---

## 1. Executive summary

Handlebar is a web app where a manager walks the bar with a phone, scans each bottle's barcode, and records how much is left — producing a valued inventory count, par-level reorder lists, and an audit-ready record.

### Business

**The problem:** liquor is expensive, easy to lose, and painful to count. There is currently no measured variance — no way to separate over-pouring and shrinkage from normal usage.

| | |
|---|---|
| Users | Owner/manager, bar manager, staff — three roles |
| Scale | 50–200 bottles, one location, weekly counts |
| Target | Count time from ~2 hours to under 20 minutes |
| Payoff | Measured variance, par-level reordering, an audit-ready archive |
| Cost | $0/month infrastructure vs $150+ for commercial tools |

**Why build rather than buy:** no subscription, exact fit to the workflow, and the Arizona DLLC compliance packet (§10) — two-year invoice retention plus monthly beginning/ending figures — which no off-the-shelf product produces.

**Open business decisions:** whether to keep xtraCHEF Essentials (one hour of invoice testing decides it, §13), and whether variance is worth the recipe-mapping work in Phase 2.

**The real risk isn't technical.** It's catalog decay and adoption. If the app isn't faster than a clipboard on day one, it dies.

### Technical / product

**Shape:** a plain responsive web app in Chrome on Android, over WiFi. HTTPS, no native wrapper, no app store.

**The core loop:** scan barcode → product resolves → tap tenths (open bottles) or enter a quantity (sealed) → next.

Two count buckets, because they need different handling: sealed backstock is 60–75% of units and only needs a number; open bottles are the ones needing a fill level.

**The catalog builds itself** through scan-to-enroll — an unknown barcode opens a fast new-product form. The first count is slow; every count after is quick.

**Counts are immutable once closed.** Corrections are appended adjustments, never edits. That's what makes both variance and audit defence credible.

**Deliberately not in the MVP:** AI fill estimation, photos, invoice OCR, Toast variance, compliance packet. Every part of the MVP is deterministic and testable — nothing depends on a model being right.

### Backend / stack

| Layer | Choice |
|---|---|
| Hosting | Hostinger Cloud Startup — already owned, 1 of 10 web app slots |
| Runtime | Node (managed) |
| Framework | Next.js 16 App Router, TypeScript |
| Database | MySQL, included |
| ORM | Drizzle + drizzle-kit |
| Auth | Better Auth, self-hosted |
| UI | Tailwind + shadcn/ui |
| Barcode | Native `BarcodeDetector` + WASM polyfill |
| Forms / data | React Hook Form + Zod, TanStack Query & Table |
| Later | PapaParse (Toast CSV), `@google/genai` (fill estimation) |

**Config that matters:** `output: 'standalone'`, `images: { unoptimized: true }`, MySQL pool of 5–10.

**Security is yours now** — self-hosting means you patch. Update Next.js promptly, and check session and role inside every server action, not just middleware.

**Running cost: $0.** No external services in the MVP at all.

---

## 2. The core design principle (read this before anything else)

> **Scope note:** AI fill estimation is deferred to Phase 5 (§12). This section and §6–§7 record the reasoning for when that thread is picked back up — and the principle below still governs any AI feature added later.

> **AI proposes. Human confirms. The app never blocks on the AI being right.**

This is not caution for its own sake. It comes out of three hard constraints:

**a) Vision models cannot reliably count.** Accuracy on object counting degrades sharply once there are more than about four or five items in frame. A single wide photo of a back bar with 30 bottles will produce a confident, wrong number. This is a known, documented failure mode — not something better prompting fixes.

**b) Fill level from a casual photo is genuinely hard.** Industrial fill-inspection systems hit ~95% accuracy, but only with a fixed camera, controlled lighting, and a known bottle geometry. A bar has none of those. Amber and opaque bottles hide the liquid entirely. Glass reflections wreck edge detection. Bar lighting is dim and colored.

**c) Every commercial competitor already concedes this.** Partender has the user tap the bottle and drag a line to the fill level. WISK does roughly one photo per bottle and openly requires good lighting. Nobody ships "photo of the shelf → finished count," because it doesn't work yet.

**What this means for your product:** the photo is an *accelerator and an evidence record*, not an oracle. The AI's job is to save keystrokes and produce an audit trail. The human's job is a one-tap confirmation. If you design for full automation, you will build something that is wrong in ways nobody catches until the numbers stop reconciling.

---

## 3. Goals

### Primary
1. Cut a full count from ~2 hours of clipboard work to under 30 minutes.
2. Produce a **variance number** — what the POS says you should have used vs. what you actually used.
3. Produce **par-level reorder lists** automatically.
4. Keep an **audit-ready record** that satisfies Arizona DLLC record requirements without a scramble.

### Explicit non-goals (v1)
- Recipe/pour costing per cocktail
- Employee-level shrinkage attribution
- Multi-location
- Selling this to other bars
- Full offline operation

---

## 4. Users & roles

| Role | Can do |
|---|---|
| **Owner/Manager** | Everything: counts, catalog, invoices, pricing, reports, close the month |
| **Bar Manager** | Counts, receiving, reorder lists. No cost/margin visibility. |
| **Bartender/Staff** | Count only. Cannot see prices or reports. |

Keep this simple but do build it in from day one. Retrofitting permissions is miserable, and cost data is not something you want on every phone behind the bar.

---

## 5. The counting workflow (the heart of the product)

The single biggest speed lever is **not counting everything the same way.** Most of your 50–200 bottles are sealed backstock, and sealed bottles do not need a fill level or a photo — they need a number.

### Bucket A — Sealed backstock (probably 60–75% of your units)
- Storeroom, walk-in, under-bar cases.
- **Enter a quantity. Don't photograph individually.**
- Optional: one photo of the shelf attached to the line as evidence, but the number is typed.
- Target speed: **3–5 seconds per SKU.**

### Bucket B — Open bottles (speed rail, back bar, wine by the glass)
- These are the ones that need fill level. Usually 20–60 bottles.
- Photo → AI proposes product + fill % → one tap to confirm or correct.
- Target speed: **5–8 seconds per bottle.**

### Bucket C — Kegs, cans, boxed wine
- Kegs: keg-level buckets (full / ¾ / ½ / ¼ / empty) or a keg scale.
- Cans/bottles of beer: case + unit count. No photos.

**Math check:** 150 SKUs where 45 are open bottles ≈ (105 × 4s) + (45 × 7s) ≈ **12 minutes.** That is the target. If your design can't get there, redesign it.

### Count session states
`Draft → In Progress → Submitted → Reviewed → Closed`

Once **Closed**, the count is immutable. Corrections happen as a new adjustment record, never by editing history. This matters enormously for both variance credibility and audit defense.

---

## 6. Fill-level granularity — resolve this early

You mentioned full / half / empty. **Don't ship three buckets.** Here's why:

A "half" bucket that spans anywhere from 30% to 70% carries ±20% error on every open bottle. Across 45 open bottles at an average $28 cost, that's roughly **±$250 of noise per count** — which is larger than the shrinkage you're trying to detect. Your variance report becomes meaningless.

**Recommendation: tenths.** The industry standard is dividing a bottle into 10ths, and it's what the commercial tools use. The UI:

- AI proposes a percentage with a confidence score.
- UI snaps to the nearest 10%.
- Big tap targets for the three common cases (Full / Half / Empty) plus a slider for everything else.

So you keep the fast three-tap path for obvious bottles, without throwing away precision on the ambiguous ones.

**Serious alternative worth piloting: a scale.** A $30 digital kitchen scale plus stored empty-bottle tare weights gives you fill accuracy of roughly ±2%, beats any camera, works on opaque bottles, works in bad light, and costs nothing to run. It's slower per bottle (you must lift each one) and needs a tare weight per bottle type. **Test both on 20 real bottles before committing.**

---

## 7. AI pipeline — what each stage should and shouldn't do

> **Deferred to Phase 5.** Not in the MVP. Kept here because the analysis is what justified deferring it.

| Stage | Task | Reliability today | Design stance |
|---|---|---|---|
| **1. Label recognition** | Photo → which product is this? | **Good.** This is mature. | Auto-match against your catalog. Show top match + 2 alternates. |
| **2. Fill estimation** | Photo → what % remains? | **Mediocre.** Depends heavily on bottle, liquid color, light. | Propose + confidence. Always require confirmation. Log proposed vs. confirmed. |
| **3. Invoice OCR** | Photo of delivery invoice → line items | **Good, and high ROI.** | This may be the single most valuable AI feature. Auto-populates receiving *and* files the invoice for your 2-year retention. |
| **4. Multi-bottle counting** | Shelf photo → how many bottles | **Poor.** | **Do not build this in v1.** |

### The confidence-logging loop (do this from day one)
Store `ai_proposed_fill`, `human_confirmed_fill`, and the photo for every single line. After 3–4 counts you will have a real dataset telling you:
- Which bottle types the AI is good at (clear glass, colored spirits) and which it's hopeless on (amber, opaque, black labels)
- Whether the AI is saving time or costing time
- Whether it's worth keeping at all

This is your kill-switch evidence. Without it you'll never know if the AI feature is earning its place.

### Model choice

**Decision: cloud multimodal API, model-agnostic behind a thin interface.**

Put every vision call behind one internal function — `identifyBottle(imageBlob) → {product, fillPercent, confidence}`. Swapping providers should be a one-file change. Models and prices in this category move every few months; don't hardwire one.

| Option | Verdict for this app |
|---|---|
| **Google Gemini (Flash tier)** | **Good default.** Cheap, fast, strong at images, and there's a real free tier with no card for prototyping. |
| **Claude (Haiku tier)** | Also fine. Comparable capability for label reading. |
| **On-device (Gemini Nano, etc.)** | **Not viable for a web app in 2026.** See below. |

**Cost is a rounding error either way.** A 1000×1000 image is roughly $1.30 per thousand images on a cheap fast model. At 200 bottles counted weekly ≈ 800 images/month, you're looking at **$1–3/month** including output tokens. Downscale to ~1000px before upload — bigger images cost more and don't read labels any better.

**One privacy caveat on Gemini:** Google's free tier allows your prompts and responses to be used to improve their products, with possible human review. The paid tier does not. Since this app will carry invoices, vendor costs, and margin data, **prototype on free, run production on paid.** The paid tier is still only a few dollars a month here.

### Why not on-device

On-device is appealing — free, private, works without signal — but it doesn't fit a cross-device web app right now:

- **Chrome's Prompt API (Gemini Nano) is desktop-only.** Google's own docs state Nano is not available on mobile devices, and the Chrome team's answer on Android support has been essentially "stay tuned in 2026." A count happens on a phone, walking the bar. That's exactly the device it doesn't run on.
- **Chrome-only, no Safari.** Any iPhone or iPad behind the bar gets nothing. Apple has signaled no shipping date. That breaks the "any device" requirement outright.
- **Native Android is the only real on-device path.** ML Kit's GenAI Prompt API does accept combined image + text on-device with Gemini Nano — but that's a native Android app. Choosing it means abandoning the web app and building (and maintaining) a separate iOS story.
- **Quality is the wrong trade here anyway.** Nano is a 2–4B parameter quantized model. Reading a dim, angled, partly-obscured label and matching it against a 150-SKU catalog is precisely the task where a small model degrades most. You'd be saving $2/month by making the least reliable part of the app less reliable.

**Revisit if** you later go native Android-only, or if Chrome ships Nano on Android and you have a real reason to want offline inference. Neither is true today, and bottle photos aren't sensitive data, so the privacy argument for local is weak here.

---

## 8. Data model

MVP tables. Deferred tables (Invoice, InvoiceLine, Depletion) are sketched at the end so today's schema doesn't block them.

```
User            id, name, email, email_verified, image, role, active
                role: owner | manager | staff
                owned by Better Auth — session, account, and verification
                are its tables too; credential password hashes live on
                account.password, not on User

Vendor          id, name, contact, order_method, lead_time_days

Product         id, name, brand, category, unit_type,
                size_ml, case_size, vendor_id,
                current_unit_cost, empty_weight_g, full_weight_g,
                waste_factor, shelf_life_days,
                active
                unit_type: bottle | can | keg

ProductBarcode  id, product_id, barcode, format,
                pack_level, is_primary
                pack_level: each | case

ProductPar      id, product_id, location_id (nullable),
                par_level, reorder_point

Location        id, name, sort_order

Count           id, type, status, started_at, closed_at,
                opened_by, closed_by, total_value, notes
                type: full | spot | monthly_close
                status: draft | in_progress | submitted | reviewed | closed

CountLine       id, count_id, product_id, location_id,
                sealed_case_qty, sealed_each_qty,
                partial_fills (JSON),
                unit_cost_at_count, case_size_at_count (both nullable),
                opened_at,
                counted_by, counted_at
                UNIQUE (count_id, product_id, location_id)

CountLineWrite  id, count_line_id, count_id, written_by, applied_at,
                sealed_case_delta, sealed_each_delta,
                partial_fills_delta (JSON), client_line_id
                UNIQUE (client_line_id)
                append-only — one row per write applied to a CountLine,
                never updated or deleted
```

### The decisions behind it

**User is Better Auth's table, not a hand-rolled one.** Better Auth (§11) owns `user`, `session`, `account`, and `verification`; `role` and `active` are Handlebar's own fields added on top. Credential sign-in stores its password hash on `account.password` (Better Auth's credential provider), not on `User` — a `password_hash` column here would just be a second, unused place a password could live. This keeps `count.opened_by`, `count.closed_by`, and `count_line.counted_by` as ordinary integer foreign keys into `user.id`, same as everything else in this model.

**Track product-level quantities, not bottle identities.** A bottle isn't an entity with a lifecycle — a line is `sealed_each_qty: 4, partial_fills: [0.3, 0.8]` = 5.1 units. Individual bottle identity only matters for rare or allocated spirits; add it later as an optional flag, never as the base model.

**Barcodes are one-to-many.** A product routinely carries several codes: the bottle UPC and the case UPC differ, vendors change UPCs across packaging revisions, and some bottles carry both UPC-A and EAN-13. A `upc` column on Product means your first case scan creates a phantom duplicate product. `pack_level` also does double duty — scanning a case carton drops the UI into case entry, scanning a loose bottle into eaches. The interaction falls out of the schema for free.

**Snapshot cost and case size onto the count line.** `current_unit_cost` and `case_size` live on Product and change over time. If closed counts reference them live, a March count silently re-values itself in July and the variance history becomes fiction. Copy both onto `CountLine` at count time; closed counts then never move. Both are nullable on `CountLine`: most of the catalog starts with no cost and no case size recorded, and forcing a non-null snapshot would either block counting altogether or invite a silent `0` — the exact plausible-but-wrong failure this app exists to avoid. `NULL` means "unpriced at count time," excluded from valuation rather than counted as free; once a product's cost is entered later, its past `NULL` lines stay `NULL` rather than being repriced.

**`waste_factor` on Product.** Fraction of volume assumed lost to pour waste, spill, and foam — currently meaningful only for draft beer (kegs), 0 for everything else.

**`shelf_life_days` on Product, `opened_at` on CountLine.** Days after opening before a product should be discarded, and the date a specific counted bottle/keg was opened. Both unused by any computation or UI in the MVP — they exist so a later shelf-life feature is additive, not a migration plus a recount.

**Store cases and eaches separately — don't convert at entry.** Beer gets counted both ways here. If "3 cases" is stored as 72 and `case_size` is later corrected from 24 to 12, that historical count is quietly wrong. Store what was observed: `sealed_case_qty: 3, sealed_each_qty: 7`.

**Unique constraint on (count_id, product_id, location_id).** Scanning the same bottle twice must increment the existing line, not create a second one. Without the constraint you get silent double-counting — the worst class of bug, because the total still looks plausible. The same product in two locations correctly produces two lines; that's information you want.

**Idempotency needs its own ledger, not a column on CountLine.** The retry queue (§11) means a write can arrive twice, and a single write only ever *creates* a line the first time — every scan after that *increments* an existing one (the unique constraint above). A single `client_line_id` column on `CountLine` can only remember the most recent write, so it can only catch a retry of that one write; an earlier write, retried after a later one has already landed, doesn't match and silently re-applies — a second, invisible increment. `CountLineWrite` fixes this by giving every individual write its own permanent row, keyed by that write's `client_line_id`, UNIQUE. A duplicate-key violation on insert is the signal that a write already applied — enforced by the database, not remembered by a column that can only hold one value at a time. It's also the audit trail §10 needs: summing every write's delta for a line reconstructs exactly what happened, in order, by whom — independent of `CountLine`'s own (mutable, current-state) columns.

**`partial_fills` as a JSON array, not a rollup.** `[0.3, 0.8]` rather than "2 bottles, 1.1 total." Identical math, but you can reopen and correct one bottle without recounting the shelf, and the audit trail shows what was actually observed. MySQL handles JSON natively and you read the whole array at once anyway.

**Par lives in its own table with a nullable `location_id`.** Null means one par for the product overall; populated means per-location. The MVP only ever writes null rows. If you later want 2 bottles of Tito's on the rail and 6 in the storeroom, that's a new row rather than a schema change. Costs one join, buys the option.

**Never hard-delete a product.** Historical counts reference it. `active: false` and it disappears from count screens while history stays intact.

### Kegs

A keg is a product with `unit_type: keg` and `size_ml` set to its volume — a half-barrel is ~58,670 ml, a sixtel ~19,550. A tapped keg recorded as 0.4 in `partial_fills` is then 0.4 × size_ml, exactly the same math as a bottle. No special-casing.

The difficulty is measurement, not storage — you can't eyeball a keg's level. Weight is the only honest method: `(current − empty) ÷ (full − empty)`. `empty_weight_g` and `full_weight_g` exist for that, nullable and unused by anything else.

**MVP uses tenths for kegs like everything else.** Crude but usable, and no extra code. The columns are there so a weight-entry mode later is a UI change rather than a migration.

### Deferred tables

Not built in the MVP, listed so the schema above stays compatible:

```
Invoice         id, vendor_id, invoice_number, date, image_url,
                ocr_status, total, retention_until

InvoiceLine     id, invoice_id, product_id, qty, unit_cost, extended

Depletion       id, product_id, period_start, period_end,
                theoretical_qty (from POS), source

RecipeComponent id, pos_item_guid, product_id, pour_ml
```

`RecipeComponent` is what makes Phase 2's variance report possible — the map from a Toast menu item to the products and volumes it consumes.

---

## 9. Reports (v1)

1. **Count Summary** — total value by category and location, vs. previous count.
2. **Variance Report** — theoretical usage (from POS) vs. actual usage (from counts). *This is the report that justifies the whole project.*
3. **Reorder List** — anything below reorder point, grouped by vendor, with suggested order quantity.
4. **Pour Cost** — beverage COGS ÷ beverage sales, by category and overall.
5. **Dead Stock** — SKUs with no depletion in 60/90 days.
6. **Month-End Close** — beginning and ending inventory value for the period. (See compliance section.)

**Variance formula:**
```
Actual usage    = opening inventory + purchases − closing inventory
Theoretical     = sum of POS-recorded pours × recipe volume
Variance        = actual − theoretical
Variance %      = variance ÷ theoretical
```
Anything over ~5% variance is worth investigating. Industry commentary puts typical bar shrinkage far higher than that, though treat vendor-published shrinkage figures as marketing until you measure your own.

---

## 10. Arizona compliance module (your differentiator)

This is where a purpose-built app beats an off-the-shelf one for you specifically, since compliance already sits on your plate.

**What Arizona requires (verify against current rule text and your license series):**

- **A.A.C. R19-1-501** — a licensee must maintain all invoices, records, bills, and other documents relating to the purchase, sale, or delivery of spirituous liquor for **two years**, and produce them for the Department on request. Restaurant and hotel-motel licensees carry the same obligation for **food** records.
- **DLLC audit checklist** calls for a **recent, accurate inventory of food and liquor taken within two weeks of the audit interview**, plus **monthly beginning and ending inventory figures** for both food and liquor.
- Routine inspections ask for purchase invoices for spirituous liquor, among other records.
- If you hold a restaurant license, the food-to-liquor revenue split is a live compliance issue, and your inventory figures feed it. Confirm the specifics with your licensing attorney.

**Therefore the app should:**
- Store every invoice image with a `retention_until` date set to **invoice_date + 2 years minimum** (3 is safer), and never auto-delete before it.
- Produce a **Month-End Close** report with beginning and ending inventory figures, food and liquor separated, locked once closed.
- Have a one-button **"Audit Packet" export**: date range → PDF/ZIP with all invoices, all closed counts, and monthly beginning/ending figures.
- Log who counted what and when, immutably.

*This is planning research, not legal advice. Confirm current requirements with the DLLC and your attorney before relying on any of it.*

---

## 11. Platform & technical spec

**Decision: a plain responsive web app, run in Chrome on the Android phone. No native wrapper, no app store, no Kotlin. Revisit only when iPhones enter the picture.**

### Why the simple answer is the right one

Two facts collapse the whole native-vs-web debate:

**1. WiFi covers where you count.** Offline was the single strongest argument for going native. It's gone. You don't need on-device SQLite, background sync, or WorkManager.

**2. Chrome on Android already gives you the two native features you actually wanted.**

| Feature | In plain Chrome on Android? |
|---|---|
| **Barcode scanning** | **Yes** — the Barcode Detection API is supported on Android (and Android WebView), covering UPC-A, UPC-E, EAN-13, EAN-8, Code-128 and more |
| **Torch / flash** | **Yes** — `track.applyConstraints({ advanced: [{ torch: true }] })` on the video track; Chrome on Android supports it |
| Camera capture | Yes — file input, or `getUserMedia` for a live preview |
| Screen wake lock | Yes — keep the screen alive through a 20-minute count |

So the entire reason to reach for Capacitor evaporates for your current setup. Build the web app. Ship it. Use it.

### Barcode scanning — build this early

Every liquor bottle carries a UPC, and detection runs on-device with no network call.

**For sealed backstock this replaces the photo entirely:** scan → product identified deterministically → type a quantity. No AI, no confidence score, no confirmation tap. Since sealed units are 60–75% of your count, **this is a bigger speed win than the entire AI pipeline.**

Feature-detect with `'BarcodeDetector' in window` and fall back to the `barcode-detector` npm package (a ZXing-C++ WASM polyfill) so the same code keeps working in any browser. That fallback is also your iOS answer later.

### Camera capture
- Live preview via `getUserMedia` for the scan-and-shoot flow; file input with `capture="environment"` as the simple fallback.
- **Turn the torch on for fill-level photos.** Dim, colored bar lighting is the documented top cause of fill-estimation failure (§2). This is the cheapest accuracy win available and it's one line of code.
- Downscale client-side to ~1000–1200px long edge before upload. Saves bandwidth, time, and API cost.

### Connectivity — light insurance, not an architecture
WiFi is reliable here, so don't build an offline-first system. But don't make every tap a blocking network call either:
- Optimistic UI: the count line appears instantly, saves in the background.
- Small IndexedDB queue for pending writes, flushed on reconnect. An hour of work, saves you a lost count someday.
- Sync indicator ("12 lines pending") so a dropped AP is visible rather than silent.
- Server stays authoritative. The local queue is a buffer, never a source of truth.

**Worth a two-minute test before you rely on this:** walk into the walk-in with the phone and load a page. Walk-ins are metal boxes and routinely kill WiFi. If it's dead in there, either count that section outside the box or lean harder on the queue.

### Notifications
Web push is unreliable enough that you shouldn't build on it. **Send par-level and reorder alerts by email or SMS.** Simpler and it reaches you when you're not holding the phone.

### If iPhones arrive later — then wrap it

Safari supports neither the Barcode Detection API nor the torch constraint. That's the moment Capacitor earns its place, and the migration is days, not a rewrite:

| | **Capacitor** (the eventual pick) | Expo / React Native | Flutter | Native Kotlin |
|---|---|---|---|---|
| Reuses your web codebase | **Entirely** | No | No | No |
| Back office stays one codebase | **Yes** | No | No | No |
| Barcode | `@capacitor-mlkit/barcode-scanning` | expo-camera / vision-camera | Mature | ML Kit direct |
| Adding iOS | `npx cap add ios` | Included | Included | Full rewrite |
| Learning curve for you | Minimal | Moderate | High | High |

Two notes for that future decision: the Capacitor ML Kit plugin supports CocoaPods only for iOS dependency management, not Swift Package Manager. And Expo's EAS Build compiles iOS in the cloud, which removes the need for a Mac that can run a current Xcode — check whether yours can before assuming local iOS builds are an option.

### Stack — Hostinger Cloud Startup

**Decision: host it on the Hostinger Cloud Startup plan you already pay for. Marginal infrastructure cost is zero.**

**First, a correction of the target.** At your scale, "scalable" is the wrong thing to optimize. Roughly 200 count lines a week is ~10,000 rows a year. Around 800 photos a month. Three to five users. Any database on any tier handles that without noticing — you are four orders of magnitude below where architecture decisions start to matter. **The resource that actually runs out is your weekends.** Optimize for build speed and few moving parts.

### What Cloud Startup already gives you

| Need | Covered by |
|---|---|
| App runtime | **Node.js web apps** — supported on Cloud plans, with GitHub integration, ZIP upload, or IDE deploy. Cloud Startup allows up to 10 Node.js apps, so the inventory app sits alongside the restaurant site. |
| Database | **MySQL**, included, managed from hPanel |
| File storage | **100 GB NVMe.** Your photo volume is ~2 GB/year — a rounding error. |
| Compute | 4 CPU cores, 3 GB RAM, 100 PHP workers |
| Database connections | 100 max MySQL user connections |
| Backups | **Daily**, included on all Cloud tiers |
| SSL | Auto-provisioned (required for camera access) |
| Network | Dedicated IP, free CDN, unlimited bandwidth |
| Commercial use | Permitted — no terms problem |

**So the whole external-services stack disappears.** No Vercel, no Supabase, no Neon, no separate object storage, no extra bills, no extra logins.

### Two things to configure deliberately

**Resources are shared, not dedicated per app.** The 3 GB RAM, 4 cores, and 100 GB storage cover *everything* on the plan — your existing restaurant website plus this app. A Node process for an app this size idles around 100–200 MB, so there's ample room, but it isn't isolated. If the website is WordPress it's already drawing on the same pool. Worth watching after you deploy, not worth worrying about in advance.

**Set the database pool small.** You get 100 MySQL user connections, shared with the website. A Node connection pool of **5–10** is plenty for five users and leaves the rest alone. Some ORMs default to larger pools — set this explicitly rather than accepting the default. (This is also why the serverless connection-exhaustion problem never appears here: one long-lived process holds one small pool.)

### Deployment shape
- Deploy as a **subdomain** — `handlebar.<yourdomain>` — as a separate Node.js app in hPanel
- Connect the GitHub repo; pushes trigger builds
- MySQL database created from hPanel
- Photos written to the plan's storage, served through the CDN with signed/expiring URLs
- Environment variables for the Gemini API key — server-side only, never in client code

### The stack — TypeScript, decided

| Layer | Pick | Why |
|---|---|---|
| **Language** | TypeScript | Types across the client/server boundary matter most exactly where this app is fiddly: count lines, fill percentages, CSV rows, AI responses |
| **Framework** | **Next.js 16 (App Router)** | One codebase for the phone counting UI, the desktop back office, and the API routes. Supported by Hostinger's managed Node.js hosting. |
| **Styling** | Tailwind CSS | Fast, and suits the big-tap-target, high-contrast, dark-mode UI a dim bar needs |
| **Components** | shadcn/ui | Copy-in, no dependency bloat. Its slider and dialog primitives are exactly the fill-level UI. |
| **Database** | MySQL | Included with the plan |
| **ORM** | **Drizzle** + drizzle-kit | TypeScript-first, near-zero runtime, generates readable SQL, first-class MySQL. Lighter than Prisma's query engine on shared hosting. |
| **Auth** | **Better Auth** (Drizzle adapter) | Self-hosted, data in your own database, no per-user fees, MIT licensed |
| **Validation** | Zod | One schema shared by forms, API routes, CSV import, and parsing Gemini's JSON |
| **Forms** | React Hook Form + Zod resolver | |
| **Server state** | TanStack Query | Optimistic UI and the retry queue for count lines |
| **Tables** | TanStack Table | Reports and the catalog editor |
| **Barcode** | Native `BarcodeDetector` + `barcode-detector` polyfill | On-device, no network, no plugin |
| **CSV** | PapaParse | Toast PMIX import |
| **Vision** | `@google/genai` in a route handler | Server-side only |
| **Local queue** | `idb` | Thin IndexedDB wrapper for pending writes |

### Why Next.js, given it's the heaviest option

Its headline strengths — ISR, edge, image optimization, Vercel integration — are mostly irrelevant here. The reason to pick it anyway is **ecosystem depth**: for a solo builder leaning on AI assistance, Next.js has by far the most documentation, examples, and training data behind it. That's a bigger productivity multiplier than any framework's elegance.

SvelteKit is lighter and less churn-prone if that appeals. It's a defensible alternative, not a better one.

### Auth: use Better Auth, not NextAuth
The landscape shifted in early 2026 — Better Auth absorbed Auth.js, and the library formerly known as NextAuth is now in maintenance mode receiving security patches only. Better Auth is TypeScript-first, runs entirely inside your app with no external service, stores users in your own MySQL, and has a Drizzle adapter. For five users with three roles (§4), it's a config file and a schema generation command.

### Self-hosting configuration
- **`output: 'standalone'`** in `next.config.ts` — Next traces dependencies and emits a minimal self-contained server, which keeps the deployed footprint small on shared hosting.
- **`images: { unoptimized: true }`** — you're serving photos from storage with signed URLs anyway, and disabling it sidesteps the self-hosted image-optimization surface entirely.
- **Skip ISR and Cache Components.** This is an authenticated internal tool; nothing here benefits from them.
- **Watch build memory.** `next build` can spike above 1 GB, and you're sharing 3 GB with the website. If Hostinger's builder struggles, build in GitHub Actions and deploy the artifact instead.
- **Connection pool of 5–10** in the Drizzle MySQL config (see above).

### Runtime: Node in production, Bun in your terminal

**The hosting decides this.** Hostinger's managed Node.js hosting runs Node. Deno needs a custom runtime environment that shared and managed hosting doesn't provide, and the Bun path on Hostinger is likewise VPS-with-root-access. Choosing either as your production runtime means moving to a VPS — surrendering the free managed hosting and picking up OS patching, SSL renewal, process supervision, and backups. That's a $9/month bill plus ongoing ops, paid for a speed increase this app cannot use.

**Because "Node is slow" isn't the binding constraint here.** Look at where the seconds actually go in a counting session:

| Step | Time | Runtime-dependent? |
|---|---|---|
| Gemini vision call | 5–15s | No |
| Photo upload over bar WiFi | 1–3s | No |
| MySQL query against ~10k rows | <1ms | No |
| Human picks up bottle, taps fill level | 3–6s | No |
| Node handling the request | negligible at 5 users | — |

Swapping runtimes optimizes the one row that rounds to zero. This is the same trap as optimizing for "scalable" — a real property, just not the one that's binding.

**Where Bun genuinely helps, and you should use it:** `bun install` is dramatically faster than npm — seconds instead of most of a minute — and that compounds every time you install, in local development and in CI. Its test runner and CLI startup are similarly quick.

**Recommended split:**
- **`bun install`** as your package manager, locally and in CI. Real win, zero production risk.
- **Node to actually run the app**, in development as well as production. Dev/prod parity is worth more than a few hundred milliseconds of startup — you don't want a class of bug that only appears once deployed.
- If you move builds to GitHub Actions (see build-memory note above), Bun there too.

**One compatibility check:** Bun's npm compatibility is strong for the mainstream ecosystem, but the gaps cluster in native addons, `vm` usage, and some `worker_threads` patterns. Use `mysql2` (pure JavaScript) for the database driver and you won't meet any of them.

**On Deno specifically:** its module resolution doesn't use `node_modules` the way the npm ecosystem assumes, which has historically broken ORMs and build tools that rely on that layout. Next.js doesn't target it as a primary runtime either. For a solo maintainer, that's an entire compatibility surface adopted for no measurable gain on this workload.

### Security hygiene — this is on you now

Self-hosting means **you own patching**. Next.js shipped a security release in July 2026 covering App Router middleware/proxy bypasses, SSRF through rewrites and Server Actions, and image-optimization issues. On Vercel some of that is mitigated platform-side; on Hostinger it isn't.

Two rules that make this manageable:

1. **Subscribe to Next.js security releases and update promptly.** Set a recurring reminder — this is a compliance-adjacent app holding two years of invoices.
2. **Never rely on middleware/proxy alone for authorization.** Check the session and role inside every server action and route handler as well. Several of these CVEs are middleware bypasses; with defence in depth they become non-events for you.

### Schema note — MySQL, not Postgres
The conceptual model in §8 is unchanged, with one adjustment: `partial_fills[]` becomes a **JSON column** rather than a Postgres array. MySQL handles JSON natively and you'll be reading the whole array at once anyway. Everything else maps directly.

### The one thing worth adding — offsite invoice backup

Hostinger's daily backups are good, but your Arizona invoice archive (§10) is a **two-year-plus legal record**, and putting it behind a single vendor with a single account is a single point of failure. A lapsed renewal, a billing dispute, or an account issue and the archive the DLLC would ask for is gone.

**Sync invoice images to cheap object storage as a second copy** — Cloudflare R2 or Backblaze B2, pennies per month at your volume. Bottle photos don't need this; invoices do. Treat it as compliance insurance, not paranoia.

### Watch the renewal price
Hostinger's headline rates are promotional and step up substantially at renewal — Cloud Startup in particular. You're already committed, but budget the renewal figure rather than the signup figure when you think about running costs.

### Running cost

| Item | Monthly |
|---|---|
| Hosting | **$0** — already paid for |
| Database | $0 — included |
| File storage | $0 — included |
| Offsite invoice backup | ~$0–1 |
| Gemini API | $1–3 |
| **Total** | **~$1–4** |

Commercial bar-inventory subscriptions run $150+/month. You're building this for the cost of a coffee, on infrastructure you already own, and you keep the data and the compliance packet.

### Structural notes
- One codebase, mobile-first, served over HTTPS
- Photos in storage with signed URLs — never base64 in the database
- Set the invoice-image retention rule (§10) explicitly; don't rely on default cleanup
- Immutable closed counts: append adjustments, never edit history

### Non-functional requirements
| Requirement | Target |
|---|---|
| Count line save latency | < 300ms perceived (optimistic UI) |
| Photo upload | Async, never blocks the next bottle |
| Full count of 150 SKUs | < 20 minutes |
| Works one-handed | Yes — one hand holds the phone, one holds the bottle |
| Screen readable in dim bar light | High contrast, large tap targets, dark mode |
| Data retention | 3 years minimum, immutable closed counts |

---

## 12. MVP scope & build phases

### MVP — locked

**In scope:**
- Product catalog (SKU, size, cost, vendor, par, reorder point, UPC)
- Locations (speed rail, back bar, storeroom, walk-in)
- **Barcode scan** to identify a product
- **Fill level in tenths** — tapped by hand, no AI
- **Quantity input** for sealed units
- Count sessions with the Draft → Closed lifecycle
- Valuation and count summary
- Reorder list against par levels
- Auth with the three roles (§4)

**Deferred:**
- AI fill estimation (§7 stage 2)
- Bottle photos entirely
- Invoice OCR (§7 stage 3)
- Toast PMIX import and variance reporting
- Compliance/audit packet (§10)

### What deferring the AI buys you

This is a bigger simplification than it looks. Dropping fill estimation and photos removes, from the MVP:

- The vision API integration, the API key, and the server-side inference route
- The propose-then-confirm UX and the confidence-logging loop
- **Object storage, signed URLs, image downscaling, and the upload queue**
- The AI running cost — MVP is now **$0/month** on infrastructure you already own

**The MVP has no AI in it at all.** That's a feature. Every part of it is deterministic and testable, and the whole thing is CRUD plus a barcode scanner. You can build and trust it without ever wondering whether the model was right.

It also means **Phase 0.5 (the 20-bottle photo test) is deferred too** — its only purpose was deciding whether to build fill estimation. Do it when you pick that thread back up.

### The design decision this forces: scan-to-enroll

Barcode is now the only smart input in the app, and it only works if products carry UPCs. Pre-populating UPCs for 150 SKUs by hand would be miserable and is not how to start.

**Instead: let the catalog build itself during the first count.** When an unknown barcode is scanned, the app opens a quick "new product" form with the UPC pre-filled — name, size, cost, category, location — and then continues the count. Every subsequent scan of that bottle resolves instantly.

Consequences worth being deliberate about:
- **Your first count will be slow.** Budget 2–3× normal; you're doing data entry and counting at once. Every count after that is fast.
- **Phase 0's spreadsheet doesn't need UPC numbers.** Fill in names, sizes, costs, vendors, and pars. Barcodes accumulate through use.
- **Make the new-product form fast.** Under 20 seconds, minimum viable fields, everything else editable later from the back office. If enrolling a product is painful, the catalog decays and the whole system dies with it — this is the single highest-risk interaction in the MVP (§14).
- **Handle the no-barcode case.** Damaged labels, house infusions, some wine. Always offer a searchable product picker beside the scan button.

### Phases

**Phase 0 — Catalog baseline (1–2 weeks, no code)**
Build the catalog in a spreadsheet: every SKU, size, cost, vendor, par. Do one full manual count. Time it. Record the total value. This is the benchmark the app has to beat, and the catalog is 80% of the work in any inventory system.

**Phase 1 — The MVP**
Everything in the scope list above. Ship it. Use it for a month of real counts.

**Phase 2 — Toast PMIX import + variance**
CSV upload, map Item GUID → product + pour spec, produce the actual-vs-theoretical report (§9, §11). The recipe map is the work, not the import. **This is the feature that justifies the whole project** — but it's worth nothing until you have several months of trustworthy counts to compare against, which is exactly why it comes after the MVP has been running.

**Phase 3 — Compliance packet**
Month-end close, beginning/ending inventory figures, retention rules, audit export (§10).

**Phase 4 — Invoice capture**
Only if the xtraCHEF test (§13) comes back negative. If xtraCHEF handles invoices well, you never build this.

**Phase 5 — AI fill estimation**
Revisit with real data in hand. By then you'll know from a month of tapped tenths which bottles are ambiguous and slow, which tells you whether AI would actually help and where. Run the 20-bottle test then.

## 13. Build vs. buy — be honest with yourself

**Reasons to buy** (WISK, Partender, BarGuard, Backbar): POS integrations already built; someone else maintains it; works next week.

**Reasons to build:** no recurring subscription; you own the data; the Arizona compliance packet doesn't exist in any off-the-shelf product; it fits your exact workflow; you'll actually learn the system.

**Honest middle path:** run a free or cheap trial of one commercial tool during Phase 0. Two weeks of using someone else's product will teach you more about what you actually want than any amount of specifying. Then build, buy, or abandon with real information.

### The xtraCHEF question — settle this before cancelling

You currently pay for **xtraCHEF Essentials** and don't use it. Before cancelling, know what you're giving up:

| Tier | What it includes |
|---|---|
| **Essentials** (formerly Lite) — what you have | Invoice processing (AI line-item capture), accounting sync, basic food-cost analytics |
| **Pro** | All of the above **plus recipe costing and inventory management** |

**Key point: Essentials was never going to do what you're building.** Counting, fill levels, and actual-vs-theoretical variance all live in Pro. So it isn't a substitute for this project.

**But it does the invoice half — which is the half you ranked highest.** xtraCHEF digitizes and archives supplier invoices with line-item extraction. That is simultaneously:
- Phase 3's highest-ROI AI feature (§7), and
- Your Arizona 2-year invoice retention requirement (§10), handled automatically

**So: one hour before you cancel.** Photograph a month of liquor invoices into it. Then judge:

- **Extraction is clean** → you already own your invoice pipeline and your compliance archive. Keep it, and build only the counting half. Your project just got a third smaller.
- **Extraction is messy or the workflow annoys you** → cancel it. Independent review scores for xtraCHEF are poor (G2 sits around 2.4/5 with support and OCR complaints), so this is a real possibility. You can rebuild invoice OCR yourself with a vision API for roughly nothing.

Either way you'll have decided on evidence rather than on a subscription line you've been ignoring.

**Two cautions:** Toast contracts commonly run multi-year, so check your agreement for terms on removing a subscription before assuming you can cancel freely. And note that upgrading to xtraCHEF **Pro** would give you counting and AvT without building anything — but reviewers consistently flag its bar-specific inventory tooling as its weakest area, which is precisely your use case. Not an obvious win. (That criticism comes loudest from a direct competitor, so weigh it accordingly — but the G2 scores are independent.)

---

## 14. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| AI fill estimates are too unreliable to be useful | High | Phase 0.5 test decides this before you build it. Fall back to tap-the-tenths or a scale. |
| Catalog maintenance decays; new SKUs never get added | **High — this is what actually kills inventory systems** | Make adding a product take under 20 seconds. Invoice OCR auto-creates draft products. |
| Staff won't adopt it | High | Count must be *faster* than the clipboard on day one, or it's dead. |
| Photos balloon storage costs | Low | Downscale on device; retain photos 90 days, keep invoice images the full 2+ years. |
| Scope creep into a full bar-management platform | Medium | Non-goals list in §3. Re-read it monthly. |
| Building this eats time the business needs | Medium | Phase 1 is small on purpose. If Phase 1 doesn't get used, stop. |

---

## 15. Success criteria

Measure at 90 days:
- Full count takes **under 20 minutes** (baseline: your Phase 0 timing)
- Counts happen **weekly without being nagged**
- Variance is **measured** — knowing it's 8% beats guessing it's fine
- Zero stockouts of top-20 SKUs
- Audit packet exports in under a minute

---

## 16. Open questions to resolve

1. ~~What POS? Do you have RMS Essentials?~~ **Resolved: Toast, no RMS. Use the PMIX CSV export — no subscription needed.**
2. Does xtraCHEF Essentials extract your liquor invoices cleanly? One hour of testing decides whether you keep it and skip building Phase 3's invoice half. **Do this before cancelling.**
2. How many of your 50–200 units are open bottles vs. sealed? Drives the whole speed calculation.
3. Weekly or monthly counts? Weekly gives usable variance; monthly barely does.
4. Do you need per-bartender attribution later? Affects schema now.
5. Does wine need vintage tracking, or is it by-the-glass only?
6. Who else counts besides you?

---

## References

- Partender fill-line interaction — https://www.theiotintegrator.com/hospitality/bars-add-a-twist-of-ai-for-better-beverage-inventory-control
- Bar inventory app landscape 2026 — https://restaurantinventorymanagementsoftware.com/blog/bar-inventory-app-complete-guide
- BarGuard (photo fill estimate + invoice OCR) — https://barguard.app/bar-inventory-app
- VLM counting limitations — https://techxplore.com/news/2026-05-ai.html
- Compositional counting failures — https://arxiv.org/pdf/2510.04401
- Fill-level inspection challenges (opaque/amber, reflections) — https://imagevision.ai/blog/fill-level-inspection-with-vision-ai-in-bottles-for-consistent-quality/
- Machine-vision fill accuracy benchmarks — https://ojs.wiserpub.com/index.php/CCDS/article/download/4756/2354/45168
- A.A.C. R19-1-501, records retention — https://www.azliquor.gov/LiquorLaws/ViewRule.cfm?RuleID=78
- DLLC records required for audit — https://www.azliquor.gov/forms/aud_recretreq.pdf
- DLLC inspections — https://liquor.az.gov/public-safety/inspections
- Image token cost — https://platform.claude.com/docs/en/build-with-claude/vision
- iOS PWA limitations — https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide
