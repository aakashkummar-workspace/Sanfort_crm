import { NextResponse } from "next/server";
import { listWhatsAppMessages } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { checkServiceStatus } from "@/lib/service-status";

export const dynamic = "force-dynamic";

// Who may read the message log. Deliberately narrow, and narrower than it
// looks: unlike the audit log this carries the message *bodies*, which include
// fee amounts, outstanding balances and parent phone numbers in plain text.
// GET only — nothing writes through this route; sends go through the fee /
// broadcast / diagnostic routes that already own their own authorisation.
const CAN_VIEW = new Set(["admin", "principal"]);

// GET /api/whatsapp/messages?limit=&offset=&studentId=&phone=&status=&event=&from=&to=&q=
//
// The log is not in /api/data on purpose (it grows with every fee payment), so
// this is the only read path.
export async function GET(req) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  }
  if (!CAN_VIEW.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised to view the WhatsApp log" }, { status: 403 });
  }

  const url = new URL(req.url);
  const p = (k) => url.searchParams.get(k) || undefined;

  try {
    const result = await listWhatsAppMessages({
      limit: p("limit"), offset: p("offset"),
      studentId: p("studentId"), phone: p("phone"),
      status: p("status"), event: p("event"),
      from: p("from"), to: p("to"), q: p("q"),
    });
    // Billing state from SirahOS. A locked service sends nothing however
    // healthy the counts look, so the log has to say so.
    let service = { allowed: true };
    try { service = await checkServiceStatus(); } catch { /* never block the log */ }
    return NextResponse.json({ ok: true, ...result, service });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed to read the WhatsApp log" }, { status: 500 });
  }
}
