"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { openCountAction } from "@/app/actions/counts";
import { Button } from "@/components/ui/button";

/**
 * Opens a new count and drops straight into the first counting leg. All three
 * roles may open a count (spec §4).
 *
 * `full` is the only type offered here. `spot` and `monthly_close` exist in
 * the schema but choosing between three count types is a back-office decision
 * made before anyone picks up the phone, not a question to ask someone
 * standing at the speed rail.
 */
export function StartCountButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function start() {
    setError(null);
    startTransition(async () => {
      const result = await openCountAction({ type: "full" });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      router.push(`/count/${result.data.id}/scan`);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button size="primary" full onClick={start} disabled={pending}>
        {pending ? "Starting…" : "Start a count"}
      </Button>
      {error ? (
        <p className="text-caption text-negative" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
