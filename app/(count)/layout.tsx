import { requireUser } from "@/lib/current-user";
import { CountTabBar } from "@/components/count/tab-bar";

/**
 * The counting app: mobile, one-handed, and ALWAYS dark.
 *
 * `className="dark"` is hardcoded — never conditional on
 * `prefers-color-scheme`, a cookie, or a user setting (docs/design-system.md
 * §1). The phone is used in a dim bar; the OS theme of whatever handset is
 * behind the counter tonight is not a signal about the room's lighting.
 */
export default async function CountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  return (
    <div className="dark flex min-h-dvh flex-col bg-background text-foreground touch-manipulation">
      <div className="flex-1">{children}</div>
      <CountTabBar role={user.role} />
    </div>
  );
}
