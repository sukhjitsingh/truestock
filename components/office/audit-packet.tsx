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
import { createAuditPacketAction, getAuditPacketAction } from "@/app/actions/invoices";
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
      return "Ready";
    case "processing":
      return "Processing";
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
      <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-6">
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill tone={statusTone(status)}>{statusLabel(status)}</StatusPill>
          <span className="text-row-subtitle text-muted-foreground">
            {dateFrom} — {dateTo}
          </span>
        </div>

        {status === "processing" ? (
          <p className="text-row-subtitle text-muted-foreground">
            Building your export — invoices, counts, and a SHA-256 manifest for this date range.
            This page checks again every few seconds; you can leave and come back.
          </p>
        ) : null}

        {status === "ready" && downloadUrl ? (
          <div className="flex flex-col gap-2">
            <p className="text-row-subtitle text-muted-foreground">
              The packet is ready. The download link expires
              {expiresAt ? ` at ${formatDateTime(expiresAt)}` : " in 10 minutes"} — after that,
              request a new one.
            </p>
            <a
              href={downloadUrl}
              className="flex min-h-tap-min w-fit items-center rounded-md bg-primary px-4 text-label uppercase text-primary-foreground"
            >
              Download ZIP
            </a>
          </div>
        ) : null}

        {status === "unavailable" ? (
          <p className="text-row-subtitle text-muted-foreground">
            {error ?? "This packet expired or the export failed to build."}
          </p>
        ) : null}

        {status === "ready" || status === "unavailable" ? (
          <div>
            <Button type="button" variant="outline" size="tap" onClick={resetToForm}>
              Request a new packet
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
      className="flex flex-col gap-section-gap rounded-md border border-border bg-card p-6"
      noValidate
    >
      <h2 className="text-label uppercase text-muted-foreground">Create audit packet</h2>
      <p className="text-row-subtitle text-muted-foreground">
        Pick a date range to export every invoice and count in it, plus a SHA-256 manifest, as a
        ZIP. Building it happens in the background; a download link is emailed to you and appears
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

      {error ? (
        <p className="rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {error}
        </p>
      ) : null}

      <div>
        <Button type="submit" size="primary" disabled={submitting}>
          {submitting ? "Requesting…" : "Create audit packet"}
        </Button>
      </div>
    </form>
  );
}
