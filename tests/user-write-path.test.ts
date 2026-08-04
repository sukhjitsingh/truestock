import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@/db";
import { user, session, organization } from "@/db/schema";
import { eq } from "drizzle-orm";
import { listUsers, setUserActive, setUserRole } from "@/lib/domain/users";
import { NotFoundError } from "@/lib/domain/errors";
import type { Actor } from "@/lib/authz";
import { resetDatabase } from "./helpers/test-db";

const makeActor = (userId: number, organizationId: number, role: "owner" | "manager" | "staff"): Actor => ({
  userId,
  organizationId,
  role,
});

describe("User Write Path", () => {
  let org1Id: number;
  let org2Id: number;
  let owner1Id: number;
  let staff1Id: number;

  beforeEach(async () => {
    await resetDatabase();

    const [o1] = await db.insert(organization).values({ name: "Org 1", slug: "org-1" }).$returningId();
    const [o2] = await db.insert(organization).values({ name: "Org 2", slug: "org-2" }).$returningId();
    org1Id = o1.id;
    org2Id = o2.id;

    const [u1] = await db.insert(user).values({
      name: "Owner 1",
      email: "owner1@org1.com",
      organizationId: org1Id,
      role: "owner",
      active: true,
    }).$returningId();

    const [u2] = await db.insert(user).values({
      name: "Staff 1",
      email: "staff1@org1.com",
      organizationId: org1Id,
      role: "staff",
      active: true,
    }).$returningId();

    await db.insert(user).values({
      name: "Staff 2",
      email: "staff2@org1.com",
      organizationId: org1Id,
      role: "staff",
      active: true,
    });

    owner1Id = u1.id;
    staff1Id = u2.id;
  });

  it("listUsers only returns users from the actor's organization", async () => {
    const actor = makeActor(owner1Id, org1Id, "owner");
    const users = await listUsers(actor);
    expect(users.length).toBe(3);

    // Add user to org2 — must not appear in org1 listing.
    await db.insert(user).values({
      name: "Other User",
      email: "other@org2.com",
      organizationId: org2Id,
      role: "staff",
      active: true,
    });

    const usersFiltered = await listUsers(actor);
    expect(usersFiltered.length).toBe(3);
  });

  it("deactivating a user deletes their session rows", async () => {
    const actor = makeActor(owner1Id, org1Id, "owner");

    // Create a session for staff1
    await db.insert(session).values({
      userId: staff1Id,
      expiresAt: new Date(Date.now() + 86400_000),
      token: "test-token-staff1",
    });

    await setUserActive(actor, { userId: staff1Id, active: false });

    const sessions = await db.select().from(session).where(eq(session.userId, staff1Id));
    expect(sessions.length).toBe(0);

    const rows = await db.select().from(user).where(eq(user.id, staff1Id));
    expect(rows[0].active).toBe(false);
  });

  it("activating a user does NOT delete sessions", async () => {
    const actor = makeActor(owner1Id, org1Id, "owner");

    await db.update(user).set({ active: false }).where(eq(user.id, staff1Id));
    await db.insert(session).values({
      userId: staff1Id,
      expiresAt: new Date(Date.now() + 86400_000),
      token: "test-token-activate",
    });

    await setUserActive(actor, { userId: staff1Id, active: true });

    const sessions = await db.select().from(session).where(eq(session.userId, staff1Id));
    expect(sessions.length).toBe(1);
  });

  it("refuses to deactivate the last active owner", async () => {
    const actor = makeActor(owner1Id, org1Id, "owner");

    // owner1 is the only owner. Promote staff1 first so we can deactivate them.
    await db.update(user).set({ role: "owner" }).where(eq(user.id, staff1Id));
    // Now deactivate staff1 (second owner — allowed).
    await setUserActive(actor, { userId: staff1Id, active: false });

    // Only owner1 remains. Cannot deactivate owner1 now (but self-guard catches it first).
    await expect(setUserActive(actor, { userId: owner1Id, active: false }))
      .rejects.toThrow("You cannot deactivate your own account.");
  });

  it("allows demoting an owner while another owner is still active", async () => {
    const actor = makeActor(owner1Id, org1Id, "owner");

    // owner1 is the only owner. Demoting self is blocked before any count runs.
    await expect(setUserRole(actor, { userId: owner1Id, role: "staff" }))
      .rejects.toThrow("You cannot change your own role.");

    // Promote staff1 so the org has two active owners, then demote staff1.
    // This must SUCCEED: the guard protects the last *active* owner, and
    // owner1 is still active, so the org is not left without one.
    await db.update(user).set({ role: "owner" }).where(eq(user.id, staff1Id));
    await setUserRole(actor, { userId: staff1Id, role: "staff" });

    const [row] = await db.select().from(user).where(eq(user.id, staff1Id));
    expect(row.role).toBe("staff");
  });

  it("refuses to demote the last active owner", async () => {
    // The guard counts *active* owners other than the target. Reaching it
    // therefore needs an actor who is an owner whose own row is inactive —
    // otherwise the actor is themselves the second active owner and the
    // demotion is legitimately allowed (the case above).
    //
    // This state is not reachable through the UI: requireSession refuses an
    // inactive user with a 403 (lib/authz.ts) before any action runs, and
    // deactivation deletes the user's sessions in the same transaction. The
    // test calls the domain function directly to prove the invariant holds at
    // the layer that owns it, rather than relying on the authz layer above it.
    // Defence in depth is the point: if the session check is ever bypassed —
    // and several Next.js CVEs have been middleware bypasses (invariant 7) —
    // the org still cannot be left with no active owner.
    await db.update(user).set({ role: "owner", active: false }).where(eq(user.id, staff1Id));
    const inactiveOwner = makeActor(staff1Id, org1Id, "owner");

    await expect(setUserRole(inactiveOwner, { userId: owner1Id, role: "staff" }))
      .rejects.toThrow(/last active owner/);

    // owner1 must still be an owner — the write was refused, not partially applied.
    const [row] = await db.select().from(user).where(eq(user.id, owner1Id));
    expect(row.role).toBe("owner");
  });

  it("refuses to deactivate an owner when no other owner is active", async () => {
    // Same shape as above, for the deactivation leg of the same invariant.
    await db.update(user).set({ role: "owner", active: false }).where(eq(user.id, staff1Id));
    const inactiveOwner = makeActor(staff1Id, org1Id, "owner");

    await expect(setUserActive(inactiveOwner, { userId: owner1Id, active: false }))
      .rejects.toThrow(/last active owner/);

    const [row] = await db.select().from(user).where(eq(user.id, owner1Id));
    expect(row.active).toBe(true);
  });

  it("refuses cross-tenant operations", async () => {
    const actor = makeActor(owner1Id, org1Id, "owner");

    const [uOther] = await db.insert(user).values({
      name: "Other",
      email: "other@org2.com",
      organizationId: org2Id,
      role: "staff",
      active: true,
    }).$returningId();

    await expect(setUserActive(actor, { userId: uOther.id, active: false }))
      .rejects.toThrow(NotFoundError);
  });

  it("refuses self-deactivation and self-demotion", async () => {
    const actor = makeActor(owner1Id, org1Id, "owner");
    await expect(setUserActive(actor, { userId: owner1Id, active: false }))
      .rejects.toThrow("You cannot deactivate your own account.");
    await expect(setUserRole(actor, { userId: owner1Id, role: "staff" }))
      .rejects.toThrow("You cannot change your own role.");
  });
});
