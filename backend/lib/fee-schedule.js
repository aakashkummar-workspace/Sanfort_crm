// Monthly fee schedule — a DERIVED VIEW, never a ledger.
//
// The school bills in terms (Term I/II/III) plus a single annual transport
// balance, and the 587 historical receipts carry no month tag. So there is no
// stored month-level truth to read: this module reconstructs one from the
// totals the school does bill, so a parent can be shown "what is due in
// August". It is deliberately pure — no I/O, no db.js import — so the same
// arithmetic runs on the server (API) and in the browser (Fees screen), and so
// it can be unit-checked against real numbers without touching live money data.
//
// THE INVARIANT this module is built on:
//
//   billed(type) = pendingAmount(type) + Σ receipts(type).amount
//
// `payPendingFee` settles a fee by DECREMENTING `amount` on the one pending row
// for that `${studentId}__${feeType}` and writing a receipt of the same
// feeType. Rupees move from the pending side to the receipt side; the sum does
// not change. Which is why every schedule here derives from `billed` and NEVER
// from `pending`: a `pending / 11` divisor would silently reshuffle every
// month's "due" figure the moment a parent paid anything.

export const DEFAULT_SCHEDULE_MONTHS = 11;
export const DEFAULT_YEAR_START_MONTH = 4; // April — the Indian academic year

// Term → the calendar block it covers, and the ONE month it is attributed to.
// Terms are not twelfthed: the school charges a term, not a monthly tuition,
// so inventing a per-month tuition figure would be fiction a parent could not
// reconcile against any receipt. Offsets are months from the year start.
const TERM_BLOCKS = [
  { feeType: "term1", label: "Term I",   startOffset: 0, span: 4 },
  { feeType: "term2", label: "Term II",  startOffset: 4, span: 4 },
  { feeType: "term3", label: "Term III", startOffset: 8, span: 4 },
];

// Fee types that are charged once, not across the year. Smearing an admission
// or uniform charge over 11 months would misrepresent when it was owed.
export const ONE_TIME_FEE_TYPES = [
  "application", "kit", "uniform", "eca", "stem", "annualday", "annual",
];

// Types spread evenly across the billable months.
const SPREAD_FEE_TYPES = ["transport"];

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// A pending row's or receipt's owning student id. Legacy rows store the bare
// student id with no "__" separator; composite rows store "STN-9001__term1".
export const rowStudentId = (r) =>
  String(r?.studentId ?? r?.student_id ?? (String(r?.id || "").split("__")[0] || ""));

// A row's fee type, normalised. Rows written before the fee_type column render
// as term1 elsewhere in the app (see feeTypeLabel), so match that here rather
// than inventing a fourth bucket the UI has no column for.
export const rowFeeType = (r) => {
  const explicit = r?.feeType ?? r?.fee_type;
  if (explicit) return String(explicit);
  const idPart = String(r?.id || "").split("__")[1];
  return idPart || "term1";
};

const paidAtOf = (r) => r?.paidAt ?? r?.paid_at ?? null;

/**
 * Split `total` into `n` whole-rupee parts.
 *
 * Floor for parts 1..n-1 and the remainder on the LAST part, so the parts sum
 * EXACTLY to `total`. A per-month Math.round (what the old transportPerMonth
 * did) drifts a few rupees against the annual figure — tolerable in an
 * informational column, wrong in a statement a parent adds up by hand.
 */
export function splitEvenly(total, n) {
  const count = Math.max(0, Math.floor(num(n)));
  if (count === 0) return [];
  const amount = num(total);
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(amount);
  const base = Math.floor(abs / count);
  const out = new Array(count).fill(base * sign);
  out[count - 1] = sign * (abs - base * (count - 1));
  return out;
}

// Calendar month (1-12) at `offset` months after `yearStartMonth`.
function monthAt(yearStartMonth, offset) {
  return ((num(yearStartMonth) - 1 + offset) % 12 + 12) % 12 + 1;
}

// "Apr-Jul" style label for a term's block, for the note explaining why a
// term's whole amount sits on one row.
function blockLabel(yearStartMonth, startOffset, span) {
  const first = MONTH_NAMES[monthAt(yearStartMonth, startOffset) - 1];
  const last = MONTH_NAMES[monthAt(yearStartMonth, startOffset + span - 1) - 1];
  return `${first}-${last}`;
}

