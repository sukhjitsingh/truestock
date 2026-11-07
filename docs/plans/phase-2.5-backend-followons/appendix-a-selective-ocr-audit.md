# Appendix — pdf-inspector usage audit (grounds Gate 1 & feeds Gate 2)

Reference material, not a gate doc. Written from `@firecrawl/pdf-inspector@1.15.0`'s
own `index.d.ts` (`node_modules/@firecrawl/pdf-inspector/index.d.ts`) and the
current pipeline (`lib/domain/extraction-pipeline.ts`), both re-read directly
2026-08-23 — every claim below is checked against real code, not carried
over from an earlier summary.

## What the pipeline does today

`runClaimedJob` (`lib/domain/extraction-pipeline.ts`):

1. `classifyPdf(bytes)` → thin wrapper over `pdfInspector.classifyPdfAsync` —
   cheap classification only: `pdfType`, `pageCount`, 0-indexed
   `pagesNeedingOcr`, `confidence`.
2. **`text` path** (confidence above threshold, no encoding issues):
   `processPdf(bytes)` → `pdfInspector.processPdfAsync` gives full-document
   Markdown. Lines are parsed deterministically out of that Markdown.
   **No AI call at all** — this path is already free and fast, and stays
   untouched by this feature.
3. **`scanned`/`mixed` path**: the *entire* PDF buffer is base64-encoded and
   sent to Claude Vision in one call —
   `source: { type: "base64", media_type: "application/pdf", data: doc.pdfBase64 }`
   (`extractInvoice`, `lib/domain/extraction-pipeline.ts:884-887`). For
   `mixed`, pdf-inspector's Markdown is also attached as ground-truth text,
   but the image bytes sent to Claude are the **whole document, every
   page**, with no page filtering of any kind.

## Confirmed gap: `processPdfWithOcr` is never called

Grepped the whole codebase — `pdfInspector.processPdfWithOcr` has zero call
sites. From the library's own type declarations:

```
processPdfWithOcr(buffer: Buffer, options?: OcrOptions): Promise<OcrPdfResult>
```

This is the library's **one-call selective-OCR pipeline**. Per its doc
comment: *"OCR defaults to Auto, which only loads PDFium, ONNX Runtime, and
the OCR model if native extraction routes at least one page."* — i.e. pages
that are already clean text cost nothing extra; only pages that genuinely
need image-based reading trigger the local OCR model at all.

`OcrOptions.mode` (`OcrMode` enum) controls routing:
- `Off` — never OCR, return native extraction only.
- `Auto` (default) — OCR only pages the native quality signals flag.
- `Force` — OCR every selected page.

The result (`OcrPdfResult`) gives, per page:
- `markdown` — final text, sourced either natively, via OCR, or fused.
- `provenance.source` (`PageContentSource`: `Native` / `Ocr` / `Fused`).
- `provenance.ocrConfidence` — a 0–1 quality score, only present when OCR ran.
- `provenance.hostedRecommended` — the library's own signal that a page's
  local OCR result is unreliable enough to warrant a hosted/AI-vision read.
- Document-level `pagesRoutedToOcr` (which pages actually ran local OCR) vs.
  `pagesRecommendedForOcr` (which pages the classifier flagged, whether or
  not they were routed).

None of this — per-page provenance, confidence, or the hosted-recommendation
signal — is captured anywhere in the pipeline today, because the function
that produces it is never called.

## The concrete inefficiency this produces

For any `scanned`/`mixed` invoice, **100% of pages are sent to Claude Vision**
regardless of how many pages `processPdfWithOcr`'s own native OCR could have
resolved locally at no per-token cost. A multi-page invoice is the worst
case: one bad photo page currently forces every other page in the same
document through the paid Vision path too, even pages that are typed text
pdf-inspector could already read for free (the same read the `text` path
already gets).

## What "using the selective-OCR pipeline" means — resolved at Gate 3 research

1. Route `scanned`/`mixed`-classified documents through `processPdfWithOcr`
   (`OcrMode.Auto`) instead of straight to Claude Vision.
2. Use `pagesRecommendingHosted` (backed by each page's
   `provenance.hostedRecommended`) to decide **whether to call Claude Vision
   at all** — empty means skip it entirely and use `processPdfWithOcr`'s own
   markdown, non-empty means call Vision.

