// Mark timed-out sends that Evolution actually delivered.
//
// On 31 Oct 2026 a fee-reminder run burst 166 sends at Evolution. It served
// them one at a time and delivered them, but answered too slowly, so our 8s
// client timeout recorded a failure. Checking Evolution's own sent history
// afterwards showed all 72 unique numbers DID receive the message.
//
// A row that says "failed" when the parent has the message is worse than no
// row: staff re-send, and the parent gets a duplicate fee demand. This walks
// the timed-out rows, asks Evolution whether an outbound message exists for
// that number on that day, and corrects the ones that landed.
//
//   node scripts/reconcile-whatsapp-timeouts.mjs            # report only
//   node scripts/reconcile-whatsapp-timeouts.mjs --apply    # write changes
//
// Only touches rows whose error is a client-side timeout. A 400 "number does
// not exist" is a real failure and is left alone.

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const evoUrl = process.env.EVOLUTION_API_URL;
const evoKey = process.env.EVOLUTION_API_KEY;
const evoInst = process.env.EVOLUTION_INSTANCE;

if (!url || !key) { console.error("Supabase env vars missing"); process.exit(1); }
if (!evoUrl || !evoKey || !evoInst) { console.error("Evolution env vars missing"); process.exit(1); }

const db = createClient(url, key);

// Did Evolution send anything to this number on this day?
const seen = new Map();
async function deliveredOn(phone, dayISO) {
  const cacheKey = `${phone}|${dayISO}`;
  if (seen.has(cacheKey)) return seen.get(cacheKey);
  const from = Date.parse(`${dayISO}T00:00:00Z`);
  const to = from + 86400000;
  let hit = false;
  try {
    const res = await fetch(`${evoUrl}/chat/findMessages/${evoInst}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: evoKey },
      body: JSON.stringify({
        where: { key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: true } },
        limit: 50,
      }),
    });
    const j = await res.json();
    const recs = j?.messages?.records || [];
    hit = recs.some((r) => {
      const t = (r.messageTimestamp || 0) * 1000;
      return t >= from && t < to;
    });
  } catch (e) {
    console.warn(`  ${phone}: lookup failed (${e.message}) — left unchanged`);
    hit = null; // unknown: never downgrade a row on a lookup error
  }
  seen.set(cacheKey, hit);
  return hit;
}

const { data: rows, error } = await db
  .from("whatsapp_messages")
  .select("id,to_phone,created_at,error,status")
  .eq("status", "failed")
  .like("error", "%timed out%")
  .limit(2000);

if (error) { console.error("read failed:", error.message); process.exit(1); }
console.log(`${rows.length} timed-out rows to check${APPLY ? "" : "  (dry run)"}\n`);

let fixed = 0, stillFailed = 0, unknown = 0;
for (const r of rows) {
  const day = String(r.created_at).slice(0, 10);
  const got = await deliveredOn(r.to_phone, day);
  if (got === null) { unknown++; continue; }
  if (!got) { stillFailed++; continue; }
  fixed++;
  if (APPLY) {
    const { error: e2 } = await db
      .from("whatsapp_messages")
      .update({
        status: "sent",
        error: "Delivered. Our 8s timeout recorded a failure; Evolution's own history confirms it was sent.",
      })
      .eq("id", r.id);
    if (e2) console.warn(`  ${r.id}: update failed (${e2.message})`);
  }
}

console.log(`delivered after all : ${fixed}${APPLY ? " (corrected)" : " (would correct)"}`);
console.log(`genuinely failed    : ${stillFailed}`);
if (unknown) console.log(`could not check     : ${unknown} (left as failed)`);
if (!APPLY && fixed) console.log(`\nRe-run with --apply to write these.`);
