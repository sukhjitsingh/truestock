# Spike: can a small OCR engine fit on Hostinger and do the bulk of scanned/photo invoices?

**Status: measurement spike. Nothing here is wired into the app, and nothing was deployed to Hostinger.**
Companion to `findings.md` (the deterministic vendor-template prototype). The harness is
`scripts/ocr-bench/` (README there); the numbers below come from its scorer. No document text, names, item
names or amounts appear in this file: only counts, percentages, timings and memory figures.

**Question.** `findings.md` showed the template and arithmetic gate work but the library OCR drops a one-digit
quantity at every single resolution. Is there a small, offline OCR engine that (a) fits the Hostinger Cloud
Startup limits (4 cores / 3 GB shared with the website, Node only, 120 s per request, process and thread
caps) and (b) reads the scanned and photographed invoices well enough that Claude Vision becomes a last resort?

**Answer in one paragraph.** Granite-Docling is out: it hallucinates on these pages (money F1 0.0) and needs
1.5 GB or more and 40 to 250 s per page. tesseract.js fits but reads money worse than PP-OCR and never
passes the template. **PP-OCRv6-small (det+rec via ONNX Runtime) is the engine to keep:** it reads every money
amount on the scan correctly (19 of 19, no false tokens), at about 1.2 s and 610 MB per page on a 2-CPU
container. But **no engine at any single resolution passes the existing template and gate**, so none can yet
do the bulk of the work. The remaining defects are in what sits between the engine and the template (a
lone one-digit quantity is missed, and the markdown puts every amount in the first row), not in the choice of
engine. One invoice, one scan, one photo: this is a go/no-go input, not a result.

## What was measured

Three candidates, from the earlier shortlist:

| # | Candidate | Runtime variants |
|---|---|---|
| 1 | PP-OCRv6-small det+rec (`pp-ocrv6-small`, oar-ocr v0.7.0 models) | `onnxruntime-node` 1.31.1 (native addon) and `onnxruntime-web` 1.31.1 (WASM) |
| 2 | tesseract.js 7.0.0, WASM | `fast` and `best_int` English models, page-segmentation modes 3, 4, 6, 11, plus a whitelist variant |
| 3 | Granite-Docling-258M, ONNX, via `@huggingface/transformers` 4.3.1 | q4 and q8 weights; whole page and 512/768 px tiles |

Method:

- Same five page images for every engine: the real scan at 100 / 150 / 200 dpi and the real photo at 100 / 150
  (the photo "dpi" is an upscale factor; the 200 render is 41 MP and was skipped).
- Each run is a **throwaway Docker container**: `--network none`, `--memory` equal to `--memory-swap`, 2 CPUs,
  2 requested threads, models and images mounted read-only, one container at a time. Node 22.23.4, Debian 12,
  x86-64, in the app image.
- Memory is read from the process and the cgroup (`maxRssMb`, `cgroupPeakMb`), and OOM kills come from
  `docker inspect`, so a killed run is recorded as a failure with stub results, never as a missing row.
- Scoring runs the engine's markdown through the **real** `extractWithOcrTemplate` and gate (unchanged
  spike code). It also scores money-token precision / recall / F1 and quantity recall against a ground truth,
  and tries merging engines per field.
- Ground truth for the scan is the per-field consensus of three library-OCR renders. It has 6 lines, passes the
  strict gate, and its lines sum to the printed total to the cent, so its amounts are anchored by arithmetic and
  not only by agreement. One field disagreed between renders and was left unread. **The photo has no ground
  truth**: it is cross-checked against the money tokens the library renders agree on.
- Timing runs were repeated serially after the exploratory work, with nothing else running. Timings are from
  an Intel Mac Docker VM and are only relative. Memory, thread counts and OOM outcomes carry over better.

## Results (1536 MB cap, 2 CPUs, serial run, 5 pages)

Money F1 and quantity recall are for the best-ranked scan page. Template status is the real template's
verdict at 100 / 150 / 200 dpi: `NT` no template matched, `PF` parse failed (fails closed), `GF` gate failed.
"s/scan" and "s/photo" are mean inference seconds per page.

