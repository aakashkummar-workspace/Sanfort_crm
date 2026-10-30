"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { KPI, LineBarChart } from "../ui";
import { money, moneyK, formatClassLabel } from "@/lib/format";

// Fallback only. The canonical list lives in backend/lib/db.js and arrives
// via the bootstrap as EXPENSE_CATEGORY_CATALOG; this copy is what the
// dropdown falls back to if the payload predates that field. The two had
// already drifted — "Inventory purchase" existed server-side and not here.
const FALLBACK_EXPENSE_CATEGORIES = [
  "Salary", "Utilities", "Supplies", "Maintenance", "Transport", "Events",
  "Stationery", "Software", "Marketing", "Donation outflow", "Misc",
];
const PAYMENT_METHODS = ["Bank transfer", "UPI", "Cheque", "Cash", "Credit card"];

// Categories that represent a physical purchase. The "Also track in
// inventory" toggle on the Add Expense modal is shown only when the
// current category is one of these — salaries, utilities, software
// licences etc. shouldn't end up as inventory rows.
const PURCHASE_CATEGORIES = new Set([
  "Supplies", "Stationery", "Maintenance", "Inventory purchase",
]);

// Inventory category slugs. Mirrors what the Inventory screen accepts —
// kept short so the dropdown stays clean. "stationery" is the default
// when the expense category is Stationery; "asset" otherwise.
const INVENTORY_CATEGORIES = [
  { value: "stationery", label: "Stationery" },
  { value: "asset",      label: "Asset" },
  { value: "book",       label: "Book" },
  { value: "uniform",    label: "Uniform" },
  { value: "lab",        label: "Lab" },
  { value: "sports",     label: "Sports" },
];

function Toast({ msg, tone, onClose }) {
  if (!msg) return null;
  const bg = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--err, #b13c1c)" : "var(--ink)";
  return (
    <div onClick={onClose} role="status" style={{
      position: "fixed", bottom: 18, right: 18, zIndex: 9000,
      background: bg, color: "#fff", padding: "9px 14px", borderRadius: 8,
      fontSize: 12, fontWeight: 500, cursor: "pointer", maxWidth: 360,
      boxShadow: "0 12px 30px -16px rgba(0,0,0,0.35)",
    }}>{msg}</div>
  );
}

function ModalShell({ title, sub, onClose, children, width = 480 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: width, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div>
            <div className="card-title">{title}</div>
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{hint}</span>}
    </label>
  );
}

