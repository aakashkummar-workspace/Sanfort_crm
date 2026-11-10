import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  addChangeReport, listChangeReports, notifyRole, logAudit,
} from "@/lib/db";
import { writeScreenshot } from "@/lib/media";
import { forwardToSirahOS } from "@/lib/change-forward";
import {
  canFile, canTriage, REPORT_TYPES, SEVERITIES, STATUSES,
} from "@/lib/change-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/change-reports?status=&type=&severity=&limit=&offset=
//
// A triager sees everything. Everyone else sees ONLY their own reports, and
// that is enforced by pinning reporterId into the query rather than by
// filtering what comes back — a caller cannot widen their own scope by
// sending a different parameter, because no parameter controls it.
export async function GET(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  if (!canFile(session.role) && !canTriage(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised" }, { status: 403 });
  }

  const sp = new URL(req.url).searchParams;
  const triager = canTriage(session.role);

  try {
    const out = await listChangeReports({
      reporterId: triager ? undefined : session.sub,
      status: sp.get("status") || undefined,
      type: sp.get("type") || undefined,
      severity: sp.get("severity") || undefined,
      limit: Math.min(Math.max(Number(sp.get("limit")) || 50, 1), 200),
      offset: Math.max(Number(sp.get("offset")) || 0, 0),
    });
    return NextResponse.json({ ok: true, ...out, canTriage: triager });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Failed" }, { status: 500 });
  }
}

// POST /api/change-reports — file a report.
export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  if (!canFile(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised to file reports" }, { status: 403 });
  }

  let body; try { body = await req.json(); } catch { body = null; }
  if (!body?.title?.trim()) return NextResponse.json({ ok: false, error: "A short title is required" }, { status: 400 });
  if (!body?.description?.trim()) return NextResponse.json({ ok: false, error: "Please describe what happened" }, { status: 400 });

  const type = REPORT_TYPES.includes(body.type) ? body.type : "bug";
  const severity = SEVERITIES.includes(body.severity) ? body.severity : "major";

  // Write the screenshot first: if it is malformed or oversized we reject
  // before creating a report that points at a file which does not exist.
  let screenshotFile = null;
  if (body.screenshot) {
    try {
      screenshotFile = writeScreenshot(body.screenshot).file;
    } catch (e) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
    }
  }

  try {
    const report = await addChangeReport({
      type, severity,
      title: body.title.trim(),
      description: body.description.trim(),
      expectedBehaviour: body.expectedBehaviour?.trim() || null,
      pageUrl: body.pageUrl, pageRoute: body.pageRoute,
      browserInfo: body.browserInfo, screenSize: body.screenSize,
      screenshotFile,
      reporterId: session.sub,
      reporterName: session.name || session.email || "Staff",
      reporterRole: session.role,
    });

    // Fire-and-forget: the report is already saved, and a notification
    // failure must never cost the reporter their report.
    notifyRole(["admin", "principal"], {
      type: severity === "blocking" ? "urgent" : "info",
      title: severity === "blocking"
        ? `Blocking issue: ${report.title}`
        : `Change report: ${report.title}`,
      description: `${report.reporterName} · ${report.pageRoute || "unknown screen"}`,
      redirectUrl: "/?screen=change_reports",
    }).catch((e) => console.warn(`[change-reports] notify failed: ${e.message}`));

    // Copy it to Sirah Digital, who make the changes. Same reasoning as above:
    // not awaited, never throws, and the report stands without it.
    forwardToSirahOS(report).catch(() => {});

    try {
      await logAudit(session.name || "Staff", "Filed change report", `${report.id} · ${report.title}`, {
        actorId: session.sub, actorRole: session.role,
        entityType: "change_report", entityId: report.id,
        meta: { type, severity, route: report.pageRoute, hasScreenshot: !!screenshotFile },
      });
    } catch {}

    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message || "Could not save the report" }, { status: 500 });
  }
}