| Variant | Money F1 % | Qty recall % | Template 100/150/200 | s/scan | s/photo | Peak RSS MB | Threads |
|---|---:|---:|---|---:|---:|---:|---:|
| **ppocr-node** | **100.0** | 83.3 | NT / PF / PF | **1.2** | 1.6 | **608** | 10 |
| ppocr-web (WASM) | 100.0 | 83.3 | NT / PF / PF | 3.6 | 4.6 | 688 | 12 |
| tess-best-psm6-wl | 85.7 | 33.3 | PF / PF / PF | 2.8 | 7.2 | 704 | 13 |
| tess-best-psm11 | 82.1 | 50.0 | PF / PF / PF | 1.6 | 3.8 | 707 | 12 |
| tess-fast-psm11 | 82.1 | 16.7 | PF / PF / PF | 1.2 | 3.3 | 709 | 12 |
| tess-fast-psm4 | 75.7 | 83.3 | PF / PF / PF | 1.2 | 3.5 | 705 | 12 |
| tess-fast-psm6 | 75.7 | 83.3 | PF / PF / PF | 1.2 | 3.2 | 669 | 12 |
| tess-best-psm4 | 72.2 | 16.7 | PF / PF / PF | 1.6 | 4.1 | 677 | 12 |
| tess-fast-psm3 | 70.3 | **100.0** | PF / PF / PF | 1.3 | 3.8 | 700 | 12 |
| tess-best-psm6 | 58.8 | 33.3 | PF / PF / PF | 1.6 | 3.7 | 679 | 12 |
| granite-tile768 (q4, 3 pages) | 0.0 | 0.0 | - / NT / NT | 41.7 | 245.8 | 1408 | n/a |

Readings:

- **Nothing passes.** 0 template passes and 0 false accepts across every variant and resolution. The gate did
  what it is for: it refused every page it could not prove.
- **PP-OCR is the only engine with perfect money recall** (19 true positives, 0 false positives, 0 misses),
  identical text from the node and web builds. Its misses are quantities: a lone one-digit number is dropped
  (5 of 6 found at best). On the photo the template reaches the gate and fails it on arithmetic (6 lines read,
  2 line-arithmetic failures), which is the safe outcome.
- **Tesseract is a different trade-off, not a better one.** `tess-fast-psm3` finds every quantity (100%) but
  money F1 is 70.3. No tesseract variant combines both. Its best money F1 is 85.7 (whitelist on, 100 dpi).
- **Resolution does not fix it.** The best page per engine moves between 100 and 200 dpi without a pattern.
- **Photo (cross-check only):** PP-OCR finds 20 of 20 reference money tokens at both upscales; tesseract finds
  13 to 19 of 20 depending on mode.

## Why the template still fails: row structure, not engine quality

For PP-OCR the money tokens are all there, yet the template reports `amount-count@row1(6 amts)` at 150 and
200 dpi: **the first row is assigned 6 amounts, more than one row can hold**, so the per-row amount rules cannot
pair amounts with lines. For tesseract the failures are `amount-count` and unpairable-amount. Two defects
therefore sit between the engine and the gate:

1. A lone one-digit quantity is dropped by detection or recognition (PP-OCR 5 of 6 at best; this is also the
   defect the library OCR showed in `findings.md`). At 150 dpi a lower detection threshold recovers one more
   quantity, but that page then no longer matches the template at all (`NT`).
2. Row assembly. `lib/rows.mjs` clusters words by y-position with a 0.5 x median-height tolerance, and the
   template consumes a flat token stream. The pairing the template needs is on the word boxes, which the
   engines return and the library OCR does not.

Merging engines did not help. Hand-picked pairs and triples (optimistic, chosen with the ground truth),
multi-resolution merges, and a blind sweep of 48 + 192 + 144 combinations all gave 0 gate passes and 0
false accepts; the sweep's PP-OCR x tesseract merges had conflicting fields in 78 of 144 cases. The merge fails for the same
reason: the row sets differ, so rows are matched by shared amounts, not by position.

## Memory ladder (does it fit a smaller box?)

Same five images; "OOM" means the kernel killed the container. The 23 MP photo page is what drives memory:
at 512 MB the 10 MP photo page still decodes and the 23 MP one is killed.

| Variant | 1 GB | 768 MB | 512 MB |
|---|---|---|---|
| ppocr-node | ok (617 MB peak) | ok (612) | **OOM** |
| ppocr-web | ok (682) | ok (687) | not run |
| tess-fast-psm4 | ok (696) | ok (673) | **OOM** |
| tess-best-psm6-wl | ok (697) | ok (706) | **OOM** |
| granite q4 tile512 | OOM | OOM | not run |

Granite below 1 GB was only run for tile512. Tile768 was run at 1536 MB and peaked at the cap itself (1536 MB
cgroup, 1408 MB RSS) without being killed; the whole-page run was killed at 1536 MB and needed a 3 GB cap
(2611 MB RSS, 2726 MB cgroup peak).

