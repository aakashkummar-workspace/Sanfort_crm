import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { notifyWhatsApp, whatsappEnvStatus } from "@/lib/whatsapp";
import { logAudit, whatsAppCounts } from "@/lib/db";
import { getProvider } from "@/lib/providers/index.js";

export const dynamic = "force-dynamic";

// Admin-only WhatsApp configuration check. Returns which Evolution env vars
// are present on the running server (boolean only — never the actual key)
// so an admin can verify the production VPS picked up .env.local. POST
// optionally fires a single test message to a phone the admin supplies, so
// they can confirm Evolution → WhatsApp delivery end-to-end.

function denyNonAdmin(session) {
  if (!session) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 401 });
  if (session.role !== "admin") return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  return null;
}

export async function GET() {
  const session = await getSession();
  const deny = denyNonAdmin(session);
  if (deny) return deny;
  // Which adapter is live, plus the last-24h outcome counts. "Env vars are
  // present" was never the question an admin actually had — "is anything
  // getting through right now?" is, and that only the log can answer.
  let provider = null;
  try { provider = getProvider().id; } catch { provider = null; }
  let counts = {};
  try { counts = await whatsAppCounts(); } catch {}
  return NextResponse.json({ ok: true, env: whatsappEnvStatus(), provider, counts });
}

export async function POST(req) {
  const session = await getSession();
  const deny = denyNonAdmin(session);
  if (deny) return deny;

  let body; try { body = await req.json(); } catch { body = null; }
  const phone = body?.phone;
  if (!phone) return NextResponse.json({ ok: false, error: "phone required" }, { status: 400 });

  const message =
    body?.message?.trim() ||
    `Test message from Sanfort International School CRM at ${new Date().toLocaleString("en-IN")}.`;

  // actor/actorId are log-only — they put a name against the test row so the
  // WhatsApp screen doesn't show an anonymous "test" among real sends.
  const result = await notifyWhatsApp("test", {
    phone, message,
    actor: session.name || "Admin", actorId: session.id || null,
  });
  try {
    await logAudit(
      session.name || "Admin",
      "WhatsApp diagnostic test",
      `phone=${phone} · ok=${!!result.ok}${result.skipped ? ` · skipped=${result.skipped}` : ""}${result.error ? ` · err=${result.error}` : ""}`
    );
  } catch {}
  return NextResponse.json({ ok: true, result, env: whatsappEnvStatus() });
}
