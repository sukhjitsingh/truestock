import { requireUser } from "@/lib/current-user";
import { Preflight } from "@/components/count/preflight";
import { PreflightOriginCheck } from "@/components/count/preflight-origin-check";

export const metadata = { title: "Preflight · Truestock" };

/**
 * Device preflight — the first URL to open on a phone that has never run a
 * count, and the first thing to re-open when one starts behaving oddly.
 *
 * Behind `requireUser` deliberately. Nothing it reports is sensitive on its
 * own, but an unauthenticated route that enumerates a device's capabilities
 * is free reconnaissance for no benefit — anyone who needs this is signing in
 * to count anyway. See docs/phone-count-test.md for the protocol it opens.
 */
export default async function PreflightPage() {
  await requireUser();

  return (
    <div className="px-bar-pad pb-8 pt-6">
      <h1 className="text-header-title text-foreground">Preflight</h1>
      <p className="mt-1 text-row-subtitle text-muted-foreground">
        What this phone can and cannot do, before it matters.
      </p>
      <div className="mt-section-gap">
        <PreflightOriginCheck />
      </div>
      <Preflight />
    </div>
  );
}
