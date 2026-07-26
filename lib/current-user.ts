import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { user as userTable } from "@/db/schema";
import type { Role } from "@/lib/authz";

export interface CurrentUser {
  userId: number;
  name: string;
  email: string;
  role: Role;
}

/**
 * The read-side counterpart to lib/authz.ts's `requireSession`.
 *
 * `requireSession` THROWS, which is right for a server action — the caller
 * turns it into an error result. A layout or page needs to *redirect* to the
 * sign-in screen instead, and a thrown AuthzError inside a React Server
 * Component renders an error boundary rather than a login form.
 *
 * This does NOT weaken invariant 7. It is a navigation helper, not an
 * authorization boundary: every server action still calls `requireRole`
 * itself and re-reads role from the database. Rendering a page is not
 * permission to mutate anything, and nothing here is trusted by a write path.
 *
 * Fails closed identically to `requireSession` — a session pointing at a
 * missing or deactivated user resolves to null, not to a partly-usable
 * identity.
 *
 * `cache()` dedupes this within a single request, so a layout and the page it
 * wraps share one session lookup instead of two.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const sessionData = await auth.api.getSession({ headers: await headers() });
  if (!sessionData?.session || !sessionData.user) {
    return null;
  }

  const userId = Number(sessionData.user.id);
  const [row] = await db
    .select({
      name: userTable.name,
      email: userTable.email,
      role: userTable.role,
      active: userTable.active,
    })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);

  if (!row || !row.active) {
    return null;
  }
  return { userId, name: row.name, email: row.email, role: row.role as Role };
});

/** Resolve the signed-in user or bounce to the sign-in screen. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}

/**
 * Back-office pages only. Staff is count-only (spec §4) and has no
 * back-office surface at all — sent to the counting app rather than shown a
 * "permission denied" page for a screen they will never be able to open.
 */
export async function requireOfficeUser(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role === "staff") {
    redirect("/count");
  }
  return user;
}
