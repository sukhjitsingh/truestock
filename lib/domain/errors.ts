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
