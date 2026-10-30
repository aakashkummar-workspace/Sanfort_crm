import { NextResponse } from "next/server";
import { listTeacherAttendanceLog } from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Correction history is a management view, not a staff-visible one: a teacher
// reading this would see when a colleague's mark was changed and by whom.
const CAN_READ = new Set(["admin", "principal"]);

// GET /api/teacher-attendance/log?teacherId=&date=&limit=
export async function GET(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  if (!CAN_READ.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not allowed" }, { status: 403 });
  }
  const url = new URL(req.url);
  const teacherId = url.searchParams.get("teacherId") || undefined;
  const date      = url.searchParams.get("date")      || undefined;
  const limit     = Math.min(Number(url.searchParams.get("limit")) || 200, 1000);
  const rows = await listTeacherAttendanceLog({ teacherId, date, limit });
  return NextResponse.json({ ok: true, rows });
}
