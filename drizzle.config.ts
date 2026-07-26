import { defineConfig } from "drizzle-kit";
import { config as loadEnv } from "dotenv";

// drizzle-kit runs outside Next.js, so .env.local isn't loaded automatically.
loadEnv({ path: ".env.local" });

const DATABASE_URL = process.env.DATABASE_URL;

// `generate` diffs db/schema.ts against drizzle/meta and needs no live
// connection, so DATABASE_URL is optional for it. `migrate`, `push`, `pull`,
// and `studio` do need a real connection — they'll fail with mysql2's own
// connection error if DATABASE_URL is missing or wrong at that point, which
// is a clearer signal than failing eagerly here for every command.
export default defineConfig({
  dialect: "mysql",
  schema: "./db/schema.ts",
  out: "./drizzle",
  ...(DATABASE_URL ? { dbCredentials: { url: DATABASE_URL } } : {}),
  strict: true,
  verbose: true,
});