/**
 * Allocate a fee type's receipts across that type's month rows, oldest month
 * first, and label each row paid / part / due.
 *
 * This is the one genuinely DERIVED step: receipts carry no month tag, so
 * "which month did this ₹5,000 pay for" is unanswerable from the data. Filling
 * the earliest unsettled month first is the convention that matches how a
 * cashier actually collects (nobody pays March before April), and the UI is
 * required to say so — otherwise an accountant will eventually read a derived
 * allocation as a ledger fact.
 *
 * Receipts with a null `paidAt` (possible per fromRecentFee — the column
 * post-dates the oldest rows) sort last among themselves but are allocated the
 * same way; the count is returned so the UI can footnote them.
 */
function allocatePaid(rows, receipts) {
  const dated = [...receipts].sort((a, b) => {
    const A = paidAtOf(a), B = paidAtOf(b);
    if (!A && !B) return 0;
    if (!A) return 1;  // undated last — they still land on the earliest due month
    if (!B) return -1;
    return String(A).localeCompare(String(B));
  });
  let pool = dated.reduce((a, r) => a + num(r.amount), 0);
  for (const row of rows) {
    const apply = Math.min(row.due, Math.max(0, pool));
    row.paid = apply;
    pool -= apply;
    row.status = row.due === 0 ? "nil" : apply >= row.due ? "paid" : apply > 0 ? "part" : "due";
  }
  // Leftover means receipts exceed the derived billed total for the type —
  // only reachable if a row was edited down after collection. Surfaced rather
  // than swallowed so it can be investigated, never silently dropped.
  return Math.max(0, pool);
}

/**
 * Build a student's monthly fee schedule from their pending rows + receipts.
 *
 * @param pendingFees   that student's pending_fees rows (already filtered)
 * @param receipts      that student's recent_fees receipts (already filtered)
 * @param monthsCount   billable months transport is spread over
 * @param yearStartMonth calendar month (1-12) the academic year opens on
 * @param admissionMonth optional calendar month (1-12) one-offs are dated to
 * @returns { months, oneTime, totals, undatedReceiptCount, notes, ... }
 */
