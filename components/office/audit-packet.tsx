"use client";

/**
 * The "Create audit packet" form + status poll — Phase 2.5, Slice 5
 * (docs/plans/phase-2.5-invoice-automation/04-slices.md, "Slice 5 — Audit
 * Packet"). Owner-only end to end: the page that renders this component
 * already gates on `requireRole("owner")`
 * (app/(office)/office/invoices/audit-packet/page.tsx), and both actions
 * called from here re-check it themselves (invariant 7) — this component's
 * own gate is belt, not buckle.
 *
 * ## Shape
 *
 * `createAuditPacketAction({dateFrom, dateTo})` creates the `audit_packet`
 * row (status `building`) and fires the background build unawaited — it
 * returns `{packetId}` immediately, before the ZIP exists. From there this
 * component polls `getAuditPacketAction({packetId})` — a plain `setInterval`
 * while `status === "processing"`, cleared the moment it isn't — until the
 * packet resolves to `{status: "ready", downloadUrl, expiresAt}` or
 * `{status: "unavailable"}` (`lib/domain/audit-packets.ts`'s
 * `getAuditPacketStatus`: `expired`/`failed` collapse to the same
 * "unavailable" shape a caller cannot and should not distinguish).
 *
 * Every awaited call is wrapped in try/catch, matching
 * `InvoiceUploadForm`'s discipline: an un-caught `await someServerAction()`
 * throws silently offline (a documented trap in this repo) and would
 * otherwise leave the poll loop dead with nothing on screen explaining why.
 * A transient fetch failure during polling is swallowed and retried on the
 * next tick rather than flipping the badge to "unavailable" — a dropped
 * request is not the same claim as the server having marked the packet
 * failed or expired.
 *
 * ## Client-side validation, before the request ever leaves the browser
 *
 * `createAuditPacketSchema` (`lib/validation/invoices.ts`) refines
 * `dateFrom <= dateTo` and `dateTo` not in the future — this form checks the
 * same two things client-side before calling the action, so a backwards
 * range is caught with the field still focused rather than round-tripping
 * to the server to learn what the browser already knew. The server check
 * remains the actual boundary; this is only to avoid a wasted request, same
 * spirit as `AGENTS.md`'s method="post" rule below — validate at the
 * boundary the input crosses first, never trust only the client.
 *
 * ## Why the form disappears once a packet is requested
 *
 * There is no "list past packets" action (only `create` and `get(packetId)`
 * — `lib/domain/audit-packets.ts`), so this screen only ever tracks the one
 * request currently in flight or just resolved. Once `createAuditPacketAction`
 * returns a `packetId`, the form is replaced by a status card; "Request a
 * new packet" (only offered once the current one reaches `ready` or
 * `unavailable` — never mid-poll) resets back to the form. That mirrors
 * `InvoiceUploadForm`'s "Upload another" — one in-flight thing on screen at
 * a time, not a stack of them.
 */
import { useEffect, useState } from "react";
import { FileArchive, Download, Loader2, AlertCircle, CheckCircle, RotateCcw } from "lucide-react";
import Link from "next/link";
import {
  createAuditPacketAction,
  getAuditPacketAction,
  previewAuditPacketAction,
} from "@/app/actions/invoices";
import type { AuditPacketOmittedInvoice } from "@/lib/domain/audit-packets";
import {
  packetOmissionsView,
  previewKey,
  previewView,
  type OmittedRowView,
  type PreviewState,
} from "@/lib/audit-packet-omissions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { StatusPill, type PillTone } from "@/components/ui/status-pill";
import { formatDateTime } from "@/lib/utils";

const POLL_INTERVAL_MS = 3000;

type Status = "processing" | "ready" | "unavailable";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `dateFrom`/`dateTo` are plain YYYY-MM-DD strings — lexicographic order
 *  matches calendar order for that format, so a bare string compare is
 *  correct and matches `lib/validation/invoices.ts`'s own refinement. */
function validateRange(dateFrom: string, dateTo: string): string | null {
  if (!dateFrom || !dateTo) return "Choose both a start and end date.";
  if (dateFrom > dateTo) return "End date must be on or after the start date.";
  if (dateTo > todayIso()) return "End date cannot be in the future.";
  return null;
}

