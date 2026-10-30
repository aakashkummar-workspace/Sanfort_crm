// Message provider registry.
//
// One seam between "what we want to say" (whatsapp.js: phone normalisation,
// event→mode decision, logging) and "how it goes out" (an adapter). The school
// is on Evolution today and may move to Meta Cloud API; that move should be an
// .env change plus one new file in this folder, not a rewrite of whatsapp.js.
//
// Every adapter exports:
//   { id, envStatus(), async sendText({to, text}),
//     async sendImage({to, media, caption, fileName}) }
//
// Send methods resolve to { ok, providerMessageId?, status?, raw?, error? } and
// never throw — a WhatsApp glitch must not fail the fee payment that triggered
// it. `to` is already normalised when it reaches an adapter: the leading-zero /
// +91 rules are India-specific school policy, not transport detail, so they
// stay in whatsapp.js above this layer.

import evolution from "./evolution.js";
import meta from "./meta.js";

const PROVIDERS = { evolution, meta };

// Named so a caller (or a log line) can tell a provider misconfiguration apart
// from a send failure. Thrown, not swallowed: a typo in MESSAGE_PROVIDER means
// no parent receives anything, and a silent fallback to Evolution would hide
// that for as long as it took someone to notice the missing messages.
export class UnknownProviderError extends Error {
  constructor(name) {
    super(
      `Unknown MESSAGE_PROVIDER "${name}". Valid values: ${Object.keys(PROVIDERS).join(", ")}. ` +
      `Fix MESSAGE_PROVIDER in .env.local (unset = "evolution").`
    );
    this.name = "UnknownProviderError";
    this.provider = name;
  }
}

export function getProvider() {
  const name = (process.env.MESSAGE_PROVIDER || "evolution").trim().toLowerCase();
  const p = PROVIDERS[name];
  if (!p) throw new UnknownProviderError(name);
  return p;
}

export const PROVIDER_IDS = Object.keys(PROVIDERS);
