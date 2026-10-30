import { NextResponse } from "next/server";
import { patchComplaintStatus, addComplaint, logAudit } from "@/lib/db";
import { getSession } from "@/lib/auth";

export async function PATCH(req) {
  const session = await getSession();
  const actor = session?.name || "System";
  let body; try { body = await req.json(); } catch { body = null; }
  const { id, status } = body || {};
  if (!id || !status) return NextResponse.json({ ok: false, error: "id+status required" }, { status: 400 });
  try {
    const updated = await patchComplaintStatus(id, status);
    if (!updated) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    try {
      await logAudit(actor, `Complaint → ${status}`, `${updated.id} ${updated.student}`,
        { actorId: session?.sub, actorRole: session?.role, entityType: "complaint", entityId: updated.id,
          meta: { status } });
    } catch {}
    return NextResponse.json({ ok: true, complaint: updated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 400 });
  }
}

// Parents and staff submit new complaints (or leave requests) here.
export async function POST(req) {
  let body; try { body = await req.json(); } catch { body = null; }
  if (!body || !String(body.issue || "").trim()) {
    return NextResponse.json({ ok: false, error: "Please describe the issue or leave reason" }, { status: 400 });
  }
  try {
    const row = await addComplaint(body);
    try {
      await logAudit(
        body.parent || "Parent",
        body.type === "leave_request" ? "Leave request submitted" : "Complaint submitted",
        `${row.id} · ${body.student || "—"}`
      );
    } catch {}
    return NextResponse.json({ ok: true, complaint: row });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 400 });
  }
}
