"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { AvatarChip, FakeQR, StatusChip, UpiQR, buildUpiUri } from "../ui";
import { money, moneyK, FEE_TYPES, feeTypeLabel, formatClassLabel } from "@/lib/format";
import { resolveSchool, downloadPdf } from "@/lib/export";

const DEMO_PARENT_PHONE = "+919876543210";
// Transport is stored as one annual balance per student; pending reports also
// show it per month by dividing across this many billable months.
const TRANSPORT_MONTHS = 11;
const transportPerMonth = (amt) => Math.round((Number(amt) || 0) / TRANSPORT_MONTHS);

// Customized bulk-reminder presets. `combo` = students who have BOTH fee types
// pending (reminds both lines); `type` = a single fee type pending. `group`
// rows are non-clickable section headers in the menu.
const REMIND_PRESETS = [
  { group: "Admission + another (both pending)" },
  { label: "Admission + Term I",     combo: ["application", "term1"] },
  { label: "Admission + Term II",    combo: ["application", "term2"] },
  { label: "Admission + Term III",   combo: ["application", "term3"] },
  { label: "Admission + Transport",  combo: ["application", "transport"] },
  { group: "Single fee type pending" },
  { label: "Admission fees only",    type: "application" },
  { label: "Transport fees only",    type: "transport" },
  { label: "Term I",                 type: "term1" },
  { label: "Term II",                type: "term2" },
  { label: "Term III",               type: "term3" },
];

// Escape HTML for the print-popup template (the receipt is built as a string
// because it lives in a fresh window outside React's reach).
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// "When" label for a fee row. Paid rows show the real payment date+time from
// the stored ISO timestamp (paidAt) — the old rows stored a frozen "just now"
// string that never updated, so we prefer paidAt and only fall back to the
// stored label when there's no timestamp. Pending/overdue keep their
// "due <date>" label.
function formatFeeWhen(f) {
  if (!f) return "—";
  if (f.status === "pending" || f.status === "overdue") return f.time || "—";
  const iso = f.paidAt || f.paid_at;
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(d.getTime())) {
      return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
    }
  }
  return (f.time && f.time !== "just now") ? f.time : "—";
}

