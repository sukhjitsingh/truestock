/**
 * Shared result shape + error handling for every server action in
 * app/actions/*. Keeps two promises from CLAUDE.md at once:
 *   - "Errors returned to the client are actionable and never leak
 *     internals" — anything that isn't a recognized domain error (AuthzError,
 *     ValidationError, DomainError) is logged server-side and collapsed to a
 *     generic message before it reaches the client.
 *   - Zod issues are surfaced with enough detail to fix the input (field +
 *     message), not just "invalid input".
 */

import { ZodError } from "zod";
import { AuthzError } from "@/lib/authz";
import { DomainError } from "@/lib/domain/errors";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; fieldErrors?: Record<string, string> } };

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function actionError(
  message: string,
  fieldErrors?: Record<string, string>,
): ActionResult<never> {
  return { ok: false, error: { message, fieldErrors } };
}

/**
 * Wrap a server action body so every action gets consistent error handling
 * without repeating the same try/catch in every file. The action's body
 * throws on failure (AuthzError, DomainError, ZodError, or anything else);
 * this turns that into a safe ActionResult.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return ok(data);
  } catch (err) {
    if (err instanceof AuthzError) {
      return actionError(err.message);
    }
    if (err instanceof DomainError) {
      return actionError(err.message);
    }
    if (err instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of err.issues) {
        const key = issue.path.join(".") || "_root";
        if (!fieldErrors[key]) {
          fieldErrors[key] = issue.message;
        }
      }
      return actionError("Some fields need attention.", fieldErrors);
    }
    // Unknown failure: log the real error server-side for debugging, but
    // never forward its message or stack to the client — it could contain
    // SQL, file paths, or other internals.
    console.error("[action] unhandled error", err);
    return actionError("Something went wrong. Please try again.");
  }
}
