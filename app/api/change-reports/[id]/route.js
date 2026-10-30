import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getChangeReport, updateChangeReport, removeChangeReport,
  addNotification, logAudit,
} from "@/lib/db";
import { deleteScreenshot } from "@/lib/media";
import { canTriage, STATUSES, STATUS_LABELS } from "@/lib/change-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// May this session see this particular report? Triagers see all; everyone
// else sees only what they filed. One function, used by GET, PATCH and
// DELETE, so the three cannot drift apart.
function mayView(session, report) {
  if (!session || !report) return false;
  if (canTriage(session.role)) return true;
  return report.reporterId === session.sub;
}

export async function GET(req, { params }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  const report = await getChangeReport(params.id).catch(() => null);
  // Same answer for missing and forbidden, so the id space cannot be probed
  // for which reports exist.
  if (!mayView(session, report)) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, report, canTriage: canTriage(session.role) });
}

// PATCH — triage only. A reporter must not be able to mark their own report
// fixed, or reassign it.
export async function PATCH(req, { params }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  if (!canTriage(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised" }, { status: 403 });
  }

  let body; try { body = await req.json(); } catch { body = null; }
  if (body?.status && !STATUSES.includes(body.status)) {
    return NextResponse.json({ ok: false, error: "Unknown status" }, { status: 400 });
  }

  const before = await getChangeReport(params.id).catch(() => null);
  if (!before) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  try {
    const report = await updateChangeReport(params.id, {
      status: body?.status,
      assignedToId: body?.assignedToId,
      assignedToName: body?.assignedToName,
      resolutionNotes: body?.resolutionNotes,
    });

    // Tell the reporter their report moved. People who never see their
    // reports go anywhere stop filing them.
    if (body?.status && body.status !== before.status && before.reporterId
        && before.reporterId !== session.sub) {
      addNotification({
        userId: before.reporterId,
        type: "info",
        title: `Your report is now ${STATUS_LABELS[body.status] || body.status}`,
        description: before.title,
        redirectUrl: "/?screen=change_reports",
      }).catch((e) => console.warn(`[change-reports] reporter notify failed: ${e.message}`));
    }

    try {
      await logAudit(session.name || "Admin", "Updated change report", `${params.id} · ${before.title}`, {
        actorId: session.sub, actorRole: session.role,
        entityType: "change_report", entityId: params.id,
        meta: { from: before.status, to: report?.status, assigned: report?.assignedToName || null },
      });
    } catch {}

    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 500 });
  }
}

// DELETE — triage only. Removes the screenshot too: a deleted report should
// not leave a picture of someone's fee record on disk.
export async function DELETE(req, { params }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  if (!canTriage(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised" }, { status: 403 });
  }
  try {
    const removed = await removeChangeReport(params.id);
    if (!removed) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    if (removed.screenshotFile) deleteScreenshot(removed.screenshotFile);
    try {
      await logAudit(session.name || "Admin", "Deleted change report", `${params.id} · ${removed.title}`, {
        actorId: session.sub, actorRole: session.role,
        entityType: "change_report", entityId: params.id,
      });
    } catch {}
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 500 });
  }
}
