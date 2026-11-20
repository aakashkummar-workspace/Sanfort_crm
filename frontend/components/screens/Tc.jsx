"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";
import { formatClassLabel } from "@/lib/format";

const STATUS_LABEL = { requested: "Requested", approved: "Approved", issued: "Issued", rejected: "Rejected" };
const STATUS_TONE  = { requested: "", approved: "warn", issued: "ok", rejected: "bad" };

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

function ModalShell({ title, sub, onClose, children, width = 520 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: width, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
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

export default function ScreenTc({ E, refresh, role }) {
  const canEdit = role === "admin" || role === "principal";
  const [requests, setRequests] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [printingTc, setPrintingTc] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (m, t) => { setToast({ msg: m, tone: t }); setTimeout(() => setToast(null), 3000); };

  async function load() {
    try {
      const r = await fetch("/api/tc", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setRequests(j.requests || []);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  const counts = useMemo(() => ({
    total: requests.length,
    requested: requests.filter((r) => r.status === "requested").length,
    issued: requests.filter((r) => r.status === "issued").length,
    rejected: requests.filter((r) => r.status === "rejected").length,
  }), [requests]);

  async function handleAdd(payload) {
    const r = await fetch("/api/tc", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    setShowAdd(false);
    showToast(`TC request ${j.request.id} created`, "ok");
    await load();
    await refresh?.();
  }

  async function patch(tc, status) {
    try {
      const r = await fetch("/api/tc", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: tc.id, status }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      showToast(`TC ${status === "issued" ? "issued — " + j.request.serialNo : status}`, "ok");
      await load();
    } catch (e) { showToast(e.message, "err"); }
  }

  async function remove(tc) {
    if (!confirm(`Remove TC request ${tc.id}?`)) return;
    try {
      const r = await fetch("/api/tc", {
        method: "DELETE", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: tc.id }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      showToast("Removed", "ok");
      await load();
    } catch (e) { showToast(e.message, "err"); }
  }

  return (
    <div className="page">
      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />

      <div className="page-head">
        <div>
          <div className="page-eyebrow">People · Records</div>
          <div className="page-title">Transfer <span className="amber">Certificates</span></div>
          <div className="page-sub">Request → approve → issue printable TC with auto serial number</div>
        </div>
        {canEdit && (
          <div className="page-actions">
            <button className="btn accent" onClick={() => setShowAdd(true)}>
              <Icon name="plus" size={13} />New TC request
            </button>
          </div>
        )}
      </div>

      <div className="grid g-4" style={{ marginBottom: 14 }}>
        {(() => {
          const byStatus = (s) => requests.filter((r) => r.status === s);
          const itemFor = (r) => ({
            label: r.studentName || r.studentId,
            value: formatClassLabel(r.cls),
            sub: r.requestedAt ? `Requested ${String(r.requestedAt).slice(0, 10)}` : "",
            tone: r.status === "issued" ? "ok" : r.status === "rejected" ? "bad" : "warn",
          });
          return (
            <>
              <KPI
                label="Total requests" value={counts.total} sub="all-time"
                puck="mint" puckIcon="reports"
                details={{
                  title: `TC requests · ${counts.total}`,
                  sub: "Most recent first",
                  items: requests.slice(0, 12).map(itemFor),
                }}
              />
              <KPI
                label="Awaiting" value={counts.requested}
                sub={counts.requested ? "needs action" : "none pending"}
                puck="cream" puckIcon="clock"
                details={{
                  title: `Awaiting · ${counts.requested}`,
                  sub: counts.requested === 0 ? "All TC requests actioned" : "Pending review",
                  items: byStatus("requested").map(itemFor),
                }}
              />
              <KPI
                label="Issued" value={counts.issued} sub="printed & handed over"
                puck="peach" puckIcon="check"
                details={{
                  title: `Issued · ${counts.issued}`,
                  sub: "TCs already issued",
                  items: byStatus("issued").map(itemFor),
                }}
              />
              <KPI
                label="Rejected" value={counts.rejected} sub="declined"
                puck="rose" puckIcon="x"
                details={{
                  title: `Rejected · ${counts.rejected}`,
                  sub: counts.rejected === 0 ? "No TCs declined" : "Declined requests",
                  items: byStatus("rejected").map(itemFor),
                }}
              />
            </>
          );
        })()}
      </div>

      <div className="card">
        <div className="card-head">
          <div><div className="card-title">All TC requests</div><div className="card-sub">Newest first</div></div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr><th>TC #</th><th>Student</th><th>Class</th><th>Reason</th><th>Status</th><th>Serial</th><th></th></tr>
            </thead>
            <tbody>
              {requests.length === 0 && <tr><td colSpan={7} className="empty">No TC requests yet.</td></tr>}
              {requests.map((tc) => (
                <tr key={tc.id}>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{tc.id}</td>
                  <td>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{tc.studentName}</div>
                    <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{tc.studentId}</div>
                  </td>
                  <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{formatClassLabel(tc.cls)}</td>
                  <td style={{ fontSize: 11.5, color: "var(--ink-3)", maxWidth: 240 }}>{tc.reason || "—"}</td>
                  <td><span className={`chip ${STATUS_TONE[tc.status]}`}><span className="dot" />{STATUS_LABEL[tc.status]}</span></td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>{tc.serialNo || "—"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      {canEdit && tc.status === "requested" && (
                        <>
                          <button className="btn sm" onClick={() => patch(tc, "approved")}>Approve</button>
                          <button className="btn sm ghost" onClick={() => patch(tc, "rejected")}>Reject</button>
                        </>
                      )}
                      {canEdit && tc.status === "approved" && (
                        <button className="btn sm accent" onClick={() => patch(tc, "issued")}>
                          <Icon name="check" size={11} />Issue
                        </button>
                      )}
                      {tc.status === "issued" && (
                        <button className="btn sm" onClick={() => setPrintingTc(tc)}>
                          <Icon name="download" size={11} />Print
                        </button>
                      )}
                      {canEdit && (
                        <button className="icon-btn" onClick={() => remove(tc)} title="Remove"><Icon name="x" size={12} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && canEdit && (
        <AddTcModal students={E.ADDED_STUDENTS || []} onClose={() => setShowAdd(false)} onSubmit={handleAdd} />
      )}
      {printingTc && (
        <PrintTcModal tc={printingTc} onClose={() => setPrintingTc(null)} />
      )}
    </div>
  );
}

function AddTcModal({ students, onClose, onSubmit }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ studentId: "", reason: "" });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const stu = students.find((s) => s.id === form.studentId);
      if (!stu) throw new Error("Pick a student");
      await onSubmit({
        studentId: stu.id,
        studentName: stu.name,
        cls: stu.cls,
        reason: form.reason.trim() || null,
      });
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }

  return (
    <ModalShell title="New TC request" sub="Mark a student for transfer / TC issuance" onClose={onClose}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Student *" hint={`${students.length} students on roll`}>
          <select className="select" value={form.studentId} onChange={(e) => set("studentId", e.target.value)}>
            <option value="">— pick a student —</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>{s.name} · {formatClassLabel(s.cls)} · {s.id}</option>
            ))}
          </select>
        </Field>
        <Field label="Reason (optional)" hint="e.g. Family relocation, change of school">
          <textarea
            className="input"
            style={{ width: "100%", height: 72, padding: "8px 10px", lineHeight: 1.5, resize: "vertical" }}
            value={form.reason}
            onChange={(e) => set("reason", e.target.value)}
            placeholder="Reason for transfer…"
          />
        </Field>
        {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy || !form.studentId}>
            {busy ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function PrintTcModal({ tc, onClose }) {
  const print = () => {
    const w = window.open("", "_blank", "width=820,height=1100");
    if (!w) return;
    const doc = w.document;
    doc.title = `TC ${tc.serialNo}`;
    // Pretty-print a date if we have one; otherwise leave blank for hand-fill.
    const fmt = (iso) => iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" }) : "";
    const academicYear = (() => {
      const d = tc.issuedAt ? new Date(tc.issuedAt) : new Date();
      const y = d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
      return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
    })();
    const style = doc.createElement("style");
    style.textContent = `
      @page { size: A4; margin: 14mm 16mm; }
      * { box-sizing: border-box; }
      body { font-family: Arial, Helvetica, sans-serif; padding: 0; color: #000; font-size: 12px; line-height: 1.45; }
      .head { display: flex; align-items: center; gap: 14px; border-bottom: 1.5px solid #000; padding-bottom: 10px; }
      .head img { width: 64px; height: 64px; object-fit: contain; flex-shrink: 0; }
      .head .school { flex: 1; text-align: center; }
      .head .school-name { font-size: 19px; font-weight: 700; letter-spacing: 0.5px; }
      .head .addr { font-size: 11.5px; font-weight: 600; margin-top: 2px; }
      .head .reco { font-size: 11px; font-weight: 700; margin-top: 1px; }
      .title { text-align: center; font-size: 15px; font-weight: 700; margin: 10px 0 14px; text-decoration: underline; letter-spacing: 0.5px; }
      .top-meta { display: grid; grid-template-columns: 1fr; row-gap: 4px; margin-bottom: 10px; }
      .top-meta .row { display: flex; gap: 6px; }
      .top-meta .lbl { width: 110px; font-weight: 600; }
      .top-meta .blank { flex: 1; border-bottom: 1px dotted #555; min-height: 14px; padding: 0 4px; }
      .item { display: grid; grid-template-columns: 4fr 6fr; column-gap: 12px; padding: 3px 0; align-items: end; }
      .item .l { font-size: 12px; }
      .item .r { display: flex; align-items: end; gap: 6px; min-height: 16px; }
      .item .r .colon { width: 6px; }
      .item .r .val { flex: 1; border-bottom: 1px dotted #555; padding: 0 4px; min-height: 14px; }
      .item.subline .l { padding-left: 14px; color: #222; }
      .item.tall .r { min-height: 28px; }
      table.cs { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 11.5px; }
      table.cs th, table.cs td { border: 1px solid #000; padding: 6px 8px; text-align: center; vertical-align: middle; }
      table.cs th { font-weight: 700; background: #fafafa; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.4px; }
      .sign-block { display: flex; justify-content: flex-end; margin-top: 28px; font-size: 12px; }
      .sign-block .col { text-align: center; }
      .notes { margin-top: 26px; font-size: 11px; line-height: 1.5; }
      .notes b { font-weight: 700; }
      .declar { text-align: center; margin-top: 20px; font-weight: 700; text-decoration: underline; font-size: 12.5px; }
      .declar-body { margin-top: 8px; font-size: 11.5px; line-height: 1.6; text-indent: 18px; }
      .parent-sign { display: flex; justify-content: flex-end; margin-top: 28px; font-size: 12px; }
    `;
    doc.head.appendChild(style);
    doc.body.innerHTML = `
      <div class="head">
        <img src="${window.location.origin}/logo.png" alt="logo" />
        <div class="school">
          <div class="school-name">SANFORT INTERNATIONAL SCHOOL</div>
          <div class="addr">No. 57, KAMARAJ SALAI POORANANKUPPAM PUDUCHERRY -605007</div>
          <div class="reco">(RECOGNISED BY THE GOVT. OF PUDUCHERRY)</div>
        </div>
      </div>

      <div class="title">TRANSFER CERTIFICATE</div>

      <div class="top-meta">
        <div class="row"><span class="lbl">T.C No</span><span>:</span><span class="blank">${escape(tc.serialNo || "")}</span></div>
        <div class="row"><span class="lbl">Admission No</span><span>:</span><span class="blank">${escape(tc.studentId || "")}</span></div>
        <div class="row"><span class="lbl">U. I .D. No</span><span>:</span><span class="blank"></span></div>
      </div>

      <div class="item">
        <div class="l">1. a) Name of the School</div>
        <div class="r"><span class="colon">:</span><span class="val">SANFORT INTERNATIONAL SCHOOL</span></div>
      </div>
      <div class="item subline">
        <div class="l">b) Name of the Education District / Revenue District</div>
        <div class="r"><span class="colon">:</span><span class="val">PUDUCHERRY</span></div>
      </div>
      <div class="item">
        <div class="l">2. Name of the Pupil (in Block letters)</div>
        <div class="r"><span class="colon">:</span><span class="val">${escape((tc.studentName || "").toUpperCase())}</span></div>
      </div>
      <div class="item">
        <div class="l">3. Name of the Father and Mother of the pupil</div>
        <div class="r"><span class="colon">:</span><span class="val"></span></div>
      </div>
      <div class="item">
        <div class="l">4. Nationality and Religion</div>
        <div class="r"><span class="colon">:</span><span class="val"></span></div>
      </div>
      <div class="item">
        <div class="l">5. Community<br/><span style="padding-left:0">&nbsp;&nbsp;&nbsp;&nbsp;Whether He/ She belongs to SC/ST/BC/MBC</span></div>
        <div class="r"><span class="colon">:</span><span class="val"></span></div>
      </div>
      <div class="item">
        <div class="l">6. Gender</div>
        <div class="r"><span class="colon">:</span><span class="val"></span></div>
      </div>
      <div class="item tall">
        <div class="l">7. Date of Birth as entered in the Admission<br/>&nbsp;&nbsp;&nbsp;&nbsp;Register in figures and words</div>
        <div class="r"><span class="colon">:</span><span class="val"></span></div>
      </div>
      <div class="item">
        <div class="l">8. Personal Marks of Identification</div>
        <div class="r"><span class="colon">:</span><span class="val"></span></div>
      </div>
      <div class="item">
        <div class="l">9. Date of Admission and Standard in Which admitted</div>
        <div class="r"><span class="colon">:</span><span class="val"></span></div>
      </div>
      <div class="item tall">
        <div class="l">10. Standard in which the pupil was studying at the time<br/>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Of leaving (in words)</div>
        <div class="r"><span class="colon">:</span><span class="val">${escape(tc.cls || "")}</span></div>
      </div>
      <div class="item">
        <div class="l">11. Whether qualified for promotion to higher standard</div>
        <div class="r"><span class="colon">:</span><span class="val">Yes</span></div>
      </div>
      <div class="item tall">
        <div class="l">12. Whether the pupil was in the receipt of any scholarship?<br/>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;(Nature of the scholarship to be specified)</div>
        <div class="r"><span class="colon">:</span><span class="val"></span></div>
      </div>
      <div class="item tall">
        <div class="l">13. Whether the pupil has undergone Medical inspection<br/>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;During the last academic year</div>
        <div class="r"><span class="colon">:</span><span class="val"></span></div>
      </div>
      <div class="item">
        <div class="l">14. Date on which the pupil actually left the School</div>
        <div class="r"><span class="colon">:</span><span class="val">${escape(fmt(tc.issuedAt))}</span></div>
      </div>
      <div class="item">
        <div class="l">15. The Pupil's conduct and character</div>
        <div class="r"><span class="colon">:</span><span class="val">Good</span></div>
      </div>
      <div class="item tall">
        <div class="l">16. Date on which application for Transfer Certificate was<br/>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Made on behalf of the pupil by the parent or guardian</div>
        <div class="r"><span class="colon">:</span><span class="val">${escape(fmt(tc.requestedAt))}</span></div>
      </div>
      <div class="item">
        <div class="l">17. Date of the Transfer Certificate</div>
        <div class="r"><span class="colon">:</span><span class="val">${escape(fmt(tc.issuedAt))}</span></div>
      </div>

      <div style="margin-top:14px;font-weight:600;">18. Course of Study</div>
      <table class="cs">
        <thead>
          <tr>
            <th>Name of the<br/>School</th>
            <th>Academic Year</th>
            <th>Standard<br/>Studied</th>
            <th>First Language</th>
            <th>Medium of<br/>Instruction</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>SANFORT<br/>INTERNATIONAL<br/>SCHOOL</td>
            <td>${academicYear}</td>
            <td>${escape(tc.cls || "")}</td>
            <td>TAMIL</td>
            <td>ENGLISH</td>
          </tr>
        </tbody>
      </table>

      <div class="sign-block">
        <div class="col">
          Signature of the Headmistress<br/>
          With date and school seal
        </div>
      </div>

      <div class="notes">
        <b>Note:</b>
        <ol style="margin:6px 0 0 22px;padding:0;">
          <li>Erasures and unauthenticated of fraudulent alterations<br/>In the certificate will lead to is cancellation.</li>
          <li>Should be signed in ink by the Head of the Institution<br/>Who will be held responsible for the correctness of the entries.</li>
        </ol>
      </div>

      <div class="declar">DECLARATION BY THE PARENT OR GUARDIAN</div>
      <div class="declar-body">
        I hereby declare that the particulars recorded against items 2 to 7 are correct and that no Change will be demanded by me in future.
      </div>

      <div class="parent-sign">Signature of the Parent of Guardian</div>
    `;
    w.focus();
    setTimeout(() => w.print(), 250);
  };

  // Local HTML escaper for the print template strings.
  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  return (
    <ModalShell title={`Transfer Certificate · ${tc.serialNo}`} sub={`${tc.studentName} (${formatClassLabel(tc.cls)})`} onClose={onClose} width={500}>
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ background: "var(--bg-2)", padding: 14, borderRadius: 10, fontSize: 12, lineHeight: 1.6 }}>
          Issued <b>{new Date(tc.issuedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</b> by <b>{tc.issuedBy}</b><br/>
          Reason: {tc.reason || "—"}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn accent" onClick={print}><Icon name="download" size={13} />Print TC</button>
        </div>
      </div>
    </ModalShell>
  );
}