export default function ScreenMoney({ E, refresh, role }) {
  // Who can add / edit / remove expenses on this screen:
  //   - admin, principal                          — always allowed (top of the org)
  //   - school_accountant, trust_accountant       — finance is literally their role
  //   - custom roles                              — allowed when the admin ticked
  //     Edit on the "money" feature in the Custom Roles screen
  const canEdit = (() => {
    if (role === "admin" || role === "principal") return true;
    if (role === "school_accountant" || role === "trust_accountant") return true;
    const a = E?.ACCESS?.[role]?.money;
    return !!(a && a.canEdit);
  })();

  // Build live ledger entries from real fee receipts + expenses.
  const incomeRows = useMemo(() => (E.RECENT_FEES || []).map((f) => ({
    id: f.id || `RCP-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    date: f.time || "",
    desc: `Fee · ${f.name} · ${f.id || ""}`,
    scope: "school",
    category: "Fees",
    method: f.method || "—",
    amount: f.amount,
    in: true,
  })), [E.RECENT_FEES]);

  const donationRows = useMemo(() => (E.DONOR_RECEIPTS || []).map((r) => ({
    id: r.id, date: r.issuedAtLabel || r.issuedAt,
    desc: `Donation · ${r.donorName}${r.memo ? ` · ${r.memo}` : ""}`,
    scope: "trust",
    category: "Donation",
    method: r.method || "—",
    amount: r.amount,
    in: true,
  })), [E.DONOR_RECEIPTS]);

  // expense id → the finalised pay run that owns it. PAY_RUNS is admin-only
  // (dropped for every other role), so this map is simply empty elsewhere.
  const payrollExpenseIds = useMemo(() => {
    const m = new Map();
    for (const r of (E.PAY_RUNS || [])) {
      if (r.status === "finalised" && r.expenseId) m.set(r.expenseId, r);
    }
    return m;
  }, [E.PAY_RUNS]);

  const expenseRows = useMemo(() => (E.EXPENSES || []).map((e) => ({
    id: e.id, date: e.date,
    desc: `${e.category}${e.vendor ? ` · ${e.vendor}` : ""}${e.memo ? ` · ${e.memo}` : ""}`,
    scope: e.scope || "school",
    category: e.category,
    method: e.paymentMethod || "—",
    amount: e.amount,
    in: false,
    inventoryId: e.inventoryId || null,
    isInventoryPurchase: !!e.inventoryId || e.category === "Inventory purchase",
    // A finalised pay run stores this expense's id; deleting the row would
    // leave the run pointing at nothing. The server refuses it too — this
    // just stops the admin reaching for a button that can only fail.
    payrollRun: payrollExpenseIds.get(e.id) || null,
  })), [E.EXPENSES, payrollExpenseIds]);

  const TXNS = useMemo(() => [...incomeRows, ...donationRows, ...expenseRows], [incomeRows, donationRows, expenseRows]);

  // Trust Accountant is locked to the trust ledger — they never see the
  // school stream, so the picker is preset to "Trust only" and hidden
  // below. Other roles default to "Combined" and can switch freely.
  const isTrustOnly = role === "trust_accountant";
  const [accountScope, setAccountScope] = useState(isTrustOnly ? "Trust only" : "Combined");   // Combined | School only | Trust only
  const [ledgerType, setLedgerType] = useState("All");            // All | Collected | Spent
  const [methodFilter, setMethodFilter] = useState("All");
  const [spentFilter, setSpentFilter] = useState("All");          // All | Manual | Inventory
  const [showAddExpense, setShowAddExpense] = useState(false);
  // When a template tile is clicked, we pre-fill the Add Expense modal
  // with the template's defaults. `null` means a fresh blank modal.
  const [expensePrefill, setExpensePrefill] = useState(null);
  // The template-management modal (create/edit/delete tiles).
  const [editingTemplate, setEditingTemplate] = useState(null);  // null | {} | template-row
  const [toast, setToast] = useState(null);

  const showToast = (msg, tone) => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 3000);
  };

  const methods = useMemo(() => {
    const set = new Set(TXNS.map((t) => t.method).filter(Boolean));
    return ["All", ...Array.from(set)];
  }, [TXNS]);

  const scopeFilter = accountScope === "School only" ? "school" : accountScope === "Trust only" ? "trust" : null;

  const filteredTxns = useMemo(() => {
    return TXNS.filter((t) => {
      if (scopeFilter && t.scope !== scopeFilter) return false;
      if (ledgerType === "Collected" && !t.in) return false;
      if (ledgerType === "Spent"    &&  t.in) return false;
      if (methodFilter !== "All" && t.method !== methodFilter) return false;
      // Spent-side sub-filter: only applies when we're showing Spent rows.
      if (!t.in) {
        if (spentFilter === "Inventory" && !t.isInventoryPurchase) return false;
        if (spentFilter === "Manual"    &&  t.isInventoryPurchase) return false;
      }
      return true;
    });
  }, [TXNS, scopeFilter, ledgerType, methodFilter, spentFilter]);

  // KPIs respect the active scope filter.
  const incomeYtd  = filteredTxns.filter((t) => t.in).reduce((a, t) => a + (t.amount || 0), 0);
  const expenseYtd = filteredTxns.filter((t) => !t.in).reduce((a, t) => a + (t.amount || 0), 0);
  const pendingTotal = (E.PENDING_FEES || []).reduce((a, f) => a + (f.amount || 0), 0);

  async function submitExpense(payload) {
    const r = await fetch("/api/expenses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    setShowAddExpense(false);
    showToast(`Money spent · ${j.expense.id} added`, "ok");
    await refresh?.();
  }

  // Filter the templates we show in the Quick Templates strip to the
  // scope the admin is currently looking at. Combined view shows both.
  const visibleTemplates = useMemo(() => {
    const all = E.EXPENSE_TEMPLATES || [];
    if (accountScope === "School only") return all.filter((t) => t.scope === "school");
    if (accountScope === "Trust only")  return all.filter((t) => t.scope === "trust");
    return all;
  }, [E.EXPENSE_TEMPLATES, accountScope]);

  function openExpenseFromTemplate(tmpl) {
    setExpensePrefill(tmpl);
    setShowAddExpense(true);
  }

  async function saveTemplate(payload) {
    const isEdit = editingTemplate?.id;
    const url = isEdit ? `/api/expenses/templates/${editingTemplate.id}` : `/api/expenses/templates`;
    const r = await fetch(url, {
      method: isEdit ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    setEditingTemplate(null);
    showToast(isEdit ? "Template updated" : "Template saved", "ok");
    await refresh?.();
  }

  async function removeTemplate(tmpl) {
    if (!confirm(`Delete template "${tmpl.name}"?`)) return;
    try {
      const r = await fetch(`/api/expenses/templates/${tmpl.id}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      showToast("Template removed", "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
  }

  async function removeExpense(t) {
    if (!confirm(`Remove expense ${t.id}?`)) return;
    try {
      const r = await fetch("/api/expenses", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: t.id }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      showToast("Expense removed", "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
  }

  return (
    <div className="page">
      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />

      <div className="page-head">
        <div>
          <div className="page-title">
            {isTrustOnly ? <>Trust <span className="amber">expenses</span></>
                         : <>Money <span className="amber">Control</span></>}
          </div>
          <div className="page-sub">
            {isTrustOnly
              ? <>Trust ledger only · donations, donor receipts, trust expenses.</>
              : <>Two streams kept separate: <strong>Spent</strong> (manual expenses + inventory purchases) and <strong>Collected</strong> (student fees, donations, trust receipts).</>}
          </div>
        </div>
        <div className="page-actions">
          {!isTrustOnly && (
            <div className="segmented">
              {["Combined", "School only", "Trust only"].map((s) => (
                <button key={s} className={accountScope === s ? "active" : ""} onClick={() => setAccountScope(s)}>{s}</button>
              ))}
            </div>
          )}
          {canEdit && (
            <button className="btn accent" onClick={() => setShowAddExpense(true)}>
              <Icon name="plus" size={13} />Add money spent
            </button>
          )}
        </div>
      </div>

      {(() => {
        // Pre-compute popover breakdowns once so each KPI's `details` is
        // self-contained. Income / expense rollups are by category so the
        // popover answers "where does this money come from / go to?".
        const incomeRows  = filteredTxns.filter((t) =>  t.in);
        const expenseRows = filteredTxns.filter((t) => !t.in);

        const groupByCategory = (rows) => {
          const m = new Map();
          for (const t of rows) {
            const k = t.category || "Uncategorised";
            if (!m.has(k)) m.set(k, { category: k, total: 0, count: 0, rows: [] });
            const e = m.get(k);
            e.total += t.amount || 0;
            e.count += 1;
            e.rows.push(t);
          }
          // Newest entry first inside each category, biggest category first overall.
          for (const e of m.values()) {
            e.rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
          }
          return [...m.values()].sort((a, b) => b.total - a.total);
        };
        const incomeByCat  = groupByCategory(incomeRows);
        const expenseByCat = groupByCategory(expenseRows);

        const pendingRows = (E.PENDING_FEES || []).slice().sort((a, b) => (b.amount || 0) - (a.amount || 0));

        return (
          <div className="grid g-4" style={{ marginBottom: 14 }}>
            <KPI
              label="Money in · Collected"
              value={moneyK(incomeYtd)}
              sub={`${incomeRows.length} entr${incomeRows.length === 1 ? "y" : "ies"} · ${accountScope === "Combined" ? "all accounts" : accountScope}`}
              puck="mint" puckIcon="trending"
              details={{
                title: `Collected · ${money(incomeYtd)}`,
                sub: `Student fees + donations + trust receipts · grouped by source`,
                items: incomeByCat.length === 0
                  ? []
                  : incomeByCat.map((c) => ({
                      label: c.category,
                      value: money(c.total),
                      sub: `${c.count} entr${c.count === 1 ? "y" : "ies"} · click to expand`,
                      tone: "ok",
                      children: c.rows.map((r) => ({
                        label: r.desc || "—",
                        value: money(r.amount || 0),
                        sub: [r.date, r.method].filter(Boolean).join(" · "),
                      })),
                    })),
              }}
            />
            <KPI
              label="Money out · Spent"
              value={moneyK(expenseYtd)}
              sub={`${expenseRows.length} entr${expenseRows.length === 1 ? "y" : "ies"} · expenses + inventory purchases`}
              puck="peach" puckIcon="money"
              details={{
                title: `Spent · ${money(expenseYtd)}`,
                sub: `Manually-logged expenses + auto-cascaded inventory buys · grouped by category`,
                items: expenseByCat.length === 0
                  ? []
                  : expenseByCat.map((c) => ({
                      label: c.category,
                      value: money(c.total),
                      sub: `${c.count} entr${c.count === 1 ? "y" : "ies"} · click to expand`,
                      tone: "bad",
                      children: c.rows.map((r) => ({
                        label: r.desc || "—",
                        value: money(r.amount || 0),
                        sub: [r.date, r.method, r.isInventoryPurchase ? "from inventory" : ""].filter(Boolean).join(" · "),
                      })),
                    })),
              }}
            />
            <KPI
              label="Net flow"
              value={moneyK(incomeYtd - expenseYtd)}
              sub={incomeYtd >= expenseYtd ? "in surplus" : "in deficit"}
              puck={incomeYtd >= expenseYtd ? "mint" : "peach"}
              puckIcon={incomeYtd >= expenseYtd ? "trending" : "warning"}
              details={{
                title: `Net flow · ${money(incomeYtd - expenseYtd)}`,
                sub: `Collected ${money(incomeYtd)} − Spent ${money(expenseYtd)}`,
                items: [
                  {
                    label: "Collected",
                    value: money(incomeYtd),
                    sub: `${incomeRows.length} entr${incomeRows.length === 1 ? "y" : "ies"} · click to expand`,
                    tone: "ok",
                    // Each source category becomes a child row, and each
                    // category expands one level further to its individual
                    // transactions — same drill-down pattern as the
                    // dedicated Collected KPI.
                    children: incomeByCat.map((c) => ({
                      label: c.category,
                      value: money(c.total),
                      sub: `${c.count} entr${c.count === 1 ? "y" : "ies"}`,
                      tone: "ok",
                      children: c.rows.map((r) => ({
                        label: r.desc || "—",
                        value: money(r.amount || 0),
                        sub: [r.date, r.method].filter(Boolean).join(" · "),
                      })),
                    })),
                  },
                  {
                    label: "Spent",
                    value: money(expenseYtd),
                    sub: `${expenseRows.length} entr${expenseRows.length === 1 ? "y" : "ies"} · click to expand`,
                    tone: "bad",
                    children: expenseByCat.map((c) => ({
                      label: c.category,
                      value: money(c.total),
                      sub: `${c.count} entr${c.count === 1 ? "y" : "ies"}`,
                      tone: "bad",
                      children: c.rows.map((r) => ({
                        label: r.desc || "—",
                        value: money(r.amount || 0),
                        sub: [r.date, r.method, r.isInventoryPurchase ? "from inventory" : ""].filter(Boolean).join(" · "),
                      })),
                    })),
                  },
                ],
              }}
            />
            <KPI
              label="Pending receivables"
              value={moneyK(pendingTotal)}
              sub={`${pendingRows.length} student${pendingRows.length === 1 ? "" : "s"}`}
              puck="sky" puckIcon="fees"
              details={{
                title: `Pending receivables · ${money(pendingTotal)}`,
                sub: `${pendingRows.length} student${pendingRows.length === 1 ? "" : "s"} · highest-balance first`,
                items: pendingRows.slice(0, 12).map((f) => ({
                  label: `${f.name || "—"} · ${f.cls ? formatClassLabel(f.cls) : "—"}`,
                  value: money(f.amount || 0),
                  sub: f.overdue ? "overdue" : `due ${f.due || "—"}`,
                  tone: f.overdue ? "bad" : "warn",
                })),
              }}
            />
          </div>
        );
      })()}

      {canEdit && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-head">
            <div>
              <div className="card-title">Quick expense templates</div>
              <div className="card-sub">
                Save recurring expenses as one-click tiles · click a tile to pre-fill the Add Expense modal
              </div>
            </div>
            <button
              className="btn ghost"
              onClick={() => setEditingTemplate({})}
              style={{ height: 32 }}
            >
              <Icon name="plus" size={12} />Add template
            </button>
          </div>
          <div className="card-body">
            {visibleTemplates.length === 0 ? (
              <div style={{
                padding: "18px 14px", textAlign: "center",
                color: "var(--ink-4)", fontSize: 12.5,
                background: "var(--bg-2)", borderRadius: 8,
                border: "1px dashed var(--rule, #e5dfd1)",
              }}>
                No templates yet. Click <strong>Add template</strong> to save your first recurring expense
                (e.g. <em>Electricity bill · ₹12,000 · Utilities</em>) — then it shows up here as a one-click tile.
              </div>
            ) : (
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                gap: 10,
              }}>
                {visibleTemplates.map((t) => (
                  <TemplateTile
                    key={t.id}
                    tmpl={t}
                    onUse={() => openExpenseFromTemplate(t)}
                    onEdit={() => setEditingTemplate(t)}
                    onDelete={() => removeTemplate(t)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid g-12">
        <div className="card col-12">
          <div className="card-head">
            <div><div className="card-title">Money flow</div><div className="card-sub">Weekly · 12 weeks · ₹ lakhs · collected (line) vs spent (bars)</div></div>
          </div>
          <div className="card-body" style={{ padding: "8px 8px 0" }}>
            <LineBarChart data={E.INCOME_SERIES} w={1100} h={240} lineKeys={["inc"]} barKey="exp" palette={["var(--accent-2)"]} />
          </div>
        </div>

        {/* Two parallel breakdown cards — Spent on the left, Collected on
            the right. Inventory purchases are auto-cascaded so their
            category shows alongside manual expense categories. */}
        <BreakdownCard
          title="Money out · Spent"
          sub={`${accountScope} · by category`}
          accent="bad"
          rows={(() => {
            const byCat = new Map();
            for (const t of filteredTxns) {
              if (t.in) continue;
              const cat = t.isInventoryPurchase ? "Inventory purchase" : t.category;
              byCat.set(cat, (byCat.get(cat) || 0) + t.amount);
            }
            return [...byCat.entries()].sort((a, b) => b[1] - a[1]);
          })()}
          emptyMessage="No spending recorded yet."
        />
        <BreakdownCard
          title="Money in · Collected"
          sub={`${accountScope} · by source`}
          accent="ok"
          rows={(() => {
            const byCat = new Map();
            for (const t of filteredTxns) {
              if (!t.in) continue;
              byCat.set(t.category, (byCat.get(t.category) || 0) + t.amount);
            }
            return [...byCat.entries()].sort((a, b) => b[1] - a[1]);
          })()}
          emptyMessage="No income posted yet."
        />

        <div className="card col-12">
          <div className="card-head">
            <div>
              <div className="card-title">Ledger · recent transactions</div>
              <div className="card-sub">{filteredTxns.length} of {TXNS.length} transaction{TXNS.length === 1 ? "" : "s"} shown</div>
            </div>
            <div className="card-actions">
              <div className="segmented">
                {["All", "Collected", "Spent"].map((t) => (
                  <button key={t} className={ledgerType === t ? "active" : ""} onClick={() => setLedgerType(t)}>{t}</button>
                ))}
              </div>
              {ledgerType !== "Collected" && (
                <div className="segmented">
                  {["All", "Manual", "Inventory"].map((t) => (
                    <button key={t} className={spentFilter === t ? "active" : ""} onClick={() => setSpentFilter(t)}>{t}</button>
                  ))}
                </div>
              )}
              <select className="select" style={{ height: 32, fontSize: 12 }} value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)}>
                {methods.map((m) => <option key={m}>{m}</option>)}
              </select>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead><tr><th>ID</th><th>Date</th><th>Description</th><th>Account</th><th>Category</th><th>Method</th><th className="num">Amount</th>{canEdit && <th></th>}</tr></thead>
              <tbody>
                {filteredTxns.length === 0 && (
                  <tr><td colSpan={canEdit ? 8 : 7} className="empty">
                    {TXNS.length === 0
                      ? "No transactions yet. Fee receipts, donations and logged expenses will appear here."
                      : "No transactions match the current filters."}
                  </td></tr>
                )}
                {filteredTxns.map((t) => (
                  <tr key={t.id}>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-3)" }}>{t.id}</td>
                    <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{t.date}</td>
                    <td style={{ fontSize: 13 }}>
                      {t.desc}
                      {t.isInventoryPurchase && (
                        <span className="chip warn" style={{ marginLeft: 6, fontSize: 10 }} title={t.inventoryId ? `Linked to inventory item ${t.inventoryId}` : "From inventory"}>
                          <Icon name="inventory" size={10} />Inventory
                        </span>
                      )}
                      {t.payrollRun && (
                        <span className="chip accent" style={{ marginLeft: 6, fontSize: 10 }} title={`Pay run ${t.payrollRun.id} · ${t.payrollRun.staffCount} staff`}>
                          <Icon name="money" size={10} />Payroll {t.payrollRun.period}
                        </span>
                      )}
                    </td>
                    <td><span className={`chip ${t.scope === "trust" ? "accent" : "info"}`}><span className="dot" />{t.scope === "trust" ? "Trust" : "School"}</span></td>
                    <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{t.category}</td>
                    <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{t.method}</td>
                    <td className="num" style={{ color: t.in ? "var(--ok)" : "var(--bad)", fontWeight: 500 }}>
                      {t.in ? "+" : "−"}{money(t.amount)}
                    </td>
                    {canEdit && (
                      <td style={{ textAlign: "right" }}>
                        {!t.in && t.id?.startsWith("EXP-") && !t.isInventoryPurchase && !t.payrollRun && (
                          <button className="icon-btn" onClick={() => removeExpense(t)} title="Remove expense"><Icon name="x" size={12} /></button>
                        )}
                        {t.isInventoryPurchase && (
                          <span style={{ fontSize: 10, color: "var(--ink-4)" }} title="Remove from Inventory screen">locked</span>
                        )}
                        {t.payrollRun && !t.isInventoryPurchase && (
                          <span style={{ fontSize: 10, color: "var(--ink-4)" }} title={`Finalised pay run ${t.payrollRun.id} — post an adjustment run instead`}>locked</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showAddExpense && canEdit && (
        <AddExpenseModal
          onClose={() => { setShowAddExpense(false); setExpensePrefill(null); }}
          onSubmit={submitExpense}
          defaultScope={isTrustOnly || accountScope === "Trust only" ? "trust" : "school"}
          lockScope={isTrustOnly}
          customCategories={E.EXPENSE_CATEGORIES || []}
          baseCategories={E.EXPENSE_CATEGORY_CATALOG || []}
          onCategoryAdded={refresh}
          prefill={expensePrefill}
        />
      )}

      {editingTemplate && canEdit && (
        <TemplateEditModal
          template={editingTemplate.id ? editingTemplate : null}
          defaultScope={isTrustOnly || accountScope === "Trust only" ? "trust" : "school"}
          lockScope={isTrustOnly}
          customCategories={E.EXPENSE_CATEGORIES || []}
          baseCategories={E.EXPENSE_CATEGORY_CATALOG || []}
          onClose={() => setEditingTemplate(null)}
          onSubmit={saveTemplate}
        />
      )}
    </div>
  );
}

// One template tile. Click anywhere on it = "Use this template" (opens the
// Add Expense modal pre-filled). The corner buttons handle edit / delete.
function TemplateTile({ tmpl, onUse, onEdit, onDelete }) {
  return (
    <div
      style={{
        position: "relative",
        background: "var(--card)",
        border: "1px solid var(--rule, #e5dfd1)",
        borderRadius: 10,
        padding: "12px 12px 12px 14px",
        display: "flex", flexDirection: "column", gap: 6,
        cursor: "pointer",
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
      onClick={onUse}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--rule, #e5dfd1)"; }}
      role="button"
      title="Click to use this template"
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", lineHeight: 1.3, flex: 1, minWidth: 0 }}>
          {tmpl.name}
        </span>
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <button
            className="icon-btn"
            title="Edit template"
            onClick={onEdit}
            style={{ width: 22, height: 22 }}
          ><Icon name="pencil" size={10} /></button>
          <button
            className="icon-btn"
            title="Delete template"
            onClick={onDelete}
            style={{ width: 22, height: 22 }}
          ><Icon name="x" size={11} /></button>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--ink-3)" }}>
        <span className="chip">{tmpl.category}</span>
        <span style={{ color: "var(--ink-4)" }}>·</span>
        <span style={{ textTransform: "uppercase", letterSpacing: 0.4, fontSize: 9.5, color: "var(--ink-4)" }}>
          {tmpl.scope}
        </span>
      </div>
      <div style={{
        fontSize: 16, fontWeight: 600, color: "var(--ink)",
        fontFamily: "var(--font-mono)", marginTop: 2,
      }}>
        {tmpl.defaultAmount > 0 ? `₹${Number(tmpl.defaultAmount).toLocaleString("en-IN")}` : "no default"}
      </div>
      {tmpl.defaultVendor && (
        <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
          to {tmpl.defaultVendor}
        </div>
      )}
    </div>
  );
}

// Create / edit a single template. Same shape as the Add Expense form but
// stores defaults instead of recording one expense.
function TemplateEditModal({ template, defaultScope, lockScope = false, customCategories = [], baseCategories = [], onClose, onSubmit }) {
  const isEdit = !!template;
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState("");
  const [form, setForm] = useState({
    name: template?.name || "",
    scope: template?.scope || defaultScope || "school",
    category: template?.category || "Supplies",
    defaultAmount: template?.defaultAmount ? String(template.defaultAmount) : "",
    defaultVendor: template?.defaultVendor || "",
    defaultPaymentMethod: template?.defaultPaymentMethod || "Bank transfer",
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const mergedCategories = (() => {
    const out = [...(baseCategories.length ? baseCategories : FALLBACK_EXPENSE_CATEGORIES)];
    const seen = new Set(out.map((c) => c.toLowerCase()));
    for (const c of customCategories) {
      if (c.type !== form.scope) continue;
      const name = String(c.name || "").trim();
      if (name && !seen.has(name.toLowerCase())) {
        out.push(name);
        seen.add(name.toLowerCase());
      }
    }
    return out;
  })();

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const name = form.name.trim();
      if (!name) throw new Error("Template name is required");
      const payload = {
        name,
        scope: form.scope,
        category: form.category,
        defaultAmount: Number(form.defaultAmount) || 0,
        defaultVendor: form.defaultVendor.trim() || null,
        defaultPaymentMethod: form.defaultPaymentMethod,
      };
      await onSubmit(payload);
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title={isEdit ? `Edit template · ${template.name}` : "New expense template"}
      sub="Saved defaults that pre-fill the Add Expense modal in one click."
      onClose={onClose}
    >
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Template name *">
          <input
            className="input"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Electricity bill"
            autoFocus
            maxLength={80}
          />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Account *">
            <div className="segmented" style={lockScope ? { opacity: 0.7, pointerEvents: "none" } : undefined}>
              <button type="button" disabled={lockScope} className={form.scope === "school" ? "active" : ""} onClick={() => !lockScope && set("scope", "school")}>School</button>
              <button type="button" disabled={lockScope} className={form.scope === "trust" ? "active" : ""} onClick={() => !lockScope && set("scope", "trust")}>Trust</button>
            </div>
          </Field>
          <Field label="Category">
            <select
              className="select"
              value={form.category}
              onChange={(e) => set("category", e.target.value)}
            >
              {mergedCategories.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Default amount (₹)" hint="You can override per use">
            <input
              className="input"
              inputMode="numeric"
              value={form.defaultAmount}
              onChange={(e) => set("defaultAmount", e.target.value.replace(/\D/g, ""))}
              placeholder="12000"
            />
          </Field>
          <Field label="Default payment method">
            <select
              className="select"
              value={form.defaultPaymentMethod}
              onChange={(e) => set("defaultPaymentMethod", e.target.value)}
            >
              {PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Default vendor (optional)">
          <input
            className="input"
            value={form.defaultVendor}
            onChange={(e) => set("defaultVendor", e.target.value)}
            placeholder="e.g. TANGEDCO"
          />
        </Field>
        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy}>
            <Icon name="check" size={13} />{busy ? "Saving…" : isEdit ? "Save changes" : "Create template"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function AddExpenseModal({ onClose, onSubmit, defaultScope, lockScope = false, customCategories = [], baseCategories = [], onCategoryAdded, prefill = null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    scope: prefill?.scope || defaultScope || "school",
    category: prefill?.category || "Supplies",
    amount: prefill?.defaultAmount ? String(prefill.defaultAmount) : "",
    vendor: prefill?.defaultVendor || "",
    memo: prefill?.name ? `From template: ${prefill.name}` : "",
    date: today,
    paymentMethod: prefill?.defaultPaymentMethod || "Bank transfer",
  });
  // "Also track in inventory" state. Only meaningful when the chosen
  // category is purchase-style (PURCHASE_CATEGORIES). When the user
  // switches to a non-purchase category mid-edit, the toggle stays off
  // — we don't quietly preserve it because the fields disappear and a
  // ghost-inventory write would be confusing.
  const [trackInv, setTrackInv] = useState(false);
  const [invForm, setInvForm] = useState({
    name: "",
    category: "stationery",
    onHand: "",
    unitPrice: "",
  });
  const canTrackInventory = PURCHASE_CATEGORIES.has(form.category);
  // Reset inventory tracking whenever the category changes to a
  // non-purchase one. Cheaper than a useEffect — runs only on category
  // change which is rare.
  const setCategory = (c) => {
    setForm((f) => ({ ...f, category: c }));
    if (!PURCHASE_CATEGORIES.has(c)) setTrackInv(false);
    // Pre-fill the inventory category sensibly based on the expense one.
    setInvForm((iv) => ({
      ...iv,
      category: c === "Stationery" ? "stationery" : iv.category,
    }));
  };
  const setInv = (k, v) => setInvForm((iv) => ({ ...iv, [k]: v }));
  // Inline-add category state. The "+ Add" button next to the dropdown
  // toggles the inline input; submitting POSTs to the categories API
  // and selects the new category automatically.
  const [showAddCat, setShowAddCat] = useState(false);
  const [newCat, setNewCat] = useState("");
  const [catBusy, setCatBusy] = useState(false);
  const [catErr, setCatErr] = useState("");
  const amtRef = useRef(null);
  useEffect(() => { amtRef.current?.focus(); }, []);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Merge built-in categories with the custom ones for the active scope.
  // De-dupe by name so an admin can't accidentally hide a built-in by
  // adding the same name as a custom row.
  const mergedCategories = (() => {
    const out = [...(baseCategories.length ? baseCategories : FALLBACK_EXPENSE_CATEGORIES)];
    const seen = new Set(out.map((c) => c.toLowerCase()));
    for (const c of customCategories) {
      if (c.type !== form.scope) continue;
      const name = String(c.name || "").trim();
      if (name && !seen.has(name.toLowerCase())) {
        out.push(name);
        seen.add(name.toLowerCase());
      }
    }
    return out;
  })();

  async function addCategory() {
    const name = newCat.trim();
    if (!name) return;
    setCatBusy(true); setCatErr("");
    try {
      const r = await fetch("/api/expenses/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, type: form.scope }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      setCategory(j.category.name);
      setNewCat("");
      setShowAddCat(false);
      await onCategoryAdded?.();
    } catch (ex) {
      setCatErr(ex.message);
    } finally {
      setCatBusy(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const amount = Number(form.amount);
      if (!amount) throw new Error("Enter a positive amount");
      const payload = {
        scope: form.scope, category: form.category,
        amount, vendor: form.vendor.trim() || null, memo: form.memo.trim() || null,
        date: form.date, paymentMethod: form.paymentMethod,
      };
      if (trackInv && canTrackInventory) {
        const itemName = invForm.name.trim();
        if (!itemName) throw new Error("Item name required for inventory tracking");
        const qty = Math.max(1, Math.floor(Number(invForm.onHand) || 1));
        // Default unit price = total expense / qty so the inventory line
        // total reconciles with the expense amount. User can override.
        const unitPriceRaw = invForm.unitPrice.trim();
        const unitPrice = unitPriceRaw === ""
          ? Math.round(amount / qty)
          : Math.max(0, Math.floor(Number(unitPriceRaw) || 0));
        payload.inventory = {
          name: itemName,
          category: invForm.category || "stationery",
          onHand: qty,
          unitPrice,
        };
      }
      await onSubmit(payload);
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }

  return (
    <ModalShell title="Add money spent" sub="Records the spend in the ledger under the chosen account." onClose={onClose}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Account *">
            <div className="segmented" style={lockScope ? { opacity: 0.7, pointerEvents: "none" } : undefined}>
              <button type="button" disabled={lockScope} className={form.scope === "school" ? "active" : ""} onClick={() => !lockScope && set("scope", "school")}>School</button>
              <button type="button" disabled={lockScope} className={form.scope === "trust" ? "active" : ""} onClick={() => !lockScope && set("scope", "trust")}>Trust</button>
            </div>
          </Field>
          <Field label="Date">
            <input className="input" type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Category">
            <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
              <select
                className="select"
                value={form.category}
                onChange={(e) => setCategory(e.target.value)}
                style={{ flex: 1, minWidth: 0 }}
              >
                {mergedCategories.map((c) => <option key={c}>{c}</option>)}
              </select>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setShowAddCat((v) => !v)}
                title="Add a new category"
                style={{ flexShrink: 0, padding: "0 10px" }}
              >
                <Icon name="plus" size={12} />
              </button>
            </div>
            {showAddCat && (
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <input
                  className="input"
                  value={newCat}
                  onChange={(e) => setNewCat(e.target.value)}
                  placeholder={`New ${form.scope} category`}
                  maxLength={60}
                  style={{ flex: 1 }}
                  autoFocus
                />
                <button
                  type="button"
                  className="btn accent"
                  onClick={addCategory}
                  disabled={catBusy || !newCat.trim()}
                >{catBusy ? "Adding…" : "Add"}</button>
              </div>
            )}
            {catErr && (
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--err, #b13c1c)" }}>{catErr}</div>
            )}
          </Field>
          <Field label="Amount (₹) *">
            <input ref={amtRef} className="input" inputMode="numeric" value={form.amount} onChange={(e) => set("amount", e.target.value.replace(/\D/g, ""))} placeholder="50000" />
          </Field>
        </div>
        <Field label="Vendor / paid to (optional)">
          <input className="input" value={form.vendor} onChange={(e) => set("vendor", e.target.value)} placeholder="e.g. Sapna Books" />
        </Field>
        <Field label="Memo (optional)" hint="invoice #, PO ref, notes">
          <input className="input" value={form.memo} onChange={(e) => set("memo", e.target.value)} placeholder="INV-9234 · April supplies" />
        </Field>
        <Field label="Payment method">
          <select className="select" value={form.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value)}>
            {PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}
          </select>
        </Field>

        {canTrackInventory && (
          <div style={{
            background: "var(--bg-2)", border: "1px dashed var(--rule, #e5dfd1)",
            borderRadius: 8, padding: "10px 12px",
          }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={trackInv}
                onChange={(e) => setTrackInv(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink)" }}>
                Also track as inventory
              </span>
              <span style={{ fontSize: 10.5, color: "var(--ink-4)", marginLeft: "auto" }}>
                creates a linked stock row
              </span>
            </label>
            {trackInv && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                <Field label="Item name *">
                  <input
                    className="input"
                    value={invForm.name}
                    onChange={(e) => setInv("name", e.target.value)}
                    placeholder="e.g. A4 ruled notebooks"
                  />
                </Field>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                  <Field label="Inventory category">
                    <select
                      className="select"
                      value={invForm.category}
                      onChange={(e) => setInv("category", e.target.value)}
                    >
                      {INVENTORY_CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Quantity">
                    <input
                      className="input"
                      inputMode="numeric"
                      value={invForm.onHand}
                      onChange={(e) => setInv("onHand", e.target.value.replace(/\D/g, ""))}
                      placeholder="e.g. 50"
                    />
                  </Field>
                  <Field label="Unit price (₹)" hint="leave blank to split total ÷ qty">
                    <input
                      className="input"
                      inputMode="numeric"
                      value={invForm.unitPrice}
                      onChange={(e) => setInv("unitPrice", e.target.value.replace(/\D/g, ""))}
                      placeholder="auto"
                    />
                  </Field>
                </div>
              </div>
            )}
          </div>
        )}

        {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy || !form.amount}>
            {busy ? "Saving…" : <><Icon name="check" size={13} />Add money spent</>}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// Side-by-side breakdown card. `accent="ok"` (green bars) for Collected,
// `accent="bad"` (red/peach bars) for Spent. `rows` is [[label, total]].
function BreakdownCard({ title, sub, rows, accent = "ok", emptyMessage }) {
  const total = rows.reduce((a, [, v]) => a + v, 0);
  const barColor = accent === "bad" ? "var(--bad, #b13c1c)" : "var(--ok, #1f7a3a)";
  return (
    <div className="card col-6">
      <div className="card-head">
        <div>
          <div className="card-title">{title}</div>
          <div className="card-sub">{sub}</div>
        </div>
        <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: barColor }}>
          {moneyK(total)}
        </span>
      </div>
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.length === 0 || total === 0 ? (
          <div className="empty" style={{ padding: 16 }}>{emptyMessage}</div>
        ) : rows.map(([cat, val], i) => {
          const pct = (val / total) * 100;
          return (
            <div key={i}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                <span style={{ fontWeight: 700 }}>{cat}</span>
                <span className="mono">{moneyK(val)} · {pct.toFixed(1)}%</span>
              </div>
              <div className="bar thick"><span style={{ width: `${pct}%`, background: barColor }} /></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
