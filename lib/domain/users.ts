/**
 * User management domain logic (spec §4, open-items #3).
 *
 * Every function here takes an `Actor` explicitly rather than reaching for the
 * session itself — same shape as lib/domain/counts.ts — so the tenant boundary
 * is a parameter the caller (app/actions/users.ts) is forced to supply from
 * `requireRole`, and so this logic is testable against a real database without
 * a mocked Better Auth session.
 *
 * The one invariant that makes this module worth isolating: **deactivating a
 * user must revoke their sessions in the same transaction as flipping
 * `active`** (open-items #3). lib/authz.ts already re-reads `active` on every
 * request and refuses an inactive account (defence in depth), but a live
 * session row left behind is a still-valid Better Auth credential — deleting it
 * atomically is what turns "deactivated" into "logged out right now" with no
 * window in between.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { user as userTable, session as sessionTable } from "@/db/schema";
import type { Actor, Role } from "@/lib/authz";
import { NotFoundError, ConflictError } from "@/lib/domain/errors";

export interface ManagedUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  active: boolean;
}

/** Every user in the actor's organization (invariant 9: tenant-scoped read). */
export async function listUsers(actor: Actor): Promise<ManagedUser[]> {
  return db
    .select({
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
      role: userTable.role,
      active: userTable.active,
    })
    .from(userTable)
    .where(eq(userTable.organizationId, actor.organizationId));
}

/**
 * Load one user, scoped to the actor's tenant. A cross-tenant id returns
 * NotFound rather than an answer that confirms the row exists elsewhere
 * (invariant 9). Shared by the mutations below so every write ownership-checks
 * before it touches anything.
 */
async function requireUserInOrg(actor: Actor, userId: number): Promise<ManagedUser> {
  const [row] = await db
    .select({
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
      role: userTable.role,
      active: userTable.active,
    })
    .from(userTable)
    .where(
      and(eq(userTable.id, userId), eq(userTable.organizationId, actor.organizationId)),
    )
    .limit(1);

  if (!row) {
    throw new NotFoundError("User");
  }
  return row;
}

/** Change a user's role. Tenant-scoped; the target must be in the actor's org. */
export async function updateUserRole(
  actor: Actor,
  userId: number,
  role: Role,
): Promise<ManagedUser> {
  await requireUserInOrg(actor, userId);

  await db
    .update(userTable)
    .set({ role })
    .where(
      and(eq(userTable.id, userId), eq(userTable.organizationId, actor.organizationId)),
    );

  return requireUserInOrg(actor, userId);
}

/**
 * Activate or deactivate a user.
 *
 * When deactivating, the `active` flip and the delete of every session row for
 * that user happen in ONE transaction — the guarantee this whole module exists
 * for. If the session delete fails, the deactivation rolls back with it, so the
 * two can never disagree.
 *
 * Two guards before we get there:
 *   - an owner cannot deactivate themselves (locking the last owner out of
 *     their own org is not a recoverable mistake through this UI)
 *   - the target must be in the actor's organization (invariant 9)
 */
export async function setUserActive(
  actor: Actor,
  userId: number,
  active: boolean,
): Promise<ManagedUser> {
  if (!active && actor.userId === userId) {
    throw new ConflictError("You cannot deactivate your own account.");
  }

  await requireUserInOrg(actor, userId);

  await db.transaction(async (tx) => {
    await tx
      .update(userTable)
      .set({ active })
      .where(
        and(
          eq(userTable.id, userId),
          eq(userTable.organizationId, actor.organizationId),
        ),
      );

    if (!active) {
      // Kill every live session for this user. onDelete: cascade on
      // session.userId would also drop these if the row were deleted, but we
      // never delete the user (invariant 6) — so the revoke is explicit and
      // in the same transaction as the flip above.
      await tx.delete(sessionTable).where(eq(sessionTable.userId, userId));
    }
  });

  return requireUserInOrg(actor, userId);
}
