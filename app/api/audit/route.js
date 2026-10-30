import { NextResponse } from "next/server";
import { listAuditEvents } from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Who may read the full activity history. Deliberately narrow: the log carries
// every action every user has taken, including fee amounts and student names.
//
// trust_accountant is excluded on purpose — scopeForRole already hands them a
// regex-filtered finance-only slice of the audit trail, and this route would
// widen that to the whole school.
const CAN_VIEW_AUDIT = new Set(["admin", "principal"]);

// GET /api/audit?limit=&offset=&who=&action=&entityType=&entityId=&from=&to=&q=
//
// The uncapped read. readAllData() keeps its own 100-row limit for the
// dashboard strip; this is the path that can page past it.
export async function GET(req) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  }
  if (!CAN_VIEW_AUDIT.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised to view the activity log" }, { status: 403 });
  }

  const url = new URL(req.url);
  const p = (k) => url.searchParams.get(k) || undefined;

  try {
    const result = await listAuditEvents({
      limit: p("limit"), offset: p("offset"),
      who: p("who"), action: p("action"),
      entityType: p("entityType"), entityId: p("entityId"),
      from: p("from"), to: p("to"), q: p("q"),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed to read the activity log" }, { status: 500 });
  }
}
