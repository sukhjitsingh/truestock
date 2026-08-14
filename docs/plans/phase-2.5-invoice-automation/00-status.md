# Status: Phase 2.5 — OCR invoice automation

- Gate 1 — Product: APPROVED 2026-08-14
- Gate 2 — Architecture: APPROVED 2026-08-14
- Gate 3 — Program Design: APPROVED 2026-08-14
- Gate 4 — Slice plan: APPROVED 2026-08-14

## Slices
- [ ] Slice 1 — tracer bullet: the Hostinger native-binary spike (`@firecrawl/pdf-inspector` loads under `output: 'standalone'`)
- [ ] Slice 2 — (filled at Gate 4)

## Notes for a fresh session
Read `docs/invoice-automation-research.md` in full (Parts 1–5) before anything else —
it is the build spec this plan turns into slices. The decision note at the top is
binding: **xtraCHEF is out; build replaces it.** The §2.8 checks are acceptance
criteria for our build, not vendor evaluation.

**Research findings that changed the build shape (Part 5, 2026-08-13):**

1. **Scan-primary intake.** The big-three distributor portals (SGWS, Breakthru, RNDC)
   download *scans of signed paper*, not generated PDFs; the real-world artifact is the
   photographed paper receipt. Text-based PDFs exist (email-forwarded invoices, some
   regional portals like Bernick's) but are the minority, not the default. The PRD is
   written scan-primary: Claude vision is the assumed primary OCR path, pdf-inspector's
   free text path is a bonus fast-path, and **the review queue is the throughput
   governor** — the review UI is the biggest work chunk, deliberately.
2. **Hostinger spike is de-risked.** Runtime is LiteSpeed `lsnode` on CloudLinux 8
   (glibc 2.28), Node 18/20/22/24 selectable; native binaries proven there (Prisma
   engines). The real risk is `output: 'standalone'` file tracing dropping the `.node`
   file (known `nft` bugs). Mitigations: `serverExternalPackages` +
   `outputFileTracingIncludes`. Escape hatch: KVM VPS ~$4–8/mo. **Slice 1 is the spike.**
3. **§2.8 check 14 (text-vs-scanned split) is a first-week-of-build measurement, not a
   pre-gate blocker** — the owner logs into distributor portals during slice work, not
   before planning.

**Sequencing facts:** this phase lands before production (Phase 3). Invoices captured
during it live in local object storage against a local database — decide "migrate at
Phase 3" vs "throwaway pilot" on the way in, not on deploy day (ROADMAP Phase 2.5).
Build `retention_until` here, not in Phase 6. This phase reverses the "no AI / no file
storage" MVP exclusions — AGENTS.md's rule stops applying at this line.

**Phasing inside the phase** (from research §3.8): A = Archive (no AI, ships first
regardless), B = Extraction + review, C = Matching, D = Cost flow + alerts, E = Audit
packet, F = Auto-approve (never before ~100 invoices of correction data). The PRD
(Gate 1) covers A–E as the feature; F stays deferred.
