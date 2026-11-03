// Billing gate: SirahOS decides whether this school's WhatsApp service is paid
// up, and we refuse to send while it is not.
//
// SirahOS cannot stop us sending — it only publishes the answer — so the check
// lives here, at the one seam every message passes through (whatsapp.js).
//
// Two deliberate choices:
//
//   • Cached for a minute. A fee run sends hundreds of messages; asking per
//     message would add a network round trip to each one.
//   • Fails OPEN. If SirahOS is unreachable we keep the last known answer, and
//     allow when we have none. A billing server having a bad minute must not
//     stop a parent's fee receipt. A genuine lock still holds, because the
//     answer is cached from the last successful check.
//
// Unset SIRAHOS_PROJECT_ID (or SIRAHOS_URL) disables the gate entirely, so a
// dev or self-hosted copy is unaffected.

const TTL_MS = 60_000;
const TIMEOUT_MS = 5_000;

let cache = { allowed: true, at: 0, known: false };

function config() {
  return {
    base: (process.env.SIRAHOS_URL || "https://api.os.sirahagents.com").replace(/\/+$/, ""),
    projectId: (process.env.SIRAHOS_PROJECT_ID || "").trim(),
    secret: (process.env.SIRAHOS_SECRET || "").trim(),
  };
}

/**
 * @returns {Promise<{allowed: boolean, reason?: string}>}
 */
export async function checkServiceStatus() {
  const { base, projectId, secret } = config();
  if (!projectId || !secret) return { allowed: true };          // gate not configured

  if (cache.known && Date.now() - cache.at < TTL_MS) {
    return { allowed: cache.allowed, reason: cache.reason };
  }

  try {
    const res = await fetch(`${base}/api/service-status/${projectId}`, {
      headers: { "X-Sirahos-Signature": secret },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // 401/404/503 means the gate is misconfigured, not that we are overdue.
      console.warn(`[service-status] HTTP ${res.status} — allowing sends`);
      return { allowed: cache.known ? cache.allowed : true, reason: cache.reason };
    }
    const s = await res.json();
    cache = { allowed: s.allowed !== false, at: Date.now(), known: true, reason: s.reason };
    return { allowed: cache.allowed, reason: cache.reason };
  } catch (e) {
    console.warn(`[service-status] unreachable (${e.message}) — using last known answer`);
    return { allowed: cache.known ? cache.allowed : true, reason: cache.reason };
  }
}

/** Let a webhook flip the state immediately instead of waiting for the TTL. */
export function setServiceStatus(allowed, reason) {
  cache = { allowed, at: Date.now(), known: true, reason };
}
