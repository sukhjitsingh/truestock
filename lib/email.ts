/**
 * Minimal outbound-email abstraction (Phase 2.5, Slice 5 — audit packets).
 *
 * NOT a real SES/SendGrid integration — no credentials exist in this
 * environment to test against (02-architecture.md's storage/env table lists
 * `EMAIL_PROVIDER` / `EMAIL_API_KEY` / `EMAIL_FROM` as Hostinger-production
 * config, unset here). This module has exactly two paths:
 *
 *   - `EMAIL_PROVIDER` unset (dev/test — the normal case in this
 *     environment): the message is pushed onto `devEmailOutbox` (an
 *     exported, importable array) so tests can assert against it directly,
 *     and logged to the console. This is 04-slices.md's own "simulated in
 *     dev" requirement, made actually testable rather than just logged.
 *   - `EMAIL_PROVIDER` set (production, e.g. Hostinger): a real best-effort
 *     HTTP call to the configured provider's REST API (SendGrid's v3
 *     `mail/send`, via a plain `fetch` — no new SDK dependency). Wrapped in
 *     try/catch: an email-delivery hiccup must never fail the caller. The
 *     ZIP + manifest `buildAuditPacketJob` already wrote to disk and
 *     recorded on `audit_packet` is the durable artifact; this email is a
 *     convenience notification on top of it, not the thing being audited.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Every message `sendEmail` sent while `EMAIL_PROVIDER` was unset, in send
 * order. Module-level state, not per-call — tests own clearing it (e.g.
 * `devEmailOutbox.length = 0` in a `beforeEach`) the same way they own
 * `resetDatabase()`; this file has no test-lifecycle hook of its own.
 */
export const devEmailOutbox: EmailMessage[] = [];

/**
 * SendGrid's v3 `mail/send` endpoint, called directly via `fetch` rather
 * than pulling in `@sendgrid/mail` — this is a best-effort notification, not
 * a code path worth a new dependency for.
 */
const SENDGRID_SEND_URL = "https://api.sendgrid.com/v3/mail/send";

async function sendViaConfiguredProvider(message: EmailMessage): Promise<void> {
  const apiKey = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    console.error(
      "[email] EMAIL_PROVIDER is set but EMAIL_API_KEY/EMAIL_FROM are missing — dropping email to",
      message.to,
    );
    return;
  }

  try {
    const response = await fetch(SENDGRID_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: from },
        subject: message.subject,
        content: [{ type: "text/plain", value: message.text }],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[email] provider responded ${response.status} for ${message.to}: ${body}`);
    }
  } catch (err) {
    // Swallow, deliberately — see the module header. The caller (the audit
    // packet job) must not fail because a notification email did not send.
    console.error("[email] send failed", err);
  }
}

/** Sends one email. Never throws — see the module header for both paths' error handling. */
export async function sendEmail(message: EmailMessage): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER?.trim();
  if (!provider) {
    devEmailOutbox.push(message);
    console.log(`[email:dev] to=${message.to} subject=${JSON.stringify(message.subject)}`);
    return;
  }
  await sendViaConfiguredProvider(message);
}
