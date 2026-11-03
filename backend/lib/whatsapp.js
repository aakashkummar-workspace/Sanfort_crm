// WhatsApp send path — normalisation, routing, and logging.
//
// The transport itself lives in backend/lib/providers/*. This file owns what
// is school policy rather than transport detail: the India phone rules, the
// text-vs-image decision, and the record of what was sent.
//
// Env vars (set in .env.local):
//   MESSAGE_PROVIDER    = evolution | meta        (default: evolution)
//   EVOLUTION_API_URL   = https://message.sirahagents.com   (no trailing slash)
//   EVOLUTION_API_KEY   = <per-instance API key from Sirah Messenger dashboard>
//   EVOLUTION_INSTANCE  = School_Crm
//
// Why fire-and-forget: a fee payment / reminder is the user-facing happy
// path; we never want a downstream WhatsApp glitch to block or fail it.
//
// Why the log lives HERE and not at the call sites: six routes call
// notifyWhatsApp and four of them don't await it. Six independent log writers
// would drift within a release — one would forget the student id, another the
// actor — and a seventh caller would arrive with no logging at all. This
// function has five exit points and already writes an audit row at each; the
// message row goes out at the same five places, so every caller gets a full
// log row for free and can keep ignoring the promise.
import { logAudit, addWhatsAppMessage, addWhatsAppMessages, newWhatsAppMessageId } from "./db";
import { getProvider } from "./providers/index.js";
import { checkServiceStatus } from "./service-status.js";

// India numbers: strip everything except digits, drop leading 0, prefix 91
// if missing. Returns null if the result isn't a 12-digit Indian number
// (so we don't burn a WhatsApp credit on a bad row).
//
// Stays above the provider adapter on purpose: this is the school's
// single-country admissions policy, not something a transport should own.
function normalizeIndianPhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) d = "91" + d;
  if (d.length !== 12 || !d.startsWith("91")) return null;
  return d;
}

// Best-effort audit write. We never want an audit failure to block the
// WhatsApp send or the surrounding API response, so swallow exceptions.
async function recordAudit(event, status, detail) {
  try {
    await logAudit("WhatsApp", `WhatsApp · ${event} · ${status}`, detail);
  } catch {}
}

// A failing provider can answer with an HTML error page or a stack trace.
// Unbounded, that lands in a jsonb column on every failure during an outage.
const PROVIDER_RESPONSE_CAP = 2048;
function cappedProviderResponse(raw) {
  if (raw == null) return null;
  try {
    const s = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (s.length <= PROVIDER_RESPONSE_CAP) {
      return typeof raw === "string" ? { text: raw } : raw;
    }
    return { truncated: true, bytes: s.length, text: s.slice(0, PROVIDER_RESPONSE_CAP) };
  } catch {
    return { truncated: true, text: String(raw).slice(0, PROVIDER_RESPONSE_CAP) };
  }
}

// Build the log row from the payload the caller already passes. The routes
// hand us far more context than the old audit string kept — studentName,
// studentId, cls, amount, receiptId, feeType, caption — and all of it was
// being thrown away.
//
// media_url must NEVER hold the bytes: fees/pay sends the rendered receipt as
// a base64 data URI (a full PNG, routinely 50-200KB). Writing that into a text
// column grows the table by megabytes a day and makes the list query drag
// every image along with it. For a data URI we record the fact of an image and
// drop the payload — the receipt is reproducible from the fee row.
function buildLogRow(event, payload, phone) {
  // Derived here, not passed in: the early-exit paths (bad provider, missing
  // credentials) run before the send mode matters, and passing "text" there
  // lost the caption — a fee receipt logged with a null body, which is the
  // one thing this table exists to keep.
  const mode = payload.imageUrl ? "image" : "text";
  // Store media only when it is actually a reference. fees/pay sends a
  // "data:image/png;base64,..." URI and fees/send-qr sends bare base64 with no
  // prefix at all, so a startsWith("data:") test alone would still let the QR
  // bytes through. Anything that isn't an http(s) URL is treated as inline
  // bytes and dropped.
  const raw = typeof payload.imageUrl === "string" ? payload.imageUrl : "";
  const isReference = /^https?:\/\//i.test(raw);
  const hasMedia = mode === "image" && !!payload.imageUrl;
  return {
    id: newWhatsAppMessageId(),
    event,
    direction: "out",
    toPhone: phone,
    recipientName: payload.parentName || payload.recipientName || null,
    studentId: payload.studentId || null,
    studentName: payload.studentName || null,
    // For an image send the caption IS the text the parent reads, so it is the
    // body; fall back to `message` either way so nothing with words in it gets
    // logged as an empty row.
    body: (mode === "image" ? (payload.caption || payload.message) : (payload.message || payload.caption)) || null,
    mediaUrl: hasMedia && isReference ? raw : null,
    hasMedia,
    actor: payload.actor || null,
    actorId: payload.actorId || null,
    broadcastId: payload.broadcastId || null,
    retryOf: payload.retryOf || null,
    attempt: Number(payload.attempt) || (payload.retryOf ? 2 : 1),
  };
}

