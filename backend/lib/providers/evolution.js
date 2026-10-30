// Evolution API adapter — the provider the school runs today.
//
// Env vars (set in .env.local):
//   EVOLUTION_API_URL   = https://message.sirahagents.com   (no trailing slash)
//   EVOLUTION_API_KEY   = <per-instance API key from Sirah Messenger dashboard>
//   EVOLUTION_INSTANCE  = School_Crm
//
// Lifted verbatim out of whatsapp.js so the transport can be swapped without
// touching the India-specific phone normalisation or the logging around it.
// `to` arrives already normalised — see the note in providers/index.js.

function evolutionConfig() {
  const base = (process.env.EVOLUTION_API_URL || "").replace(/\/+$/, "");
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;
  if (!base || !key || !instance) return null;
  return { base, key, instance };
}

// Low-level POST to Evolution. 8s timeout (image sends take a couple of
// seconds because Evolution streams the upload to WhatsApp).
async function evoPost(path, body) {
  const cfg = evolutionConfig();
  if (!cfg) return { ok: false, error: "Evolution env vars not set" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${cfg.base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.key,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // Carry a readable reason, not just the status. Everything upstream —
      // the log row, the audit line, the diagnostic panel — reads `.error`,
      // so a failure that set only `.status` arrived as an unexplained
      // false and got rendered as "Delivered to the provider".
      const snippet = text.trim().slice(0, 300);
      return {
        ok: false,
        status: res.status,
        error: `Evolution returned HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`,
        raw: text.slice(0, 2000),
      };
    }
    // The old code read the body as text and discarded it. Evolution returns
    // the WhatsApp message id at key.id — without it a future delivery-receipt
    // webhook has no column to join the log row on.
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch {}
    return {
      ok: true,
      status: res.status,
      providerMessageId: parsed?.key?.id || null,
      raw: parsed || text.slice(0, 2000),
    };
  } catch (e) {
    clearTimeout(timer);
    // AbortError's own message ("The operation was aborted") says nothing
    // about which side gave up, and a timeout is the failure we see most.
    const msg = e.name === "AbortError" ? "Evolution timed out after 8s" : e.message;
    return { ok: false, error: msg };
  }
}

export const id = "evolution";

// Read-only diagnostic — reports whether each env var is present (without
// revealing the actual values).
export function envStatus() {
  return {
    EVOLUTION_API_URL: !!process.env.EVOLUTION_API_URL,
    EVOLUTION_API_KEY: !!process.env.EVOLUTION_API_KEY,
    EVOLUTION_INSTANCE: !!process.env.EVOLUTION_INSTANCE,
    configured: !!evolutionConfig(),
  };
}

export async function sendText({ to, text }) {
  const cfg = evolutionConfig();
  if (!cfg) return { ok: false, error: "Evolution env vars not set" };
  return evoPost(`/message/sendText/${cfg.instance}`, { number: to, text });
}

export async function sendImage({ to, media, caption, fileName }) {
  const cfg = evolutionConfig();
  if (!cfg) return { ok: false, error: "Evolution env vars not set" };
  // Evolution v2 sendMedia. `media` accepts a URL or raw base64 (no
  // "data:image/png;base64," prefix — we strip that in receipt-image.js).
  return evoPost(`/message/sendMedia/${cfg.instance}`, {
    number: to,
    mediatype: "image",
    mimetype: "image/png",
    media,
    caption: caption || "",
    fileName: fileName || `receipt-${Date.now()}.png`,
  });
}

export default { id, envStatus, sendText, sendImage };
