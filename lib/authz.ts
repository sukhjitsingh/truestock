/**
 * The single place role rules live for Truestock (CLAUDE.md invariant 7 /
 * spec §11: "check session and role inside every server action and route
 * handler, not only in middleware").
 *
 * Every server action and route handler in this app must call
 * `requireRole(...)` (or `requireSession()` if any authenticated user may
 * proceed) as its first line, before touching any input. Nothing here trusts
 * middleware, and nothing here trusts a client-supplied role claim — the role
 * is re-read from the database on every call.
 *
 * Roles (spec §4 / CLAUDE.md):
 *   owner   — everything, including cost/margin data and catalog/vendor
 *             management.
 *   manager — counts, receiving, reorder. No cost/margin visibility.
 *   staff   — count only.
 */

import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { user as userTable, userRoleEnum } from "@/db/schema";

export type Role = (typeof userRoleEnum)[number];

export interface Actor {
  userId: number;
  role: Role;
}

/**
 * Thrown by every function in this module. Server actions should catch this
 * (or let it propagate — the message is always safe to show a client; it
 * never includes anything about *why* in terms of internals) and turn it
 * into whatever error shape the action layer uses.
 */
export class AuthzError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthzError";
    this.status = status;
  }
}

const ROLE_SET = new Set<string>(userRoleEnum);

function isKnownRole(value: string): value is Role {
  return ROLE_SET.has(value);
}

/**
 * Resolves the caller's session AND fails closed on anything that isn't a
 * fully valid, active, known-role account:
 *   - no session at all -> 401
 *   - session references a user that no longer exists -> 403
 *   - user.active === false -> 403 (defence in depth: lib/auth.ts already
 *     refuses to *create* a session for an inactive user, but a session
 *     created before deactivation is still a valid Better Auth session —
 *     this is what catches that on every subsequent request)
 *   - user.role is not one of the three known roles -> 403 (fails closed
 *     rather than guessing a default; a role should never be anything else,
 *     but if the enum is ever widened, unhandled roles must not silently
 *     fall through as authorized)
 *
 * Deliberately re-reads role/active from the database rather than trusting
 * `session.user.role` — Better Auth's session payload is only as fresh as
 * the moment the session was created/cached, and a role change (e.g. an
 * owner demoting a manager) must take effect on the next request, not the
 * next sign-in.
 */
export async function requireSession(): Promise<Actor> {
  const sessionData = await auth.api.getSession({ headers: await headers() });
  if (!sessionData?.session || !sessionData.user) {
    throw new AuthzError(401, "Sign in required.");
  }

  const userId = Number(sessionData.user.id);
  const rows = await db
    .select({ role: userTable.role, active: userTable.active })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  const row = rows[0];

  if (!row) {
    throw new AuthzError(403, "Account not found.");
  }
  if (!row.active) {
    throw new AuthzError(403, "Account is inactive.");
  }
  if (!isKnownRole(row.role)) {
    throw new AuthzError(403, "Account has an unrecognized role.");
  }

  return { userId, role: row.role };
}

/**
 * Resolves the caller and asserts their (freshly-loaded) role is one of
 * `allowed`. This is the function nearly every server action/route handler
 * should call first.
 */
export async function requireRole(...allowed: Role[]): Promise<Actor> {
  const actor = await requireSession();
  if (!allowed.includes(actor.role)) {
    throw new AuthzError(
      403,
      "You do not have permission to perform this action.",
    );
  }
  return actor;
}

/** Cost and margin data (CLAUDE.md invariant 8 / spec §4) is owner-only. */
export function canSeeCost(role: Role): boolean {
  return role === "owner";
}

/** Vendor and catalog-cost management is owner-only. */
export function canManageCost(role: Role): boolean {
  return role === "owner";
}

/** Counts, receiving, reorder — owner and manager. Staff is count-only. */
export function canManageInventoryOps(role: Role): boolean {
  return role === "owner" || role === "manager";
}