// Write one log row, unless the caller is collecting rows itself. The
// broadcast route fans out to up to 500 recipients; 500 individual inserts
// would spend the route's whole time budget on the log, so it passes a
// `collect` array and writes once with addWhatsAppMessages.
async function recordMessage(row, collect) {
  if (Array.isArray(collect)) { collect.push(row); return; }
  try { await addWhatsAppMessage(row); } catch {}
}

// Public entry point — signature unchanged, so pay/route.js,
// pay-online/route.js, send-qr/route.js, remind/route.js,
// broadcast/route.js and the admin diagnostic need no edits.
//
//   notifyWhatsApp("fee_paid",     { phone, imageUrl, caption, ... })
//   notifyWhatsApp("fee_qr_send",  { phone, imageUrl, caption, ... })
//   notifyWhatsApp("fee_reminder", { phone, message, ... })
//   notifyWhatsApp("broadcast",    { phone, message, ... })
//   notifyWhatsApp("test",         { phone, message, ... })
//
// Returns { ok, status?, raw?, error?, skipped?, phone?, messageId? }. Every
// attempt — success, skip, or failure — writes both an audit row and a
// whatsapp_messages row carrying the body itself.
//
// Recognised extra payload keys (all optional, all for the log):
//   actor, actorId, broadcastId, retryOf, attempt, recipientName,
//   _collect  — an array to push the row onto instead of inserting it
// Evolution serves one message at a time per WhatsApp session. On 31 Oct a
// fee-reminder run fired 166 sends inside two seconds; they queued behind
// each other at the provider and 166 of 170 hit our 8s timeout while only
// waiting their turn. Serialising here rather than at each call site fixes
// every caller at once, including broadcast, which fans out the same way.
let waChain = Promise.resolve();
const WA_GAP_MS = Number(process.env.WHATSAPP_GAP_MS || 350);

export function notifyWhatsApp(event, payload = {}) {
  const run = waChain.then(() => sendOne(event, payload));
  // Keep the chain alive on failure, and leave a gap so a long run does not
  // become a burst the moment one send returns quickly.
  waChain = run.then(
    () => new Promise((r) => setTimeout(r, WA_GAP_MS)),
    () => new Promise((r) => setTimeout(r, WA_GAP_MS))
  );
  return run;
}

