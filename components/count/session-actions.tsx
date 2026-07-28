"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  submitCountAction,
  reviewCountAction,
  closeCountAction,
} from "@/app/actions/counts";
import { ActionBar, ActionBarPrimary } from "@/components/ui/action-bar";
import { Button } from "@/components/ui/button";
import type { Role } from "@/lib/authz";

/**
 * The count session's primary action — derived from role AND status, never
 * from status alone.
 *
 * `closeCountAction`/`reviewCountAction` require owner or manager; staff
 * literally cannot call them. So a staff viewer at `submitted`/`reviewed`
 * gets no action bar at all and a plain "waiting on someone else" note,
 * rather than a button that exists only to reject them.
 *
 * At `closed` this component renders NOTHING. Not a disabled bar — absent.
 * A closed count is immutable (invariant 1), and a greyed-out CLOSE COUNT
 * button implies the state is merely unavailable right now rather than
 * permanent.
 */
export function SessionActions({
  countId,
  status,
  role,
  totalValue,
}: {
  countId: number;
  status: string;
  role: Role;
  /** Owner only, already gated server-side. Drives the two-line button. */
  totalValue?: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (status === "closed") {
    return null;
  }

  const canReviewOrClose = role === "owner" || role === "manager";

  function run(action: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error?.message ?? "Something went wrong.");
        return;
      }
      router.refresh();
    });
  }

  if (status === "draft" || status === "in_progress") {
    return (
      <Bar error={error}>
        <Button
          variant="outline"
          size="primary"
          className="flex-1"
          onClick={() => router.push(`/count/${countId}/scan`)}
        >
          Keep counting
        </Button>
        <ActionBarPrimary
          label={pending ? "Submitting…" : "Submit count"}
          disabled={pending}
          onClick={() => run(() => submitCountAction({ countId }))}
        />
      </Bar>
    );
  }

  if (!canReviewOrClose) {
    return (
      <ActionBar className="justify-center">
        <p className="text-caption text-muted-foreground">
          Submitted. A manager reviews and closes this count.
        </p>
      </ActionBar>
    );
  }

  if (status === "submitted") {
    return (
      <Bar error={error}>
        <ActionBarPrimary
          label={pending ? "Working…" : "Mark reviewed"}
          disabled={pending}
          onClick={() => run(() => reviewCountAction({ countId }))}
        />
      </Bar>
    );
  }

  // reviewed → close. `totalValue` is undefined for a manager, which makes
  // this a single-line button rather than a two-line one with a blank
  // second row (design-system.md §8.3).
  return (
    <Bar error={error}>
      <ActionBarPrimary
        label={pending ? "Closing…" : "Close count"}
        value={totalValue}
        disabled={pending}
        onClick={() => run(() => closeCountAction({ countId }))}
      />
    </Bar>
  );
}

function Bar({ children, error }: { children: React.ReactNode; error: string | null }) {
  return (
    <>
      {error ? (
        <div className="fixed inset-x-0 bottom-[calc(var(--spacing-action-bar))] z-40 px-bar-pad">
          <p className="rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
            {error}
          </p>
        </div>
      ) : null}
      <ActionBar>{children}</ActionBar>
    </>
  );
}
