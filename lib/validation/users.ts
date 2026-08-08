/**
 * Zod schemas for the user-management boundary (app/actions/users.ts).
 *
 * These validate the shape of client input before it reaches the domain
 * layer. Ownership and tenant scoping are NOT expressed here — those are
 * enforced in lib/domain/users.ts against the actor, because a schema cannot
 * know which organization a caller belongs to.
 */
import { z } from "zod";
import { userRoleEnum } from "@/db/schema";

export const roleSchema = z.enum(userRoleEnum);

/** A positive integer user id. Coerced so a form value ("3") is accepted. */
const userIdSchema = z.coerce.number().int().positive();

export const updateUserRoleSchema = z.object({
  userId: userIdSchema,
  role: roleSchema,
});
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;

export const setUserActiveSchema = z.object({
  userId: userIdSchema,
  active: z.boolean(),
});
export type SetUserActiveInput = z.infer<typeof setUserActiveSchema>;
