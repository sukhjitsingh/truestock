"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { uploadInvoiceAction, confirmUploadAction } from "@/app/actions/invoices";
import type { VendorSummary } from "@/lib/domain/catalog";
import { invoiceSourceEnum } from "@/db/enums";
import { ACCEPTED_INVOICE_CONTENT_TYPES } from "@/lib/storage/invoice-content-types";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";

type InvoiceSource = (typeof invoiceSourceEnum)[number];

const SOURCE_LABEL: Record<InvoiceSource, string> = {
  photo: "Photo",
  pdf: "PDF",
  email_forward: "Forwarded email",
};

const CONTENT_TYPE_LABEL: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPEG photo",
  "image/png": "PNG photo",
  "image/heic": "HEIC photo",
  "image/webp": "WEBP photo",
};

/** A PDF is a PDF; anything else accepted here is a photographed page. The
 * source select still lets the user correct this (e.g. a scanned email). */
function sourceForContentType(contentType: string): InvoiceSource {
  return contentType === "application/pdf" ? "pdf" : "photo";
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type Stage = "idle" | "hashing" | "requesting" | "uploading" | "verifying" | "verify-failed" | "done";

const PENDING_STAGES: ReadonlySet<Stage> = new Set(["hashing", "requesting", "uploading", "verifying"]);

function stageLabel(stage: Stage): string {
  switch (stage) {
    case "hashing":
      return "Reading file…";
    case "requesting":
      return "Requesting upload slot…";
    case "uploading":
      return "Uploading…";
    case "verifying":
      return "Verifying…";
    default:
      return "Upload invoice";
  }
}

/**
 * The upload + archive handshake — Phase 2.5 Slice 1
 * (docs/plans/phase-2.5-invoice-automation/04-slices.md). Three server
 * round-trips, all required:
 *
 *   1. `uploadInvoiceAction` — creates the `invoice` (status `uploaded`) and
 *      `extraction_job` (status `awaiting_upload`) rows, returns where to
 *      PUT the bytes.
 *   2. `PUT` the raw file to that URL (`app/api/invoices/[id]/file/route.ts`).
 *   3. `confirmUploadAction` — re-derives SHA-256 and byte length from what
 *      actually landed on disk and only THEN moves the job to `queued`.
 *
 * The byte length and SHA-256 declared in step 1 are computed in the
 * browser (`crypto.subtle.digest`) — never trusted from the `File` object's
 * own `size`/`type`, which is exactly what step 3 exists to catch if this
 * client lied or the network mangled the body.
 *
 * `confirmUploadAction`'s `matched: false` means the bytes on disk didn't
 * verify. This is never reported as success — see `putAndConfirm` below.
 * The retry button re-runs steps 2+3 only, against the SAME `invoiceId`
 * `uploadInvoiceAction` already created; retrying step 1 as well would
 * create a second `invoice`/`extraction_job` pair for one file, since
 * `uploadInvoiceAction` has no idempotency key of its own (unlike
 * count-line writes' `client_line_id`).
 *
 * Every awaited call is wrapped in try/catch. A server action that throws
 * while offline produces no error and no state change if left unguarded — a
 * known trap in this repo (see AGENTS.md) — which would leave the stage
 * stuck mid-upload with nothing on screen explaining why.
 *
 * Plain `useState` + manual validation, matching `VendorEditForm` and
 * `LocationEditForm` (the established pattern in this codebase for office
 * forms) rather than React Hook Form — there is no multi-field schema
 * validation problem here that RHF would earn its keep on, and every
 * sibling form in `components/office/` uses this shape.
 */
export function InvoiceUploadForm({ vendors }: { vendors: VendorSummary[] }) {
  const router = useRouter();

  const [file, setFile] = useState<File | null>(null);
  const [contentType, setContentType] = useState("");
  const [source, setSource] = useState<InvoiceSource>("photo");
  const [vendorId, setVendorId] = useState("");

  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const pending = PENDING_STAGES.has(stage);

  function reset() {
    setFile(null);
    setContentType("");
    setSource("photo");
    setVendorId("");
    setInvoiceId(null);
    setUploadUrl(null);
    setStage("idle");
    setError(null);
    setFieldErrors({});
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setError(null);
    setFieldErrors({});
    setStage("idle");
    setInvoiceId(null);
    setUploadUrl(null);

    if (!selected) {
      setFile(null);
      setContentType("");
      return;
    }
    if (!ACCEPTED_INVOICE_CONTENT_TYPES.includes(selected.type)) {
      setFile(null);
      setContentType("");
      setError("That file type isn't supported. Choose a PDF, JPEG, PNG, HEIC, or WEBP file.");
      return;
    }
    setFile(selected);
    setContentType(selected.type);
    setSource(sourceForContentType(selected.type));
  }

  /**
   * Steps 2 + 3 — factored out so the retry button can re-run exactly this
   * and nothing else. Never sets `stage("done")` on a `matched: false` or a
   * failed PUT — the whole point of the handshake is that "the bytes are on
   * the server" is not the same claim as "the bytes are verified", and this
   * function is the only place that gets to say the second one.
   */
  async function putAndConfirm(id: number, url: string, bytes: File, type: string) {
    setStage("uploading");
    setError(null);
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": type },
        body: bytes,
      });
      // 409 is not a failure to fall out on — it is the server saying these
      // bytes already landed and were already confirmed. The only way to
      // reach it from THIS form is the retry path after a confirm whose
      // RESPONSE was lost: the upload genuinely succeeded, the job is
      // already past `awaiting_upload`, and the invoice is sitting in the
      // archive below. Treating it as "the file failed to upload" would put
      // the user in a loop retrying something that is already done, with a
      // permanent error on screen contradicting the row they can see.
      //
      // So fall through to confirm instead. `markUploadConfirmed` replays as
      // a no-op against an already-confirmed invoice — that is its documented
      // contract and it is enforced under the same row lock the 409 came
      // from (`lib/domain/extraction.ts:lockJobForUpload`) — so it returns
      // `matched: true` and this ends where it should have the first time.
      if (!response.ok && response.status !== 409) {
        setStage("verify-failed");
        setError("The file failed to upload. Check your connection and try again.");
        return;
      }
    } catch {
      setStage("verify-failed");
      setError("Could not reach the server to upload the file. Check your connection and try again.");
      return;
    }

    setStage("verifying");
    try {
      const result = await confirmUploadAction({ invoiceId: id });
      if (!result.ok) {
        setStage("verify-failed");
        setError(result.error.message);
        return;
      }
      if (!result.data.matched) {
        setStage("verify-failed");
        setError("The uploaded file didn't verify against what was declared. Try uploading it again.");
        return;
      }
      setStage("done");
      router.refresh();
    } catch {
      setStage("verify-failed");
      setError("Could not reach the server to verify the upload. Check your connection and try again.");
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("Choose a file first.");
      return;
    }

    setError(null);
    setFieldErrors({});
    setStage("hashing");

    let fileSha256: string;
    let fileSizeBytes: number;
    try {
      const buffer = await file.arrayBuffer();
      fileSizeBytes = buffer.byteLength;
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      fileSha256 = toHex(digest);
    } catch {
      setStage("idle");
      setError("Could not read the file. Try choosing it again.");
      return;
    }

    setStage("requesting");
    try {
      const result = await uploadInvoiceAction({
        ...(vendorId ? { vendorId: Number(vendorId) } : {}),
        source,
        contentType,
        fileSha256,
        fileSizeBytes,
      });
      if (!result.ok) {
        setStage("idle");
        setError(result.error.message);
        setFieldErrors(result.error.fieldErrors ?? {});
        return;
      }
      setInvoiceId(result.data.invoiceId);
      setUploadUrl(result.data.uploadUrl);
      await putAndConfirm(result.data.invoiceId, result.data.uploadUrl, file, contentType);
    } catch {
      setStage("idle");
      setError("Could not reach the server. Check your connection and try again.");
    }
  }

  function handleRetry() {
    if (invoiceId == null || uploadUrl == null || !file) return;
    void putAndConfirm(invoiceId, uploadUrl, file, contentType);
  }

  return (
    <form method="post" onSubmit={handleSubmit} className="flex flex-col gap-section-gap" noValidate>
      <h2 className="text-label uppercase text-muted-foreground">Upload an invoice</h2>

      <Field
        label="File"
        htmlFor="invoice-file"
        error={fieldErrors.fileSha256 ?? fieldErrors.fileSizeBytes ?? fieldErrors.contentType}
        hint="PDF, JPEG, PNG, HEIC, or WEBP — up to 25 MB."
      >
        <input
          id="invoice-file"
          type="file"
          accept={ACCEPTED_INVOICE_CONTENT_TYPES.join(",")}
          onChange={handleFileChange}
          disabled={pending}
          className="min-h-tap-min rounded-md border border-input bg-card px-3 py-2 text-body text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-label file:uppercase file:text-primary-foreground"
        />
      </Field>

      {file ? (
        <p className="text-caption text-muted-foreground">
          {file.name} · {CONTENT_TYPE_LABEL[contentType] ?? contentType} · {(file.size / 1024).toFixed(0)} KB
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Vendor" htmlFor="invoice-vendor" error={fieldErrors.vendorId} hint="Optional — leave blank if unknown.">
          <Select id="invoice-vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)} disabled={pending}>
            <option value="">No vendor set</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="How it arrived" htmlFor="invoice-source">
          <Select
            id="invoice-source"
            value={source}
            onChange={(e) => setSource(e.target.value as InvoiceSource)}
            disabled={pending}
          >
            {invoiceSourceEnum.map((value) => (
              <option key={value} value={value}>
                {SOURCE_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {error ? (
        <p className="rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {error}
        </p>
      ) : null}
      {stage === "done" ? (
        <p className="rounded-md bg-success-bg px-3 py-2 text-caption text-success" role="status">
          Uploaded and verified — it&apos;s in the archive below.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {stage === "verify-failed" ? (
          <Button type="button" variant="outline" size="tap" onClick={handleRetry}>
            Retry upload
          </Button>
        ) : (
          <Button type="submit" size="primary" disabled={pending || !file}>
            {stageLabel(stage)}
          </Button>
        )}
        {stage === "done" ? (
          <button
            type="button"
            onClick={reset}
            className="text-caption text-muted-foreground underline hover:text-foreground"
          >
            Upload another
          </button>
        ) : null}
      </div>
    </form>
  );
}
