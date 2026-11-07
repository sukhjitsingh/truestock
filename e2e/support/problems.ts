/**
 * Collects everything a page does wrong that a passing assertion would not show.
 *
 * Why this is not optional. The two worst failures this project has shipped —
 * the static-CSP hydration break and the plaintext-password GET submit — both
 * returned 200, rendered correct HTML, and passed every status check. They were
 * visible only as browser-side noise: a CSP violation, a console error, an
 * uncaught exception. So every test runs with a collector attached and FAILS if
 * the page produced anything not explicitly allow-listed. A clean run is then
 * evidence about the client, not just about the server.
 *
 * What counts as a problem:
 *   - `console.error` (this includes Chrome's "Failed to load resource: ... 4xx/5xx");
 *   - `pageerror` (an uncaught exception or unhandled rejection in the page);
 *   - `securitypolicyviolation` events — captured by an in-page listener, because
 *     Chrome reports CSP violations through a channel the devtools console API
 *     does not carry (AGENTS.md), so listening for console text would miss them;
 *   - a same-origin response with status >= 500 (a 4xx is already a console error).
 *
 * What does NOT count: `requestfailed`. A navigation away from a page aborts
 * its in-flight server-action POSTs with ERR_ABORTED; that is benign and
 * universal, and flagging it would make every navigation test flaky.
 *
 * Allow-listing is per test (`problems.allow(/…/)`) with a reason in the test
 * itself, so an expected 401 on the wrong-password test is stated where it is
 * expected rather than hidden in a global filter.
 */
import type { Page } from "playwright/test";
import { baseUrl } from "./env";

export interface Problem {
  kind: "console" | "pageerror" | "csp" | "http5xx";
  text: string;
  url: string;
}

/** Patterns that are never a defect in the app. Keep this list short and each entry justified. */
const ALWAYS_ALLOWED: readonly RegExp[] = [
  // Chrome logs this when a page is torn down mid-fetch (navigation during a
  // server action). The abort itself is benign; see the header.
  /net::ERR_ABORTED/,
];

export interface ProblemCollector {
  /** Everything seen so far, allowed or not. */
  all(): Problem[];
  /** Only what no allow pattern matched. */
  unexpected(): Problem[];
  /** Tolerate problems whose text matches. Call from the test that expects them. */
  allow(...patterns: RegExp[]): void;
  /** Forget what was seen so far — for the point where a test deliberately provokes an error. */
  clear(): void;
}

export async function attachProblemCollector(page: Page): Promise<ProblemCollector> {
  const seen: Problem[] = [];
  const allowed: RegExp[] = [...ALWAYS_ALLOWED];
  // The app under test, not whatever the page happens to be on right now (it
  // is about:blank when the collector attaches).
  const origin = new URL(baseUrl()).origin;

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    seen.push({ kind: "console", text: msg.text(), url: msg.location().url || page.url() });
  });
  page.on("pageerror", (err) => {
    seen.push({ kind: "pageerror", text: err.message, url: page.url() });
  });
  page.on("response", (res) => {
    if (res.status() < 500) return;
    // Same-origin only: a third party failing is not this app's defect, and the
    // CSP would block most of them anyway.
    const target = res.url();
    if (!target.startsWith(origin)) return;
    seen.push({ kind: "http5xx", text: `${res.status()} ${res.request().method()} ${target}`, url: page.url() });
  });

  // CSP violations: the listener runs inside the page and reports through an
  // exposed function. Registered before any navigation so the very first
  // document is covered.
  await page.exposeFunction("__e2eReportCsp", (directive: string, blocked: string) => {
    seen.push({ kind: "csp", text: `${directive} blocked ${blocked}`, url: page.url() });
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const report = (window as unknown as { __e2eReportCsp?: (d: string, b: string) => void }).__e2eReportCsp;
      report?.(e.violatedDirective, e.blockedURI || "inline");
    });
  });

  const isAllowed = (p: Problem) => allowed.some((re) => re.test(p.text));
  return {
    all: () => [...seen],
    unexpected: () => seen.filter((p) => !isAllowed(p)),
    allow: (...patterns) => {
      allowed.push(...patterns);
    },
    clear: () => {
      seen.length = 0;
    },
  };
}

/** One line per problem, for an assertion message. Truncated: a stack trace is not a summary. */
export function describeProblems(problems: Problem[]): string[] {
  return problems.map((p) => `[${p.kind}] ${p.text.slice(0, 300)} (on ${p.url})`);
}