export default function ScreenFees({ E, refresh, role, session, searchFocus, clearSearchFocus }) {
  const school = resolveSchool(E?.SETTINGS);
  const actor  = session?.name || null;
  const isParent = role === "parent";
  // Admin, principal and the school accountant may edit the per-class fee
  // structure (term amounts + application + van).
  const canEditStructure = role === "admin" || role === "principal" || role === "school_accountant" || role === "fees_manager";
  // ---------- core state ----------
  // Parent-aware initial selection: pick the first PENDING (or the first
  // PAID) for the currently-logged-in child, not whichever happens to be
  // top of the global list.
  const [selected, setSelected] = useState(() => {
    const childId = role === "parent" && E.ADDED_STUDENTS && E.ADDED_STUDENTS[0]
      ? E.ADDED_STUDENTS[0].id : null;
    const p = childId ? (E.PENDING_FEES || []).filter((f) => (f.studentId || f.id) === childId) : (E.PENDING_FEES || []);
    const r = childId ? (E.RECENT_FEES  || []).filter((f) => (f.studentId || f.id) === childId) : (E.RECENT_FEES  || []);
    return p[0] || r[0];
  });
  const [stage, setStage] = useState("pick");
  const [method, setMethod] = useState("UPI");
  const [busy, setBusy] = useState(false);
  // Amount the parent is paying right now. Empty string = pay full balance.
  // Validated against the selected fee's outstanding amount in markPaid().
  const [payAmount, setPayAmount] = useState("");
  // Last-completed payment summary for the receipt (so the receipt reflects
  // what was actually paid, even after the pending row is updated).
  const [lastPayment, setLastPayment] = useState(null);

  // Reset the pay-amount whenever the selected fee changes.
  useEffect(() => { setPayAmount(""); setLastPayment(null); }, [selected?.id, selected?.amount]);

  // Trust-wide finance settings (UPI ID, payee name) — used to build the
  // scannable QR on the Pay step. Fetched once on mount; admin changes them
  // under Settings → Finance.
  const [finance, setFinance] = useState({ upi: "", upiPayeeName: "" });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/settings", { cache: "no-store" });
        const j = await r.json();
        if (!cancelled && j.ok) {
          setFinance({
            upi: j.settings?.finance?.upi || "",
            upiPayeeName: j.settings?.finance?.upiPayeeName || "",
          });
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  // ---------- filters / selection ----------
  const [statusFilter, setStatusFilter] = useState("All");
  const [classFilter, setClassFilter] = useState("All");
  const [feeTypeFilter, setFeeTypeFilter] = useState("All"); // All | term1 | term2 | term3 | transport | application
  const [filterOpen, setFilterOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [pendingClassPick, setPendingClassPick] = useState(null); // { termLabel, byClass, classKeys }
  const [collectOpen, setCollectOpen] = useState(false);
  const [picked, setPicked] = useState(new Set());

  // ---------- toast ----------
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const flash = (msg, tone = "ok") => {
    setToast({ msg, tone });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  };

  // Pending row currently being edited (amount-only). Staff-only.
  const [editingFee, setEditingFee] = useState(null);
  // Receipt awaiting delete-confirmation. Only admin/principal/accountant
  // can open this — parents and teachers don't get the delete affordance.
  const [deletingReceipt, setDeletingReceipt] = useState(null);
  const canDeleteReceipt = role === "admin" || role === "principal" || role === "school_accountant" || role === "fees_manager";
  // "Add fee" modal — staff picks a student + fee type + amount to create a
  // brand-new pending row. Lets the school collect Application, Kit, ECA,
  // Uniform, Term I/II/III, Van, STEM, Annual Day fees as separate items.
  const [addFeeOpen, setAddFeeOpen] = useState(false);
  const [structureOpen, setStructureOpen] = useState(false);
  const [remindConfirm, setRemindConfirm] = useState(false);
  const [remindBusy, setRemindBusy] = useState(false);
  const [remindMenuOpen, setRemindMenuOpen] = useState(false);
  const [bulkRemind, setBulkRemind] = useState(null); // { label, ids, students, amount } | null

  // Optimistic pay-overlay. A full /api/data refresh is slow (and sometimes
  // stalls) on production, so after a collection we update the numbers locally
  // from the pay response IMMEDIATELY — the collected total goes up and the
  // balance goes down at once. The overlay is reconciled away as soon as the
  // authoritative refresh lands (see the reconcile effect below), so nothing
  // double-counts.
  //   receipts: new receipt rows to add to RECENT_FEES
  //   paidIds:  { [pendingFeeId]: remainingBalance }  (0 = fully paid → drop the row)
  const [payOverlay, setPayOverlay] = useState({ receipts: [], paidIds: {} });

  const handleAddFee = async (payload) => {
    const r = await fetch("/api/fees/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      flash(j.error || "Could not add fee", "bad");
      return false;
    }
    flash(`${feeTypeLabel(payload.feeType)} added · ₹${Number(payload.amount).toLocaleString("en-IN")}`);
    await refresh?.();
    return true;
  };
  const saveFeeAmount = async (id, amount) => {
    const r = await fetch("/api/fees/amount", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, amount }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      flash(j.error || "Could not update fee", "bad");
      return false;
    }
    flash(`Fee updated · ₹${Number(amount).toLocaleString("en-IN")} outstanding`);
    await refresh?.();
    return true;
  };

  // ---------- parent-scoped fee lists ----------
  // Defence-in-depth: even if AppShell's parent-scoping was applied upstream,
  // we also scope here, so the Fees screen *always* respects "only my child"
  // when viewed as a parent. Non-parent roles see every row as before.
  const myChildId = isParent && E.ADDED_STUDENTS && E.ADDED_STUDENTS[0]
    ? E.ADDED_STUDENTS[0].id : null;
  const scopedPending = useMemo(() => {
    // Apply the optimistic overlay first: reduce partially-paid rows to their
    // remaining balance and drop fully-paid ones, so the pending total + count
    // reflect a just-recorded collection before the slow refresh lands.
    let base = (E.PENDING_FEES || [])
      .map((f) => {
        const rem = payOverlay.paidIds[f.id];
        return rem === undefined ? f : { ...f, amount: rem };
      })
      .filter((f) => {
        const rem = payOverlay.paidIds[f.id];
        return !(rem !== undefined && rem <= 0);
      });
    return myChildId ? base.filter((f) => (f.studentId || f.id) === myChildId) : base;
  }, [E.PENDING_FEES, payOverlay, myChildId]);

  const scopedRecent = useMemo(() => {
    // Union the authoritative receipts with any optimistic ones not yet present
    // in the fetched data (matched by receipt id, so no double-count).
    const base = E.RECENT_FEES || [];
    const baseIds = new Set(base.map((r) => r.id));
    const extra = payOverlay.receipts.filter((r) => !baseIds.has(r.id));
    const merged = extra.length ? [...extra, ...base] : base;
    return myChildId ? merged.filter((f) => (f.studentId || f.id) === myChildId) : merged;
  }, [E.RECENT_FEES, payOverlay, myChildId]);

  // Reconcile the overlay whenever authoritative data arrives: drop overlay
  // receipts once the real recent_fees carries them, and drop paid-overrides
  // once the real pending_fees already reflects the payment (row gone, or its
  // balance already reduced). Keeps the overlay from lingering or mis-marking a
  // later re-created fee with the same id.
  useEffect(() => {
    setPayOverlay((prev) => {
      if (prev.receipts.length === 0 && Object.keys(prev.paidIds).length === 0) return prev;
      const recentIds = new Set((E.RECENT_FEES || []).map((r) => r.id));
      const pendingAmt = new Map((E.PENDING_FEES || []).map((f) => [f.id, Number(f.amount) || 0]));
      const receipts = prev.receipts.filter((r) => !recentIds.has(r.id));
      const paidIds = {};
      for (const [pid, rem] of Object.entries(prev.paidIds)) {
        const authAmt = pendingAmt.get(pid);
        if (authAmt === undefined) continue;   // row removed upstream → payment reflected
        if (authAmt <= rem) continue;          // upstream balance already reduced → reflected
        paidIds[pid] = rem;                    // upstream still stale → keep correcting
      }
      const unchanged =
        receipts.length === prev.receipts.length &&
        Object.keys(paidIds).length === Object.keys(prev.paidIds).length;
      return unchanged ? prev : { receipts, paidIds };
    });
  }, [E.RECENT_FEES, E.PENDING_FEES]);

  // ---------- derived data ----------
  const all = useMemo(
    () => [
      ...scopedRecent.map((f) => ({ ...f, status: "paid" })),
      ...scopedPending.map((f) => ({ ...f, status: f.overdue ? "overdue" : "pending", method: "—", time: "due " + f.due })),
    ],
    [scopedRecent, scopedPending]
  );

  // Orderly running serial per receipt (the SL No on the printed receipt).
  // Numbered by payment time across all receipts, so they read 0001, 0002, …
  // in the order money was collected — instead of the old "last 3 digits of
  // the receipt id" which came out random (320, 59, 842…).
  const serialByReceipt = useMemo(() => {
    const list = [...(E.RECENT_FEES || [])].sort((a, b) => {
      const ta = a.paidAt || a.paid_at || "";
      const tb = b.paidAt || b.paid_at || "";
      if (ta !== tb) return ta < tb ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
    const map = {};
    list.forEach((r, i) => { map[r.id] = i + 1; });
    return map;
  }, [E.RECENT_FEES]);
  const serialFor = (fee) => {
    const n = fee && serialByReceipt[fee.id];
    if (n) return String(n).padStart(3, "0");
    // Fallback for rows not in the receipts list (e.g. previewing a pending fee).
    return String(fee?.id || "").replace(/[^0-9]/g, "").slice(-3).padStart(3, "0");
  };

  // Global search deep-link: when a fee/paid row is picked from the
  // topbar search, select it so the right-hand Collect/Receipt panel
  // jumps to that record.
  useEffect(() => {
    if (!searchFocus) return;
    if (searchFocus.type !== "fee" && searchFocus.type !== "paid") return;
    const hit = all.find((f) => f.id === searchFocus.id);
    if (hit) setSelected(hit);
    clearSearchFocus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchFocus]);

  // Fee-type slice first, so the Paid/Pending/Overdue/All counts below reflect
  // the chosen fee type (e.g. "Term I → Paid · N, Pending · M").
  const feeTypeOf = (f) => (f.feeType || f.fee_type || "term1");
  const typeScoped = useMemo(
    () => (feeTypeFilter === "All" ? all : all.filter((f) => feeTypeOf(f) === feeTypeFilter)),
    [all, feeTypeFilter]
  );

  // Counts are by STUDENT (not fee line-item), so "Pending · 276" reads as
  // "276 students have a pending fee" rather than counting all 1,238 rows.
  const studentOf = (f) => f.studentId || f.student_id || String(f.id || "").split("__")[0];
  const uniqStudents = (arr) => new Set(arr.map(studentOf).filter(Boolean)).size;
  const counts = {
    All: uniqStudents(typeScoped),
    Paid: uniqStudents(typeScoped.filter((f) => f.status === "paid")),
    Pending: uniqStudents(typeScoped.filter((f) => f.status === "pending")),
    Overdue: uniqStudents(typeScoped.filter((f) => f.status === "overdue")),
  };

  const visible = typeScoped.filter((f) => {
    if (statusFilter === "Paid" && f.status !== "paid") return false;
    if (statusFilter === "Pending" && f.status !== "pending") return false;
    if (statusFilter === "Overdue" && f.status !== "overdue") return false;
    // classFilter holds the raw class number string ("1"-"12", "13"=PRE-MONT,
    // "14"=MONT I, "15"=MONT II) or "All". Compare against f.cls's leading
    // segment so Roman / Montessori labels all work without per-label mapping.
    if (classFilter !== "All" && String(f.cls || "").split("-")[0] !== classFilter) return false;
    return true;
  });

  const totals = {
    collected: scopedRecent.reduce((a, f) => a + f.amount, 0),
    pending: scopedPending.reduce((a, f) => a + f.amount, 0),
    overdue: scopedPending.filter((f) => f.overdue).reduce((a, f) => a + f.amount, 0),
  };

  // Resolve a bulk-reminder preset into the pending fee lines it targets, plus
  // a parent count + total amount for the confirm dialog. `combo` presets pick
  // students with BOTH types pending and remind both their lines.
  const resolveRemindPreset = (p) => {
    const pend = scopedPending;
    let lines;
    if (p.combo) {
      const [a, b] = p.combo;
      const sa = new Set(pend.filter((f) => feeTypeOf(f) === a).map(studentOf));
      const sb = new Set(pend.filter((f) => feeTypeOf(f) === b).map(studentOf));
      const both = new Set([...sa].filter((s) => sb.has(s)));
      lines = pend.filter((f) => both.has(studentOf(f)) && (feeTypeOf(f) === a || feeTypeOf(f) === b));
    } else {
      lines = pend.filter((f) => feeTypeOf(f) === p.type);
    }
    return {
      ids: lines.map((f) => f.id),
      students: new Set(lines.map(studentOf)).size,
      amount: lines.reduce((s, f) => s + (Number(f.amount) || 0), 0),
    };
  };
  const remindPresetRows = useMemo(
    () => REMIND_PRESETS.map((p) => (p.group ? p : { ...p, ...resolveRemindPreset(p) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopedPending]
  );

  // After data refresh, if `selected` is paid and we're in "pick", advance to next pending
  useEffect(() => {
    if (stage !== "pick" || !selected) return;
    const stillPending = scopedPending.find((f) => f.id === selected.id);
    if (!stillPending) {
      const next = scopedPending[0];
      if (next) setSelected(next);
    }
  }, [scopedPending, stage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop bulk selections that no longer exist
  useEffect(() => {
    setPicked((prev) => {
      const valid = new Set(all.map((f) => f.id));
      let changed = false;
      const next = new Set();
      prev.forEach((id) => {
        if (valid.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [all]);

  // ---------- handlers ----------
  // UPI needs the QR step so the parent can scan and the office can wait
  // for a "Mark paid" tap once the bank confirms. Cash is collected
  // physically at the counter — there's nothing to scan, so we skip
  // straight to recording the payment.
  //
  // For UPI specifically: as soon as we move to the QR step we ALSO fire
  // the QR off to the parent's WhatsApp via n8n, so they can scan it on
  // their own phone if they're not at the office. Send is fire-and-forget
  // — we don't block the UI on it; the in-office QR shows immediately.
  const proceed = () => {
    if (method === "Cash") {
      markPaid();
      return;
    }
    setStage("qr");
    if (method === "UPI") {
      const balance = (selected.amount || 0) + (selected.overdue ? 200 : 0);
      const amt = payAmount.trim() === "" ? balance : Math.floor(Number(payAmount) || 0);
      // Don't await — the QR is on screen the moment setStage runs.
      // The user sees a toast when WhatsApp confirms (or fails).
      sendQrToWhatsApp(amt);
    }
  };

  const markPaid = async () => {
    if (!selected) return;
    if (selected.status === "paid") {
      setStage("paid");
      return;
    }
    // Validate the partial-amount input before hitting the API.
    const balance = (selected.amount || 0) + (selected.overdue ? 200 : 0);
    const amt = payAmount.trim() === "" ? null : Math.floor(Number(payAmount));
    if (amt !== null) {
      if (!Number.isFinite(amt) || amt <= 0) {
        flash("Enter a valid amount", "bad");
        return;
      }
      if (amt > balance) {
        flash(`Amount can't exceed ₹${balance.toLocaleString("en-IN")}`, "bad");
        return;
      }
    }
    setBusy(true);
    try {
      const r = await fetch("/api/fees/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selected.id, method, amount: amt }),
      });
      const json = await r.json();
      if (!json.ok) {
        flash(json.error || "Could not post payment", "bad");
        setBusy(false);
        return;
      }
      // Stash the payment details for the receipt + remember the partial state.
      setLastPayment({
        amount: json.fee.amount,
        remaining: json.remaining,
        partial: json.partial,
        method,
        serial: json.fee?.serial ?? null,
      });
      // Optimistic overlay — update the collected total + pending balance NOW,
      // from the server's own response, so the numbers are correct instantly
      // even if the full refresh below is slow or stalls on production.
      const f = json.fee;
      const paidRow = {
        id: f.id,
        studentId: f.studentId || f.student_id,
        student_id: f.student_id || f.studentId,
        name: f.name, cls: f.cls,
        amount: Number(f.amount) || 0,
        method: f.method || method,
        time: f.time,
        paidAt: f.paidAt || f.paid_at || new Date().toISOString(),
        feeType: f.feeType || f.fee_type,
        status: json.partial ? "partial" : "paid",
        serial: f.serial ?? null,
      };
      setPayOverlay((prev) => ({
        receipts: [paidRow, ...prev.receipts.filter((r) => r.id !== paidRow.id)],
        paidIds: { ...prev.paidIds, [selected.id]: Number(json.remaining) || 0 },
      }));
      // Fire the authoritative refresh but don't block the UI on it — the
      // overlay already shows the correct numbers. If it stalls, no harm.
      refresh?.();
      flash(json.partial
        ? `Partial payment posted · ₹${json.remaining.toLocaleString("en-IN")} still pending`
        : "Payment posted · receipt auto-sent",
        "ok");
    } finally {
      setBusy(false);
      setStage("paid");
    }
  };

  const reset = () => setStage("pick");

  const openReceipt = (fee) => {
    setSelected(fee);
    setStage("paid");
    flash(`Receipt loaded · ${fee.id}`);
  };

  const headerCollect = () => {
    if (scopedPending.length === 0) {
      flash("No pending fees right now", "ok");
      return;
    }
    setCollectOpen((v) => !v);
  };
  const pickFromCollect = (fee) => {
    setSelected(fee);
    setStage("pick");
    setCollectOpen(false);
    flash(`Loaded ${fee.name} · choose method and proceed`);
  };

  const togglePick = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const eligibleForRemind = visible.filter((f) => f.status !== "paid").map((f) => f.id);

  // After a Collect-fee → Mark paid, the freshly-paid id is still sitting in
  // `picked` and the user can no longer tick/untick it (the row is disabled).
  // Reconcile silently against the live data so the next Remind only targets
  // ids that are still pending.
  const eligibleSet = new Set(eligibleForRemind);
  useEffect(() => {
    if (picked.size === 0) return;
    let drift = false;
    const next = new Set();
    picked.forEach((id) => {
      if (eligibleSet.has(id)) next.add(id);
      else drift = true;
    });
    if (drift) setPicked(next);
  }, [eligibleForRemind.join("|")]);
  const allChecked = eligibleForRemind.length > 0 && eligibleForRemind.every((id) => picked.has(id));
  const togglePickAll = () => {
    if (allChecked) setPicked(new Set());
    else setPicked(new Set(eligibleForRemind));
  };

  const remindSelected = async (channel = "WhatsApp") => {
    if (picked.size === 0) {
      flash("Pick at least one row first", "bad");
      return;
    }
    const ids = [...picked];
    const r = await fetch("/api/fees/remind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, channel }),
    });
    const json = await r.json();
    if (json.ok) {
      flash(`${json.count} ${channel} reminders queued`);
      setPicked(new Set());
      await refresh?.();
    } else {
      flash("Reminder failed", "bad");
    }
  };

  // Branded PDF export — opens a printable, properly aligned report with the
  // school logo, identity block, summary chips, and a clean data table.
  const exportPdf = () => {
    const totalCollected = all
      .filter((f) => f.status === "paid")
      .reduce((sum, f) => sum + (Number(f.amount) || 0), 0);
    const totalPending = all
      .filter((f) => f.status === "pending" || f.status === "overdue")
      .reduce((sum, f) => sum + (Number(f.amount) || 0), 0);
    const overdueCount = all.filter((f) => f.status === "overdue").length;

    const opened = downloadPdf({
      title: "Fees Register",
      subtitle: `${all.length} fee record${all.length === 1 ? "" : "s"} · paid, pending and overdue`,
      school,
      actor,
      dateRange: "Current snapshot",
      orientation: "landscape",
      summary: [
        { label: "Total records", value: all.length },
        { label: "Collected",     value: money(totalCollected) },
        { label: "Pending",       value: money(totalPending) },
        { label: "Overdue",       value: overdueCount },
      ],
      columns: [
        { key: "i",      label: "#",        align: "right",  width: "32px" },
        { key: "id",     label: "Receipt / ID", width: "150px" },
        { key: "name",   label: "Student" },
        { key: "cls",    label: "Class",    align: "center", width: "60px" },
        { key: "feeType",label: "Fee type" },
        { key: "amount", label: "Amount",   align: "right" },
        { key: "status", label: "Status",   align: "center", width: "80px" },
        { key: "method", label: "Method",   align: "center", width: "80px" },
        { key: "time",   label: "When",     align: "right",  width: "90px" },
      ],
      rows: all.map((f, i) => ({
        i: i + 1,
        id: f.id,
        name: f.name || "—",
        cls: f.cls ? formatClassLabel(f.cls) : "—",
        feeType: feeTypeLabel(f.feeType) || "—",
        amount: money(f.amount || 0),
        status: (f.status || "—").replace(/^./, (c) => c.toUpperCase()),
        method: f.method || "—",
        time: formatFeeWhen(f),
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-fees-register-${new Date().toISOString().slice(0, 10)}`,
    });
    if (opened === false) {
      flash("Pop-up blocked — please allow pop-ups for this site", "bad");
    } else {
      flash(`Opened PDF preview · ${all.length} rows`);
    }
  };

  // Scoped report generator — same branded PDF, but restricted to one payment
  // status ("paid" / "unpaid") and/or one fee type (term1/term2/term3/
  // application/transport…). Drives the "Generate report" preset menu so admin
  // can pull e.g. "only Term I", "only paid", "only Transport" in one click.
  const generateReport = ({ statusKey = "all", feeTypeKey = "all", label }) => {
    let rows = all;
    if (feeTypeKey !== "all") rows = rows.filter((f) => feeTypeOf(f) === feeTypeKey);
    if (statusKey === "paid") rows = rows.filter((f) => f.status === "paid");
    else if (statusKey === "unpaid") rows = rows.filter((f) => f.status === "pending" || f.status === "overdue");

    if (rows.length === 0) { flash(`No records for "${label}"`, "bad"); return; }

    const collected = rows.filter((f) => f.status === "paid").reduce((a, f) => a + (Number(f.amount) || 0), 0);
    const outstanding = rows.filter((f) => f.status !== "paid").reduce((a, f) => a + (Number(f.amount) || 0), 0);
    const studentCount = new Set(rows.map(studentOf).filter(Boolean)).size;

    const opened = downloadPdf({
      title: `Fees Report · ${label}`,
      subtitle: `${rows.length} record${rows.length === 1 ? "" : "s"} · ${studentCount} student${studentCount === 1 ? "" : "s"}`,
      school,
      actor,
      dateRange: "Current snapshot",
      orientation: "landscape",
      summary: [
        { label: "Records",     value: rows.length },
        { label: "Students",    value: studentCount },
        { label: "Collected",   value: money(collected) },
        { label: "Outstanding", value: money(outstanding) },
      ],
      columns: [
        { key: "i",      label: "#",        align: "right",  width: "32px" },
        { key: "id",     label: "Receipt / ID", width: "150px" },
        { key: "name",   label: "Student" },
        { key: "cls",    label: "Class",    align: "center", width: "60px" },
        { key: "feeType",label: "Fee type" },
        { key: "amount", label: "Amount",   align: "right" },
        { key: "status", label: "Status",   align: "center", width: "80px" },
        { key: "method", label: "Method",   align: "center", width: "80px" },
        { key: "time",   label: "When",     align: "right",  width: "90px" },
      ],
      rows: rows.map((f, i) => ({
        i: i + 1,
        id: f.id,
        name: f.name || "—",
        cls: f.cls ? formatClassLabel(f.cls) : "—",
        feeType: feeTypeLabel(f.feeType) || "—",
        amount: money(f.amount || 0),
        status: (f.status || "—").replace(/^./, (c) => c.toUpperCase()),
        method: f.method || "—",
        time: formatFeeWhen(f),
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-fees-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 10)}`,
    });
    if (opened === false) {
      flash("Pop-up blocked — please allow pop-ups for this site", "bad");
    } else {
      flash(`Opened report · ${label} · ${rows.length} rows`);
    }
  };

  // Term-wise pending statement — one row per student who owes the given term,
  // with columns for that term + Admission + Transport dues (student-wise
  // pivot). Used for term-by-term collection.
  const generatePendingStatement = (termKey, termLabel) => {
    const owns = (f) => f.studentId || f.student_id || String(f.id || "").split("__")[0];
    const byStudent = {};
    for (const f of scopedPending) {
      const sid = owns(f);
      if (!sid) continue;
      if (!byStudent[sid]) byStudent[sid] = { name: f.name, cls: f.cls, term: 0, admission: 0, transport: 0 };
      const t = feeTypeOf(f);
      const amt = Number(f.amount) || 0;
      if (t === termKey) byStudent[sid].term += amt;
      else if (t === "application") byStudent[sid].admission += amt;
      else if (t === "transport") byStudent[sid].transport += amt;
    }
    // Every student who owes any of the three (that term / Admission / Transport).
    const students = Object.values(byStudent)
      .filter((s) => s.term > 0 || s.admission > 0 || s.transport > 0)
      .sort((a, b) => String(a.cls || "").localeCompare(String(b.cls || "")) || String(a.name || "").localeCompare(String(b.name || "")));
    if (students.length === 0) { flash(`No pending ${termLabel} / Admission / Transport`, "bad"); return; }

    const sumT = students.reduce((a, s) => a + s.term, 0);
    const sumA = students.reduce((a, s) => a + s.admission, 0);
    const sumTr = students.reduce((a, s) => a + s.transport, 0);

    const opened = downloadPdf({
      title: `Pending Fees · ${termLabel}`,
      subtitle: `${students.length} student${students.length === 1 ? "" : "s"} · ${termLabel} + Admission + Transport dues`,
      school,
      actor,
      dateRange: "Current snapshot",
      orientation: "landscape",
      summary: [
        { label: "Students",    value: students.length },
        { label: termLabel,     value: money(sumT) },
        { label: "Admission",   value: money(sumA) },
        { label: "Transport",   value: money(sumTr) },
        { label: "Grand total", value: money(sumT + sumA + sumTr) },
      ],
      columns: [
        { key: "i",         label: "#",         align: "right",  width: "32px" },
        { key: "name",      label: "Student" },
        { key: "cls",       label: "Class",     align: "center", width: "64px" },
        { key: "term",      label: termLabel,   align: "right" },
        { key: "admission", label: "Admission", align: "right" },
        { key: "transport", label: "Transport", align: "right" },
        { key: "trMonth",   label: `Transport / month (÷${TRANSPORT_MONTHS})`, align: "right" },
        { key: "total",     label: "Total due", align: "right" },
      ],
      rows: students.map((s, i) => ({
        i: i + 1,
        name: s.name || "—",
        cls: s.cls ? formatClassLabel(s.cls) : "—",
        term: s.term ? money(s.term) : "—",
        admission: s.admission ? money(s.admission) : "—",
        transport: s.transport ? money(s.transport) : "—",
        trMonth: s.transport ? money(transportPerMonth(s.transport)) : "—",
        total: money(s.term + s.admission + s.transport),
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-pending-${termLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 10)}`,
    });
    if (opened === false) flash("Pop-up blocked — please allow pop-ups for this site", "bad");
    else flash(`${termLabel} pending statement · ${students.length} students`);
  };

  // Class-wise pending — the students grouped under each class (Class I, then
  // Class II, …), each class its own section with a class subtotal, and a grand
  // total at the end. Rendered as a printable page (multi-section layout).
  // Build + open a printable pending PDF for the given class groups
  // (groups = [{ clsKey, list }]). Works for a single class or all of them.
  const printPendingClasses = (termLabel, groups) => {
    const m = (n) => `₹${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
    let gT = 0, gA = 0, gTr = 0;
    const sections = groups.map(({ clsKey, list }) => {
      let cT = 0, cA = 0, cTr = 0;
      const rows = list.map((s, i) => {
        cT += s.term; cA += s.admission; cTr += s.transport;
        return `<tr><td style="text-align:right;color:#999">${i + 1}</td><td>${escapeHtml(s.name || "—")}</td>`
          + `<td style="text-align:right">${s.term ? m(s.term) : "—"}</td>`
          + `<td style="text-align:right">${s.admission ? m(s.admission) : "—"}</td>`
          + `<td style="text-align:right">${s.transport ? m(s.transport) : "—"}</td>`
          + `<td style="text-align:right">${s.transport ? m(transportPerMonth(s.transport)) : "—"}</td>`
          + `<td style="text-align:right;font-weight:600">${m(s.term + s.admission + s.transport)}</td></tr>`;
      }).join("");
      gT += cT; gA += cA; gTr += cTr;
      const head = ["#", "Student", termLabel, "Admission", "Transport", "Transport / month", "Total due"]
        .map((h, idx) => `<th style="text-align:${idx === 1 ? "left" : "right"};padding:4px 6px;border-bottom:1px solid #bbb;color:#555;font-weight:600">${escapeHtml(h)}</th>`).join("");
      return `<h3 style="margin:18px 0 4px;color:#1f3a8a;font-size:14px">${escapeHtml(formatClassLabel(clsKey))}`
        + ` <span style="font-weight:400;color:#666;font-size:12px">· ${list.length} student${list.length === 1 ? "" : "s"}</span></h3>`
        + `<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr>${head}</tr></thead><tbody>${rows}`
        + `<tr style="background:#f5f2ec;font-weight:700"><td></td><td>Class total</td>`
        + `<td style="text-align:right">${m(cT)}</td><td style="text-align:right">${m(cA)}</td>`
        + `<td style="text-align:right">${m(cTr)}</td><td style="text-align:right">${m(transportPerMonth(cTr))}</td>`
        + `<td style="text-align:right">${m(cT + cA + cTr)}</td></tr></tbody></table>`;
    }).join("");
    const scope = groups.length === 1 ? formatClassLabel(groups[0].clsKey) : `${groups.length} classes`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Pending ${escapeHtml(termLabel)} — ${escapeHtml(scope)}</title>`
      + `<style>td{padding:4px 6px;border-bottom:1px solid #eee}</style></head>`
      + `<body style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:900px;margin:24px auto;padding:0 16px">`
      + `<div style="text-align:center;border-bottom:2px solid #1f3a8a;padding-bottom:10px;margin-bottom:8px">`
      + `<div style="font-size:18px;font-weight:800;color:#1f3a8a">${escapeHtml(school?.name || "Sanfort International School")}</div>`
      + `<div style="font-size:13px;margin-top:4px">Pending Fees · ${escapeHtml(termLabel)} + Admission + Transport · ${escapeHtml(scope)}</div></div>`
      + `<div style="font-size:12px;margin-bottom:4px">Grand total: ${m(gT + gA + gTr)} (${escapeHtml(termLabel)} ${m(gT)} · Admission ${m(gA)} · Transport ${m(gTr)})</div>`
      + sections
      + `<div style="margin-top:16px;font-size:12px;text-align:right;font-weight:800;color:#1f3a8a">Grand total: ${m(gT + gA + gTr)}</div>`
      + `<div style="margin-top:20px;font-size:10px;color:#999;text-align:center">Generated ${escapeHtml(new Date().toLocaleString("en-IN"))}${actor ? ` · ${escapeHtml(actor)}` : ""}</div>`
      + `</body></html>`;
    const w = window.open("", "_blank");
    if (!w) { flash("Pop-up blocked — please allow pop-ups for this site", "bad"); return; }
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { try { w.print(); } catch {} }, 400);
  };

  // Class-wise pending — open a picker so each class can be downloaded on its own.
  const generatePendingByClass = (termKey, termLabel) => {
    const owns = (f) => f.studentId || f.student_id || String(f.id || "").split("__")[0];
    const byStudent = {};
    for (const f of scopedPending) {
      const t = feeTypeOf(f);
      if (t !== termKey && t !== "application" && t !== "transport") continue;
      const sid = owns(f);
      if (!sid) continue;
      if (!byStudent[sid]) byStudent[sid] = { name: f.name, cls: f.cls || "—", term: 0, admission: 0, transport: 0 };
      const amt = Number(f.amount) || 0;
      if (t === termKey) byStudent[sid].term += amt;
      else if (t === "application") byStudent[sid].admission += amt;
      else if (t === "transport") byStudent[sid].transport += amt;
    }
    const students = Object.values(byStudent).filter((s) => s.term > 0 || s.admission > 0 || s.transport > 0);
    if (students.length === 0) { flash(`No pending ${termLabel} / Admission / Transport`, "bad"); return; }
    const byClass = {};
    for (const s of students) { (byClass[s.cls] = byClass[s.cls] || []).push(s); }
    const classKeys = Object.keys(byClass).sort((a, b) =>
      (Number(String(a).split("-")[0]) || 0) - (Number(String(b).split("-")[0]) || 0) || String(a).localeCompare(String(b)));
    classKeys.forEach((k) => byClass[k].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))));
    setPendingClassPick({ termLabel, byClass, classKeys });
  };

  const importStructure = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.xlsx,.xls";
    input.onchange = (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      flash(`Imported "${f.name}" · ${(f.size / 1024).toFixed(1)} KB`);
    };
    input.click();
  };

  // Receipt actions
  const phoneFor = () => DEMO_PARENT_PHONE.replace(/[^0-9]/g, "");
  const sendWhatsApp = () => {
    const text = encodeURIComponent(`Receipt for ${selected.name} (${selected.id}) · ₹${selected.amount} paid via ${method}. Thank you — Sanfort International School.`);
    window.open(`https://wa.me/${phoneFor()}?text=${text}`, "_blank");
    flash("Opened WhatsApp");
  };
  const sendSms = () => {
    window.open(`sms:${DEMO_PARENT_PHONE}?body=Receipt%20${selected.id}%20%E2%82%B9${selected.amount}%20paid`, "_self");
    flash("Opened SMS app");
  };
  const sendEmail = () => {
    const subject = encodeURIComponent(`Fee receipt · ${selected.id} · ${selected.name}`);
    const body = encodeURIComponent(`Dear Parent,\n\nThis is to confirm receipt of ₹${selected.amount} towards fees for ${selected.name} (${formatClassLabel(selected.cls)}, Reg ID ${selected.id}).\nMethod: ${method}\n\nThank you,\nSanfort International School\nRun by Sanvi Educational and Charitable Trust`);
    window.open(`mailto:parent@example.com?subject=${subject}&body=${body}`, "_self");
    flash("Opened email draft");
  };
  // Sends the UPI QR (with amount + student details baked in) to the
  // parent's WhatsApp via the n8n webhook. Server-side resolves the
  // parent's phone from the student record so the UI doesn't need it.
  const sendQrToWhatsApp = async (amt) => {
    if (!selected) return;
    if (busy) return;
    if (!finance.upi) {
      flash("Set the school's UPI ID under Settings → Finance first", "bad");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/fees/send-qr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selected.id, amount: amt, method }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Could not send QR");
      flash(`QR sent on WhatsApp to ${j.sentTo}`);
    } catch (e) {
      flash(e.message, "bad");
    } finally { setBusy(false); }
  };
  const printReceipt = () => {
    if (!selected) return;
    const paidAmt   = lastPayment?.amount ?? (selected.amount + (selected.overdue ? 200 : 0));
    const partial   = lastPayment?.partial && lastPayment.remaining > 0;
    const remaining = lastPayment?.remaining || 0;
    const methodUsed = (selected.method && selected.method !== "—") ? selected.method : method;
    const receiptNo  = lastPayment?.serial != null ? String(lastPayment.serial).padStart(3, "0") : serialFor(selected);
    const today = new Date();
    const dateStr  = today.toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
    const monthStr = today.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
    // Particulars come straight from the fee row's category. A late-fee line
    // is added when the row is overdue. This way the printed receipt matches
    // exactly what was paid (Application Fees / Kit / ECA / Term I etc.).
    const lines = [
      { label: feeTypeLabel(selected.feeType), amount: selected.amount },
    ];
    if (selected.overdue) lines.push({ label: "Late Fee", amount: 200 });
    // Pad to a minimum of 5 rows so the printed receipt has consistent height
    // (matches the physical-book look of the template).
    const minRows = 5;
    const padded = [
      ...lines,
      ...Array.from({ length: Math.max(0, minRows - lines.length) }, () => ({ label: "", amount: null })),
    ];
    const rowsHtml = padded.map((l, i) => `
      <tr>
        <td class="sno">${l.label ? `${i + 1}.` : ""}</td>
        <td class="part">${l.label ? `${escapeHtml(l.label)}<span class="dots"></span>` : "&nbsp;"}</td>
        <td class="amt">${l.amount !== null ? l.amount.toLocaleString("en-IN") : ""}</td>
      </tr>`).join("");
    const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Receipt · ${escapeHtml(selected.name)} · ${escapeHtml(selected.id)}</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:Arial,Helvetica,sans-serif;color:#000;margin:0;padding:18px;background:#fff;}
  .wrap{width:360px;margin:0 auto;border:1px solid #1f3a8a;padding:14px 16px 18px;}
  .school{color:#1f3a8a;font-weight:800;font-size:18px;text-align:center;letter-spacing:0.3px;line-height:1.15;}
  .reg{color:#1f3a8a;font-weight:600;font-size:10.5px;text-align:center;margin-top:2px;}
  .addr{color:#1f3a8a;font-weight:600;font-size:10.5px;text-align:center;margin-top:1px;}
  .cell{color:#1f3a8a;font-weight:600;font-size:10.5px;text-align:center;margin-top:1px;}
  .meta{margin-top:10px;font-size:11.5px;color:#1f3a8a;font-weight:600;}
  .meta .row{display:flex;justify-content:space-between;gap:14px;padding:3px 0;}
  .meta .cell-l{flex:1;}
  .meta .cell-r{flex:1;text-align:left;}
  .field{display:inline-flex;align-items:baseline;gap:4px;}
  .val{display:inline-block;border-bottom:1px dotted #1f3a8a;min-width:90px;padding:0 4px;color:#000;font-weight:500;}
  .slno{color:#c11d1d;font-weight:800;font-size:18px;letter-spacing:1px;border:0;padding-left:6px;}
  table.part{width:100%;border-collapse:collapse;margin-top:10px;border:1px solid #1f3a8a;}
  table.part th{background:#fff;color:#1f3a8a;font-weight:700;font-size:11.5px;border:1px solid #1f3a8a;padding:5px 6px;text-align:left;}
  table.part th.amt-col{text-align:right;width:80px;}
  table.part td{border:1px solid #1f3a8a;padding:6px 6px;font-size:12px;height:22px;}
  table.part td.sno{width:36px;text-align:center;font-weight:600;color:#000;}
  table.part td.amt{width:80px;text-align:right;font-weight:600;font-family:Arial,sans-serif;}
  table.part td.part{position:relative;}
  table.part td.part .dots{display:inline-block;border-bottom:1px dotted #888;flex:1;margin-left:6px;width:60%;}
  table.part tr.total td{font-weight:700;color:#1f3a8a;font-size:13px;background:#fafbff;}
  .footer{display:flex;justify-content:flex-end;margin-top:6px;font-size:11px;color:#000;font-style:italic;}
  .balance{margin-top:6px;font-size:11px;color:#a06820;text-align:right;font-weight:600;}
  .logo-row{display:flex;align-items:center;gap:10px;margin-bottom:4px;}
  .logo-row img{width:54px;height:54px;object-fit:contain;}
  .logo-row .school-block{flex:1;text-align:center;}
  .trust{color:#1f3a8a;font-weight:700;font-size:11px;text-align:center;margin-top:2px;letter-spacing:0.3px;}
  @media print { @page { size: auto; margin: 8mm; } body{padding:0;} }
</style></head>
<body>
  <div class="wrap">
    <div class="logo-row">
      <img src="${window.location.origin}/logo.png" alt="logo" />
      <div class="school-block">
        <div class="school">SANFORT INTERNATIONAL SCHOOL</div>
        <div class="trust">Sanvi Educational and Charitable Trust</div>
      </div>
    </div>
    <div class="cell">Cell : 98765 43210</div>

    <div class="meta">
      <div class="row">
        <div class="cell-l"><span class="field">Adm. No : <span class="val">${escapeHtml(selected.id)}</span></span></div>
        <div class="cell-r"><span class="field">SL. No. <span class="slno">${receiptNo}</span></span></div>
      </div>
      <div class="row">
        <div class="cell-l"><span class="field">Name : <span class="val">${escapeHtml(selected.name)}</span></span></div>
        <div class="cell-r"><span class="field">Class : <span class="val">${escapeHtml(formatClassLabel(selected.cls))}</span></span></div>
      </div>
      <div class="row">
        <div class="cell-l"><span class="field">Month : <span class="val">${escapeHtml(monthStr)}</span></span></div>
        <div class="cell-r"><span class="field">Date : <span class="val">${escapeHtml(dateStr)}</span></span></div>
      </div>
    </div>

    <table class="part">
      <thead>
        <tr>
          <th>S.No.</th>
          <th>Particulars</th>
          <th class="amt-col">Amount<br/>Rs.</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
        <tr class="total">
          <td class="sno"></td>
          <td class="part" style="text-align:right;padding-right:10px;">TOTAL</td>
          <td class="amt">${paidAmt.toLocaleString("en-IN")}</td>
        </tr>
      </tbody>
    </table>

    ${partial ? `<div class="balance">Balance pending: Rs. ${remaining.toLocaleString("en-IN")}</div>` : ""}

    <div class="footer">Paid via ${escapeHtml(methodUsed)} &nbsp;·&nbsp; Cashier</div>
  </div>
  <script>window.addEventListener("load",()=>{setTimeout(()=>{window.print();},80);});</script>
</body></html>`;
    const w = window.open("", "_blank", "width=560,height=820");
    if (!w) { flash("Popup blocked — allow popups to download the receipt", "bad"); return; }
    w.document.open(); w.document.write(html); w.document.close();
    flash(`Receipt for ${selected.name} ready to print / save as PDF`);
  };

  // ---------- render ----------
  return (
    <div className="page">
      <Toast toast={toast} />

      <div className="page-head">
        <div>
          <div className="page-eyebrow">Finance · Fees register</div>
          <div className="page-title">Fees & <span className="amber">Transaction</span></div>
          <div style={{ display: "flex", gap: 10, color: "var(--ink-3)", fontSize: 12, marginTop: 12, flexWrap: "wrap" }}>
            <span className="chip ok"><span className="dot" />{money(totals.collected)} collected (live)</span>
            <span className="chip warn"><span className="dot" />{money(totals.pending)} pending</span>
            <span className="chip bad"><span className="dot" />{money(totals.overdue)} overdue</span>
          </div>
        </div>
        <div className="page-actions">
          {isParent ? (
            /* Parent view is read-only — payments are taken at the school
               office; this screen just shows what's pending and what's been
               recorded against this child. */
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              height: 30, padding: "0 12px",
              background: "var(--bg-2)", border: "1px solid var(--rule)",
              borderRadius: 999, fontSize: 11.5, color: "var(--ink-3)",
            }}>
              <Icon name="audit" size={11} />Read-only · pay at the school office
            </span>
          ) : (
            <>
              <button className="btn" onClick={importStructure}><Icon name="upload" size={13} />Import structure</button>
              <div style={{ position: "relative" }}>
                <button
                  className={`btn ${reportOpen ? "accent" : ""}`}
                  onClick={() => setReportOpen((v) => !v)}
                  title="Generate a branded PDF report — full register or scoped to paid / unpaid / a fee type"
                >
                  <Icon name="download" size={13} />Generate report
                  <Icon name="chevronDown" size={11} />
                </button>
                {reportOpen && (
                  <ReportMenu
                    onClose={() => setReportOpen(false)}
                    onFull={() => { setReportOpen(false); exportPdf(); }}
                    onPick={(preset) => { setReportOpen(false); generateReport(preset); }}
                    onPending={(key, label) => { setReportOpen(false); generatePendingStatement(key, label); }}
                    onPendingClass={(key, label) => { setReportOpen(false); generatePendingByClass(key, label); }}
                  />
                )}
              </div>
              <button className="btn" onClick={() => setAddFeeOpen(true)} title="Create a new pending fee item (Kit, ECA, Term I…)">
                <Icon name="plus" size={13} />Add fee
              </button>
              {canEditStructure && (
                <button className="btn" onClick={() => setStructureOpen(true)} title="Set per-class Term I/II/III, Application and Van fee amounts">
                  <Icon name="settings" size={13} />Fee structure
                </button>
              )}
              {/* Divider — Collect fee + Remind overdue are set apart on the right. */}
              <div style={{ width: 1, alignSelf: "stretch", background: "var(--rule)", margin: "2px 4px" }} />
              <div style={{ position: "relative" }}>
                <button className="btn accent" onClick={headerCollect}>
                  <Icon name="plus" size={13} />Collect fee
                  {scopedPending.length > 0 && (
                    <span className="mono" style={{ marginLeft: 4, fontSize: 11, opacity: 0.85 }}>
                      · {scopedPending.length} pending
                    </span>
                  )}
                </button>
                {collectOpen && (
                  <CollectMenu
                    items={scopedPending}
                    onPick={pickFromCollect}
                    onClose={() => setCollectOpen(false)}
                  />
                )}
              </div>
              <div style={{ position: "relative" }}>
                <button
                  className={`btn ${remindMenuOpen ? "accent" : ""}`}
                  onClick={() => setRemindMenuOpen((v) => !v)}
                  disabled={scopedPending.length === 0}
                  title="Send a customized bulk reminder — by fee type or admission+term/transport combinations"
                >
                  <Icon name="megaphone" size={13} />Bulk reminder
                  <Icon name="chevronDown" size={11} />
                </button>
                {remindMenuOpen && (
                  <RemindMenu
                    rows={remindPresetRows}
                    onClose={() => setRemindMenuOpen(false)}
                    onPick={(r) => {
                      setRemindMenuOpen(false);
                      if (!r.ids || r.ids.length === 0) { flash(`No parents pending for "${r.label}"`, "bad"); return; }
                      setBulkRemind({ label: r.label, ids: r.ids, students: r.students, amount: r.amount });
                    }}
                  />
                )}
              </div>
              <button
                className="btn"
                onClick={() => {
                  if (scopedPending.length === 0) { flash("No pending fees to remind about", "bad"); return; }
                  setRemindConfirm(true);
                }}
                disabled={scopedPending.length === 0}
                title={scopedPending.length === 0 ? "No pending fees" : `Reminds all ${scopedPending.length} parents with pending fees`}
              >
                <Icon name="megaphone" size={13} />Remind all
              </button>
            </>
          )}
        </div>
      </div>

      {!isParent && <CollectionSummary recent={scopedRecent} />}

      <div className="grid g-12">
        <div className="card col-8">
          <div className="card-head">
            <div><div className="card-title">Fee register</div><div className="card-sub">{counts.All} student{counts.All === 1 ? "" : "s"} · counts by student</div></div>
            <div className="card-actions">
              <div className="segmented">
                {["All", "Paid", "Pending", "Overdue"].map((s) => (
                  <button
                    key={s}
                    className={statusFilter === s ? "active" : ""}
                    onClick={() => setStatusFilter(s)}
                  >
                    {s} · {counts[s]}
                  </button>
                ))}
              </div>
              <select
                className="select"
                value={feeTypeFilter}
                onChange={(e) => setFeeTypeFilter(e.target.value)}
                title="Filter the register by fee type — combine with Paid / Pending / All above"
                style={{ height: 30, fontSize: 12, padding: "0 8px", borderColor: feeTypeFilter !== "All" ? "var(--accent)" : undefined }}
              >
                <option value="All">All fee types</option>
                <option value="term1">Term I</option>
                <option value="term2">Term II</option>
                <option value="term3">Term III</option>
                <option value="transport">Transport</option>
                <option value="application">Admission</option>
              </select>
              <div style={{ position: "relative" }}>
                <button className={`btn sm ${classFilter !== "All" ? "accent" : ""}`} onClick={() => setFilterOpen((v) => !v)}>
                  <Icon name="filter" size={12} />
                  {classFilter === "All" ? "Filter" : formatClassLabel(classFilter)}
                </button>
                {filterOpen && (
                  <FilterMenu
                    value={classFilter}
                    classes={E.CLASSES || []}
                    onClose={() => setFilterOpen(false)}
                    onPick={(v) => { setClassFilter(v); setFilterOpen(false); }}
                  />
                )}
              </div>
            </div>
          </div>

          {!isParent && picked.size > 0 && (
            <div style={{
              padding: "10px 18px", display: "flex", alignItems: "center", gap: 12,
              background: "var(--accent-soft)", borderBottom: "1px solid var(--rule-2)",
              fontSize: 12.5,
            }}>
              <span style={{ fontWeight: 500, color: "var(--accent-2)" }}>{picked.size} selected</span>
              <button className="btn sm accent" onClick={() => remindSelected("WhatsApp")}>
                <Icon name="whatsapp" size={11} />Remind on WhatsApp
              </button>
              <button className="btn sm" onClick={() => remindSelected("SMS")}>
                <Icon name="sms" size={11} />Remind via SMS
              </button>
              <button className="btn sm ghost" onClick={() => setPicked(new Set())} style={{ marginLeft: "auto" }}>Clear</button>
            </div>
          )}

          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 24 }}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={togglePickAll}
                      disabled={eligibleForRemind.length === 0}
                      title={eligibleForRemind.length ? "Select all unpaid in view" : "Nothing to select"}
                    />
                  </th>
                  <th>Student</th>
                  <th>Class</th>
                  <th>Fee type</th>
                  <th className="num">Amount</th>
                  <th>Method</th>
                  <th>Status</th>
                  <th>When</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr><td colSpan={9} className="empty">No fees match this filter.</td></tr>
                )}
                {visible.map((f, i) => (
                  <tr key={f.id + "-" + i} style={selected && selected.id === f.id ? { background: "var(--card-2)" } : undefined}>
                    <td style={{ width: 24 }}>
                      <input
                        type="checkbox"
                        checked={picked.has(f.id)}
                        disabled={f.status === "paid"}
                        onChange={() => togglePick(f.id)}
                      />
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <AvatarChip initials={f.name.split(" ").map((n) => n[0]).join("")} />
                        <div>
                          <div style={{ fontSize: 12.5, fontWeight: 500 }}>{f.name}</div>
                          <div style={{ fontSize: 11, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{f.id}</div>
                        </div>
                      </div>
                    </td>
                    <td><span className="chip">{formatClassLabel(f.cls)}</span></td>
                    <td><span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent-2)" }}>{feeTypeLabel(f.feeType)}</span></td>
                    <td className="num">{money(f.amount)}</td>
                    <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{f.method}</td>
                    <td><StatusChip status={f.status}>{f.status.charAt(0).toUpperCase() + f.status.slice(1)}</StatusChip></td>
                    <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{formatFeeWhen(f)}</td>
                    <td>
                      {f.status === "paid" ? (
                        <span style={{ display: "inline-flex", gap: 4 }}>
                          <button className="btn sm ghost" onClick={() => openReceipt(f)}>Receipt</button>
                          {canDeleteReceipt && (
                            <button
                              className="btn sm ghost"
                              title="Delete this receipt from history"
                              onClick={() => setDeletingReceipt(f)}
                              style={{ color: "var(--bad)" }}
                            >
                              <Icon name="x" size={11} />
                            </button>
                          )}
                        </span>
                      ) : isParent ? (
                        <span style={{ fontSize: 11, color: "var(--ink-4)" }}>Pay at office</span>
                      ) : (
                        <span style={{ display: "inline-flex", gap: 4 }}>
                          <button
                            className="btn sm ghost"
                            title="Edit outstanding amount"
                            onClick={() => setEditingFee(f)}
                          >
                            <Icon name="pencil" size={11} />Edit
                          </button>
                          <button className="btn sm accent" onClick={() => { setSelected(f); setStage("pick"); flash(`Loaded ${f.name}`); }}>Collect</button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Parents get a read-only summary card; staff get the live Collect flow. */}
        {isParent ? (
          <ParentFeesSummary
            scopedPending={scopedPending}
            scopedRecent={scopedRecent}
            child={E.ADDED_STUDENTS && E.ADDED_STUDENTS[0]}
            openReceipt={openReceipt}
            onRefresh={refresh}
          />
        ) : (
        <>
        {editingFee && (
          <EditFeeAmountModal
            fee={editingFee}
            onClose={() => setEditingFee(null)}
            onSave={async (amt) => {
              const ok = await saveFeeAmount(editingFee.id, amt);
              if (ok) setEditingFee(null);
            }}
          />
        )}
        {deletingReceipt && (
          <DeleteReceiptModal
            receipt={deletingReceipt}
            onCancel={() => setDeletingReceipt(null)}
            onConfirm={async () => {
              try {
                const r = await fetch("/api/fees/receipt", {
                  method: "DELETE",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ id: deletingReceipt.id }),
                });
                const json = await r.json().catch(() => ({}));
                if (!r.ok || !json.ok) throw new Error(json.error || "Delete failed");
                flash(`Receipt ${deletingReceipt.id} removed from history`, "ok");
                setDeletingReceipt(null);
                await refresh?.();
              } catch (e) {
                flash(e.message || "Delete failed", "bad");
              }
            }}
          />
        )}
        <div
          className="card col-4"
          // Sticky so the Collect-fee flow stays in view while the cashier
          // scrolls through a long fee register on the left.
          //   - `top: 68px` clears the 56px sticky topbar plus a 12px gap,
          //     so the card title isn't hidden behind it
          //   - `alignSelf: start` stops the grid cell from stretching to
          //     the row's full height (which would defeat sticky)
          //   - `maxHeight` + scrollY ensures the panel scrolls internally
          //     when its steps grow tall (e.g. QR step with full receipt)
          //   - `zIndex: 4` keeps it under the topbar (z-index 5) so the
          //     topbar still covers its top edge during scroll transitions
          style={{
            position: "sticky",
            top: 68,
            alignSelf: "start",
            maxHeight: "calc(100vh - 80px)",
            overflowY: "auto",
            zIndex: 4,
          }}
        >
          <div className="card-head">
            <div>
              <div className="card-title">Collect fee</div>
              <div className="card-sub">
                {stage === "pick" && "Step 1 of 3 · Review"}
                {stage === "qr" && "Step 2 of 3 · Payment"}
                {stage === "paid" && "Step 3 of 3 · Receipt"}
              </div>
            </div>
            <div className="card-actions">
              <div style={{ display: "flex", gap: 4 }}>
                {["pick", "qr", "paid"].map((s, i) => (
                  <div
                    key={s}
                    onClick={() => {
                      if (s === "pick") setStage("pick");
                      else if (s === "qr" && selected && selected.status !== "paid") setStage("qr");
                      else if (s === "paid" && selected && selected.status === "paid") setStage("paid");
                    }}
                    style={{
                      height: 4, width: 22, borderRadius: 3, cursor: "pointer",
                      background: ["pick", "qr", "paid"].indexOf(stage) >= i ? "var(--accent)" : "var(--rule-2)",
                    }}
                  />
                ))}
              </div>
            </div>
          </div>

          {selected && (
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: "var(--card-2)", border: "1px solid var(--rule)", borderRadius: 10, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "var(--accent-ink)", display: "grid", placeItems: "center", fontWeight: 600, fontSize: 14 }}>
                    {selected.name.split(" ").map((n) => n[0]).join("")}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, fontSize: 13.5 }}>{selected.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{formatClassLabel(selected.cls)} · {selected.id} · {DEMO_PARENT_PHONE}</div>
                  </div>
                </div>
                <div className="hr" style={{ margin: "10px 0" }} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", rowGap: 4, fontSize: 12 }}>
                  <span style={{ color: "var(--ink-3)" }}>{feeTypeLabel(selected.feeType)}</span><span className="mono">{money(selected.amount)}</span>
                  <span style={{ color: "var(--ink-3)" }}>Late fee</span>
                  <span className="mono" style={{ color: selected.overdue ? "var(--bad)" : "inherit" }}>{selected.overdue ? money(200) : "—"}</span>
                </div>
                <div className="hr" style={{ margin: "10px 0" }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Payable</span>
                  <span className="mono" style={{ fontSize: 20, fontWeight: 500 }}>{money(selected.amount + (selected.overdue ? 200 : 0))}</span>
                </div>
              </div>

              {stage === "pick" && (
                <>
                  {selected.status !== "paid" && (() => {
                    const balance = (selected.amount || 0) + (selected.overdue ? 200 : 0);
                    const amt = payAmount.trim() === "" ? balance : Math.floor(Number(payAmount) || 0);
                    const valid = amt > 0 && amt <= balance;
                    const remaining = balance - amt;
                    const isPartial = remaining > 0;
                    return (
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                          <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Amount to pay</span>
                          <button
                            type="button"
                            onClick={() => setPayAmount(String(balance))}
                            style={{ background: "none", border: 0, color: "var(--accent)", fontSize: 11, fontWeight: 500, cursor: "pointer", padding: 0 }}
                          >
                            Pay full ₹{balance.toLocaleString("en-IN")}
                          </button>
                        </div>
                        <div style={{
                          display: "flex", alignItems: "center", height: 38,
                          background: "var(--card-2)", border: `1px solid ${valid ? "var(--rule)" : "var(--bad)"}`,
                          borderRadius: 9, overflow: "hidden",
                        }}>
                          <span style={{
                            display: "inline-flex", alignItems: "center", height: "100%",
                            padding: "0 11px",
                            background: "var(--bg-2)", borderRight: "1px solid var(--rule)",
                            fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--ink-3)",
                          }}>₹</span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={payAmount}
                            onChange={(e) => setPayAmount(e.target.value.replace(/\D/g, ""))}
                            placeholder={String(balance)}
                            style={{
                              flex: 1, height: "100%", border: 0, background: "transparent",
                              outline: "none", padding: "0 12px",
                              fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--ink)",
                            }}
                          />
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11.5 }}>
                          <span style={{ color: isPartial ? "var(--warn)" : "var(--ok)" }}>
                            {!valid
                              ? <span style={{ color: "var(--bad)" }}>Enter a valid amount up to ₹{balance.toLocaleString("en-IN")}</span>
                              : isPartial
                                ? <>Partial · ₹{remaining.toLocaleString("en-IN")} will remain pending</>
                                : <>Full payment · this clears the balance</>
                            }
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                  <div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Method</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                      {[{ k: "UPI", i: "qr" }, { k: "Cash", i: "money" }].map((m) => (
                        <button
                          key={m.k}
                          onClick={() => setMethod(m.k)}
                          className="btn"
                          style={{
                            justifyContent: "center", padding: "8px 6px",
                            background: method === m.k ? "var(--accent-soft)" : "var(--card)",
                            borderColor: method === m.k ? "var(--accent)" : "var(--rule)",
                            color: method === m.k ? "var(--accent-2)" : "var(--ink-2)",
                          }}
                        >
                          <Icon name={m.i} size={14} />{m.k}
                        </button>
                      ))}
                    </div>
                  </div>
                  {selected.status === "paid" ? (
                    <button className="btn" onClick={() => setStage("paid")} style={{ justifyContent: "center", padding: "10px 12px" }}>
                      View receipt <Icon name="arrowRight" size={13} />
                    </button>
                  ) : (
                    <button
                      className="btn accent"
                      onClick={proceed}
                      disabled={busy}
                      style={{ justifyContent: "center", padding: "10px 12px" }}
                    >
                      {method === "Cash"
                        ? <>{busy ? "Recording…" : "Record cash payment"} <Icon name="check" size={13} /></>
                        : <>Show QR to scan <Icon name="arrowRight" size={13} /></>}
                    </button>
                  )}
                </>
              )}

              {stage === "qr" && (() => {
                // Build the actual UPI deep-link from the saved finance settings
                // and the current selection. The amount on the QR matches what
                // the parent typed in the previous step (full balance if blank).
                const balance = (selected.amount || 0) + (selected.overdue ? 200 : 0);
                const amt = payAmount.trim() === "" ? balance : Math.floor(Number(payAmount) || 0);
                const upiUri = buildUpiUri({
                  upiId: finance.upi,
                  payeeName: finance.upiPayeeName || "Sanfort International School",
                  amount: amt,
                  note: `Fee ${selected.id}`,
                  transactionRef: selected.id,
                });
                return (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <div className="qrbox"><UpiQR size={180} uri={upiUri} /></div>
                    {finance.upi ? (
                      <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                        {finance.upi} · {method}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11.5, color: "var(--warn)", textAlign: "center", maxWidth: 240 }}>
                        Set the school's UPI ID under <b>Settings → Finance</b> for parents to be able to scan & pay.
                      </div>
                    )}
                    <div style={{ fontSize: 12, color: "var(--ink-3)", textAlign: "center", lineHeight: 1.5 }}>
                      Parent scans this QR in any UPI app.
                      <br />
                      Payment auto-verified &amp; receipt sent.
                    </div>
                    {/* Send the same QR to the parent's WhatsApp so they can
                        scan it on their own phone if they're not at the office. */}
                    <button
                      className="btn"
                      style={{ width: "100%", justifyContent: "center" }}
                      onClick={() => sendQrToWhatsApp(amt)}
                      disabled={busy || !finance.upi}
                      title={finance.upi ? "Send this QR to the parent's WhatsApp" : "Set a UPI ID under Settings → Finance first"}
                    >
                      <Icon name="whatsapp" size={13} />Send QR to WhatsApp
                    </button>
                    <div style={{ display: "flex", gap: 6, width: "100%" }}>
                      <button className="btn" style={{ flex: 1, justifyContent: "center" }} onClick={reset} disabled={busy}>Back</button>
                      <button className="btn accent" style={{ flex: 1, justifyContent: "center" }} onClick={markPaid} disabled={busy}>
                        <Icon name="check" size={13} />{busy ? "Posting…" : "Mark paid"}
                      </button>
                    </div>
                    <span className="live-pill"><span className="pulse-dot" />Listening for payment…</span>
                  </div>
                );
              })()}

              {stage === "paid" && (() => {
                // Match the printed-receipt layout (school header + meta grid +
                // particulars table) so the on-screen preview is faithful to
                // what the user will get out of the printer.
                const navy = "#1f3a8a";
                // One particulars line per fee type. The legacy "Tuition +
                // Activity" split is replaced by the actual feeType on the
                // pending/receipt row.
                const lines = [
                  { label: feeTypeLabel(selected.feeType), amount: selected.amount },
                ];
                if (selected.overdue) lines.push({ label: "Late Fee", amount: 200 });
                const totalAmt = lastPayment?.amount ?? (selected.amount + (selected.overdue ? 200 : 0));
                const slNo = lastPayment?.serial != null ? String(lastPayment.serial).padStart(3, "0") : serialFor(selected);
                const today = new Date();
                const dateStr  = today.toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
                const monthStr = today.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
                const dotted = { display: "inline-block", borderBottom: `1px dotted ${navy}`, minWidth: 70, padding: "0 4px", color: "#000", fontWeight: 500 };
                return (
                <>
                  <div className="receipt" id="fee-receipt" style={{ background: "#fff", border: `1px solid ${navy}`, padding: "12px 14px", color: "#000", fontFamily: "Arial, Helvetica, sans-serif" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                      <img src="/logo.png" alt="logo" style={{ width: 50, height: 50, objectFit: "contain", flexShrink: 0 }} />
                      <div style={{ flex: 1, textAlign: "center", color: navy }}>
                        <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: 0.3, lineHeight: 1.15 }}>SANFORT INTERNATIONAL SCHOOL</div>
                        <div style={{ fontWeight: 700, fontSize: 10.5, marginTop: 2, letterSpacing: 0.3 }}>Sanvi Educational and Charitable Trust</div>
                      </div>
                    </div>
                    <div style={{ textAlign: "center", color: navy }}>
                      <div style={{ fontWeight: 600, fontSize: 10 }}>Cell : 98765 43210</div>
                    </div>

                    <div style={{ marginTop: 8, fontSize: 11, color: navy, fontWeight: 600 }}>
                      <div style={{ display: "flex", gap: 10, padding: "2px 0" }}>
                        <div style={{ flex: 1 }}>Adm. No : <span style={dotted}>{selected.id}</span></div>
                        <div style={{ flex: 1 }}>SL. No. <span style={{ color: "#c11d1d", fontWeight: 800, fontSize: 14, letterSpacing: 1, marginLeft: 4 }}>{slNo}</span></div>
                      </div>
                      <div style={{ display: "flex", gap: 10, padding: "2px 0" }}>
                        <div style={{ flex: 1 }}>Name : <span style={dotted}>{selected.name}</span></div>
                        <div style={{ flex: 1 }}>Class : <span style={dotted}>{formatClassLabel(selected.cls)}</span></div>
                      </div>
                      <div style={{ display: "flex", gap: 10, padding: "2px 0" }}>
                        <div style={{ flex: 1 }}>Month : <span style={dotted}>{monthStr}</span></div>
                        <div style={{ flex: 1 }}>Date : <span style={dotted}>{dateStr}</span></div>
                      </div>
                    </div>

                    <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, border: `1px solid ${navy}`, fontSize: 11.5 }}>
                      <thead>
                        <tr>
                          <th style={{ border: `1px solid ${navy}`, padding: "4px 6px", color: navy, textAlign: "left", fontSize: 10.5, fontWeight: 700, width: 40 }}>S.No.</th>
                          <th style={{ border: `1px solid ${navy}`, padding: "4px 6px", color: navy, textAlign: "left", fontSize: 10.5, fontWeight: 700 }}>Particulars</th>
                          <th style={{ border: `1px solid ${navy}`, padding: "4px 6px", color: navy, textAlign: "right", fontSize: 10.5, fontWeight: 700, width: 80 }}>Amount<br />Rs.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((l, i) => (
                          <tr key={i}>
                            <td style={{ border: `1px solid ${navy}`, padding: "5px 6px", textAlign: "center", fontWeight: 600 }}>{i + 1}.</td>
                            <td style={{ border: `1px solid ${navy}`, padding: "5px 6px" }}>{l.label}<span style={{ borderBottom: "1px dotted #888", display: "inline-block", width: "40%", marginLeft: 6, verticalAlign: "middle", height: 1 }} /></td>
                            <td style={{ border: `1px solid ${navy}`, padding: "5px 6px", textAlign: "right", fontWeight: 600 }}>{l.amount.toLocaleString("en-IN")}</td>
                          </tr>
                        ))}
                        {Array.from({ length: Math.max(0, 5 - lines.length) }).map((_, i) => (
                          <tr key={`pad-${i}`}>
                            <td style={{ border: `1px solid ${navy}`, padding: "5px 6px", height: 22 }}>&nbsp;</td>
                            <td style={{ border: `1px solid ${navy}`, padding: "5px 6px" }}>&nbsp;</td>
                            <td style={{ border: `1px solid ${navy}`, padding: "5px 6px" }}>&nbsp;</td>
                          </tr>
                        ))}
                        <tr style={{ background: "#fafbff" }}>
                          <td style={{ border: `1px solid ${navy}`, padding: "5px 6px" }}></td>
                          <td style={{ border: `1px solid ${navy}`, padding: "5px 10px", color: navy, fontWeight: 700, fontSize: 12, textAlign: "right" }}>TOTAL</td>
                          <td style={{ border: `1px solid ${navy}`, padding: "5px 6px", textAlign: "right", color: navy, fontWeight: 700, fontSize: 12 }}>{totalAmt.toLocaleString("en-IN")}</td>
                        </tr>
                      </tbody>
                    </table>

                    {lastPayment?.partial && lastPayment.remaining > 0 && (
                      <div style={{ textAlign: "right", marginTop: 6, color: "#a06820", fontSize: 11, fontWeight: 600 }}>
                        Balance pending: Rs. {lastPayment.remaining.toLocaleString("en-IN")}
                      </div>
                    )}
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6, fontSize: 10.5, fontStyle: "italic", color: "#000" }}>
                      Paid via {selected.method && selected.method !== "—" ? selected.method : method} &nbsp;·&nbsp; Cashier
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <button className="btn" onClick={sendWhatsApp}><Icon name="whatsapp" size={12} />WhatsApp</button>
                    <button className="btn" onClick={sendSms}><Icon name="sms" size={12} />SMS</button>
                    <button className="btn" onClick={printReceipt}><Icon name="download" size={12} />PDF</button>
                    <button className="btn" onClick={sendEmail}><Icon name="mail" size={12} />Email</button>
                  </div>
                  <button className="btn accent" onClick={() => { reset(); headerCollect(); }} style={{ justifyContent: "center" }}>
                    <Icon name="check" size={13} />Done · collect another
                  </button>
                </>
                );
              })()}
            </div>
          )}
        </div>
        </>
        )}
      </div>

      {addFeeOpen && !isParent && (
        <AddFeeItemModal
          students={E.ADDED_STUDENTS || []}
          onClose={() => setAddFeeOpen(false)}
          onSave={async (payload) => {
            const ok = await handleAddFee(payload);
            if (ok) setAddFeeOpen(false);
          }}
        />
      )}

      {structureOpen && canEditStructure && (
        <FeeStructureModal
          classes={E.CLASSES || []}
          onClose={() => setStructureOpen(false)}
          onSaved={() => { setStructureOpen(false); flash("Fee structure saved", "ok"); }}
        />
      )}

      {remindConfirm && (
        <ConfirmModal
          title="Send fee reminders?"
          message={`This will send a fee reminder to ${scopedPending.length} parent${scopedPending.length === 1 ? "" : "s"} with a pending balance. Do you want to continue?`}
          confirmLabel="Yes, send"
          cancelLabel="No"
          busy={remindBusy}
          onCancel={() => { if (!remindBusy) setRemindConfirm(false); }}
          onConfirm={async () => {
            setRemindBusy(true);
            try {
              const r = await fetch("/api/fees/remind", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({}),  // no ids = remind all pending
              });
              const j = await r.json();
              if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
              flash(`Reminder sent to ${j.sent.length} parent${j.sent.length === 1 ? "" : "s"}`, "ok");
              await refresh?.();
            } catch (e) { flash(e.message, "bad"); }
            finally { setRemindBusy(false); setRemindConfirm(false); }
          }}
        />
      )}

      {bulkRemind && (
        <ConfirmModal
          title="Send bulk reminder?"
          message={`${bulkRemind.label} — this reminds ${bulkRemind.students} parent${bulkRemind.students === 1 ? "" : "s"} (${money(bulkRemind.amount)} across ${bulkRemind.ids.length} fee line${bulkRemind.ids.length === 1 ? "" : "s"}). Continue?`}
          confirmLabel="Yes, send"
          cancelLabel="No"
          busy={remindBusy}
          onCancel={() => { if (!remindBusy) setBulkRemind(null); }}
          onConfirm={async () => {
            setRemindBusy(true);
            try {
              const r = await fetch("/api/fees/remind", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ids: bulkRemind.ids }),
              });
              const j = await r.json();
              if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
              flash(`${bulkRemind.label} · ${j.sent.length} reminder${j.sent.length === 1 ? "" : "s"} sent`, "ok");
              await refresh?.();
            } catch (e) { flash(e.message, "bad"); }
            finally { setRemindBusy(false); setBulkRemind(null); }
          }}
        />
      )}

      {pendingClassPick && (
        <div onClick={() => setPendingClassPick(null)} style={{ position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)", display: "grid", placeItems: "center", zIndex: 300, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 480, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
            <div className="card-head">
              <div>
                <div className="card-title">Pending · {pendingClassPick.termLabel} — by class</div>
                <div className="card-sub">Download each class separately ({pendingClassPick.termLabel} + Admission + Transport)</div>
              </div>
              <button className="icon-btn" onClick={() => setPendingClassPick(null)}><Icon name="x" size={14} /></button>
            </div>
            <div style={{ padding: "6px 10px 4px", display: "flex", flexDirection: "column", gap: 6 }}>
              {pendingClassPick.classKeys.map((k) => {
                const list = pendingClassPick.byClass[k];
                const total = list.reduce((a, s) => a + s.term + s.admission + s.transport, 0);
                return (
                  <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 8px", borderRadius: 8, background: "var(--card-2)" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{formatClassLabel(k)}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-4)" }}>{list.length} student{list.length === 1 ? "" : "s"} · {money(total)} due</div>
                    </div>
                    <button className="btn sm accent" onClick={() => printPendingClasses(pendingClassPick.termLabel, [{ clsKey: k, list }])}>
                      <Icon name="download" size={11} />Download
                    </button>
                  </div>
                );
              })}
            </div>
            <div style={{ padding: "10px 14px", borderTop: "1px solid var(--rule)", display: "flex", justifyContent: "space-between", gap: 8 }}>
              <button className="btn" onClick={() => printPendingClasses(pendingClassPick.termLabel, pendingClassPick.classKeys.map((k) => ({ clsKey: k, list: pendingClassPick.byClass[k] })))}>
                <Icon name="download" size={12} />All classes (one file)
              </button>
              <button className="btn ghost" onClick={() => setPendingClassPick(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Small reusable Yes/No confirmation modal (styled, matches the app).
function ConfirmModal({ title, message, confirmLabel = "Yes", cancelLabel = "No", tone = "accent", busy = false, onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !busy) onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);
  return (
    <div onClick={() => { if (!busy) onCancel(); }} style={{ position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)", display: "grid", placeItems: "center", zIndex: 300, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 400 }}>
        <div className="card-head">
          <div><div className="card-title">{title}</div></div>
          <button type="button" className="icon-btn" onClick={onCancel} disabled={busy}><Icon name="x" size={14} /></button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>{message}</div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
            <button type="button" className={`btn ${tone}`} onClick={onConfirm} disabled={busy}>
              <Icon name="check" size={13} />{busy ? "Sending…" : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- parent fees summary (read-only) ----------
// Shows the same financial picture as the staff "Collect fee" panel —
// pending balance broken into term/activity/late, plus a list of past
// receipts — but with no payment controls. Parents pay at the school
// office; this card is purely informational.
// Fee collection at a glance — today's & this month's takings, the running
// total, and a day-wise / month-wise breakdown. Computed from paid receipts
// (recent_fees) using each receipt's payment timestamp (paidAt).
function CollectionSummary({ recent }) {
  const [today, setToday] = useState("");
  const [monthKey, setMonthKey] = useState("");
  const [view, setView] = useState("day"); // "day" | "month"
  const [detail, setDetail] = useState(null); // { key } — day/month whose receipts to list
  useEffect(() => {
    const d = new Date();
    setToday(d.toISOString().slice(0, 10));
    setMonthKey(d.toISOString().slice(0, 7));
  }, []);

  const list = Array.isArray(recent) ? recent : [];
  const dateOf = (f) => String(f.paidAt || f.paid_at || "").slice(0, 10);
  const amt = (f) => Number(f.amount) || 0;
  const sum = (arr) => arr.reduce((a, f) => a + amt(f), 0);
  const dated = list.filter((f) => dateOf(f)); // receipts that carry a date

  const todayList = dated.filter((f) => dateOf(f) === today);
  const monthList = dated.filter((f) => dateOf(f).slice(0, 7) === monthKey);

  // Breakdown grouped by day or month, newest first.
  const byKey = {};
  for (const f of dated) {
    const k = view === "day" ? dateOf(f) : dateOf(f).slice(0, 7);
    if (!byKey[k]) byKey[k] = { amount: 0, count: 0 };
    byKey[k].amount += amt(f);
    byKey[k].count += 1;
  }
  const rows = Object.entries(byKey)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, view === "day" ? 14 : 12);

  const fmtKey = (k) => {
    if (view === "day") {
      const d = new Date(`${k}T00:00:00`);
      return isNaN(d.getTime()) ? k : d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
    }
    const [y, m] = k.split("-");
    const d = new Date(Number(y), Number(m) - 1, 1);
    return isNaN(d.getTime()) ? k : d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  };

  const Tile = ({ label, amount, count, tone }) => (
    <div style={{ flex: "1 1 150px", padding: "12px 14px", borderRight: "1px solid var(--rule)" }}>
      <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: tone || "var(--ink)", marginTop: 2 }}>{money(amount)}</div>
      <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 1 }}>{count} receipt{count === 1 ? "" : "s"}</div>
    </div>
  );

  // Receipts for the clicked day/month (for the details popup).
  const detailItems = detail
    ? dated
        .filter((f) => (view === "day" ? dateOf(f) : dateOf(f).slice(0, 7)) === detail.key)
        .sort((a, b) => (String(a.paidAt || a.paid_at) < String(b.paidAt || b.paid_at) ? 1 : -1))
    : [];

  return (
    <>
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Fee collection</div>
          <div className="card-sub">Daily · monthly · total — from recorded payments</div>
        </div>
        <div className="card-actions">
          <div className="segmented">
            <button className={view === "day" ? "active" : ""} onClick={() => setView("day")}>Day-wise</button>
            <button className={view === "month" ? "active" : ""} onClick={() => setView("month")}>Month-wise</button>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", borderBottom: "1px solid var(--rule)" }}>
        <Tile label="Today" amount={sum(todayList)} count={todayList.length} tone="var(--ok)" />
        <Tile label="This month" amount={sum(monthList)} count={monthList.length} tone="var(--accent-2)" />
        <Tile label="Total collected" amount={sum(list)} count={list.length} />
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th>{view === "day" ? "Date" : "Month"}</th>
              <th className="num">Receipts</th>
              <th className="num">Amount collected</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={3} className="empty">No recorded payments yet.</td></tr>
            )}
            {rows.map(([k, v]) => (
              <tr key={k} onClick={() => setDetail({ key: k })} style={{ cursor: "pointer" }} title="View the receipts for this period">
                <td>{fmtKey(k)}{view === "day" && k === today ? <span className="chip ok" style={{ marginLeft: 6, fontSize: 9.5 }}>Today</span> : null}</td>
                <td className="num" style={{ color: "var(--ink-3)" }}>{v.count}</td>
                <td className="num" style={{ fontWeight: 600 }}>{money(v.amount)} <Icon name="chevronRight" size={11} style={{ opacity: 0.4, verticalAlign: "middle" }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>

    {detail && (
      <div onClick={() => setDetail(null)} style={{ position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)", display: "grid", placeItems: "center", zIndex: 260, padding: 16 }}>
        <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 640, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
          <div className="card-head">
            <div>
              <div className="card-title">Collection · {fmtKey(detail.key)}</div>
              <div className="card-sub">{detailItems.length} receipt{detailItems.length === 1 ? "" : "s"} · {money(detailItems.reduce((a, f) => a + amt(f), 0))}</div>
            </div>
            <button className="icon-btn" onClick={() => setDetail(null)}><Icon name="x" size={14} /></button>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>#</th>
                  <th>Student</th>
                  <th>Class</th>
                  <th>Fee type</th>
                  <th>Method</th>
                  <th className="num">Amount</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {detailItems.length === 0 && <tr><td colSpan={7} className="empty">No receipts.</td></tr>}
                {detailItems.map((f, i) => (
                  <tr key={f.id || i}>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)" }}>{i + 1}</td>
                    <td style={{ fontSize: 12.5, fontWeight: 500 }}>{f.name || "—"}</td>
                    <td>{f.cls ? <span className="chip">{formatClassLabel(f.cls)}</span> : "—"}</td>
                    <td><span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent-2)" }}>{feeTypeLabel(f.feeType)}</span></td>
                    <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{f.method || "—"}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{money(f.amount || 0)}</td>
                    <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{formatFeeWhen({ ...f, status: "paid" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function ParentFeesSummary({ scopedPending, scopedRecent, child, openReceipt, onRefresh }) {
  const totalPending = scopedPending.reduce((a, f) => a + (f.amount || 0), 0);
  const overdueChip  = scopedPending.some((f) => f.overdue);
  const totalPaid    = scopedRecent.reduce((a, f) => a + (f.amount || 0), 0);
  const initials = (n) => (n || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const [payingOrder, setPayingOrder] = useState(null);
  const [busy, setBusy] = useState(false);

  async function startOnlinePayment() {
    if (!child || totalPending === 0) return;
    setBusy(true);
    try {
      const r = await fetch("/api/fees/pay-online", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: child.id, amount: scopedPending[0].amount, intent: "create" }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Could not start payment");
      setPayingOrder(j.order);
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  async function confirmOnlinePayment() {
    if (!payingOrder) return;
    setBusy(true);
    try {
      const r = await fetch("/api/fees/pay-online", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: payingOrder.studentId, amount: payingOrder.amount, intent: "verify" }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Verify failed");
      setPayingOrder(null);
      await onRefresh?.();
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div
      className="card col-4"
      style={{
        position: "sticky",
        top: 68,
        alignSelf: "start",
        maxHeight: "calc(100vh - 80px)",
        overflowY: "auto",
        zIndex: 4,
      }}
    >
      <div className="card-head">
        <div>
          <div className="card-title">{child?.name ? `${child.name.split(" ")[0]}'s fees` : "Fees · summary"}</div>
          <div className="card-sub">Read-only · payments are recorded by the school office</div>
        </div>
      </div>
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {child && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, background: "var(--card-2)", border: "1px solid var(--rule)", borderRadius: 10 }}>
            <div style={{ width: 38, height: 38, borderRadius: 9, background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "var(--accent-ink)", display: "grid", placeItems: "center", fontWeight: 600, fontSize: 13 }}>
              {initials(child.name)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{child.name}</div>
              <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{formatClassLabel(child.cls)} · {child.id}</div>
            </div>
          </div>
        )}

        <div style={{ background: "var(--card-2)", border: "1px solid var(--rule)", borderRadius: 10, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Outstanding</span>
            <span className="mono" style={{ fontSize: 20, fontWeight: 500, color: totalPending > 0 ? "var(--ink)" : "var(--ok)" }}>
              {totalPending > 0 ? `₹${totalPending.toLocaleString("en-IN")}` : "All clear"}
            </span>
          </div>
          {totalPending > 0 && (
            <>
              <div style={{ marginTop: 8, fontSize: 11.5, color: overdueChip ? "var(--bad)" : "var(--warn)" }}>
                {overdueChip ? "One or more items overdue" : "Pending — settle online or at the office"}
              </div>
              <button
                className="btn accent"
                style={{ marginTop: 10, width: "100%", justifyContent: "center" }}
                onClick={startOnlinePayment}
                disabled={busy}
              >
                <Icon name="fees" size={12} />Pay online (UPI / Razorpay)
              </button>
            </>
          )}
        </div>

        <div style={{ background: "var(--card-2)", border: "1px solid var(--rule)", borderRadius: 10, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Paid this term</span>
            <span className="mono" style={{ fontSize: 14, fontWeight: 500, color: "var(--ok)" }}>₹{totalPaid.toLocaleString("en-IN")}</span>
          </div>
          {scopedRecent.length === 0 ? (
            <div style={{ fontSize: 11.5, color: "var(--ink-4)" }}>No receipts on file yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {scopedRecent.slice(0, 4).map((r) => (
                <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5 }}>
                  <span style={{ color: "var(--ink-3)" }}>
                    {r.method} · {formatFeeWhen(r)} {r.status === "partial" && <span style={{ color: "var(--warn)" }}>· partial</span>}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span className="mono">₹{(r.amount || 0).toLocaleString("en-IN")}</span>
                    <button className="btn sm ghost" style={{ height: 22, padding: "0 6px", fontSize: 10.5 }} onClick={() => openReceipt(r)}>Receipt</button>
                  </span>
                </div>
              ))}
              {scopedRecent.length > 4 && (
                <div style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 4 }}>+{scopedRecent.length - 4} more in the table on the left</div>
              )}
            </div>
          )}
        </div>

        <div style={{ fontSize: 11, color: "var(--ink-4)", lineHeight: 1.5 }}>
          You can pay online from this app, or visit the school office during working hours. Receipts appear here as soon as payment is captured.
        </div>
      </div>

      {payingOrder && (
        <PayOnlineModal order={payingOrder} busy={busy} onClose={() => setPayingOrder(null)} onConfirm={confirmOnlinePayment} />
      )}
    </div>
  );
}

function PayOnlineModal({ order, busy, onClose, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 460 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Confirm online payment</div>
            <div className="card-sub">Order {order.orderId} · {order.gateway}</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ background: "var(--bg-2)", padding: 16, borderRadius: 10, textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "var(--ink-4)", textTransform: "uppercase", letterSpacing: 0.5 }}>Amount</div>
            <div style={{ fontSize: 28, fontWeight: 600, color: "var(--ink)" }}>₹{order.amount.toLocaleString("en-IN")}</div>
            <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 4 }}>For {order.studentName} · {formatClassLabel(order.cls)}</div>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.5 }}>
            In production this opens the Razorpay / PhonePe checkout. For this demo, click <b>Confirm payment</b> to simulate
            a successful capture — the receipt will be generated and the fee marked paid.
          </div>
          <a className="btn" href={order.payUrl} target="_blank" rel="noreferrer" style={{ justifyContent: "center" }}>
            <Icon name="upload" size={12} />Open UPI app
          </a>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn accent" onClick={onConfirm} disabled={busy}>
              <Icon name="check" size={13} />{busy ? "Verifying…" : "Confirm payment"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Confirm-and-delete dialog for a single receipt row. The endpoint
// itself enforces the role gate (admin / principal / school_accountant
// only) — this dialog is the user-facing "are you sure?" step. The
// modal is deliberately blunt about the side effect: the receipt
// disappears from history but the pending balance is NOT auto-restored
// (mirrors how the API behaves; matches the user's stated intent of
// "just delete the history alone").
function DeleteReceiptModal({ receipt, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };
  const amt = Number(receipt?.amount) || 0;
  return (
    <div onClick={onCancel} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.55)",
      display: "grid", placeItems: "center", zIndex: 300, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 440 }}>
        <div style={{ padding: "18px 18px 6px", display: "flex", alignItems: "flex-start", gap: 12 }}>
          <span style={{
            width: 36, height: 36, borderRadius: 9,
            background: "var(--bad-soft, #fbe1d8)", color: "var(--bad, #b13c1c)",
            display: "grid", placeItems: "center", flexShrink: 0,
          }}>
            <Icon name="warning" size={16} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: "var(--ink)", lineHeight: 1.3 }}>
              Delete this receipt?
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.55 }}>
              <div><strong>{receipt.name}</strong> · {formatClassLabel(receipt.cls)} · {receipt.id}</div>
              <div style={{ marginTop: 4 }}>
                ₹{amt.toLocaleString("en-IN")} · {receipt.method || "—"} · {receipt.time || ""}
              </div>
            </div>
            <div style={{
              marginTop: 12, padding: "10px 12px",
              background: "var(--warn-soft, #fff4e2)",
              border: "1px solid var(--warn, #d4944e)",
              borderRadius: 7, fontSize: 11.5, color: "var(--ink-2)", lineHeight: 1.5,
            }}>
              <strong>Heads up:</strong> the receipt disappears from history and from the audit-ready ledger. The student's pending balance is <em>not</em> automatically reopened — if they actually owe this amount, raise it back via <b>Edit fees</b> after this delete.
            </div>
          </div>
        </div>
        <div style={{ padding: "12px 18px 18px", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn"
            onClick={submit}
            disabled={busy}
            style={{ background: "var(--bad)", borderColor: "var(--bad)", color: "#fff" }}
          >
            <Icon name="x" size={13} />{busy ? "Deleting…" : "Delete receipt"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Staff-only modal to edit the outstanding amount of a pending fee.
// Set to 0 to drop the pending row entirely (e.g. full waiver/scholarship).
function EditFeeAmountModal({ fee, onClose, onSave }) {
  const initial = String(fee.amount ?? 0);
  const [val, setVal] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const num = val === "" ? null : Math.floor(Number(val));
  const valid = num !== null && Number.isFinite(num) && num >= 0;
  const submit = async (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try { await onSave(num); } finally { setBusy(false); }
  };
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 420 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Edit fee amount</div>
            <div className="card-sub">{fee.name} · {formatClassLabel(fee.cls)} · {fee.id}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>
            Update the outstanding balance for this term. Use <b>0</b> to waive the fee entirely (the pending row will be removed).
          </div>
          <div style={{
            display: "flex", alignItems: "center", height: 38,
            border: "1px solid", borderColor: valid ? "var(--rule)" : "var(--bad)",
            borderRadius: 9, background: "var(--card-2)", overflow: "hidden",
          }}>
            <span style={{
              display: "inline-flex", alignItems: "center", padding: "0 12px",
              background: "var(--bg-2)", borderRight: "1px solid var(--rule)",
              fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--ink-3)",
            }}>₹</span>
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              value={val}
              onChange={(e) => setVal(e.target.value.replace(/\D/g, ""))}
              style={{
                flex: 1, height: "100%", border: 0, background: "transparent",
                outline: "none", padding: "0 12px",
                fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--ink)",
              }}
            />
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
            Was ₹{Number(fee.amount || 0).toLocaleString("en-IN")}
            {valid && num !== Number(fee.amount || 0) && (
              <> · new outstanding ₹{num.toLocaleString("en-IN")}</>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn accent" disabled={!valid || busy}>
              <Icon name="check" size={13} />{busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// Staff modal for adding a brand-new pending-fee row of any FEE_TYPES bucket
// (Application, Kit, ECA, Uniform, Term I/II/III, Van, STEM, Annual Day).
// Lets the school collect more than one fee per student per term, each
// printed on its own receipt.
// ---------- fee structure editor (admin / principal / school accountant) ----------
// Per-class amounts for Term I/II/III + Application + Van. These drive the
// term-wise records created for every new student at admission.
function FeeStructureModal({ classes, onClose, onSaved }) {
  const FIELDS = [
    { key: "term1", label: "Term I" },
    { key: "term2", label: "Term II" },
    { key: "term3", label: "Term III" },
    { key: "application", label: "Admission" },
    { key: "transport", label: "Transport" },
  ];
  const classNums = useMemo(() => {
    const set = new Set();
    (classes || []).forEach((c) => { const n = Number(c.n); if (n) set.add(n); });
    return [...set].sort((a, b) => a - b);
  }, [classes]);

  const [rows, setRows] = useState({});   // { [n]: { term1, term2, term3, application, van } }
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/fees/structure");
        const j = await r.json().catch(() => ({}));
        const perClass = (j?.ok && j.structure?.perClass) || {};
        if (alive) setRows(perClass);
      } catch {}
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  const setCell = (n, key, val) => setRows((r) => ({ ...r, [n]: { ...(r[n] || {}), [key]: val } }));

  async function save() {
    setBusy(true); setErr("");
    const perClass = {};
    for (const n of classNums) {
      const row = rows[n] || {};
      perClass[String(n)] = {
        term1: Math.max(0, Math.floor(Number(row.term1) || 0)),
        term2: Math.max(0, Math.floor(Number(row.term2) || 0)),
        term3: Math.max(0, Math.floor(Number(row.term3) || 0)),
        application: Math.max(0, Math.floor(Number(row.application) || 0)),
        transport: Math.max(0, Math.floor(Number(row.transport) || 0)),
      };
    }
    try {
      const r = await fetch("/api/fees/structure", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ structure: { perClass } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to save");
      onSaved?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)", display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 640, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div>
            <div className="card-title">Fee structure</div>
            <div className="card-sub">Per-class amounts (₹) · used to record Term I/II/III, Application and Van fees for every new student</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {loading ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--ink-4)", fontSize: 12 }}>Loading…</div>
          ) : classNums.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--ink-4)", fontSize: 12 }}>No classes on the roster yet.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 560 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "6px 8px", color: "var(--ink-3)", fontWeight: 500 }}>Class</th>
                    {FIELDS.map((f) => (
                      <th key={f.key} style={{ textAlign: "right", padding: "6px 8px", color: "var(--ink-3)", fontWeight: 500 }}>{f.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {classNums.map((n) => (
                    <tr key={n} style={{ borderTop: "1px solid var(--rule-2)" }}>
                      <td style={{ padding: "6px 8px", whiteSpace: "nowrap", fontWeight: 600 }}>{formatClassLabel(`${n}-A`)}</td>
                      {FIELDS.map((f) => (
                        <td key={f.key} style={{ padding: "4px 4px" }}>
                          <input
                            className="input"
                            type="number"
                            min="0"
                            inputMode="numeric"
                            value={rows[n]?.[f.key] ?? ""}
                            onChange={(e) => setCell(n, f.key, e.target.value)}
                            style={{ width: 90, textAlign: "right" }}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
            Term I/II/III are recorded for every student on admission. Application is added when its amount is above ₹0; Van is added only for students who have a transport route.
          </div>

          {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="btn accent" onClick={save} disabled={busy || loading}>
              <Icon name="check" size={13} />{busy ? "Saving…" : "Save structure"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddFeeItemModal({ students, onClose, onSave }) {
  const [studentId, setStudentId] = useState(students[0]?.id || "");
  const [feeType, setFeeType]     = useState(FEE_TYPES[0].key);
  const [amount, setAmount]       = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState("");
  // Quick filter so the picker stays usable when the school has hundreds of
  // students. Matches name + reg id (case-insensitive substring).
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return students;
    return students.filter((s) =>
      `${s.name} ${s.id} ${s.cls} ${formatClassLabel(s.cls)}`.toLowerCase().includes(needle)
    );
  }, [students, q]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const num = amount === "" ? 0 : Math.floor(Number(amount));
  const valid = !!studentId && num > 0;

  async function submit(e) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true); setErr("");
    try {
      await onSave({ studentId, feeType, amount: num });
    } catch (ex) { setErr(ex.message || String(ex)); setBusy(false); }
  }

  const selectedStudent = students.find((s) => s.id === studentId);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
    }}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 480, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div>
            <div className="card-title">Add fee</div>
            <div className="card-sub">Create a new pending-fee item · pick the student, type, and amount</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 5 }}>Student *</div>
            <input
              className="input"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, reg ID, or class…"
              style={{ marginBottom: 6 }}
            />
            <div style={{
              border: "1px solid var(--rule)",
              borderRadius: 9,
              maxHeight: 200,
              overflowY: "auto",
              background: "var(--card-2)",
            }}>
              {filtered.length === 0 ? (
                <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--ink-4)", textAlign: "center" }}>
                  No students match "{q}"
                </div>
              ) : filtered.map((s) => {
                const active = s.id === studentId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setStudentId(s.id)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      border: 0,
                      borderBottom: "1px solid var(--rule-2)",
                      background: active ? "var(--accent-soft)" : "transparent",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span style={{
                      width: 26, height: 26, borderRadius: "50%",
                      background: active ? "var(--accent)" : "var(--bg-2)",
                      color: active ? "#fff" : "var(--ink-2)",
                      display: "grid", placeItems: "center",
                      fontWeight: 600, fontSize: 11, flexShrink: 0,
                    }}>
                      {s.name.split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase()}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 12.5, fontWeight: 500, color: active ? "var(--accent-2)" : "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {s.name}
                      </span>
                      <span style={{ display: "block", fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>
                        {s.id} · {formatClassLabel(s.cls)}
                      </span>
                    </span>
                    {active && <Icon name="check" size={13} />}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 5 }}>Fee type *</div>
              <select
                className="select"
                value={feeType}
                onChange={(e) => setFeeType(e.target.value)}
                style={{ width: "100%" }}
              >
                {FEE_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 5 }}>Amount (₹) *</div>
              <div style={{
                display: "flex", alignItems: "center", height: 38,
                border: `1px solid ${num > 0 ? "var(--rule)" : "var(--rule-2)"}`,
                borderRadius: 9, background: "var(--card-2)", overflow: "hidden",
              }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", padding: "0 10px",
                  background: "var(--bg-2)", borderRight: "1px solid var(--rule)",
                  fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--ink-3)",
                }}>₹</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
                  placeholder="0"
                  style={{
                    flex: 1, height: "100%", border: 0, background: "transparent",
                    outline: "none", padding: "0 10px",
                    fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--ink)",
                  }}
                />
              </div>
            </div>
          </div>

          {selectedStudent && (
            <div style={{ fontSize: 11.5, color: "var(--ink-3)", padding: "8px 10px", background: "var(--bg-2)", borderRadius: 7 }}>
              Adding <b>{feeTypeLabel(feeType)}</b> of <span className="mono">₹{num.toLocaleString("en-IN")}</span> for <b>{selectedStudent.name}</b> ({formatClassLabel(selectedStudent.cls)}).
              {" "}If a {feeTypeLabel(feeType)} row already exists for this student, it will be replaced.
            </div>
          )}

          {err && (
            <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn accent" disabled={!valid || busy}>
              <Icon name="check" size={13} />{busy ? "Saving…" : "Add fee"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// ---------- helper components ----------
function Toast({ toast }) {
  if (!toast) return null;
  const bg = toast.tone === "bad" ? "var(--bad)" : toast.tone === "warn" ? "var(--warn)" : "var(--ok)";
  return (
    <div
      style={{
        position: "fixed",
        top: 76,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 300,
        background: bg,
        color: "#fff",
        padding: "10px 18px",
        borderRadius: 999,
        fontSize: 12.5,
        fontWeight: 500,
        boxShadow: "var(--shadow-lg)",
      }}
    >
      {toast.msg}
    </div>
  );
}

function CollectMenu({ items, onPick, onClose }) {
  useEffect(() => {
    const onDoc = (e) => {
      if (!e.target.closest(".collect-menu") && !e.target.closest(".btn")) onClose();
    };
    setTimeout(() => document.addEventListener("click", onDoc), 0);
    return () => document.removeEventListener("click", onDoc);
  }, [onClose]);

  return (
    <div
      className="collect-menu"
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        right: 0,
        zIndex: 60,
        background: "var(--card)",
        border: "1px solid var(--rule)",
        borderRadius: 12,
        boxShadow: "var(--shadow-lg)",
        padding: 6,
        width: 320,
        maxHeight: 380,
        overflowY: "auto",
      }}
    >
      <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", padding: "8px 10px 6px", display: "flex", alignItems: "center", gap: 8 }}>
        Pending fees · pick a student
        <span className="mono" style={{ marginLeft: "auto", color: "var(--ink-4)" }}>{items.length}</span>
      </div>
      {items.length === 0 && <div className="empty" style={{ padding: 16 }}>No pending fees.</div>}
      {items.map((f) => (
        <button
          key={f.id}
          onClick={() => onPick(f)}
          className="btn ghost"
          style={{
            width: "100%",
            justifyContent: "flex-start",
            height: "auto",
            padding: "10px 10px",
            gap: 10,
            display: "flex",
            alignItems: "center",
          }}
        >
          <span style={{
            width: 30, height: 30, borderRadius: "50%",
            background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
            color: "#fff", display: "grid", placeItems: "center",
            fontWeight: 600, fontSize: 11.5, flexShrink: 0,
          }}>
            {f.name.split(" ").map((n) => n[0]).join("")}
          </span>
          <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
            <span style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{f.name}</span>
            <span style={{ display: "block", fontSize: 11, color: "var(--ink-3)" }}>{feeTypeLabel(f.feeType)} · {formatClassLabel(f.cls)} · due {f.due}</span>
          </span>
          <span className="mono" style={{ fontSize: 12, fontWeight: 500, color: f.overdue ? "var(--bad)" : "var(--ink-2)" }}>
            ₹{f.amount.toLocaleString("en-IN")}
          </span>
        </button>
      ))}
    </div>
  );
}

function FilterMenu({ value, classes = [], onPick, onClose }) {
  // close on outside click
  useEffect(() => {
    const onDoc = (e) => {
      if (!e.target.closest(".filter-menu") && !e.target.closest(".btn")) onClose();
    };
    setTimeout(() => document.addEventListener("click", onDoc), 0);
    return () => document.removeEventListener("click", onDoc);
  }, [onClose]);

  // Build options from the real class roster (mirrors the Students filter).
  // key === stringified class number ("1"-"12", "13"=PRE-MONT, "14"=MONT I,
  // "15"=MONT II); label uses formatClassLabel so PRE-MONT / MONT I / MONT II
  // / Class XII all render correctly. Fallback to 1-12 if CLASSES is empty
  // so the filter never disappears entirely.
  const opts = (() => {
    if (classes.length) {
      return [{ key: "All", label: "All" }, ...classes.map((c) => ({
        key: String(c.n),
        label: c.label || formatClassLabel(String(c.n)),
      }))];
    }
    return [
      { key: "All", label: "All" },
      ...Array.from({ length: 12 }, (_, i) => ({
        key: String(i + 1),
        label: formatClassLabel(String(i + 1)),
      })),
    ];
  })();
  return (
    <div
      className="filter-menu"
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        right: 0,
        zIndex: 50,
        background: "var(--card)",
        border: "1px solid var(--rule)",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        padding: 6,
        minWidth: 160,
        maxHeight: 320,
        overflowY: "auto",
      }}
    >
      <div style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", padding: "6px 10px 4px" }}>
        Filter by class
      </div>
      {opts.map((o) => (
        <button
          key={o.key}
          onClick={() => onPick(o.key)}
          className="btn ghost"
          style={{
            width: "100%",
            justifyContent: "flex-start",
            height: 30,
            padding: "0 10px",
            fontSize: 12.5,
            background: value === o.key ? "var(--accent-soft)" : "transparent",
            color: value === o.key ? "var(--accent-2)" : "var(--ink)",
            fontWeight: value === o.key ? 500 : 400,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Preset menu for the "Generate report" button. One-click scoped PDF reports —
// full register, by payment status (paid / not paid), or by fee type
// (Term I/II/III, Admission, Transport). Each item calls back with a filter
// preset consumed by generateReport().
function ReportMenu({ onFull, onPick, onPending, onPendingClass, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const byPayment = [
    { label: "Paid — collected",       sub: "All fee types",  preset: { statusKey: "paid",   label: "Paid" } },
    { label: "Not paid — outstanding", sub: "All fee types",  preset: { statusKey: "unpaid", label: "Not paid" } },
  ];
  // Each fee type can be pulled as All / Paid / Not-paid separately.
  const byType = [
    { key: "term1",       label: "Term I" },
    { key: "term2",       label: "Term II" },
    { key: "term3",       label: "Term III" },
    { key: "application", label: "Admission fees" },
    { key: "transport",   label: "Transport" },
  ];
  const terms = [
    { key: "term1", label: "Term I" },
    { key: "term2", label: "Term II" },
    { key: "term3", label: "Term III" },
  ];

  // Section wrapper — a titled block within the popup grid.
  const Block = ({ title, hint, children, span }) => (
    <section style={{ gridColumn: span ? "1 / -1" : "auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <h4 style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--ink-3)" }}>{title}</h4>
        {hint && <span style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{hint}</span>}
      </div>
      {children}
    </section>
  );

  // Full-width tappable card (used for "Full register" + pending lists).
  const CardBtn = ({ label, sub, onClick }) => (
    <button
      onClick={onClick}
      className="btn ghost"
      style={{ width: "100%", justifyContent: "flex-start", flexDirection: "column", alignItems: "flex-start", gap: 1, height: "auto", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--rule)", background: "var(--card-2)" }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>{label}</span>
      {sub && <span style={{ fontSize: 10.5, color: "var(--ink-4)", fontWeight: 400 }}>{sub}</span>}
    </button>
  );

  const Chip = ({ label, tone, onClick }) => (
    <button
      onClick={onClick}
      className="btn ghost"
      style={{ height: 24, padding: "0 9px", fontSize: 11, fontWeight: 600, borderRadius: 6, color: tone || "var(--ink-2)", background: "var(--card)", border: "1px solid var(--rule)" }}
    >
      {label}
    </button>
  );
  const TypeRow = ({ t }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 0", borderBottom: "1px solid var(--rule)" }}>
      <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.label}</span>
      <Chip label="All" onClick={() => onPick({ feeTypeKey: t.key, label: t.label })} />
      <Chip label="Paid" tone="var(--ok)" onClick={() => onPick({ feeTypeKey: t.key, statusKey: "paid", label: `${t.label} · Paid` })} />
      <Chip label="Unpaid" tone="var(--err, #b13c1c)" onClick={() => onPick({ feeTypeKey: t.key, statusKey: "unpaid", label: `${t.label} · Not paid` })} />
    </div>
  );

  return (
    <div
      className="report-menu-overlay"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)", display: "grid", placeItems: "center", zIndex: 300, padding: 16 }}
    >
      <div
        className="report-menu"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 720,
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          background: "var(--card)",
          border: "1px solid var(--rule)",
          borderRadius: 14,
          boxShadow: "var(--shadow-lg)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--rule)", position: "sticky", top: 0, background: "var(--card)", zIndex: 1, borderRadius: "14px 14px 0 0" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>Generate report</div>
            <div style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Pick a slice to export as PDF</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>

        {/* Body grid — everything visible, aligned in two columns */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 18, padding: 18 }}>
          <Block title="Whole register" span>
            <CardBtn label="Full register — everything" sub="All students · all fee types · paid & pending" onClick={onFull} />
          </Block>

          <Block title="By payment" hint="all fee types">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {byPayment.map((o) => <CardBtn key={o.label} label={o.label} sub={o.sub} onClick={() => onPick(o.preset)} />)}
            </div>
          </Block>

          <Block title="By fee type" hint="All / Paid / Unpaid">
            <div>
              {byType.map((t) => <TypeRow key={t.key} t={t} />)}
            </div>
          </Block>

          <Block title="Pending · student-wise" hint="Term + Admission + Transport">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {terms.map((t) => (
                <CardBtn key={t.key} label={t.label} sub="One row per student" onClick={() => onPending?.(t.key, t.label)} />
              ))}
            </div>
          </Block>

          <Block title="Pending · class-wise" hint="download each class separately">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {terms.map((t) => (
                <CardBtn key={t.key} label={t.label} sub="Grouped by class" onClick={() => onPendingClass?.(t.key, t.label)} />
              ))}
            </div>
          </Block>
        </div>
      </div>
    </div>
  );
}

// Customized bulk-reminder menu. Each row shows the preset label + how many
// parents it currently targets, so admin sees the reach before sending. Rows
// with no pending parents are disabled. Group rows are section headers.
function RemindMenu({ rows, onPick, onClose }) {
  useEffect(() => {
    const onDoc = (e) => {
      if (!e.target.closest(".remind-menu") && !e.target.closest(".btn")) onClose();
    };
    setTimeout(() => document.addEventListener("click", onDoc), 0);
    return () => document.removeEventListener("click", onDoc);
  }, [onClose]);

  return (
    <div
      className="remind-menu"
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        right: 0,
        zIndex: 50,
        background: "var(--card)",
        border: "1px solid var(--rule)",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        padding: 6,
        minWidth: 260,
        maxHeight: 420,
        overflowY: "auto",
      }}
    >
      {rows.map((r, i) =>
        r.group ? (
          <div key={`g-${i}`} style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", padding: "8px 10px 4px" }}>
            {r.group}
          </div>
        ) : (
          <button
            key={r.label}
            onClick={() => onPick(r)}
            disabled={!r.ids || r.ids.length === 0}
            className="btn ghost"
            style={{
              width: "100%",
              justifyContent: "space-between",
              height: 34,
              padding: "0 10px",
              fontSize: 12.5,
              color: "var(--ink)",
              opacity: !r.ids || r.ids.length === 0 ? 0.45 : 1,
            }}
            title={!r.ids || r.ids.length === 0 ? "No parents pending" : `Remind ${r.students} parent${r.students === 1 ? "" : "s"}`}
          >
            <span>{r.label}</span>
            <span style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
              {r.students || 0}
            </span>
          </button>
        )
      )}
    </div>
  );
}
