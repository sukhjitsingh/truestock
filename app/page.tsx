import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";

/**
 * Root is a router, not a screen. Where someone lands is decided from the
 * role on their session — staff go straight to the counting app, which is the
 * only surface they have; owner and manager land in the back office, which is
 * where a desk session starts.
 */
export default async function Home() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  redirect(user.role === "staff" ? "/count" : "/office");
}
