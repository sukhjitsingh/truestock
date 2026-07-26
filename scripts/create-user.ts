/**
 * Creates a Handlebar user account. This is the ONLY way to create an
 * account — there is no public self-signup route (lib/auth.ts sets
 * `emailAndPassword.disableSignUp: true` specifically so that endpoint can
 * never be used to hand out an account, let alone a role, to an anonymous
 * caller). The seed deliberately creates no users (db/README.md), so this
 * script is how the first `owner` account gets created.
 *
 * Run with tsx, from a trusted machine/shell only — never expose this as a
 * route handler or server action. Run it via `bun run create-user -- ...`
 * (or `npm run create-user -- ...`) so `.env.local`'s DATABASE_URL is
 * actually loaded — same convention as `db:seed` (see db/README.md); neither
 * script loads dotenv itself, both rely on the package-manager `run` step
 * auto-loading `.env.local`:
 *
 *   bun run create-user -- --email owner@bar.com --name "Jane Doe" --role owner
 *
 * or with DATABASE_URL already exported in the shell:
 *
 *   tsx scripts/create-user.ts --email owner@bar.com --name "Jane Doe" --role owner
 *
 * Password is prompted interactively (not echoed to the terminal) unless
 * --password is passed explicitly. Prefer the prompt in real use — a
 * password on the command line lands in shell history.
 *
 * ## Why this bypasses the public sign-up endpoint entirely
 * `auth.$context` exposes Better Auth's internal adapter directly
 * (`internalAdapter.createUser` / `internalAdapter.linkAccount`) and its
 * password hasher (`password.hash`) — the exact same primitives
 * `/sign-up/email` itself calls internally (verified by reading
 * node_modules/better-auth/dist/api/routes/sign-up.mjs). Going around the
 * endpoint gets us two things an endpoint call couldn't:
 *   1. It still works even though `disableSignUp` is true (the endpoint
 *      refuses ALL sign-ups, which is the point).
 *   2. `internalAdapter.createUser` spreads whatever object it's given
 *      directly into the insert — unlike the endpoint, it does not filter
 *      out `role`/`active` via the `additionalFields.input: false` rule in
 *      lib/auth.ts. That rule exists to stop a public caller from setting
 *      their own role; it was never meant to stop this trusted, operator-run
 *      script from setting one.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { closePool, db } from "@/db";
import { user as userTable, userRoleEnum } from "@/db/schema";

const MIN_PASSWORD_LENGTH = 12; // keep in sync with lib/auth.ts's emailAndPassword.minPasswordLength

const argsSchema = z.object({
  email: z.email("Not a valid email address."),
  name: z.string().trim().min(1, "Name is required."),
  role: z.enum(userRoleEnum).default("owner"),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`),
});

function parseArgv(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

// Control characters, by code point rather than a literal escape/raw byte in
// this source file, used by promptPassword's raw-keystroke reader below.
const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(8);
const DELETE = String.fromCharCode(127);
const CARRIAGE_RETURN = String.fromCharCode(13);
const NEWLINE = String.fromCharCode(10);

/**
 * Prompts for a password without echoing it to the terminal by reading raw
 * keystrokes directly (rather than patching `process.stdout.write`, which is
 * a common approach for this but awkward to keep fully type-safe).
 */
async function promptPassword(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("No TTY available to prompt for a password. Pass --password instead."));
      return;
    }
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");

    let value = "";
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };
    function onData(chunk: string) {
      for (const ch of chunk) {
        if (ch === CARRIAGE_RETURN || ch === NEWLINE) {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === BACKSPACE || ch === DELETE) {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    }
    process.stdin.on("data", onData);
  });
}

async function main() {
  const rawArgs = parseArgv(process.argv.slice(2));

  if (!rawArgs.password) {
    rawArgs.password = await promptPassword("Password (hidden): ");
  }

  const parsedArgs = argsSchema.safeParse(rawArgs);
  if (!parsedArgs.success) {
    console.error("Invalid input:");
    for (const issue of parsedArgs.error.issues) {
      console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    console.error(
      '\nUsage: tsx scripts/create-user.ts --email you@bar.com --name "Your Name" [--role owner|manager|staff] [--password "..."]',
    );
    process.exitCode = 1;
    return;
  }
  const { email, name, role, password } = parsedArgs.data;
  const normalizedEmail = email.toLowerCase();

  const existing = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, normalizedEmail))
    .limit(1);
  if (existing.length > 0) {
    console.error(`A user with email ${normalizedEmail} already exists (id ${existing[0].id}).`);
    process.exitCode = 1;
    return;
  }

  const ctx = await auth.$context;

  const createdUser = await ctx.internalAdapter.createUser({
    email: normalizedEmail,
    name,
    emailVerified: true, // operator-created account; no verification email flow in the MVP
    role,
    active: true,
  });
  if (!createdUser) {
    console.error("Failed to create user.");
    process.exitCode = 1;
    return;
  }

  const hash = await ctx.password.hash(password);
  await ctx.internalAdapter.linkAccount({
    userId: createdUser.id,
    providerId: "credential",
    accountId: String(createdUser.id),
    password: hash,
  });

  console.log(`Created ${role} account: ${normalizedEmail} (user id ${createdUser.id}).`);
}

main()
  .catch((err) => {
    console.error("create-user failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
