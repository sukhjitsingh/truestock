import Link from "next/link";
import { ChevronLeft, Building2, ShieldCheck } from "lucide-react";
import { requireUser } from "@/lib/current-user";
import { SignOutButton } from "@/components/count/sign-out-button";
import { StatusPill } from "@/components/ui/status-pill";

export const metadata = { title: "Account · Truestock" };

/**
 * Mobile Shift Account & Session Info (`/count/account`, Target 12)
 *
 * Displays active shift credentials, organization boundary, user role badge,
 * and session revocation sign-out trigger (Invariant 11).
 */
export default async function AccountPage() {
  const user = await requireUser();

  const initials = user.name
    ? user.name
        .split(/\s+/)
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "U";

  const roleTitle =
    user.role === "owner"
      ? "Owner Role"
      : user.role === "manager"
        ? "Manager Role"
        : "Staff Role";

  return (
    <div className="px-bar-pad pb-action-bar pt-4">
      {/* Top Header Bar */}
      <header className="flex items-center justify-between border-b border-border/60 pb-3.5">
        <Link
          href="/count"
          aria-label="Back to Floor Count Hub"
          className="flex size-11 items-center justify-center rounded-full border border-border/80 bg-card/85 text-foreground backdrop-blur-md shadow-xs transition-all hover:border-accent/40 active:scale-95"
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
        </Link>
        <span className="text-screen-title font-semibold uppercase tracking-wider text-foreground">
          Shift Account
        </span>
        <div className="size-11" aria-hidden="true" />
      </header>

      {/* Screen Title & Subtitle */}
      <div className="pt-4">
        <h1 className="text-header-title text-foreground">Active Session</h1>
        <p className="mt-0.5 text-row-subtitle text-muted-foreground">
          Floor counter profile and authenticated device shift
        </p>
      </div>

      {/* Shift User Profile Card */}
      <div className="glass-card mt-section-gap p-card-pad">
        <div className="flex items-start gap-4">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-accent text-numeral-md font-bold text-accent-foreground shadow-md">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <h2 className="truncate text-row-title font-bold text-card-foreground">
                {user.name}
              </h2>
              <StatusPill tone="success">Active Shift</StatusPill>
            </div>
            <p className="truncate text-row-subtitle text-muted-foreground">{user.email}</p>

            <div className="mt-2.5 flex items-center gap-1.5 text-caption font-semibold text-accent">
              <ShieldCheck className="size-4" aria-hidden="true" />
              <span>{roleTitle}</span>
            </div>
          </div>
        </div>

        {/* Organization / Tenant Boundary Context */}
        <div className="mt-4 flex items-center gap-2.5 border-t border-border/80 pt-3 text-caption text-muted-foreground">
          <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">The Brass Door Bar &amp; Grill</span>
        </div>
      </div>

      {/* Session Actions */}
      <div className="mt-section-gap">
        <p className="mb-2 text-label uppercase text-muted-foreground font-semibold">
          Shift Actions
        </p>
        <SignOutButton />
      </div>

      <p className="mt-4 text-center text-caption text-muted-foreground">
        Roles and accounts are configured by the bar owner. There is no self-signup.
      </p>
    </div>
  );
}

