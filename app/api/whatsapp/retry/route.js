import { NextResponse } from "next/server";
import { getWhatsAppMessage, logAudit } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { notifyWhatsApp } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

// Admin only — tighter than the read route. A retry sends a real message to a
// real parent, and a reminder arriving twice is a support call.
const CAN_RETRY = new Set(["admin"]);

// POST /api/whatsapp/retry  { id }
//
// Manual retry only. There is deliberately no auto-retry anywhere in this
// path: the common failure is a wrong or disconnected number, which no amount
// of retrying fixes, and a background retry loop over a 500-recipient
// broadcast could send the same message to every parent twice.
//
// The retry is a NEW log row pointing at the original via retry_of, not an
// in-place status flip. The failed attempt is history and stays readable.
export async function POST(req) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });
  }
  if (!CAN_RETRY.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Only an admin can re-send a message" }, { status: 403 });
  }

  let body; try { body = await req.json(); } catch { body = null; }
  const id = body?.id;
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const original = await getWhatsAppMessage(id);
  if (!original) {
    return NextResponse.json({ ok: false, error: "No such message in the log" }, { status: 404 });
  }
  if (!original.toPhone) {
    return NextResponse.json({
      ok: false,
      error: "That message has no phone number to re-send to — fix the parent's number on the student record first.",
    }, { status: 400 });
  }
  if (!original.body && !original.mediaUrl) {
    return NextResponse.json({ ok: false, error: "That message has no body to re-send" }, { status: 400 });
  }

  // A receipt originally sent as a base64 data URI has no bytes in the log on
  // purpose (see schema.sql), so the retry goes out as the caption text. That
  // is the right trade: the parent gets the amount and balance in words rather
  // than nothing, and re-rendering the PNG means replaying the fee payment.
  const result = await notifyWhatsApp(original.event || "test", {
    phone: original.toPhone,
    message: original.body || "",
    imageUrl: original.mediaUrl || undefined,
    caption: original.body || "",
    recipientName: original.recipientName,
    studentId: original.studentId,
    studentName: original.studentName,
    actor: session.name || "Admin",
    actorId: session.id || null,
    retryOf: original.id,
    attempt: (Number(original.attempt) || 1) + 1,
  });

  try {
    await logAudit(
      session.name || "Admin",
      "WhatsApp message re-sent",
      `${original.event} → ${original.toPhone}${original.studentName ? ` (${original.studentName})` : ""} · ok=${!!result.ok}`,
      { actorId: session.id || null, actorRole: session.role, entityType: "whatsapp", entityId: original.id }
    );
  } catch {}

  return NextResponse.json({ ok: true, result, retryOf: original.id, messageId: result.messageId || null });
}
