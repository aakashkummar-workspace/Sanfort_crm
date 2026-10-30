import { NextResponse } from "next/server";
import { addClass, updateClass, removeClass, logAudit } from "@/lib/db";
import { getSession } from "@/lib/auth";

// POST: create a new class.  body = { n, label, sections }
export async function POST(req) {
  const session = await getSession();
  const actor = session?.name || "System";
  const body = await req.json();
  try {
    const row = await addClass(body);
    await logAudit(actor, "Added class", `${row.label} · sections ${row.sections.join(", ") || "—"}`,
      { actorId: session?.sub, actorRole: session?.role, entityType: "class", entityId: String(row.n) });
    return NextResponse.json({ ok: true, class: row });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed to add class" }, { status: 400 });
  }
}

// PATCH: update a class. body = { n, label?, sections?, subjects? }
export async function PATCH(req) {
  const session = await getSession();
  const actor = session?.name || "System";
  const body = await req.json();
  if (!body.n) return NextResponse.json({ ok: false, error: "n required" }, { status: 400 });
  try {
    const row = await updateClass(body.n, body);
    if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    await logAudit(actor, "Updated class", `Class ${body.n} · sections ${Array.isArray(body.sections) ? body.sections.join(", ") : row.sections?.join?.(", ") || "—"}`,
      { actorId: session?.sub, actorRole: session?.role, entityType: "class", entityId: String(body.n) });
    return NextResponse.json({ ok: true, class: row });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Update failed" }, { status: 400 });
  }
}

// DELETE: remove a class. body = { n }
export async function DELETE(req) {
  const session = await getSession();
  const actor = session?.name || "System";
  const body = await req.json();
  if (!body.n) return NextResponse.json({ ok: false, error: "n required" }, { status: 400 });
  try {
    await removeClass(body.n);
    await logAudit(actor, "Removed class", `Class ${body.n}`,
      { actorId: session?.sub, actorRole: session?.role, entityType: "class", entityId: String(body.n) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Delete failed" }, { status: 400 });
  }
}
