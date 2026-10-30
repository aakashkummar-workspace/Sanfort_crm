import { NextResponse } from "next/server";
import { addStudent, archiveStudent, seedStudentTermFees, logAudit, updateStudent, provisionParentLogin } from "@/lib/db";
import { getSession } from "@/lib/auth";

const monthYear = () =>
  new Date().toLocaleDateString("en-IN", { month: "short", year: "numeric" });

const newId = () => `STN-${9000 + Math.floor(Math.random() * 999)}`;

function termFeeFor(cls) {
  const n = Number(String(cls).split("-")[0]) || 1;
  return 14000 + n * 1000;
}

// Accepts a 10-digit Indian mobile (after stripping a courtesy +91/91/0 prefix)
// and returns "+91 XXXXX XXXXX". Returns null if not valid.
function formatIndianPhone(raw) {
  if (!raw) return "—";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  if (digits.length !== 10 || !/^[6-9]/.test(digits)) return null;
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

export async function POST(req) {
  const session = await getSession();
  const actor = session?.name || "System";
  const body = await req.json();
  if (!body || !body.name || !body.name.trim()) {
    return NextResponse.json({ ok: false, error: "Name is required" }, { status: 400 });
  }
  let parent = "—";
  if (body.parent && String(body.parent).trim() && String(body.parent).trim() !== "—") {
    const formatted = formatIndianPhone(body.parent);
    if (formatted === null) {
      return NextResponse.json(
        { ok: false, error: "Parent phone must be a 10-digit Indian mobile number starting with 6, 7, 8 or 9" },
        { status: 400 }
      );
    }
    parent = formatted;
  }
  const cls = Number(body.cls) || 1;
  const section = (body.section || "A").toUpperCase();
  // Evening transport is separate from morning. A null/"—" value means
  // "no evening route assigned" — the school floor practice when only
  // morning pickup is being used. The UI defaults the evening field to
  // match morning so single-pickup students can be admitted in one form.
  const transportEvening = body.transportEvening && body.transportEvening !== "—"
    ? body.transportEvening
    : null;
  const pickupStopEvening = transportEvening
    ? (String(body.pickupStopEvening || "").trim() || null)
    : null;

  const row = {
    id: newId(),
    name: body.name.trim(),
    cls: `${cls}-${section}`,
    parent,
    fee: "pending",
    attendance: 0,
    transport: body.transport || "—",
    pickupStop: String(body.pickupStop || "").trim() || null,
    transportEvening,
    pickupStopEvening,
    joined: monthYear(),
  };

  // Optional override of the auto-derived fee total at admission time (custom
  // scholarship, sibling discount, sponsored seat). When given it becomes
  // Term I; otherwise the per-class fee structure decides the term split.
  let overrideTotal = null;
  if (body.feeAmount != null && body.feeAmount !== "") {
    const n = Math.floor(Number(body.feeAmount));
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ ok: false, error: "Fee amount must be 0 or more" }, { status: 400 });
    }
    overrideTotal = n;
  }

  const student = await addStudent(row);

  // Compulsory term-wise recording: every student gets Term I/II/III upfront
  // (plus Application + Van when configured), created here and verified before
  // we return — so a silent partial save can't leave a student fee-less.
  let feeRows = [];
  try {
    feeRows = await seedStudentTermFees(student, { overrideTotal });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Student saved but term-wise fee recording failed: ${e.message}` },
      { status: 500 }
    );
  }
  const feeTotal = feeRows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  await logAudit(actor, "New admission", `${row.id} ${row.name} · fee ₹${feeTotal.toLocaleString("en-IN")} (term-wise)`,
    { actorId: session?.sub, actorRole: session?.role, entityType: "student", entityId: row.id,
      meta: { cls: row.cls, feeTotal } });

  // Auto-provision a parent login scoped to this child so the parent can sign
  // in immediately. Email may be supplied at admission time; otherwise we
  // derive a school.local one from the student id. Common password.
  const createdLogin = await provisionParentLogin({
    studentId: row.id,
    studentName: row.name,
    parentEmail: body.parentEmail || null,
  });
  if (createdLogin) {
    try {
      await logAudit(actor, "Provisioned parent login", `${row.id} ${row.name} · ${createdLogin.email}`,
        { actorId: session?.sub, actorRole: session?.role, entityType: "student", entityId: row.id });
    } catch {}
  }

  return NextResponse.json({ ok: true, student, createdLogin });
}

// PATCH /api/students { id, name?, cls?, section?, parent?, transport?, pickupStop? }
// Used by the Transport screen (bus/pickup), and by the Students screen's
// "Edit details" modal (name/class/parent).
// Role gating is enforced in the Students screen UI (principal/admin/teacher);
// the API trusts that gate + session for now.
export async function PATCH(req) {
  const session = await getSession();
  const actor = session?.name || "Principal";
  let body; try { body = await req.json(); } catch { body = null; }
  if (!body?.id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const patch = {};
  if ("transport" in body)         patch.transport         = body.transport;
  if ("pickupStop" in body)        patch.pickupStop        = body.pickupStop;
  if ("transportEvening" in body)  patch.transportEvening  = body.transportEvening;
  if ("pickupStopEvening" in body) patch.pickupStopEvening = body.pickupStopEvening;
  if ("name" in body) {
    const n = String(body.name || "").trim();
    if (!n) return NextResponse.json({ ok: false, error: "Name cannot be empty" }, { status: 400 });
    patch.name = n;
  }
  // Accept either a pre-joined "1-A" cls string, or separate cls + section.
  if ("cls" in body || "section" in body) {
    const rawCls = body.cls != null ? String(body.cls) : "";
    let clsN, sec;
    if (rawCls.includes("-")) {
      const [a, b] = rawCls.split("-");
      clsN = Number(a); sec = String(b || "A").toUpperCase();
    } else {
      clsN = Number(rawCls) || 0;
      sec = String(body.section || "A").toUpperCase();
    }
    if (!clsN || clsN < 1) return NextResponse.json({ ok: false, error: "Invalid class" }, { status: 400 });
    patch.cls = `${clsN}-${sec}`;
  }
  if ("parent" in body) {
    const raw = String(body.parent || "").trim();
    if (!raw || raw === "—") {
      patch.parent = "—";
    } else {
      const formatted = formatIndianPhone(raw);
      if (formatted === null) {
        return NextResponse.json(
          { ok: false, error: "Parent phone must be a 10-digit Indian mobile number starting with 6, 7, 8 or 9" },
          { status: 400 }
        );
      }
      patch.parent = formatted;
    }
  }

  // Height / weight — class teachers (and admin/principal) can update anytime.
  if ("heightCm" in body || "weightKg" in body) {
    const canMeasure = ["admin", "principal", "academic_director", "teacher"].includes(session?.role);
    if (!canMeasure) {
      return NextResponse.json({ ok: false, error: "Not allowed to update height/weight" }, { status: 403 });
    }
    if ("heightCm" in body) {
      if (body.heightCm === null || body.heightCm === "") patch.heightCm = null;
      else {
        const h = Number(body.heightCm);
        if (!Number.isFinite(h) || h < 30 || h > 250) {
          return NextResponse.json({ ok: false, error: "Height must be between 30 and 250 cm" }, { status: 400 });
        }
        patch.heightCm = Math.round(h * 10) / 10;
      }
    }
    if ("weightKg" in body) {
      if (body.weightKg === null || body.weightKg === "") patch.weightKg = null;
      else {
        const w = Number(body.weightKg);
        if (!Number.isFinite(w) || w < 5 || w > 200) {
          return NextResponse.json({ ok: false, error: "Weight must be between 5 and 200 kg" }, { status: 400 });
        }
        patch.weightKg = Math.round(w * 10) / 10;
      }
    }
    patch.measuredAt = new Date().toISOString();
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "Nothing to update" }, { status: 400 });
  }
  const updated = await updateStudent(body.id, patch);
  if (!updated) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  try {
    const trail = [];
    if ("name" in patch)       trail.push(`name=${patch.name}`);
    if ("cls" in patch)        trail.push(`class=${patch.cls}`);
    if ("parent" in patch)     trail.push(`parent=${patch.parent}`);
    if ("transport" in patch)  trail.push(`bus=${patch.transport || "(none)"}`);
    if ("pickupStop" in patch) trail.push(`stop=${patch.pickupStop || "(none)"}`);
    if ("heightCm" in patch || "weightKg" in patch) {
      trail.push(`ht=${updated.heightCm != null ? `${updated.heightCm}cm` : "—"}`);
      trail.push(`wt=${updated.weightKg != null ? `${updated.weightKg}kg` : "—"}`);
    }
    const action = ("heightCm" in patch || "weightKg" in patch)
      ? "Updated student height/weight"
      : (("transport" in patch || "pickupStop" in patch) && trail.length <= 2
        ? "Updated transport assignment"
        : "Updated student details");
    await logAudit(actor, action, `${updated.id} ${updated.name} · ${trail.join(" · ")}`);
  } catch {}
  return NextResponse.json({ ok: true, student: updated });
}

// "Withdraw" — soft-delete. Student record + all financial history are kept;
// only the active flag flips and any uncollected pending fee is dropped.
export async function DELETE(req) {
  const session = await getSession();
  const actor = session?.name || "System";
  const { id } = await req.json();
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  const archived = await archiveStudent(id);
  if (!archived) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  await logAudit(actor, "Archived student", `${archived.id} ${archived.name} · history kept`,
    { actorId: session?.sub, actorRole: session?.role, entityType: "student", entityId: archived.id });
  return NextResponse.json({ ok: true, student: archived });
}
