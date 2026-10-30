"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";
import { money } from "@/lib/format";
import { resolveSchool, downloadPdf } from "@/lib/export";

const MONTH_LABEL = (period) => {
  const [y, m] = String(period || "").split("-");
  if (!y || !m) return period || "—";
  return `${new Date(Number(y), Number(m) - 1, 1).toLocaleString("en-IN", { month: "long" })} ${y}`;
};

// Mirrors defaultWorkingDays in backend/lib/db.js — calendar days minus
// Sundays. Duplicated so the period picker can show the figure before the
// draft exists; the server value always wins once a run is created.
function defaultWorkingDays(period) {
  const [y, m] = String(period || "").split("-").map(Number);
  if (!y || !m) return 26;
  const days = new Date(y, m, 0).getDate();
  let sundays = 0;
  for (let d = 1; d <= days; d++) if (new Date(y, m - 1, d).getDay() === 0) sundays++;
  return days - sundays;
}

// Last 18 months, newest first. Payroll is always backward-looking — you pay
// for a month that has happened — so future months are not offered.
function recentPeriods() {
  const out = [];
  const now = new Date();
  for (let i = 0; i < 18; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function Toast({ msg, tone, onClose }) {
  if (!msg) return null;
  const bg = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--err, #b13c1c)" : "var(--ink)";
  return (
    <div onClick={onClose} role="status" style={{
      position: "fixed", bottom: 18, right: 18, zIndex: 9000,
      background: bg, color: "#fff", padding: "9px 14px", borderRadius: 8,
      fontSize: 12, fontWeight: 500, cursor: "pointer", maxWidth: 380,
      boxShadow: "0 12px 30px -16px rgba(0,0,0,0.35)",
    }}>{msg}</div>
  );
}

function ModalShell({ title, sub, onClose, children, width = 460 }) {
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
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: width }}>
        <div className="card-head">
          <div>
            <div className="card-title">{title}</div>
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={13} /></button>
        </div>
        <div style={{ padding: "4px 16px 16px" }}>{children}</div>
      </div>
    </div>
  );
}

// Finalise is the one irreversible action in the module: it writes the expense
// row and locks the run forever. A typed confirmation makes it impossible to
// trigger by muscle memory on the wrong month.
function FinaliseDialog({ run, unmatched, onClose, onConfirm, busy }) {
  const [typed, setTyped] = useState("");
  const phrase = run.period;
  return (
    <ModalShell
      title={`Finalise payroll · ${MONTH_LABEL(run.period)}`}
      sub="This cannot be undone"
      onClose={onClose}
      width={500}
    >
      <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)" }}>
        <p style={{ margin: "0 0 10px" }}>
          This records <strong>{money(run.totalNet)}</strong> as a single
          {" "}<strong>Salary</strong> expense for {run.staffCount} staff, then locks the run.
          Payslips become read-only. There is no edit and no delete —
          a correction has to be posted as a new adjustment run.
        </p>
        {unmatched > 0 && (
          <div className="chip bad" style={{ display: "block", padding: "8px 10px", marginBottom: 10, fontSize: 12, lineHeight: 1.5 }}>
            <Icon name="shield" size={11} />{" "}
            {unmatched} of {run.staffCount} staff have no attendance link and are being paid
            full salary. Fix their email in Staff and recreate the draft if that is wrong.
          </div>
        )}
        <label style={{ display: "block", fontSize: 12, color: "var(--ink-3)", marginBottom: 5 }}>
          Type <strong style={{ fontFamily: "var(--font-mono)" }}>{phrase}</strong> to confirm
        </label>
        <input
          className="input" autoFocus value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={phrase}
          style={{ fontFamily: "var(--font-mono)" }}
        />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          className="btn primary"
          disabled={busy || typed.trim() !== phrase}
          onClick={onConfirm}
        >
          {busy ? "Recording…" : `Finalise · ${money(run.totalNet)}`}
        </button>
      </div>
    </ModalShell>
  );
}

