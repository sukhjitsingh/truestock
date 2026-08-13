import { headers } from "next/headers";
import { Card } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";
import { isDevOriginAllowed } from "@/lib/dev-origins";

/**
 * Server-rendered origin check for the dev LAN setup.
 *
 * This catches a specific and costly misconfiguration: running `bun run docker:up`
 * instead of `bun run docker:up:lan` results in DEV_LAN_ORIGIN being empty. The
 * app then resolves /_next/* only for 127.0.0.1, so a client on a different
 * origin (e.g., the LAN IP) gets 403 on every chunk. The page renders and returns
 * 200, but no JavaScript ever runs — so the form is inert and the count becomes
 * impossible.
 *
 * A client-side check cannot detect this: if chunks are blocked, no client
 * JavaScript runs at all, and any check implemented as a React effect or fetch
 * simply never executes. So this must be server-rendered and work with zero
 * client-side code.
 *
 * That constraint is why open item 26's false alarm was fixed in the *allowlist*
 * rather than by having this component observe a real `/_next/*` fetch, which
 * was the first idea. Observing the outcome would be strictly more accurate and
 * strictly useless: in the failure case there is no JavaScript to do the
 * observing. The verdict has to be derivable on the server, so the only correct
 * fix is for the server-side predicate to know everything Next knows — including
 * the `localhost` allowance that no configuration expresses.
 *
 * Production is inert: dev-only logic lives in next.config.ts's `allowedDevOrigins`,
 * which does not exist in production builds. There is no secure origin restriction
 * in production (the app runs on fully qualified domains), so this check has
 * nothing meaningful to verify. It shows nothing rather than false failures.
 *
 * The nginx TLS proxy (docker/tls/nginx.conf) sets:
 *   - Host: $http_host (includes port)
 *   - X-Forwarded-Host: $http_host (same)
 * We read Host directly via the headers API, which reflects what the app sees
 * after proxying.
 */
export async function PreflightOriginCheck() {
  // In production, dev-only logic is skipped entirely. Exit early to avoid
  // rendering a meaningless "check passed" row.
  if (process.env.NODE_ENV === "production") {
    return null;
  }

  const headerList = await headers();
  const host = headerList.get("host");

  // Parse the hostname from Host header. The header includes the port
  // (e.g., "192.168.1.10:3443"), but the allowlist is bare hostnames.
  const requestHostname = host?.split(":")[0] ?? "";

  // `isDevOriginAllowed`, not `parseDevOriginHosts().includes(...)` — Next
  // allows `localhost` and `*.localhost` without them appearing in any config,
  // and checking the configured list alone reported a catastrophic failure on
  // plain `localhost:3000` while the page was demonstrably working. See open
  // item 26 and the reasoning in lib/dev-origins.ts.
  const isAllowed = isDevOriginAllowed(requestHostname);

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <p className="text-row-title text-card-foreground">Origin allowed</p>
        <StatusPill tone={isAllowed ? "success" : "negative"}>
          {isAllowed ? "Yes" : "No"}
        </StatusPill>
      </div>
      <p className="mt-1 text-row-subtitle text-muted-foreground">
        {isAllowed
          ? `${host} is in the allowed list. Client chunks will load normally.`
          : `${host} is not in the allowed list. The app will render (return 200) but client chunks return 403 — so no JavaScript runs. The form appears but never responds to taps. Fix: run \`bun run docker:up:lan\` instead of \`docker:up\`, then reload this page. See scripts/dev-lan.sh for details.`}
      </p>
    </Card>
  );
}
