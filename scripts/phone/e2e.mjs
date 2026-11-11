// `bun run e2e:phone [-- spec ...]` - the Playwright specs on the REAL phone.
// Defaults E2E_PHONE_CDP to the DevTools forward phone:rig makes (9333) and
// runs only the `phone` project (defined by playwright.config.ts when that
// variable is set). Everything after the script name goes to Playwright.
//
// Preflight: a phone whose screen is off or locked stops rendering, and every
// test then dies on its 60 s timeout (seen 2026-11-10: 19 of 19, screenshots
// timing out too). So check over adb first and stop with one clear line.
// Skipped when adb is not on PATH (E2E_PHONE_CDP may point somewhere else).
//
// Never in CI: the phone run is for development and QA only (a person's phone,
// unlocked, on the desk). CI gates on the desktop and emulated-mobile projects.
import { spawnSync } from "node:child_process";

if (process.env.CI) {
  console.error(
    "e2e:phone: refusing to run under CI. The real-phone run is for development and QA only; " +
      "CI runs `--project=desktop` and `--project=mobile` (docs/phone-count-test.md).",
  );
  process.exit(2);
}

const adbArgs = process.env.ADB_SERIAL ? ["-s", process.env.ADB_SERIAL] : [];
const power = spawnSync("adb", [...adbArgs, "shell", "dumpsys", "power"], { encoding: "utf8" });
if (!power.error && power.status === 0) {
  const awake = /mWakefulness=Awake/.test(power.stdout);
  const win = spawnSync("adb", [...adbArgs, "shell", "dumpsys", "window"], { encoding: "utf8" });
  const locked = /isKeyguardShowing=true/.test(win.stdout ?? "");
  if (!awake || locked) {
    console.error(
      `e2e:phone: the phone is ${awake ? "locked" : "asleep"}. Unlock it, leave Chrome in front, and keep the screen on ` +
        "(Developer options -> Stay awake works while charging), then run this again.",
    );
    process.exit(2);
  }
}

const env = { ...process.env, E2E_PHONE_CDP: process.env.E2E_PHONE_CDP?.trim() || "http://127.0.0.1:9333" };
const cli = new URL("../../node_modules/playwright/cli.js", import.meta.url).pathname;
const r = spawnSync(process.execPath, [cli, "test", "--project=phone", ...process.argv.slice(2)], { stdio: "inherit", env });
process.exit(r.status ?? 1);
