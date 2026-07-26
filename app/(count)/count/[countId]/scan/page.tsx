import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/current-user";
import { getCountAction } from "@/app/actions/counts";
import { listLocationsAction } from "@/app/actions/catalog";
import { CountLeg } from "@/components/count/count-leg";

/**
 * The counting leg. Everything interactive lives in `CountLeg`; this page's
 * job is to authorize, load, and refuse to open a count that can't be written
 * to.
 */
export default async function ScanPage({
  params,
}: {
  params: Promise<{ countId: string }>;
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
  if (detail.data.count.status === "closed") {
    redirect(`/count/${countId}`);
  }

  return (
    <CountLeg
      countId={countId}
      locations={locations.data}
      initialLines={detail.data.lines}
      canSeeCost={user.role === "owner"}
    />
  );
}