**Point 3 below is corrected, 2026-08-23 — the original claim here was
wrong.** It read: "Page-scope the eventual Vision call to just those pages
(pdf-inspector's own APIs are already page-scoped throughout ... this is an
established pattern in the library, not a new one being invented here)."
That conflated two different things pdf-inspector calls "page-scoped":
`processPdf(buffer, pages?)` and `extractPagesMarkdown(buffer, pages?)`
restrict which pages get parsed into **markdown** — they never produce a
page-scoped **PDF buffer or image**, which is what an external vision model
like Claude actually needs to be handed only some pages. Also checked
`@firecrawl/pdf-parse` — no such package exists (npm 404).

**Refined further, same day, after the user surfaced a specific counter-claim
worth checking directly**: the underlying **Rust crate does** have exactly
this capability. Confirmed by reading the actual source on GitHub (not
inferred from docs): `src/vision/contracts.rs` publicly exports a
`PageRenderer` trait —

```rust
fn render_pages(
    &self,
    pdf_bytes: &[u8],
    pages: &[u32],       // 1-indexed
    password: Option<&str>,
    options: &RenderOptions,
) -> Result<Vec<RenderedPage>, Self::Error>
```

— implemented by `PdfiumRenderer` (`src/vision/pdfium.rs`), both gated behind
the `vision` and `render-pdfium` Cargo features (confirmed present in
`Cargo.toml`, pulling in a separate `firecrawl-pdfium` crate). This genuinely
rasterizes only the requested pages to owned RGB bitmaps — the Rust-level
mechanism the original "no function anywhere in the library does this" claim
said didn't exist. That phrasing was too broad; it should have said "no
function in the **published npm package's JS bindings**."

**The distinction that still holds the conclusion in place**: this codebase
depends on `@firecrawl/pdf-inspector`, the **napi/Node.js binding package**,
not the raw Rust crate. Read `napi/src/lib.rs` directly — its complete
`#[napi]` export list (18 functions, enumerated) has no function that
renders or returns page images to JS. `processPdfWithOcr`'s Rust
implementation calls `pdf_inspector::vision::process_pdf_with_ocr_mem()`,
which likely uses `PageRenderer` internally to feed its own local OCR model —
but the JS-facing `OcrPdfResult` type carries only markdown strings and
per-page metadata, never a pixel buffer. The napi binding simply never wires
`render_pages` through to JavaScript, the same pattern already observed
elsewhere in that file (`extract_text_with_positions` discards `PdfRect`/
`PdfLine`/operator-list data the Rust core computes but the binding doesn't
expose).

So the real options to get a genuine page-scoped Vision call are now three,
not two:

1. **pdf-lib** (`PDFDocument.load(bytes)` → `newDoc.copyPages(srcDoc,
   [0-indexed pages])` → `newDoc.addPage(page)` → `newDoc.save()` — pure JS,
   no native bindings, confirmed via its own docs). Still the lowest-effort
   option.
2. **A new custom native Node addon** wrapping pdf-inspector's Rust
   `render_pages` directly (building on the `vision`/`render-pdfium`
   features the npm package doesn't currently compile in). Real, but a much
   bigger lift than pdf-lib: it means maintaining a second Rust/napi build
   alongside `@firecrawl/pdf-inspector`'s own, with the same cross-platform
   binary-distribution burden already noted below for that package (no
   `darwin-x64` build today; Docker-only local testing on this Intel Mac).
   Not evaluated further — recorded for completeness, not as a live option.
3. Filing an upstream request for pdf-inspector's npm package to expose
   `render_pages`/`RenderedPage` through its own napi bindings — outside
   this codebase's control, not something this round can build around.

**Decision (user, 2026-08-23): not built this round.** Recorded here as the
concrete future options if per-page Vision billing is ever wanted — option 1
would also need remapping Anthropic's page-numbers-in-response (which would
refer to the subset document) back to the original document's page numbers
for provenance/audit purposes.
3. ~~Page-scope the eventual Vision call~~ — not built this round (see
   correction above). The Vision call, when it runs at all, still sees the
   whole document, unchanged from today.
4. Persist per-page provenance (source, confidence) somewhere queryable —
   deferred; Gate 2 decided to log it rather than persist a second column
   this round (see `02-architecture.md`'s Data section).

## Confirmed, unrelated environment fact (surfaced for completeness)

`@firecrawl/pdf-inspector@1.15.0` publishes native binaries for
`linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`, `linux-arm64-musl`,
`darwin-arm64`, and `win32-x64-msvc` only — **no `darwin-x64`**. On this
Intel Mac, the library cannot load on the host at all; `bun run test:docker`
(inside the Linux container) is required to exercise any code path that
imports it. This doesn't block or shape this feature, but it does mean local
manual testing of the OCR path must happen in Docker, same as today.