export function buildMonthlySchedule({
  pendingFees = [],
  receipts = [],
  monthsCount = DEFAULT_SCHEDULE_MONTHS,
  yearStartMonth = DEFAULT_YEAR_START_MONTH,
  admissionMonth = null,
} = {}) {
  const count = Math.max(1, Math.floor(num(monthsCount) || DEFAULT_SCHEDULE_MONTHS));
  const start = Math.min(12, Math.max(1, Math.floor(num(yearStartMonth) || DEFAULT_YEAR_START_MONTH)));

  // billed per fee type = pending + receipts. Invariant under payment.
  const billed = {};
  const byTypeReceipts = {};
  for (const f of pendingFees) {
    const t = rowFeeType(f);
    billed[t] = num(billed[t]) + num(f.amount);
  }
  for (const r of receipts) {
    const t = rowFeeType(r);
    billed[t] = num(billed[t]) + num(r.amount);
    (byTypeReceipts[t] ||= []).push(r);
  }

  const undatedReceiptCount = receipts.filter((r) => !paidAtOf(r)).length;

  // ---- month skeleton ----
  const months = [];
  for (let i = 0; i < count; i++) {
    const m = monthAt(start, i);
    months.push({
      index: i,
      month: m,
      label: MONTH_NAMES[m - 1],
      term: 0, termLabel: null, termPaid: 0, termStatus: "nil",
      transport: 0, transportPaid: 0, transportStatus: "nil",
      due: 0, paid: 0, status: "nil",
    });
  }

  const notes = [];
  const unallocated = {};

  // ---- transport: billed spread evenly, remainder on the last month ----
  for (const type of SPREAD_FEE_TYPES) {
    const total = num(billed[type]);
    if (!total) continue;
    const parts = splitEvenly(total, count);
    const rows = months.map((mo, i) => ({ due: parts[i], paid: 0, status: "nil", mo }));
    const left = allocatePaid(rows, byTypeReceipts[type] || []);
    if (left > 0) unallocated[type] = left;
    for (const row of rows) {
      row.mo.transport = row.due;
      row.mo.transportPaid = row.paid;
      row.mo.transportStatus = row.status;
    }
  }

  // ---- terms: whole amount on the FIRST month of the term's block ----
  const termRows = [];
  for (const block of TERM_BLOCKS) {
    const total = num(billed[block.feeType]);
    const target = months.find((mo) => mo.index === block.startOffset);
    // A term whose first month falls outside a shortened schedule still has to
    // appear somewhere, or the column would stop summing to billed.
    const row = target || months[months.length - 1];
    if (!total && !target) continue;
    row.term += total;
    row.termLabel = row.termLabel ? `${row.termLabel} + ${block.label}` : block.label;
    termRows.push({ block, row, total });
  }
  for (const { block, row, total } of termRows) {
    const rows = [{ due: total, paid: 0, status: "nil" }];
    const left = allocatePaid(rows, byTypeReceipts[block.feeType] || []);
    if (left > 0) unallocated[block.feeType] = left;
    row.termPaid += rows[0].paid;
    row.termStatus = row.term === 0 ? "nil"
      : row.termPaid >= row.term ? "paid"
      : row.termPaid > 0 ? "part" : "due";
  }

  // The legacy-annual shape: seedStudentTermFees drops a single quoted annual
  // figure entirely into term1 with term2/term3 at ₹0. One big April row is
  // then CORRECT for the data — but it reads like a bug, so say so.
  const t1 = num(billed.term1), t2 = num(billed.term2), t3 = num(billed.term3);
  if (t1 > 0 && t2 === 0 && t3 === 0) {
    notes.push(
      `This student's whole year sits in Term I, so it shows as one ${MONTH_NAMES[monthAt(start, 0) - 1]} row `
      + `(${blockLabel(start, 0, 4)}). That is how the fee was recorded, not a calculation error.`
    );
  }

  // ---- one-offs: a separate section, dated to admission, not smeared ----
  const admMonth = admissionMonth != null && Number.isFinite(Number(admissionMonth))
    ? Math.min(12, Math.max(1, Math.floor(Number(admissionMonth))))
    : null;
  const oneTime = [];
  for (const type of ONE_TIME_FEE_TYPES) {
    const total = num(billed[type]);
    if (!total) continue;
    const rows = [{ due: total, paid: 0, status: "nil" }];
    const left = allocatePaid(rows, byTypeReceipts[type] || []);
    if (left > 0) unallocated[type] = left;
    oneTime.push({
      feeType: type,
      due: total,
      paid: rows[0].paid,
      status: rows[0].status,
      month: admMonth,
      monthLabel: admMonth ? MONTH_NAMES[admMonth - 1] : null,
    });
  }

  // ---- row + column totals ----
  for (const mo of months) {
    mo.due = mo.term + mo.transport;
    mo.paid = mo.termPaid + mo.transportPaid;
    mo.status = mo.due === 0 ? "nil"
      : mo.paid >= mo.due ? "paid"
      : mo.paid > 0 ? "part" : "due";
  }

  const monthlyDue = months.reduce((a, mo) => a + mo.due, 0);
  const monthlyPaid = months.reduce((a, mo) => a + mo.paid, 0);
  const oneTimeDue = oneTime.reduce((a, o) => a + o.due, 0);
  const oneTimePaid = oneTime.reduce((a, o) => a + o.paid, 0);
  const billedTotal = Object.values(billed).reduce((a, v) => a + num(v), 0);

  return {
    months,
    oneTime,
    billed,
    monthsCount: count,
    yearStartMonth: start,
    undatedReceiptCount,
    notes,
    unallocated,
    totals: {
      monthlyDue, monthlyPaid,
      oneTimeDue, oneTimePaid,
      due: monthlyDue + oneTimeDue,
      paid: monthlyPaid + oneTimePaid,
      outstanding: (monthlyDue + oneTimeDue) - (monthlyPaid + oneTimePaid),
      // Every month row + every one-off row must add back up to this.
      billedTotal,
    },
    isEmpty: billedTotal === 0,
  };
}

// Back-compat for the pending-statement PDF and the class-wise printout, which
// show transport as a per-month figure alongside the annual balance. Same
// divisor as the schedule above, in one place now instead of two.
export const transportPerMonth = (amt, monthsCount = DEFAULT_SCHEDULE_MONTHS) =>
  Math.round(num(amt) / Math.max(1, Math.floor(num(monthsCount) || DEFAULT_SCHEDULE_MONTHS)));
