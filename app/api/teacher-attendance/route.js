import { NextResponse } from "next/server";
import { markTeacherAttendance, listTeacherAttendance, listUsers, logAudit } from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const CAN_OVERRIDE = new Set(["admin", "principal"]);
const SOURCES = new Set(["self", "admin", "exams-strip"]);

// GET /api/teacher-attendance?teacherId=&fromDate=&toDate=
export async function GET(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  const url = new URL(req.url);
  const teacherId = url.searchParams.get("teacherId") || undefined;
  const fromDate  = url.searchParams.get("fromDate")  || undefined;
  const toDate    = url.searchParams.get("toDate")    || undefined;
  // Teachers see only their own log; admin/principal see everything.
  const filter = (session.role === "teacher")
    ? { teacherId: session.sub || session.id, fromDate, toDate }
    : { teacherId, fromDate, toDate };
  const records = await listTeacherAttendance(filter);
  return NextResponse.json({ ok: true, records });
}

// POST /api/teacher-attendance { teacherId?, date, status, leaveReason?, source? }
// Teachers can mark themselves; principal/admin can mark or override anyone.
export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  let body; try { body = await req.json(); } catch { body = null; }
  if (!body?.date) return NextResponse.json({ ok: false, error: "date required" }, { status: 400 });

  const isOverride = body.teacherId && body.teacherId !== (session.sub || session.id);
  if (isOverride && !CAN_OVERRIDE.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Only admin / principal can mark for others" }, { status: 403 });
  }

  // Which screen the mark came from. A client that sends nothing, or something
  // we don't recognise, is attributed by shape instead of being rejected —
  // older builds are still in the field and their marks must not fail.
  const source = SOURCES.has(body.source) ? body.source : (isOverride ? "admin" : "self");

  // Resolve teacher info — defaults to the signed-in teacher.
  let teacherId = body.teacherId || session.sub || session.id;
  let teacherName = session.name;
  if (isOverride) {
    const users = await listUsers();
    const u = users.find((x) => x.id === teacherId);
    if (!u) return NextResponse.json({ ok: false, error: "Teacher not found" }, { status: 404 });
    teacherName = u.name;
  }

  try {
    const row = await markTeacherAttendance({
      teacherId, teacherName,
      date: body.date,
      status: body.status,
      leaveReason: body.leaveReason,
      lateReason:  body.lateReason,
      markedBy: session.name || session.email,
      markedById: session.sub || session.id || null,
      markedFrom: source,
    });
    try {
      const changed = row.previousStatus && row.previousStatus !== row.status
        ? ` (was ${row.previousStatus})` : "";
      await logAudit(session.name || "User", "Teacher attendance", `${row.teacherName} · ${row.date} · ${row.status}${changed} · via ${source}`, {
        actorId: session?.sub,
        actorRole: session?.role,
        entityType: "teacher_attendance",
        entityId: `${teacherId}:${body.date}`,
        meta: { status: row.status, previousStatus: row.previousStatus ?? null, source },
      });
    } catch {}
    return NextResponse.json({ ok: true, record: row });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 500 });
  }
}
