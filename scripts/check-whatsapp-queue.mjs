// Guards the serial send queue in backend/lib/whatsapp.js.
//
// On 31 Oct 2026 a fee-reminder run fired 166 sends inside two seconds;
// Evolution serves one at a time, so 166 of 170 hit the 8s timeout while
// only waiting their turn. This mirrors the chain logic against a fake
// one-at-a-time provider and fails if concurrency ever climbs above 1.
//
//   node scripts/check-whatsapp-queue.mjs
let waChain = Promise.resolve();
const WA_GAP_MS = 50;

let inFlight = 0, maxInFlight = 0;

function notify(i) {
  const run = waChain.then(() => sendOne(i));
  waChain = run.then(
    () => new Promise((r) => setTimeout(r, WA_GAP_MS)),
    () => new Promise((r) => setTimeout(r, WA_GAP_MS))
  );
  return run;
}

// Fake Evolution: serves one at a time, 120ms each. Anything arriving while
// busy queues; if its wait exceeds the 8s cap it "times out" like production.
let busyUntil = 0;
async function sendOne(i) {
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  const now = Date.now();
  const start = Math.max(now, busyUntil);
  const wait = start - now;
  busyUntil = start + 120;
  try {
    if (wait > 8000) throw new Error("timed out after 8s");
    await new Promise((r) => setTimeout(r, 120));
    if (i === 7) throw new Error("boom"); // a mid-run failure must not stall the chain
    return { ok: true, i };
  } finally { inFlight--; }
}

const N = 20;
const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: N }, (_, i) =>
    notify(i).then((r) => ({ ...r }), (e) => ({ ok: false, i, err: e.message }))
  )
);
const ms = Date.now() - t0;
const ok = results.filter((r) => r.ok).length;
const timeouts = results.filter((r) => /timed out/.test(r.err || "")).length;
const boom = results.filter((r) => r.err === "boom").length;

console.log(`max concurrent at provider : ${maxInFlight}  (must be 1)`);
console.log(`delivered                  : ${ok}/${N}`);
console.log(`timeouts                   : ${timeouts}  (must be 0)`);
console.log(`real failures passed through: ${boom}  (must be 1)`);
console.log(`elapsed                    : ${ms}ms`);

const pass = maxInFlight === 1 && timeouts === 0 && boom === 1 && ok === N - 1;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