async function sendOne(event, payload = {}) {
  const collect = payload._collect;
  // A bad MESSAGE_PROVIDER means nothing reaches any parent, so it is worth a
  // loud log row rather than a thrown error that a non-awaiting caller drops.
  let provider;
  try {
    provider = getProvider();
  } catch (e) {
    const detail = `${event} skipped: ${e.message}`;
    console.error(`[whatsapp] ${detail}`);
    await recordAudit(event, "skipped", detail);
    await recordMessage({
      ...buildLogRow(event, payload, normalizeIndianPhone(payload.phone)),
      status: "skipped", error: e.message,
    }, collect);
    return { ok: false, skipped: e.message };
  }

  // Billing gate: refuse to send while SirahOS reports this school's WhatsApp
  // service as locked for non-payment. Logged like any other skip, so the
  // reason shows in the message log instead of messages quietly vanishing.
  const service = await checkServiceStatus();
  if (!service.allowed) {
    const detail = `${event} skipped: WhatsApp service locked (${service.reason || "payment overdue"})`;
    console.warn(`[whatsapp] ${detail}`);
    await recordAudit(event, "skipped", detail);
    await recordMessage({
      ...buildLogRow(event, payload, normalizeIndianPhone(payload.phone)),
      provider: provider.id, status: "skipped", error: detail,
    }, collect);
    return { ok: false, skipped: detail };
  }

  const env = provider.envStatus();
  if (!env.configured) {
    const detail = `${event} skipped: ${provider.id} provider not configured`;
    console.warn(`[whatsapp] ${detail}`);
    await recordAudit(event, "skipped", detail);
    await recordMessage({
      ...buildLogRow(event, payload, normalizeIndianPhone(payload.phone)),
      provider: provider.id, status: "skipped", error: detail,
    }, collect);
    return { ok: false, skipped: `${provider.id} provider not configured` };
  }

  const phone = normalizeIndianPhone(payload.phone);
  if (!phone) {
    const detail = `${event} skipped: invalid phone "${payload.phone || ""}"`;
    await recordAudit(event, "skipped", detail);
    await recordMessage({
      ...buildLogRow(event, payload, null),
      // Keep the raw value: "which parent record has the bad number?" is the
      // first question asked, and the normalised column is null by definition.
      toPhone: payload.phone ? String(payload.phone) : null,
      provider: provider.id, status: "skipped", error: "invalid phone",
    }, collect);
    return { ok: false, skipped: "no valid phone" };
  }

  // Image-vs-text used to be a hardcoded event-name check
  // (event === "fee_paid" || event === "fee_qr_send"). When receipt rendering
  // failed upstream, fees/pay still called with imageUrl: undefined, this
  // returned skipped:"no imageUrl", and the parent got NOTHING — not even the
  // text receipt whose caption was already built. Sniff the payload instead:
  // an image if there is an image, otherwise the text we have.
  const mode = payload.imageUrl ? "image" : "text";
  // …and when the image is the thing that failed, the caption fees/pay already
  // built IS the receipt in words ("Fees paid: ₹X / Balance to pay: ₹Y"). Send
  // it as text rather than nothing, which was the whole point of the fix.
  const text = payload.message || payload.caption || "";
  const row = { ...buildLogRow(event, payload, phone), provider: provider.id };

  if (mode === "text" && !text) {
    const detail = `${event} skipped: no message in payload`;
    console.warn(`[whatsapp] ${detail}`);
    await recordAudit(event, "skipped", detail);
    await recordMessage({ ...row, status: "skipped", error: "no message" }, collect);
    return { ok: false, skipped: "no message" };
  }

  const result = mode === "image"
    ? await provider.sendImage({
        to: phone,
        media: payload.imageUrl,
        caption: payload.caption || "",
        fileName: `receipt-${Date.now()}.png`,
      })
    : await provider.sendText({ to: phone, text });

  if (result.ok) {
    await recordAudit(event, "sent", `phone=${phone}`);
    await recordMessage({
      ...row,
      status: "sent",
      providerMessageId: result.providerMessageId || null,
      providerResponse: cappedProviderResponse(result.raw),
      sentAt: new Date().toISOString(),
    }, collect);
  } else {
    const err = result.error || result.raw || result.skipped || "unknown";
    const detail = `phone=${phone} · ${result.status || "ERR"}: ${String(err).slice(0, 300)}`;
    console.warn(`[whatsapp] ${event} → ${detail}`);
    await recordAudit(event, "failed", detail);
    await recordMessage({
      ...row,
      status: "failed",
      error: String(err).slice(0, 500),
      providerResponse: cappedProviderResponse(result.raw),
    }, collect);
  }
  return { ...result, phone, messageId: row.id };
}

// Flush a batch of rows collected via payload._collect. The broadcast route
// calls this once after Promise.allSettled instead of paying for an insert per
// recipient.
export async function flushWhatsAppLog(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  try {
    const written = await addWhatsAppMessages(rows);
    return Array.isArray(written) ? written.length : 0;
  } catch { return 0; }
}

// Read-only diagnostic — reports whether each env var is present (without
// revealing the actual values). Used by the admin diagnostic endpoint so
// staff can verify the production VPS has the credentials wired in.
//
// Delegates to the active adapter, so switching MESSAGE_PROVIDER switches
// which vars the diagnostic screen reports on. `provider` is added; the
// Evolution keys and `configured` are unchanged, so the existing route keeps
// rendering.
export function whatsappEnvStatus() {
  try {
    const provider = getProvider();
    return { provider: provider.id, ...provider.envStatus() };
  } catch (e) {
    return { provider: process.env.MESSAGE_PROVIDER || null, configured: false, error: e.message };
  }
}
