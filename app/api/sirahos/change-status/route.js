import { NextResponse } from "next/server";
import { getChangeReport, updateChangeReport } from "@/lib/db";

/**
 * POST /api/sirahos/change-status
 *
 * Sirah Digital moved one of our reports along on their side; mirror it here
 * so whoever filed it sees the answer without being told in a WhatsApp group.
 *
 * Authenticated with a shared secret rather than a session: the caller is
 * their server, and no person is signed in.
 */

// Narrower than the full set on purpose: triage here can still set
// "duplicate", which SirahOS has no equivalent for and must not overwrite.
const PUSHABLE = ["new", "acknowledged", "in_progress", "fixed", "wont_fix"];

export async function POST(req) {
  const expected = (process.env.SIRAHOS_CALLBACK_SECRET || "").trim();
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Status callbacks are not configured on this server" },
      { status: 503 },
    );
  }
  if ((req.headers.get("x-sirahos-signature") || "") !== expected) {
    return NextResponse.json({ ok: false, error: "Invalid signature" }, { status: 401 });
  }

  let body;
  try { body = await req.json(); } catch { body = null; }

  const reportId = String(body?.reportId ?? "").trim();
  const status = String(body?.status ?? "").trim();
  if (!reportId) return NextResponse.json({ ok: false, error: "reportId is required" }, { status: 400 });
  if (!PUSHABLE.includes(status)) {
    return NextResponse.json({ ok: false, error: "Unknown status" }, { status: 400 });
  }

  const existing = await getChangeReport(reportId);
  if (!existing) return NextResponse.json({ ok: false, error: "Report not found" }, { status: 404 });

  // Already there: a retry, or someone set it here first. Say so rather than
  // writing a second identical update.
  if (existing.status === status) {
    return NextResponse.json({ ok: true, id: reportId, status, unchanged: true });
  }

  const patch = { status };
  if (body?.resolutionNotes) patch.resolutionNotes = String(body.resolutionNotes).slice(0, 5000);

  const updated = await updateChangeReport(reportId, patch);
  return NextResponse.json({ ok: true, id: updated?.id ?? reportId, status: updated?.status ?? status });
}
