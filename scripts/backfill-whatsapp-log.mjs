// Rebuild the WhatsApp message history from the audit trail.
//
//   node scripts/backfill-whatsapp-log.mjs --dry-run    # report only
//   node scripts/backfill-whatsapp-log.mjs              # write
//
// Until whatsapp_messages existed, the only record of a send was an audit row
// like:
//
//   who="WhatsApp"  action="WhatsApp · fee_reminder · failed"
//   entity="phone=917845994346 · 500: {...}"
//
// That is enough to reconstruct WHO was contacted, WHEN, about WHAT, and
// whether it arrived — which is what the school needs to answer "did this
// parent get their reminder?". It is NOT enough to recover the message text:
// the body was never stored anywhere. Imported rows therefore carry a null
// body and are marked `imported: true` in meta, so nobody mistakes a
// reconstructed row for a logged one.
//
// Where the recipient's phone matches a student's parent, the student is
// linked so the row can be found by name. Safe to re-run: ids are derived from
// the audit row id, so a second run updates rather than duplicates.

import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const DRY = process.argv.includes("--dry-run");
// Only messages that actually reached a parent are imported by default. The
// failures are already visible in Activity history, and 1,562 of the 2,277
// attempts failed — importing them would bury the 380 real sends. Pass --all
// to include failures and skips.
const ONLY_SENT = !process.argv.includes("--all");

const envPath = path.join(process.cwd(), ".env.local");
if (!fs.existsSync(envPath)) {
  console.error("No .env.local found — run this from the project root.");
  process.exit(1);
}
const env = Object.fromEntries(
  fs.readFileSync(envPath, "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// "WhatsApp · fee_reminder · failed" → { event, status }
function parseAction(action = "") {
  const m = action.match(/^WhatsApp\s*·\s*([a-z_]+)\s*·\s*(sent|failed|skipped)$/i);
  if (m) return { event: m[1], status: m[2].toLowerCase() };
  // The one-off "Sent UPI QR via WhatsApp" row predates the convention.
  if (/UPI QR via WhatsApp/i.test(action)) return { event: "fee_qr_send", status: "sent" };
  return null;
}

// "phone=917845994346 · 500: {...}" → { phone, error }
function parseEntity(entity = "") {
  const phone = (entity.match(/phone=(\d+)/) || [])[1] || null;
  const rest = entity.replace(/^phone=\d+\s*(·\s*)?/, "").trim();
  return { phone, error: rest || null };
}

// A parent's phone is scraped out of the free-text `parent` field the same way
// the rest of the app does it — last 10 digits, prefixed 91.
function phoneKey(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return "91" + digits.slice(-10);
}

async function main() {
  console.log(DRY ? "DRY RUN — nothing will be written\n" : "Writing to whatsapp_messages\n");

  // 1. Every WhatsApp audit row, oldest first so ordering reads naturally.
  let rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await sb.from("audit_log").select("id,action,entity,when_label,created_at")
      .or("who.eq.WhatsApp,action.ilike.%WhatsApp%")
      .order("created_at", { ascending: true }).range(from, from + 999);
    if (r.error) { console.error("Read failed:", r.error.message); process.exit(1); }
    rows = rows.concat(r.data || []);
    if ((r.data || []).length < 1000) break;
  }
  console.log(`audit rows found: ${rows.length}`);

  // 2. Phone → student, so a reconstructed row can be found by child's name.
  const students = [];
  for (let from = 0; ; from += 1000) {
    const r = await sb.from("students").select("id,name,parent").range(from, from + 999);
    if (r.error) break;
    students.push(...(r.data || []));
    if ((r.data || []).length < 1000) break;
  }
  const byPhone = new Map();
  for (const s of students) {
    const k = phoneKey(s.parent);
    if (k && !byPhone.has(k)) byPhone.set(k, s);
  }
  console.log(`students with a usable parent phone: ${byPhone.size}`);

  // 3. Build the message rows.
  const out = [];
  let unparsed = 0;
  let excluded = 0;
  for (const r of rows) {
    const parsed = parseAction(r.action || "");
    if (!parsed) { unparsed++; continue; }
    if (ONLY_SENT && parsed.status !== "sent") { excluded++; continue; }
    const { phone, error } = parseEntity(r.entity || "");
    const student = phone ? byPhone.get(phone) : null;
    out.push({
      // Derived from the audit id, so re-running updates in place.
      id: `WAM-IMP-${r.id}`,
      provider: "evolution",
      provider_message_id: null,
      event: parsed.event,
      direction: "out",
      to_phone: phone,
      recipient_name: student ? student.parent : null,
      student_id: student ? student.id : null,
      student_name: student ? student.name : null,
      // Never stored. Null rather than a placeholder, so the screen can say so.
      body: null,
      media_url: null,
      has_media: parsed.event === "fee_paid" || parsed.event === "fee_qr_send",
      status: parsed.status,
      error: parsed.status === "failed" ? (error || "").slice(0, 500) : null,
      provider_response: { imported: true, from_audit: r.id, detail: (error || "").slice(0, 500) },
      actor: "(imported from audit)",
      actor_id: null,
      broadcast_id: null,
      retry_of: null,
      attempt: 1,
      created_at: r.created_at,
      sent_at: parsed.status === "sent" ? r.created_at : null,
      delivered_at: null,
    });
  }

  const byStatus = {};
  const byEvent = {};
  for (const m of out) {
    byStatus[m.status] = (byStatus[m.status] || 0) + 1;
    byEvent[m.event] = (byEvent[m.event] || 0) + 1;
  }
  const linked = out.filter((m) => m.student_id).length;

  console.log(`\nreconstructed: ${out.length} messages (${unparsed} audit rows not message events)`);
  if (ONLY_SENT) console.log(`  excluded ${excluded} failed/skipped attempts — pass --all to include them`);
  console.log("  by status:", JSON.stringify(byStatus));
  console.log("  by event: ", JSON.stringify(byEvent));
  console.log(`  linked to a student: ${linked} of ${out.length}`);
  const first = out[0], last = out[out.length - 1];
  if (first && last) console.log(`  range: ${String(first.created_at).slice(0, 10)} → ${String(last.created_at).slice(0, 10)}`);

  if (DRY) { console.log("\nDry run — nothing written. Re-run without --dry-run to import."); return; }
  if (out.length === 0) { console.log("Nothing to import."); return; }

  let written = 0;
  for (let i = 0; i < out.length; i += 200) {
    const batch = out.slice(i, i + 200);
    const r = await sb.from("whatsapp_messages").upsert(batch, { onConflict: "id" });
    if (r.error) { console.error(`batch at ${i} failed:`, r.error.message); process.exit(1); }
    written += batch.length;
    process.stdout.write(`\r  written ${written}/${out.length}`);
  }
  console.log(`\n\nImported ${written} messages. The WhatsApp screen now shows the full history.`);
  console.log("Imported rows have no body — the text was never stored — and are");
  console.log('marked "(imported from audit)" so they are distinguishable.');
}

main().catch((e) => { console.error(e); process.exit(1); });
