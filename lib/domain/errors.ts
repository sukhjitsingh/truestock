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
