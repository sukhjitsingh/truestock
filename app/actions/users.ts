"use server";

/**
 * User-management server actions (spec §4, open-items #3).
 *
 * Thin boundary over lib/domain/users.ts: every export checks session + role
 * itself (CLAUDE.md invariant 7) via lib/authz.ts, validates its input with a
 * Zod schema, then hands an explicit `Actor` to the domain layer. All tenant
 * scoping, the owner-self-deactivation guard, and the atomic session revocation
 * live in the domain module — this file only authorizes and validates.
 *
 * Management is owner-only (spec §4): only an owner may change roles or
 * deactivate accounts.
 */
import { requireRole } from "@/lib/authz";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as users from "@/lib/domain/users";
import { updateUserRoleSchema, setUserActiveSchema } from "@/lib/validation/users";

/** Every user in the caller's organization. Owner-only. */
export async function listUsersAction(): Promise<ActionResult<users.ManagedUser[]>> {
  return runAction(async () => {
    const actor = await requireRole("owner");
    return users.listUsers(actor);
  });
}

/** Change a user's role. Owner-only, tenant-scoped. */
export async function updateUserRoleAction(
  input: unknown,
): Promise<ActionResult<users.ManagedUser>> {
  return runAction(async () => {
    const actor = await requireRole("owner");
    const { userId, role } = updateUserRoleSchema.parse(input);
    return users.updateUserRole(actor, userId, role);
  });
}

/**
 * Activate or deactivate a user. Owner-only, tenant-scoped. Deactivation
 * revokes the user's sessions in the same transaction (open-items #3).
 */
export async function setUserActiveAction(
  input: unknown,
): Promise<ActionResult<users.ManagedUser>> {
  return runAction(async () => {
    const actor = await requireRole("owner");
    const { userId, active } = setUserActiveSchema.parse(input);
    return users.setUserActive(actor, userId, active);
  });
}
