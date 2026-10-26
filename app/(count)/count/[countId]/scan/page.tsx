import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/current-user";
import { getCountAction } from "@/app/actions/counts";
import { listLocationsAction } from "@/app/actions/catalog";
import { CountLeg } from "@/components/count/count-leg";
import { parseScanParams } from "@/lib/scan-params";

/**
 * The counting leg. Everything interactive lives in `CountLeg`; this page's
 * job is to authorize, load, and refuse to open a count that can't be written
 * to.
 */
export default async function ScanPage({
  params,
  searchParams,
}: {
  params: Promise<{ countId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const countId = Number((await params).countId);
  if (!Number.isInteger(countId) || countId <= 0) notFound();

  const [detail, locations] = await Promise.all([
    getCountAction({ countId }),
    listLocationsAction(),
  ]);

  if (!detail.ok || !locations.ok) notFound();

  // Invariant 1: a closed count takes no writes, ever. Sending someone into a
  // scanning screen that would reject every scan is worse than not opening it
  // — they would count a whole section before finding out.
  //
  // Submitted and reviewed counts are refused here for the same reason, and
  // this redirect is the half that makes the rule usable rather than merely
  // enforced. `assertCountWritable` rejects those statuses at the write, so
  // without this the screen would open, accept taps, and fail on every single
  // save — which is the "count a whole section before finding out" failure
  // written slightly differently.
  if (
    detail.data.count.status === "closed" ||
    detail.data.count.status === "submitted" ||
    detail.data.count.status === "reviewed"
  ) {
    redirect(`/count/${countId}`);
  }

  // A deep link (the Edit arrow on a counted line) may name the leg to open.
  // Validated against the ACTIVE locations loaded above, never trusted from the
  // URL: a retired or foreign id must land on the picker, not start a leg that
  // writes into it. Anything invalid falls back to the picker silently.
  const { locationId } = parseScanParams(
    await searchParams,
    locations.data.map((l) => l.id),
  );

  return (
    <CountLeg
      countId={countId}
      locations={locations.data}
      initialLines={detail.data.lines}
      canSeeCost={user.role === "owner"}
      initialLocationId={locationId}
    />
  );
}
