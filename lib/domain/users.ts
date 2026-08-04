/**
 * User management domain functions.
 *
 * Only owners may list, activate/deactivate, or change roles of other users
 * (spec §4, CLAUDE.md invariant 9). All queries are scoped to
 * `actor.organizationId` — a cross-tenant lookup returns NotFound, never data.
 *
 * Guards that prevent a lockout:
 *   - Self-deactivation and self-demotion are blocked unconditionally.
 *   - Deactivating or demoting the last active owner in the organization is
 *     blocked. This ensures at least one owner can always sign in.
 */

import { and, eq, ne, count } from "drizzle-orm";
import { db } from "@/db";
import { user, session } from "@/db/schema";
import type { Actor } from "@/lib/authz";
import { DomainError, NotFoundError } from "@/lib/domain/errors";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface UserSummary {
  id: number;
  name: string;
  email: string;
  role: "owner" | "manager" | "staff";
  active: boolean;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List all users belonging to the actor's organization.
 * Owner-only (enforced in the server action; checked here too for defence).
 */
export async function listUsers(actor: Actor): Promise<UserSummary[]> {
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
    })
    .from(user)
    .where(eq(user.organizationId, actor.organizationId))
    .orderBy(user.name);

  return rows as UserSummary[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert the target user exists and belongs to the actor's org. */
async function requireOwnUser(
  actor: Actor,
  userId: number,
): Promise<typeof user.$inferSelect> {
  const rows = await db
    .select()
    .from(user)
    .where(
      and(eq(user.id, userId), eq(user.organizationId, actor.organizationId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("User");
  return row;
}

/**
 * Count active owners in the organization (excluding a specific user id).
 * Used to prevent last-owner lockout.
 */
async function countActiveOwners(
  organizationId: number,
  excludingUserId: number,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(user)
    .where(
      and(
        eq(user.organizationId, organizationId),
        eq(user.role, "owner"),
        eq(user.active, true),
        ne(user.id, excludingUserId),
      ),
    );
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Activate or deactivate a user.
 *
 * Deactivation deletes all of the user's session rows in the same transaction,
 * so the user is locked out on their very next request (ROADMAP.md Phase 1.5,
 * open-item #3). This is the one place that guarantee lives.
 */
export async function setUserActive(
  actor: Actor,
  input: { userId: number; active: boolean },
): Promise<void> {
  if (input.userId === actor.userId) {
    throw new DomainError("SELF_DEACTIVATE", "You cannot deactivate your own account.");
  }

  const target = await requireOwnUser(actor, input.userId);

  // Prevent deactivating the last active owner.
  if (!input.active && target.role === "owner") {
    const remaining = await countActiveOwners(
      actor.organizationId,
      input.userId,
    );
    if (remaining === 0) {
      throw new DomainError(
        "LAST_OWNER",
        "Cannot deactivate the last active owner. Promote another user to owner first.",
      );
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(user)
      .set({ active: input.active })
      .where(
        and(
          eq(user.id, input.userId),
          eq(user.organizationId, actor.organizationId),
        ),
      );

    // Revoke all sessions when deactivating so the next request is refused
    // by requireSession (authz.ts) even before the session expires.
    if (!input.active) {
      await tx
        .delete(session)
        .where(eq(session.userId, input.userId));
    }
  });
}

/**
 * Change a user's role.
 *
 * Self-demotion is blocked. Demoting the last active owner is blocked.
 */
export async function setUserRole(
  actor: Actor,
  input: { userId: number; role: "owner" | "manager" | "staff" },
): Promise<void> {
  if (input.userId === actor.userId) {
    throw new DomainError("SELF_ROLE_CHANGE", "You cannot change your own role.");
  }

  const target = await requireOwnUser(actor, input.userId);

  // Prevent demoting the last active owner.
  if (target.role === "owner" && input.role !== "owner") {
    const remaining = await countActiveOwners(
      actor.organizationId,
      input.userId,
    );
    if (remaining === 0) {
      throw new DomainError(
        "LAST_OWNER",
        "Cannot demote the last active owner. Promote another user to owner first.",
      );
    }
  }

  await db
    .update(user)
    .set({ role: input.role })
    .where(
      and(
        eq(user.id, input.userId),
        eq(user.organizationId, actor.organizationId),
      ),
    );
}
