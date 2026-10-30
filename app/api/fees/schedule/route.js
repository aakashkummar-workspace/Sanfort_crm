import { NextResponse } from "next/server";
import { getStudentFeeSchedule } from "@/lib/db";
import { getSession } from "@/lib/auth";

// Read-only month-by-month fee view for one student. Same staff roles as the
// fee structure endpoint; a parent may see their own child only.
const STAFF = new Set([
  "admin", "principal", "academic_director", "school_accountant", "trust_accountant",
]);

// Derived from live pending rows + receipts on every request, so it must never
// be cached — a payment taken a second ago has to show.
export const dynamic = "force-dynamic";

// GET /api/fees/schedule?studentId=STN-9001 → { ok, student, schedule }
export async function GET(req) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  const studentId = new URL(req.url).searchParams.get("studentId");
  if (!studentId) {
    return NextResponse.json({ ok: false, error: "studentId required" }, { status: 400 });
  }

  // A parent is scoped to their own linked child. Any other role must be staff.
  if (session.role === "parent") {
    if (session.linkedId !== studentId) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
  } else if (!STAFF.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  try {
    const { student, schedule } = await getStudentFeeSchedule(studentId);
    return NextResponse.json({ ok: true, student, schedule });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 400 });
  }
}
