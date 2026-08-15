/**
 * Domain-level errors. These carry a message that is always safe to show a
 * client verbatim (never an internal detail, SQL error, or stack trace) — see
 * lib/action-result.ts for how they're turned into ActionResults.
 */
export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super("NOT_FOUND", `${what} not found.`);
  }
}

/** CLAUDE.md invariant 1: closed counts are immutable. */
export class ClosedCountError extends DomainError {
  constructor() {
    super("COUNT_CLOSED", "This count is closed and can no longer be changed.");
  }
}

/**
 * A count that has been handed on — submitted or reviewed — but not yet
 * closed. Invariant 1 only names `closed`, so this is a narrower rule laid on
 * top of it rather than the invariant itself, and it is deliberately a
 * SEPARATE error: "closed and immutable forever" and "submitted, so reopen it
 * if you meant to keep counting" are different situations with different
 * remedies, and one message for both would describe neither.
 *
 * Why writes stop here at all: submission is already presented as a freeze —
 * `SessionActions` removes "Keep counting" the moment a count is submitted —
 * while the write path went on accepting scans from anyone who reached the
 * scan URL directly. A reviewer marking a count reviewed while someone is
 * still scanning would otherwise sign off on numbers that changed afterwards.
 */
export class CountNotWritableError extends DomainError {
  constructor(status: string) {
    super(
      "COUNT_NOT_WRITABLE",
      `This count has been ${status} and is no longer being counted. Reopen it if you need to keep counting.`,
    );
  }
}

/** Count lifecycle transition attempted out of order. */
export class InvalidCountTransitionError extends DomainError {
  constructor(message: string) {
    super("INVALID_COUNT_TRANSITION", message);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super("CONFLICT", message);
  }
}

/**
 * Phase 2.5 invariant 1's mirror for invoices: an edge not present in
 * `INVOICE_TRANSITIONS` (lib/domain/invoices.ts) — including anything OUT of
 * `approved`, which is terminal — is refused with this rather than attempted.
 */
export class InvalidInvoiceTransitionError extends DomainError {
  constructor(message: string) {
    super("INVALID_INVOICE_TRANSITION", message);
  }
}

/**
 * Thrown when a transition into `reviewed` is attempted while a required
 * document field (invoice_date, invoice_number, total_gross, total_net,
 * currency, retention_until) is still NULL. The database cannot express this
 * constraint — those columns are nullable because extraction hasn't run yet
 * at upload time (db/schema.ts's `invoice` table comment) — so it is enforced
 * here, on the CAS transition itself, with a test asserting it fires.
 */
export class InvoiceNotWritableError extends DomainError {
  constructor(message: string) {
    super("INVOICE_NOT_WRITABLE", message);
  }
}

/**
 * [AR-6] `extraction_job`'s mirror of `InvalidInvoiceTransitionError`. An
 * edge not present in the lifecycle `lib/domain/extraction.ts` declares
 * (`awaiting_upload -> queued -> running -> done | failed`, plus the reap
 * sweep's `running -> queued` retry) — including anything out of `done` or
 * `failed`, both terminal — is refused with this BEFORE the CAS `UPDATE` is
 * attempted, never written even when the row happens to currently be at
 * `from`. Without this, `updateJobStatus(id, 'done', 'queued')` against a
 * job that genuinely is `done` would succeed: the CAS only checks "is the row
 * at the state I expect," not "is this edge legal," and a job silently
 * un-terminated back onto the queue is exactly the kind of state the
 * lifecycle was declared to rule out.
 */
export class InvalidExtractionTransitionError extends DomainError {
  constructor(message: string) {
    super("INVALID_EXTRACTION_TRANSITION", message);
  }
}
