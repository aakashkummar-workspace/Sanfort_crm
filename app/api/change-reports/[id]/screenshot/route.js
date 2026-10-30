import { NextResponse } from "next/server";
import fs from "fs";
import { Readable } from "stream";
import { getSession } from "@/lib/auth";
import { getChangeReport } from "@/lib/db";
import { screenshotPath } from "@/lib/media";
import { canTriage } from "@/lib/change-reports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/change-reports/<id>/screenshot
//
// The whole reason screenshots live outside public/: this endpoint is the
// only way to read one, and it checks the session first. A screenshot can
// show a student's marks, a family's fee balance or a staff salary, so an
// unauthenticated URL would be a data leak to anyone who guessed the name.
export async function GET(req, { params }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });

  const report = await getChangeReport(params.id).catch(() => null);
  const allowed = report
    && (canTriage(session.role) || report.reporterId === session.sub);
  // Missing, forbidden and no-screenshot all answer the same way.
  if (!allowed || !report.screenshotFile) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  let full, size;
  try {
    full = screenshotPath(report.screenshotFile);
    size = fs.statSync(full).size;
  } catch {
    return NextResponse.json({ ok: false, error: "The screenshot file is missing" }, { status: 410 });
  }

  return new NextResponse(Readable.toWeb(fs.createReadStream(full)), {
    status: 200,
    headers: {
      "Content-Type": report.screenshotFile.endsWith(".png") ? "image/png" : "image/jpeg",
      "Content-Length": String(size),
      // Private: personal data, must not sit in a shared cache.
      "Cache-Control": "private, max-age=0, no-store",
    },
  });
}