Scan-only pages are far cheaper: tesseract on the three scan pages ran inside a 256 MB cap in an earlier
exploratory run (284 MB peak RSS, 247 MB cgroup peak). Memory is therefore mostly a function of the largest
image you let in, so a downscale before OCR is the cheap lever if the box is tighter than 1 GB.

## Granite-Docling: infeasible on quality and on size

- Quality: tile runs repeat-guard on every non-blank scan tile, produce a few words per page, and score 0.0 money
  F1 and 0.0 quantity recall. It is a generative model; on small, dense invoice tiles it invents text.
- Size: q4 weights need at least 1.5 GB for tiles and about 2.7 GB for a whole page, which is most of the shared
  3 GB.
- Time: q4 tile768 took 41.7 s per scan page and 245.8 s for the photo (serial run, 332.5 s for 3 pages);
  tile512 took 130.6 s and 513.9 s; q8 was slower still and the photo did not finish in 20 minutes. The 120 s
  request cap is exceeded on the photo even before the Hostinger CPU slowdown.
- Only quantised weights were tested. Word boxes for Granite are estimated, not native.

## What this means for Hostinger (inference, not measurement)

Fits, by the numbers: PP-OCR node needs ~610 MB at peak and ~1.2 s per scan page on 2 shared CPUs, so even a 5 to
10 x slower shared host stays far below the 120 s request cap, with a safe margin under the 3 GB shared RAM when
images are bounded. Tesseract is the same order. Granite does not fit.

**Not proven, and each could still kill the plan:**

- `onnxruntime-node` is a **native addon** (glibc, prebuilt binary). Hostinger documents neither the glibc version
  nor native-addon support, and Truestock has never been deployed there (even `@firecrawl/pdf-inspector`'s addon is
  untested on that host). `onnxruntime-web` (WASM) is the portable fallback at about 3 x the time and 80 MB more
  memory, with identical text.
- **Thread counts:** requesting 2 threads gave 10 (ppocr-node), 12 (ppocr-web) and 12 to 13 (tesseract)
  threads at peak. Hostinger counts every process and thread against one process limit, so a concurrent
  upload could add up. The limit value is undocumented.
- The per-process memory cap, writable directories for model files (31 MB for PP-OCR, 2 ONNX models plus a dictionary), and cold start with
  other site traffic are all undocumented or unmeasured.
- Timing is from a contended Intel Mac VM; the ratio between engines is meaningful, the absolute seconds are not.

## Caveats on the evidence

- n = 1 each: one invoice, one vendor layout, one scan, one photo. Nothing says another vendor behaves the same.
- Ground truth for the scan comes from the same library OCR the template was built against. Arithmetic anchors the
  amounts, but a layout both renders misread identically would be baked in. The photo has no ground truth.
- Merge experiments with hand-picked inputs are optimistic by construction; the blind sweep is the fair one.
- Not tested: other models (for example other small document VLMs), Hostinger itself, tuned preprocessing
  (binarise, deskew, column crops), and 4-CPU timings.

## Recommendation

1. **Keep PP-OCR (node build) as the candidate engine; drop Granite; keep tesseract only as a comparison.**
   It is the only engine with perfect money recall, it is the cheapest in time and memory, and the web build
   gives the same text as a fallback.
2. **The next experiment is above the engine**, not another engine: assemble rows from the PP-OCR word boxes
   by y-position, give the template per-row tokens rather than the flat stream, and try a targeted second
   pass over the quantity column (crop and upscale) for the dropped one-digit numbers. That attacks both
   defects measured here. Gate and arithmetic checks stay unchanged.
3. **Do not decide on Hostinger from this.** Before committing the design, one disposable canary there (load
   `onnxruntime-node`, run one image, report peak memory and thread count) would settle the native-addon
   question for a few minutes of work. It touches a shared host, so it needs an explicit go-ahead; it was not
   done.
4. Claude Vision stays the fallback for everything the gate refuses. Nothing here changes the Phase 2.5
   invariants (cost posting only after human review, auto-approval off).

## Reproduce

See `scripts/ocr-bench/README.md`. In short: `run/provision.sh all` (network for npm and models only), then
`run/run-capped.sh <variant> <engine> <mem> <cpus> <threads> all`, then `run/run-score.sh derive-gt` and
`run/run-score.sh score`. Models, images, results and ground truth live outside the repo (`OCRB_BENCH`).
Verified for this report: `run/lint.sh` (eslint and `tsc` clean), `run/run-score.sh test` (74 tests pass), and
`run/check-out.mjs` contract checks on the final serial runs.
