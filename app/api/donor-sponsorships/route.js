import { NextResponse } from "next/server";
import {
  addSponsorship, listSponsorships, endSponsorship,
  readAllData, logAudit,
} from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Who may allocate a student to a donor. Teachers are included because they
// know which children are in need, but they are further restricted below to
// students in their own assigned classes.
const CAN_ALLOCATE = new Set(["admin", "principal", "academic_director", "teacher"]);

// Who may read allocations. Deliberately excludes parent and donor:
// - a parent must not learn their child is sponsored (the allocation is
//   internal by design), and
// - a donor's own view comes through the scoped /api/data payload, which
//   hands them projected student rows and never the sponsorship rows
//   themselves (those carry internal staff notes).
const CAN_VIEW = new Set(["admin", "principal", "academic_director", "teacher", "trust_accountant"]);

// A teacher may only touch students in their own classes. Enforced here rather
// than in the UI, because the UI is not an authorisation boundary.
async function teacherOwnsStudent(session, studentId) {
  const classes = Array.isArray(session?.linkedClasses) ? session.linkedClasses : [];
  if (classes.length === 0) return false;
  try {
    const data = await readAllData();
    const student = (data.addedStudents || []).find((s) => s.id === studentId);
    return !!student && classes.includes(student.cls);
  } catch {
    return false;
  }
}

// GET /api/donor-sponsorships?donorId=&studentId=&status=
export async function GET(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  if (!CAN_VIEW.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised" }, { status: 403 });
  }
  const url = new URL(req.url);
  try {
    const items = await listSponsorships({
      donorId: url.searchParams.get("donorId") || undefined,
      studentId: url.searchParams.get("studentId") || undefined,
      status: url.searchParams.get("status") || "active",
    });
    return NextResponse.json({ ok: true, items });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 500 });
  }
}

// POST /api/donor-sponsorships  { donorId, studentId, notes? }
export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  if (!CAN_ALLOCATE.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised to allocate sponsorships" }, { status: 403 });
  }
  let body; try { body = await req.json(); } catch { body = null; }
  const donorId = body?.donorId;
  const studentId = body?.studentId;
  if (!donorId || !studentId) {
    return NextResponse.json({ ok: false, error: "donorId and studentId are required" }, { status: 400 });
  }
  if (session.role === "teacher" && !(await teacherOwnsStudent(session, studentId))) {
    return NextResponse.json({ ok: false, error: "That student is not in your class" }, { status: 403 });
  }
  try {
    const item = await addSponsorship({
      donorId, studentId,
      allocatedBy: session.name || "System",
      allocatedById: session.sub || null,
      notes: body?.notes || null,
    });
    try {
      await logAudit(session.name || "System", "Allocated sponsorship", `${donorId} → ${studentId}`, {
        actorId: session.sub, actorRole: session.role,
        entityType: "sponsorship", entityId: item.id,
        meta: { donorId, studentId },
      });
    } catch {}
    return NextResponse.json({ ok: true, item });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed to allocate" }, { status: 500 });
  }
}

// DELETE /api/donor-sponsorships  { id }
// Soft-end — who allocated what, and when, stays on the record.
export async function DELETE(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  if (!CAN_ALLOCATE.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised" }, { status: 403 });
  }
  let body; try { body = await req.json(); } catch { body = null; }
  if (!body?.id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  try {
    const ended = await endSponsorship(body.id, session.name || "System");
    if (!ended) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    try {
      await logAudit(session.name || "System", "Ended sponsorship", `${ended.donorId} → ${ended.studentId}`, {
        actorId: session.sub, actorRole: session.role,
        entityType: "sponsorship", entityId: ended.id,
      });
    } catch {}
    return NextResponse.json({ ok: true, item: ended });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 500 });
  }
}
