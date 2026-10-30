// Meta WhatsApp Cloud API adapter — stub.
//
// Shipped unimplemented on purpose. It is the second implementation of the
// adapter interface, which is the only way to know the interface is real
// rather than a shape fitted to Evolution: if a field here could not be
// filled, the interface was wrong. Flip MESSAGE_PROVIDER=meta and every send
// fails loudly with "not configured" rather than quietly going nowhere.
//
// To implement: POST https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages
// with a Bearer token; the response carries messages[0].id, which maps onto
// providerMessageId the same way Evolution's key.id does.

export const id = "meta";

export function envStatus() {
  return {
    META_WHATSAPP_TOKEN: !!process.env.META_WHATSAPP_TOKEN,
    META_PHONE_NUMBER_ID: !!process.env.META_PHONE_NUMBER_ID,
    configured: false,
  };
}

export async function sendText() {
  return { ok: false, error: "Meta provider not configured" };
}

export async function sendImage() {
  return { ok: false, error: "Meta provider not configured" };
}

export default { id, envStatus, sendText, sendImage };
