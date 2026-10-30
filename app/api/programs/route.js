import { NextResponse } from "next/server";
import {
  addProgram, listPrograms, getProgram, updateProgram, removeProgram,
  setProgramParticipants, updateProgramParticipant, logAudit,
} from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const CAN_MANAGE = new Set(["admin", "principal", "academic_director"]);
// Fields a teacher is allowed to touch on a participant row: they run the
// event on the day, so attendance and results are theirs. Everything else
// (roster membership, budgets, the program itself) stays with management.
const TEACHER_PARTICIPANT_FIELDS = new Set(["attendance", "result", "position", "remarks"]);

// GET /api/programs            → list (header rows only)
// GET /api/programs?id=PRG-…   → one program + its participant roster
export async function GET(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const program = await getProgram(id);
    if (!program) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, program });
  }
  const items = await listPrograms({
    status:   url.searchParams.get("status")   || undefined,
    category: url.searchParams.get("category") || undefined,
    from:     url.searchParams.get("from")     || undefined,
    to:       url.searchParams.get("to")       || undefined,
    limit: 200,
  });
  return NextResponse.json({ ok: true, items });
}

// POST /api/programs { title, startDate, category?, …, studentIds? }
export async function POST(req) {
  const session = await getSession();
  if (!session || !CAN_MANAGE.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised" }, { status: 403 });
  }
  let body; try { body = await req.json(); } catch { body = null; }
  if (!body?.title || !body?.startDate) {
    return NextResponse.json({ ok: false, error: "title and startDate required" }, { status: 400 });
  }
  try {
    const p = await addProgram({
      title:            body.title,
      category:         body.category || "other",
      description:      body.description || null,
      startDate:        body.startDate,
      endDate:          body.endDate || null,
      venue:            body.venue || null,
      organizer:        body.organizer || null,
      organizerStaffId: body.organizerStaffId || null,
      audience:         body.audience || null,
      audienceLabel:    body.audienceLabel || null,
      status:           body.status || "planned",
      budgetPlanned:    body.budgetPlanned || 0,
      budgetActual:     body.budgetActual || 0,
      outcome:          body.outcome || null,
      notes:            body.notes || null,
      createdBy:        session.sub,
    });
    // Roster is optional at creation — a program can be planned before
    // anyone is picked for it.
    let participants = [];
    if (Array.isArray(body.studentIds) && body.studentIds.length) {
      participants = await setProgramParticipants(p.id, body.studentIds, session.sub);
    }
    try {
      await logAudit(
        session.name || "User", "Added program", `${p.id} ${p.title}`,
        { actorId: session?.sub, actorRole: session?.role, entityType: "program", entityId: p.id }
      );
    } catch {}
    return NextResponse.json({ ok: true, program: { ...p, participants } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 400 });
  }
}

// PATCH /api/programs
//   { id, …programFields }                      → edit the program (managers)
//   { id, studentIds: [...] }                   → replace the roster (managers)
//   { id, studentId, attendance?/result?/… }    → edit one participant (managers + teachers)
export async function PATCH(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  let body; try { body = await req.json(); } catch { body = null; }
  if (!body?.id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const isManager = CAN_MANAGE.has(session.role);

  // --- Participant edit ---
  if (body.studentId) {
    if (!isManager && session.role !== "teacher") {
      return NextResponse.json({ ok: false, error: "Not authorised" }, { status: 403 });
    }
    const patch = {};
    for (const k of ["role", "attendance", "result", "position", "remarks"]) {
      if (k in body) patch[k] = body[k];
    }
    // A teacher sending `role` would be changing roster membership, not
    // recording the day — reject rather than silently dropping the field.
    if (!isManager) {
      const bad = Object.keys(patch).filter((k) => !TEACHER_PARTICIPANT_FIELDS.has(k));
      if (bad.length) {
        return NextResponse.json({ ok: false, error: `Teachers may only set ${[...TEACHER_PARTICIPANT_FIELDS].join(", ")}` }, { status: 403 });
      }
    }
    if (!Object.keys(patch).length) {
      return NextResponse.json({ ok: false, error: "Nothing to update" }, { status: 400 });
    }
    try {
      const updated = await updateProgramParticipant(body.id, body.studentId, patch);
      if (!updated) return NextResponse.json({ ok: false, error: "Participant not found" }, { status: 404 });
      try {
        await logAudit(
          session.name || "User", "Updated program participant",
          `${body.id} ${body.studentId} ${patch.attendance || patch.result || ""}`.trim(),
          { actorId: session?.sub, actorRole: session?.role, entityType: "program", entityId: body.id }
        );
      } catch {}
      return NextResponse.json({ ok: true, participant: updated });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 400 });
    }
  }

  if (!isManager) return NextResponse.json({ ok: false, error: "Not authorised" }, { status: 403 });

  // --- Roster replace ---
  if (Array.isArray(body.studentIds)) {
    try {
      const participants = await setProgramParticipants(body.id, body.studentIds, session.sub);
      try {
        await logAudit(
          session.name || "User", "Updated program roster",
          `${body.id} ${participants.length} participants`,
          { actorId: session?.sub, actorRole: session?.role, entityType: "program", entityId: body.id }
        );
      } catch {}
      return NextResponse.json({ ok: true, participants });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 400 });
    }
  }

  // --- Program header edit ---
  const patch = {};
  for (const k of [
    "title", "category", "description", "startDate", "endDate", "venue",
    "organizer", "organizerStaffId", "audience", "audienceLabel", "status",
    "budgetPlanned", "budgetActual", "outcome", "notes",
  ]) {
    if (k in body) patch[k] = body[k];
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json({ ok: false, error: "Nothing to update" }, { status: 400 });
  }
  try {
    const p = await updateProgram(body.id, patch);
    if (!p) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    try {
      await logAudit(
        session.name || "User", "Updated program", `${p.id} ${p.title}`,
        { actorId: session?.sub, actorRole: session?.role, entityType: "program", entityId: p.id }
      );
    } catch {}
    return NextResponse.json({ ok: true, program: p });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 400 });
  }
}

export async function DELETE(req) {
  const session = await getSession();
  if (!session || !CAN_MANAGE.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised" }, { status: 403 });
  }
  let body; try { body = await req.json(); } catch { body = null; }
  if (!body?.id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  const removed = await removeProgram(body.id);
  if (!removed) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  try {
    await logAudit(
      session.name || "User", "Removed program", `${removed.id} ${removed.title}`,
      { actorId: session?.sub, actorRole: session?.role, entityType: "program", entityId: removed.id }
    );
  } catch {}
  return NextResponse.json({ ok: true });
}
