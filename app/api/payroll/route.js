import { NextResponse } from "next/server";
import {
  createPayRunDraft, listPayRuns, getPayRun, updatePayslip,
  setPayRunWorkingDays, finalisePayRun, removePayRunDraft, logAudit,
} from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Admin only, and unlike /api/expenses there is no custom-role escape hatch.
// Salary is the most sensitive data in the app — a payslip discloses what
// every colleague earns — and finalising a run moves real money. Granting
// that through a feature toggle would be too easy to do by accident.
const CAN_RUN_PAYROLL = new Set(["admin"]);

function deny() {
  return NextResponse.json({ ok: false, error: "Payroll is restricted to admins" }, { status: 403 });
}

// Validation vs. genuine failure. Everything payroll throws is a sentence
// meant for the admin, so a 400 is almost always the honest status; a 500
// would hide "March already has a pay run" behind "server error".
function fail(e) {
  const msg = e?.message || "Failed";
  const validation = /required|must be|already|not found|immutable|no active staff|nothing to pay|zero|adjustment run/i.test(msg);
  return NextResponse.json({ ok: false, error: msg }, { status: validation ? 400 : 500 });
}

// GET /api/payroll            → run headers
// GET /api/payroll?id=PR-…    → one run with its payslips
export async function GET(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  if (!CAN_RUN_PAYROLL.has(session.role)) return deny();
  const id = new URL(req.url).searchParams.get("id");
  try {
    if (id) {
      const run = await getPayRun(id);
      if (!run) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
      return NextResponse.json({ ok: true, run });
    }
    return NextResponse.json({ ok: true, payRuns: await listPayRuns({ limit: 36 }) });
  } catch (e) {
    return fail(e);
  }
}

// POST /api/payroll { period, workingDays?, notes? }        → create draft
// POST /api/payroll { id, action: "finalise" }              → finalise
export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  if (!CAN_RUN_PAYROLL.has(session.role)) return deny();
  let body; try { body = await req.json(); } catch { body = null; }
  const actor = session.name || session.email || "admin";

  try {
    if (body?.action === "finalise") {
      if (!body.id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
      const run = await finalisePayRun({ id: body.id, actor });
      try {
        await logAudit(
          actor,
          "Finalised payroll",
          `${run.period} · ${run.staffCount} staff · ₹${run.totalNet.toLocaleString("en-IN")}`,
          {
            actorId: session?.sub, actorRole: session?.role,
            entityType: "payroll", entityId: run.id,
            meta: {
              period: run.period, staffCount: run.staffCount,
              totalNet: run.totalNet, expenseId: run.expenseId,
            },
          }
        );
      } catch {}
      return NextResponse.json({ ok: true, run });
    }

    if (!body?.period) return NextResponse.json({ ok: false, error: "period required" }, { status: 400 });
    const run = await createPayRunDraft({
      period: body.period, workingDays: body.workingDays, notes: body.notes, actor,
    });
    const unmatched = (run.payslips || []).filter((s) => s.attendanceSource === "unmatched").length;
    try {
      await logAudit(
        actor,
        "Created payroll draft",
        `${run.period} · ${run.staffCount} staff · ₹${run.totalNet.toLocaleString("en-IN")}${unmatched ? ` · ${unmatched} unmatched` : ""}`,
        {
          actorId: session?.sub, actorRole: session?.role,
          entityType: "payroll", entityId: run.id,
          meta: {
            period: run.period, staffCount: run.staffCount,
            totalNet: run.totalNet, workingDays: run.workingDays, unmatched,
          },
        }
      );
    } catch {}
    return NextResponse.json({ ok: true, run });
  } catch (e) {
    return fail(e);
  }
}

// PATCH /api/payroll { payslipId, allowances?, deductions?, lopDays?, notes? }
// PATCH /api/payroll { id, workingDays }
export async function PATCH(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  if (!CAN_RUN_PAYROLL.has(session.role)) return deny();
  let body; try { body = await req.json(); } catch { body = null; }
  const actor = session.name || session.email || "admin";

  try {
    if (body?.payslipId) {
      const slip = await updatePayslip({
        id: body.payslipId,
        allowances: body.allowances, deductions: body.deductions,
        lopDays: body.lopDays, notes: body.notes,
      });
      try {
        await logAudit(
          actor,
          "Edited payslip",
          `${slip.staffName} · ${slip.period} · net ₹${slip.net.toLocaleString("en-IN")}`,
          {
            actorId: session?.sub, actorRole: session?.role,
            entityType: "payroll", entityId: slip.runId,
            meta: {
              payslipId: slip.id, staffId: slip.staffId, period: slip.period,
              allowances: slip.allowances, deductions: slip.deductions,
              lopDays: slip.lopDays, net: slip.net,
            },
          }
        );
      } catch {}
      return NextResponse.json({ ok: true, payslip: slip });
    }

    if (body?.id && body.workingDays !== undefined) {
      const run = await setPayRunWorkingDays({ id: body.id, workingDays: body.workingDays });
      try {
        await logAudit(
          actor,
          "Changed payroll working days",
          `${run.period} · ${run.workingDays} days · net ₹${run.totalNet.toLocaleString("en-IN")}`,
          {
            actorId: session?.sub, actorRole: session?.role,
            entityType: "payroll", entityId: run.id,
            meta: { period: run.period, workingDays: run.workingDays, totalNet: run.totalNet },
          }
        );
      } catch {}
      return NextResponse.json({ ok: true, run });
    }

    return NextResponse.json({ ok: false, error: "payslipId or (id + workingDays) required" }, { status: 400 });
  } catch (e) {
    return fail(e);
  }
}

// DELETE /api/payroll { id } — drafts only; finalisePayRun's output is permanent.
export async function DELETE(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  if (!CAN_RUN_PAYROLL.has(session.role)) return deny();
  let body; try { body = await req.json(); } catch { body = null; }
  if (!body?.id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  const actor = session.name || session.email || "admin";
  try {
    const removed = await removePayRunDraft(body.id);
    if (!removed) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    try {
      await logAudit(
        actor,
        "Deleted payroll draft",
        `${removed.period} · ${removed.staffCount} staff`,
        {
          actorId: session?.sub, actorRole: session?.role,
          entityType: "payroll", entityId: removed.id,
          meta: { period: removed.period, staffCount: removed.staffCount, totalNet: removed.totalNet },
        }
      );
    } catch {}
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