// Inline editor for one draft payslip. Kept as its own component so each row
// holds its own pending value — a single shared state would make typing in one
// row re-render and reset the others.
function EditableCell({ value, onCommit, disabled, max }) {
  const [draft, setDraft] = useState(String(value ?? 0));
  useEffect(() => { setDraft(String(value ?? 0)); }, [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 0) { setDraft(String(value ?? 0)); return; }
    if (Number(value) === n) return;
    onCommit(n);
  };
  return (
    <input
      className="input"
      type="number" min={0} max={max} step="any"
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      style={{ width: 84, height: 28, fontSize: 12, textAlign: "right", padding: "0 6px" }}
    />
  );
}

export default function Payroll({ E = {}, session }) {
  const headers = E.PAY_RUNS || [];
  const school = resolveSchool(E.SETTINGS);
  const actor = session?.name || session?.email || "Admin";

  const periods = useMemo(recentPeriods, []);
  const [period, setPeriod] = useState(periods[0]);
  const [workingDays, setWorkingDays] = useState(defaultWorkingDays(periods[0]));
  const [runs, setRuns] = useState(headers);
  const [openRun, setOpenRun] = useState(null);     // full run + payslips
  const [busy, setBusy] = useState("");
  const [confirmFinalise, setConfirmFinalise] = useState(false);
  const [toast, setToast] = useState(null);

  const flash = (msg, tone = "ok") => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 4200);
  };

  useEffect(() => { setRuns(headers); }, [headers]);
  useEffect(() => { setWorkingDays(defaultWorkingDays(period)); }, [period]);

  const existing = useMemo(
    () => runs.find((r) => r.period === period) || null,
    [runs, period]
  );

  const refreshRuns = async () => {
    try {
      const res = await fetch("/api/payroll", { cache: "no-store" });
      const json = await res.json();
      if (json.ok) setRuns(json.payRuns || []);
    } catch {}
  };

  const loadRun = async (id) => {
    setBusy("load");
    try {
      const res = await fetch(`/api/payroll?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Could not load run");
      setOpenRun(json.run);
    } catch (e) {
      flash(e.message, "err");
    } finally { setBusy(""); }
  };

  const createDraft = async () => {
    setBusy("create");
    try {
      const res = await fetch("/api/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period, workingDays }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Could not create draft");
      setOpenRun(json.run);
      await refreshRuns();
      flash(`Draft created · ${json.run.staffCount} staff · ${money(json.run.totalNet)}`);
    } catch (e) {
      flash(e.message, "err");
    } finally { setBusy(""); }
  };

  const patchSlip = async (payslipId, patch) => {
    setBusy("slip");
    try {
      const res = await fetch("/api/payroll", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payslipId, ...patch }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Could not save");
      // Reload the whole run: editing one payslip also moves the header
      // totals, and showing a stale total next to a Finalise button that
      // charges the fresh one would be the worst kind of bug here.
      await loadRun(openRun.id);
      await refreshRuns();
    } catch (e) {
      flash(e.message, "err");
    } finally { setBusy(""); }
  };

  const saveWorkingDays = async (days) => {
    setBusy("wd");
    try {
      const res = await fetch("/api/payroll", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: openRun.id, workingDays: days }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Could not save");
      await loadRun(openRun.id);
      await refreshRuns();
      flash(`Working days set to ${days} · LOP recalculated`);
    } catch (e) {
      flash(e.message, "err");
    } finally { setBusy(""); }
  };

  const finalise = async () => {
    setBusy("finalise");
    try {
      const res = await fetch("/api/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: openRun.id, action: "finalise" }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Could not finalise");
      setConfirmFinalise(false);
      await loadRun(openRun.id);
      await refreshRuns();
      flash(`Payroll finalised · ${money(json.run.totalNet)} posted to Money`);
    } catch (e) {
      flash(e.message, "err");
    } finally { setBusy(""); }
  };

  const deleteDraft = async (run) => {
    if (!window.confirm(`Delete the ${MONTH_LABEL(run.period)} draft? The month will be free to run again.`)) return;
    setBusy("delete");
    try {
      const res = await fetch("/api/payroll", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: run.id }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Could not delete");
      if (openRun?.id === run.id) setOpenRun(null);
      await refreshRuns();
      flash("Draft deleted");
    } catch (e) {
      flash(e.message, "err");
    } finally { setBusy(""); }
  };

  const slips = openRun?.payslips || [];
  const unmatched = slips.filter((s) => s.attendanceSource === "unmatched").length;
  const isDraft = openRun?.status === "draft";

  const exportPayslips = () => {
    if (!openRun) return;
    downloadPdf({
      title: `Payslips · ${MONTH_LABEL(openRun.period)}`,
      subtitle: `${openRun.staffCount} staff · ${openRun.workingDays} working days · ${openRun.status === "finalised" ? "finalised" : "DRAFT — not yet paid"}`,
      school,
      actor,
      dateRange: MONTH_LABEL(openRun.period),
      orientation: "landscape",
      summary: [
        { label: "Staff",      value: openRun.staffCount },
        { label: "Gross",      value: money(openRun.totalGross) },
        { label: "Withheld",   value: money(openRun.totalDeductions) },
        { label: "Net paid",   value: money(openRun.totalNet) },
      ],
      columns: [
        { key: "i",      label: "#",          align: "right",  width: 10 },
        { key: "name",   label: "Staff" },
        { key: "role",   label: "Role" },
        { key: "base",   label: "Base",       align: "right" },
        { key: "days",   label: "P / A / L",  align: "center" },
        { key: "lop",    label: "LOP",        align: "right" },
        { key: "allow",  label: "Allowances", align: "right" },
        { key: "deduct", label: "Deductions", align: "right" },
        { key: "net",    label: "Net",        align: "right" },
        { key: "src",    label: "Attendance", align: "center" },
      ],
      rows: slips.map((s, i) => ({
        i: i + 1,
        name: s.staffName || "—",
        role: s.staffRole || "—",
        base: money(s.baseSalary),
        days: `${s.presentDays} / ${s.absentDays} / ${s.leaveDays}`,
        lop: s.lopDays ? `${s.lopDays}d · ${money(s.lopAmount)}` : "—",
        allow: s.allowances ? money(s.allowances) : "—",
        deduct: s.deductions ? money(s.deductions) : "—",
        net: money(s.net),
        src: s.attendanceSource === "unmatched" ? "no link" : s.attendanceSource,
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-payslips-${openRun.period}`,
    });
    flash(`Payslip PDF generated · ${slips.length} staff`);
  };

  const latest = runs[0] || null;

  return (
    <>
      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />

      <div className="grid">
        <KPI
          label="Pay runs"
          value={runs.length}
          sub={latest ? `latest ${MONTH_LABEL(latest.period)} · ${latest.status}` : "none yet"}
          puckIcon="money"
        />
        <KPI
          label="Last net paid"
          value={latest?.status === "finalised" ? money(latest.totalNet) : "—"}
          sub={latest?.status === "finalised" ? `${latest.staffCount} staff` : "no finalised run"}
          puckIcon="money"
        />
        <KPI
          label="Open draft"
          value={runs.filter((r) => r.status === "draft").length}
          sub="editable until finalised"
          puckIcon="pencil"
        />

        {/* ---- period picker / new run ---- */}
        <div className="card col-12">
          <div className="card-head">
            <div>
              <div className="card-title">Run payroll</div>
              <div className="card-sub">One run per month · a month can only be paid once</div>
            </div>
          </div>
          <div style={{ padding: "4px 16px 16px", display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div>
              <label style={{ display: "block", fontSize: 11, color: "var(--ink-3)", marginBottom: 4 }}>Period</label>
              <select className="select" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ height: 34 }}>
                {periods.map((p) => (
                  <option key={p} value={p}>{MONTH_LABEL(p)}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, color: "var(--ink-3)", marginBottom: 4 }}>
                Working days
              </label>
              <input
                className="input" type="number" min={1} max={31}
                value={workingDays}
                disabled={!!existing}
                onChange={(e) => setWorkingDays(Number(e.target.value))}
                style={{ width: 90, height: 34 }}
              />
            </div>
            {existing ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className={`chip ${existing.status === "finalised" ? "ok" : "warn"}`}>
                  <span className="dot" />
                  {MONTH_LABEL(existing.period)} already has a {existing.status} run
                </span>
                <button className="btn" onClick={() => loadRun(existing.id)} disabled={!!busy}>
                  Open
                </button>
              </div>
            ) : (
              <button className="btn primary" onClick={createDraft} disabled={!!busy}>
                {busy === "create" ? "Building…" : "Create draft"}
              </button>
            )}
            <div style={{ fontSize: 11.5, color: "var(--ink-4)", maxWidth: 420, lineHeight: 1.5 }}>
              Working days is the divisor for loss-of-pay. It defaults to calendar
              days minus Sundays and is editable on the draft.
            </div>
          </div>
        </div>

        {/* ---- draft / finalised detail ---- */}
        {openRun && (
          <div className="card col-12">
            <div className="card-head">
              <div>
                <div className="card-title">
                  {MONTH_LABEL(openRun.period)}
                  <span className={`chip ${openRun.status === "finalised" ? "ok" : "warn"}`} style={{ marginLeft: 8, fontSize: 10 }}>
                    <span className="dot" />{openRun.status}
                  </span>
                </div>
                <div className="card-sub">
                  {openRun.staffCount} staff · gross {money(openRun.totalGross)} ·
                  withheld {money(openRun.totalDeductions)} ·
                  <strong style={{ color: "var(--ink)" }}> net {money(openRun.totalNet)}</strong>
                  {openRun.status === "finalised" && openRun.expenseId && (
                    <> · expense <span style={{ fontFamily: "var(--font-mono)" }}>{openRun.expenseId}</span></>
                  )}
                </div>
              </div>
              <div className="card-actions">
                {isDraft && (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 11, color: "var(--ink-3)" }}>Working days</span>
                      <EditableCell
                        value={openRun.workingDays}
                        max={31}
                        disabled={!!busy}
                        onCommit={(n) => { if (n >= 1 && n <= 31) saveWorkingDays(n); }}
                      />
                    </div>
                    <button className="btn ghost" onClick={() => deleteDraft(openRun)} disabled={!!busy}>
                      Delete draft
                    </button>
                    <button className="btn primary" onClick={() => setConfirmFinalise(true)} disabled={!!busy}>
                      Finalise
                    </button>
                  </>
                )}
                <button className="btn" onClick={exportPayslips} disabled={!!busy}>
                  <Icon name="reports" size={12} /> Payslip PDF
                </button>
                <button className="icon-btn" onClick={() => setOpenRun(null)} title="Close"><Icon name="x" size={12} /></button>
              </div>
            </div>

            {/* The unmatched banner is the single most important thing on this
                screen: it is the only signal that a teacher's attendance was
                never read, and it has to be seen BEFORE Finalise. */}
            {unmatched > 0 && (
              <div style={{
                margin: "0 16px 12px", padding: "10px 12px", borderRadius: 8,
                background: "var(--bad-soft, rgba(177,60,28,0.08))",
                border: "1px solid var(--bad, #b13c1c)",
                fontSize: 12.5, lineHeight: 1.55, color: "var(--ink-2)",
              }}>
                <strong>
                  <Icon name="shield" size={12} /> {unmatched} of {openRun.staffCount} staff
                  have no attendance link — paid at full salary.
                </strong>
                <div style={{ marginTop: 3, color: "var(--ink-3)" }}>
                  Their staff email doesn't match any login, so attendance couldn't be
                  read and no loss-of-pay was applied. Deliberate on purpose: underpaying
                  someone because two email fields disagree is worse than overpaying.
                  Fix the email in Staff and recreate the draft to apply LOP.
                </div>
              </div>
            )}

            {openRun.status === "finalised" && (
              <div style={{ margin: "0 16px 12px", fontSize: 12, color: "var(--ink-3)" }}>
                Finalised {openRun.finalisedAt ? new Date(openRun.finalisedAt).toLocaleString("en-IN") : ""}
                {openRun.finalisedBy ? ` by ${openRun.finalisedBy}` : ""}. Read-only —
                corrections are posted as a new adjustment run.
              </div>
            )}

            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Staff</th>
                    <th className="num">Base</th>
                    <th className="num">Present</th>
                    <th className="num">LOP days</th>
                    <th className="num">LOP ₹</th>
                    <th className="num">Allowances</th>
                    <th className="num">Deductions</th>
                    <th className="num">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {slips.length === 0 && (
                    <tr><td colSpan={8} className="empty">No payslips in this run.</td></tr>
                  )}
                  {slips.map((s) => (
                    <tr key={s.id}>
                      <td style={{ fontSize: 13 }}>
                        {s.staffName}
                        <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
                          {s.staffRole || "—"}
                          {s.attendanceSource === "unmatched" && (
                            <span className="chip bad" style={{ marginLeft: 5, fontSize: 9.5 }}>no attendance link</span>
                          )}
                        </div>
                      </td>
                      <td className="num" style={{ fontSize: 12 }}>{money(s.baseSalary)}</td>
                      <td className="num" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        {s.attendanceSource === "unmatched"
                          ? "—"
                          : `${s.presentDays}/${s.workingDays}`}
                      </td>
                      <td className="num">
                        {isDraft ? (
                          <EditableCell
                            value={s.lopDays}
                            max={s.workingDays}
                            disabled={!!busy}
                            onCommit={(n) => patchSlip(s.id, { lopDays: n })}
                          />
                        ) : (
                          <span style={{ fontSize: 12 }}>{s.lopDays || "—"}</span>
                        )}
                      </td>
                      <td className="num" style={{ fontSize: 12, color: s.lopAmount ? "var(--bad)" : "var(--ink-4)" }}>
                        {s.lopAmount ? `−${money(s.lopAmount)}` : "—"}
                      </td>
                      <td className="num">
                        {isDraft ? (
                          <EditableCell
                            value={s.allowances}
                            disabled={!!busy}
                            onCommit={(n) => patchSlip(s.id, { allowances: n })}
                          />
                        ) : (
                          <span style={{ fontSize: 12 }}>{s.allowances ? money(s.allowances) : "—"}</span>
                        )}
                      </td>
                      <td className="num">
                        {isDraft ? (
                          <EditableCell
                            value={s.deductions}
                            disabled={!!busy}
                            onCommit={(n) => patchSlip(s.id, { deductions: n })}
                          />
                        ) : (
                          <span style={{ fontSize: 12 }}>{s.deductions ? money(s.deductions) : "—"}</span>
                        )}
                      </td>
                      <td className="num" style={{ fontWeight: 600, fontSize: 12.5 }}>{money(s.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ---- history ---- */}
        <div className="card col-12">
          <div className="card-head">
            <div>
              <div className="card-title">Pay run history</div>
              <div className="card-sub">{runs.length} run{runs.length === 1 ? "" : "s"}</div>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Period</th><th>Status</th><th className="num">Staff</th>
                  <th className="num">Gross</th><th className="num">Withheld</th>
                  <th className="num">Net</th><th>Expense</th><th></th>
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 && (
                  <tr><td colSpan={8} className="empty">No payroll yet. Pick a month above to build the first draft.</td></tr>
                )}
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontSize: 13 }}>{MONTH_LABEL(r.period)}</td>
                    <td>
                      <span className={`chip ${r.status === "finalised" ? "ok" : "warn"}`}>
                        <span className="dot" />{r.status}
                      </span>
                    </td>
                    <td className="num" style={{ fontSize: 12 }}>{r.staffCount}</td>
                    <td className="num" style={{ fontSize: 12 }}>{money(r.totalGross)}</td>
                    <td className="num" style={{ fontSize: 12, color: "var(--ink-3)" }}>{money(r.totalDeductions)}</td>
                    <td className="num" style={{ fontSize: 12.5, fontWeight: 600 }}>{money(r.totalNet)}</td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>
                      {r.expenseId || "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn ghost" onClick={() => loadRun(r.id)} disabled={!!busy} style={{ height: 26, fontSize: 11 }}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {confirmFinalise && openRun && (
        <FinaliseDialog
          run={openRun}
          unmatched={unmatched}
          busy={busy === "finalise"}
          onClose={() => setConfirmFinalise(false)}
          onConfirm={finalise}
        />
      )}
    </>
  );
}
