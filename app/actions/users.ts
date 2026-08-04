"use server";

/**
 * User management server actions.
 *
 * Owner-only. Every action re-reads the caller's role from the database
 * (CLAUDE.md invariant 7) via requireRole. Business logic lives in
 * lib/domain/users.ts; these are thin: authorize, validate, delegate.
 */

import { requireRole } from "@/lib/authz";
import { runAction, type ActionResult } from "@/lib/action-result";
import { listUsers, setUserActive, setUserRole } from "@/lib/domain/users";
import type { UserSummary } from "@/lib/domain/users";
import { z } from "zod";

const setUserActiveSchema = z.object({
  userId: z.number().int().positive(),
  active: z.boolean(),
});

const setUserRoleSchema = z.object({
  userId: z.number().int().positive(),
  role: z.enum(["owner", "manager", "staff"]),
});

export async function actionListUsers(): Promise<ActionResult<UserSummary[]>> {
  return runAction(async () => {
    const actor = await requireRole("owner");
    return listUsers(actor);
  });
}

export async function actionSetUserActive(
  input: unknown,
): Promise<ActionResult<void>> {
  return runAction(async () => {
    const actor = await requireRole("owner");
    const parsed = setUserActiveSchema.parse(input);
    return setUserActive(actor, parsed);
  });
}

export async function actionSetUserRole(
  input: unknown,
): Promise<ActionResult<void>> {
  return runAction(async () => {
    const actor = await requireRole("owner");
    const parsed = setUserRoleSchema.parse(input);
    return setUserRole(actor, parsed);
  });
}
