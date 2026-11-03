import { NextResponse } from "next/server";
import { fileRead, fileWrite, logAudit } from "@/lib/db";
import { supabase, supabaseEnabled, fromPendingFee, fromStudent } from "@/lib/supabase";
import { getSession } from "@/lib/auth";
import { notifyWhatsApp } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

const CAN_REMIND = new Set(["admin", "principal"]);

// POST /api/fees/remind   { id?: string,  ids?: string[],  message?: string }
// Sends an in-app reminder. If neither id nor ids given, reminds EVERY pending parent.
// Reminders are stored as broadcasts so they land in Communication too.
export async function POST(req) {
  const session = await getSession();
  if (!session || !CAN_REMIND.has(session.role)) {
    return NextResponse.json({ ok: false, error: "Not authorised" }, { status: 403 });
  }
  let body; try { body = await req.json(); } catch { body = null; }
  const ids = Array.isArray(body?.ids) ? body.ids : (body?.id ? [body.id] : null);
  const customMessage = (body?.message && String(body.message).trim()) || null;

  const db = fileRead();
  // Pull pending fees from Supabase first (where new fees live), then merge
  // in anything still sitting in the file store. Dedupe by id, Supabase wins.
  const filePending = Array.isArray(db.pendingFees) ? db.pendingFees : [];
  let supaPending = [];
  if (supabaseEnabled) {
    const sel = ids
      ? await supabase.from("pending_fees").select("*").in("id", ids)
      : await supabase.from("pending_fees").select("*");
    if (!sel.error && Array.isArray(sel.data)) {
      supaPending = sel.data.map(fromPendingFee);
    }
  }
  const merged = new Map();
  filePending.forEach((p) => merged.set(p.id, p));
  supaPending.forEach((p) => merged.set(p.id, p));
  const pending = [...merged.values()];
  const targets = ids ? pending.filter((p) => ids.includes(p.id)) : pending;
  if (targets.length === 0) {
    return NextResponse.json({ ok: false, error: ids ? "No matching pending fees" : "No pending fees to remind about" }, { status: 400 });
  }

  if (!Array.isArray(db.broadcasts)) db.broadcasts = [];
  if (!Array.isArray(db.feeReminders)) db.feeReminders = [];

  const now = new Date();
  const sent = [];
  // Build a quick studentId → student lookup so we can get the parent's
  // phone for the WhatsApp event without N+1 reads. Pull from Supabase too,
  // since admissions write there now.
  const studentById = new Map(
    (db.addedStudents || []).map((s) => [s.id, s])
  );
  if (supabaseEnabled) {
    const targetIds = [...new Set(targets.map((t) => t.studentId || t.id))];
    if (targetIds.length) {
      const sel = await supabase.from("students").select("*").in("id", targetIds);
      if (!sel.error && Array.isArray(sel.data)) {
        sel.data.forEach((row) => {
          const s = fromStudent(row);
          studentById.set(s.id, s);
        });
      }
    }
  }
  // Collect the WhatsApp attempts so their real outcome can be reported back.
  // These used to be fire-and-forget with `.catch(() => {})`, so the screen
  // said "reminders sent" whether or not a single one reached a parent — which
  // is how 388 reminders failed in one batch on 29 Oct with nobody noticing.
  const waAttempts = [];

  for (const p of targets) {
    const msg = customMessage || defaultReminderMessage(p);
    const reminder = {
      id: `FRM-${now.getTime().toString(36).toUpperCase()}-${Math.floor(Math.random() * 999)}`,
      studentId: p.id,
      studentName: p.name,
      cls: p.cls,
      amount: p.amount,
      message: msg,
      sentAt: now.toISOString(),
      sentBy: session.name || "Admin",
    };
    db.feeReminders.unshift(reminder);
    db.broadcasts.unshift({
      id: `BRC-${reminder.id}`,
      campaign: "Fee reminder",
      audience: `student:${p.id}`,
      audienceLabel: p.name,
      channel: "in_app",
      message: msg,
      sent: 1,
      delivered: 1,
      sentAt: now.toISOString(),
    });
    sent.push(reminder);
    // Fire-and-forget WhatsApp text. Skipped silently if the parent has no
    // phone on file or Evolution env vars aren't configured.
    const stu = studentById.get(p.studentId) || studentById.get(p.id);
    const phone = stu?.parent || p.parent;
    if (phone) {
      const amountLabel = `₹${(p.amount || 0).toLocaleString("en-IN")}`;
      const messageText = [
        `Name: ${p.name}`,
        `Class & Section: ${p.cls || "—"}`,
        `Balance to pay: ${amountLabel}`,
        "",
        "Kindly pay the balance fees.",
        "",
        "— Sanfort International School",
        "Thank you.",
      ].join("\n");
      waAttempts.push(
        notifyWhatsApp("fee_reminder", {
          phone,
          parentName: "Parent",
          studentName: p.name,
          studentId: p.studentId || p.id,
          amount: amountLabel,
          dueDate: p.due || "soon",
          cls: p.cls,
          overdue: !!p.overdue,
          actor: session.name || "Admin",
          // Plain-text body the provider's text branch reads.
          message: messageText,
        }).then(
          (r) => ({ ok: !!(r && r.ok), skipped: !!(r && r.skipped), name: p.name,
                    error: r && (r.error || r.skipped) ? String(r.error || r.skipped).slice(0, 120) : null }),
          (e) => ({ ok: false, skipped: false, name: p.name, error: String(e && e.message || e).slice(0, 120) })
        )
      );
    } else {
      waAttempts.push(Promise.resolve({ ok: false, skipped: true, name: p.name, error: "no phone on file" }));
    }
  }
  fileWrite(db);

  // Wait for the sends rather than assuming they worked. Capped so a hanging
  // provider cannot hold the request open indefinitely — anything unresolved
  // by then is reported as unknown, not as delivered.
  // Sends are serialised in notifyWhatsApp (~1.5s each), so a full roster run
  // takes minutes — longer than any HTTP request should be held open. Wait
  // only as long as the batch could plausibly finish; past that let it carry
  // on in the background and say so, rather than reporting "unknown" for
  // sends that are simply still queued. Each one writes its own log row.
  let delivery = { attempted: waAttempts.length, delivered: 0, failed: 0, skipped: 0, failures: [] };
  if (waAttempts.length) {
    const budgetMs = Math.min(25000, 4000 + waAttempts.length * 1800);
    const settled = await Promise.race([
      Promise.all(waAttempts),
      new Promise((res) => setTimeout(() => res(null), budgetMs)),
    ]);
    if (settled) {
      for (const r of settled) {
        if (r.ok) delivery.delivered++;
        else if (r.skipped) delivery.skipped++;
        else { delivery.failed++; if (delivery.failures.length < 10) delivery.failures.push({ name: r.name, error: r.error }); }
      }
    } else {
      // Still working through the queue, not a failure. The count is what
      // is left to send; the WhatsApp log shows each outcome as it lands.
      delivery.sending = waAttempts.length;
    }
  }

  try {
    await logAudit(session.name || "Admin", "Sent fee reminders",
      `${sent.length} parent${sent.length === 1 ? "" : "s"} reminded · total ₹${sent.reduce((a, r) => a + (r.amount || 0), 0).toLocaleString("en-IN")}` +
      ` · WhatsApp ${delivery.delivered}/${delivery.attempted} delivered${delivery.failed ? `, ${delivery.failed} failed` : ""}`,
      { actorId: session.sub, actorRole: session.role, entityType: "fee_reminder",
        meta: { reminded: sent.length, ...delivery, failures: undefined } });
  } catch {}
  return NextResponse.json({ ok: true, sent, delivery });
}

function defaultReminderMessage(p) {
  const amt = (p.amount || 0).toLocaleString("en-IN");
  return `Friendly reminder: a fee of ₹${amt} is pending for ${p.name} (${p.cls}). Please clear it at your earliest convenience or contact the school office. — Sanfort International School`;
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  const db = fileRead();
  return NextResponse.json({ ok: true, reminders: Array.isArray(db.feeReminders) ? db.feeReminders : [] });
}