/** The "left out" rows, shared by the pre-creation preview and the ready packet. */
function OmittedList({ rows }: { rows: OmittedRowView[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border/80 rounded-lg border border-border/80">
      {rows.map((r) => (
        <li key={r.invoiceId} className="flex flex-wrap items-center justify-between gap-2 p-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-row-subtitle font-medium text-foreground">{r.title}</span>
            <span className="text-caption text-muted-foreground">{r.subtitle}</span>
            <span className="text-caption text-warning">{r.reason}</span>
          </div>
          <Link
            href={r.href}
            className="inline-flex min-h-tap-min items-center rounded-md border border-border px-4 text-label uppercase font-semibold text-foreground hover:bg-muted"
          >
            Open invoice
          </Link>
        </li>
      ))}
    </ul>
  );
}

function statusTone(status: Status): PillTone {
  switch (status) {
    case "ready":
      return "success";
    case "processing":
      return "warning";
    case "unavailable":
      return "negative";
  }
}

function statusLabel(status: Status): string {
  switch (status) {
    case "ready":
      return "✓ Ready for Download";
    case "processing":
      return "Building Packet…";
    case "unavailable":
      return "Unavailable";
  }
}

export function AuditPacket() {
  const today = todayIso();

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [packetId, setPacketId] = useState<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [packetOmitted, setPacketOmitted] = useState<AuditPacketOmittedInvoice[] | undefined>(undefined);

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const rangeValid = validateRange(dateFrom, dateTo) === null;

  // Preview for the chosen range. A result is tagged with the range it was
  // asked for and `cancelled` drops any response that lands after the range
  // changed, so an earlier range's list can never show under a later one.
  // A failure is stored as an error, never as an empty list: empty means
  // "nothing omitted".
  useEffect(() => {
    if (!rangeValid || status != null) return;
    const key = previewKey(dateFrom, dateTo);
    let cancelled = false;
    (async () => {
      try {
        const result = await previewAuditPacketAction({ dateFrom, dateTo });
        if (cancelled) return;
        if (!result.ok) {
          setPreview({ key, status: "error", message: result.error.message });
          return;
        }
        setPreview({
          key,
          status: "ok",
          includedInvoiceCount: result.data.includedInvoiceCount,
          omitted: result.data.omitted,
        });
      } catch {
        if (cancelled) return;
        setPreview({
          key,
          status: "error",
          message: "Could not check which invoices will be left out. Check your connection and try again.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dateFrom, dateTo, rangeValid, status]);

  // Polls only while a packet is in flight — cleared the instant `status`
  // leaves "processing" (including on unmount), so navigating away never
  // leaves a dangling interval calling a server action for a screen nobody
  // is looking at.
  useEffect(() => {
    if (packetId == null || status !== "processing") return;

    let cancelled = false;

    async function poll() {
      try {
        const result = await getAuditPacketAction({ packetId });
        if (cancelled) return;
        if (!result.ok) {
          setStatus("unavailable");
          setError(result.error.message);
          return;
        }
        if (result.data.status === "ready") {
          setStatus("ready");
          setDownloadUrl(result.data.downloadUrl ?? null);
          setExpiresAt(result.data.expiresAt ?? null);
          setPacketOmitted(result.data.omitted);
        } else if (result.data.status === "unavailable") {
          setStatus("unavailable");
        }
        // else still "processing" — leave state as-is, the next tick checks again.
      } catch {
        // Transient network failure mid-poll. Not the same claim as the
        // server reporting the packet failed or expired, so this stays
        // "processing" and tries again on the next tick rather than
        // reporting a state the server never asserted.
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [packetId, status]);

  function resetToForm() {
    setPacketId(null);
    setStatus(null);
    setDownloadUrl(null);
    setExpiresAt(null);
    setPacketOmitted(undefined);
    setPreview(null);
    setError(null);
    setFieldErrors({});
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    const validationError = validateRange(dateFrom, dateTo);
    if (validationError) {
      setError(validationError);
      setFieldErrors({ dateTo: validationError });
      return;
    }

    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      const result = await createAuditPacketAction({ dateFrom, dateTo });
      if (!result.ok) {
        setError(result.error.message);
        setFieldErrors(result.error.fieldErrors ?? {});
        return;
      }
      setPacketId(result.data.packetId);
      setStatus("processing");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (status != null) {
    return (
      <div className="flex flex-col gap-5 rounded-xl border border-border/80 bg-card/85 backdrop-blur-md p-6 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/80 pb-4">
          <div className="flex items-center gap-3">
            <StatusPill tone={statusTone(status)}>
              {statusLabel(status)}
            </StatusPill>
            <span className="text-row-subtitle font-medium text-muted-foreground">
              {dateFrom} — {dateTo}
            </span>
          </div>
          {status === "processing" ? (
            <span className="inline-flex items-center gap-1.5 text-caption text-warning">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Live polling
            </span>
          ) : null}
        </div>

        {status === "processing" ? (
          <div className="flex flex-col gap-2">
            <p className="text-row-subtitle text-muted-foreground">
              Building a ZIP of the approved, dated invoices in this range, count snapshots, and a SHA-256 manifest.
            </p>
            <p className="text-caption text-muted-foreground">
              This process runs in the background. You can stay on this page or return later.
            </p>
          </div>
        ) : null}

        {status === "ready" && downloadUrl ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-success">
              <CheckCircle className="size-5" aria-hidden="true" />
              <p className="text-row-subtitle font-medium">
                The audit archive is ready for download.
              </p>
            </div>
            <p className="text-caption text-muted-foreground">
              The secure download link expires
              {expiresAt ? ` at ${formatDateTime(expiresAt)}` : " in 10 minutes"}.
            </p>
            <div>
              <a
                href={downloadUrl}
                className="inline-flex min-h-tap-min items-center gap-2 rounded-md bg-primary px-5 text-label uppercase text-primary-foreground font-semibold shadow-xs hover:bg-primary/90"
              >
                <Download className="size-4" aria-hidden="true" />
                Download ZIP
              </a>
            </div>
          </div>
        ) : null}

        {status === "ready" ? <ReadyOmissions omitted={packetOmitted} /> : null}

        {status === "unavailable" ? (
          <div className="flex items-center gap-2 text-negative">
            <AlertCircle className="size-5" aria-hidden="true" />
            <p className="text-row-subtitle text-muted-foreground">
              {error ?? "This packet expired or the export failed to build."}
            </p>
          </div>
        ) : null}

        {status === "ready" || status === "unavailable" ? (
          <div className="pt-2 border-t border-border/80">
            <Button type="button" variant="outline" size="tap" onClick={resetToForm} className="font-semibold gap-1.5">
              <RotateCcw className="size-3.5" aria-hidden="true" />
              Request another packet
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <form
      method="post"
      onSubmit={handleSubmit}
      className="flex flex-col gap-section-gap rounded-xl border border-border/80 bg-card/85 backdrop-blur-md p-6 shadow-xs"
      noValidate
    >
      <div className="flex items-center gap-2">
        <FileArchive className="size-4 text-accent" aria-hidden="true" />
        <h2 className="text-label uppercase text-muted-foreground font-semibold">Create audit packet</h2>
      </div>
      <p className="text-row-subtitle text-muted-foreground">
        Pick a date range to export its approved, dated invoices and count snapshots, plus a
        SHA-256 manifest, as a ZIP. Invoices that are not approved or have no date are left out
        and listed below before you create it. Building it happens in the background; a download link is emailed to you and appears
        here once it&apos;s ready.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Start date" htmlFor="audit-packet-from" error={fieldErrors.dateFrom}>
          <Input
            id="audit-packet-from"
            type="date"
            value={dateFrom}
            max={today}
            onChange={(e) => setDateFrom(e.target.value)}
            disabled={submitting}
          />
        </Field>

        <Field label="End date" htmlFor="audit-packet-to" error={fieldErrors.dateTo}>
          <Input
            id="audit-packet-to"
            type="date"
            value={dateTo}
            max={today}
            onChange={(e) => setDateTo(e.target.value)}
            disabled={submitting}
          />
        </Field>
      </div>

      <PreviewPanel view={previewView(preview, dateFrom, dateTo, rangeValid)} />

      {error ? (
        <div className="flex items-center gap-2 rounded-lg bg-negative-bg p-3 text-caption text-negative" role="alert">
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <div>
        <Button type="submit" size="primary" disabled={submitting} className="font-semibold shadow-xs">
          {submitting ? "Requesting…" : "Create audit packet"}
        </Button>
      </div>
    </form>
  );
}

function PreviewPanel({ view }: { view: ReturnType<typeof previewView> }) {
  if (view.kind === "idle") return null;
  if (view.kind === "loading") {
    return (
      <p className="inline-flex items-center gap-1.5 text-caption text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Checking which invoices are in this range…
      </p>
    );
  }
  if (view.kind === "error") {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-negative-bg p-3 text-caption text-negative" role="alert">
        <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
        <span>{view.message}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" role="status">
      <p className="text-row-subtitle font-semibold text-foreground">{view.includedText}</p>
      {view.omittedHeading ? (
        <>
          <p className="text-row-subtitle font-medium text-warning">{view.omittedHeading}</p>
          <OmittedList rows={view.rows} />
        </>
      ) : (
        <p className="text-caption text-muted-foreground">No invoices in this range will be left out.</p>
      )}
    </div>
  );
}

function ReadyOmissions({ omitted }: { omitted: AuditPacketOmittedInvoice[] | undefined }) {
  const v = packetOmissionsView(omitted);
  return (
    <div className="flex flex-col gap-3">
      <p className={`text-row-subtitle font-medium ${v.kind === "list" ? "text-warning" : "text-muted-foreground"}`}>
        {v.heading}
      </p>
      {v.kind === "list" ? <OmittedList rows={v.rows} /> : null}
    </div>
  );
}
