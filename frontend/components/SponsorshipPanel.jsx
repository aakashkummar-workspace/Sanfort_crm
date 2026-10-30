"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "./Icon";
import { formatClassLabel } from "@/lib/format";

// Allocate students to a donor.
//
// The allocation is internal: nothing here is ever shown to the student or
// their parent. That is structural rather than filtered — the link lives in
// its own table, so a student record handed to a parent has no sponsorship
// field at all. See the comment on donor_sponsorships in schema.sql.
//
// A teacher may only allocate students in their own classes. That is enforced
// server-side in app/api/donor-sponsorships/route.js; the filtering here is a
// convenience, not the boundary.
export default function SponsorshipPanel({ E, role, session, donors = [] }) {
  const canAllocate = ["admin", "principal", "academic_director", "teacher"].includes(role);

  const [donorId, setDonorId] = useState("");
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [loginInfo, setLoginInfo] = useState(null);

  const students = E.ADDED_STUDENTS || [];

  const myClasses = useMemo(() => {
    if (role !== "teacher") return null;
    const list = Array.isArray(session?.linkedClasses) ? session.linkedClasses : [];
    return list.length ? new Set(list) : null;
  }, [role, session]);

  const allocatable = useMemo(() => {
    let out = students;
    if (myClasses) out = out.filter((s) => myClasses.has(s.cls));
    const q = query.trim().toLowerCase();
    if (q) out = out.filter((s) => (s.name || "").toLowerCase().includes(q));
    const taken = new Set(rows.map((r) => r.studentId));
    return out.filter((s) => !taken.has(s.id)).slice(0, 40);
  }, [students, myClasses, query, rows]);

  const load = useCallback(async (id) => {
    if (!id) { setRows([]); return; }
    setErr("");
    try {
      const r = await fetch(`/api/donor-sponsorships?donorId=${encodeURIComponent(id)}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to load");
      setRows(j.items || []);
    } catch (e) {
      setErr(e.message || String(e));
      setRows([]);
    }
  }, []);

  useEffect(() => { load(donorId); }, [donorId, load]);

  async function allocate(studentId) {
    if (!donorId || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/donor-sponsorships", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ donorId, studentId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to allocate");
      await load(donorId);
      setQuery("");
    } catch (e) { setErr(e.message || String(e)); }
    setBusy(false);
  }

  async function end(id) {
    if (busy) return;
    if (!confirm("End this sponsorship? The student stops appearing on the donor's dashboard.")) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/donor-sponsorships", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      await load(donorId);
    } catch (e) { setErr(e.message || String(e)); }
    setBusy(false);
  }

  async function createLogin() {
    if (!donorId || busy) return;
    setBusy(true); setErr(""); setLoginInfo(null);
    try {
      const r = await fetch("/api/donors/provision-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ donorId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to create login");
      setLoginInfo(j.login);
    } catch (e) { setErr(e.message || String(e)); }
    setBusy(false);
  }

  if (!canAllocate) return null;

  const donor = donors.find((d) => d.id === donorId);
  const nameOf = (sid) => (students.find((s) => s.id === sid) || {}).name || sid;
  const clsOf  = (sid) => {
    const s = students.find((x) => x.id === sid);
    return s?.cls ? formatClassLabel(s.cls) : "—";
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">Sponsored students</div>
          <div className="card-sub">
            Allocate students to a donor. Not visible to the student or their parent.
          </div>
        </div>
        {donorId && (role === "admin" || role === "principal") && (
          <button className="btn sm" onClick={createLogin} disabled={busy} title="Create a login so this donor can see their students">
            <Icon name="user" size={12} />Create donor login
          </button>
        )}
      </div>

      <div className="card-body" style={{ paddingTop: 12 }}>
        <select
          className="select"
          value={donorId}
          onChange={(e) => { setDonorId(e.target.value); setLoginInfo(null); }}
          style={{ minWidth: 240 }}
        >
          <option value="">Choose a donor…</option>
          {donors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>

        {err && (
          <div style={{ marginTop: 10, fontSize: 12, color: "var(--accent-2)" }}>{err}</div>
        )}

        {loginInfo && (
          <div style={{ marginTop: 12, padding: "11px 13px", background: "var(--accent-soft)", borderRadius: 8, fontSize: 12.5 }}>
            <strong>Login created for {donor?.name}.</strong> Share these once — the
            password cannot be shown again.
            <div style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {loginInfo.email}<br />{loginInfo.password}
            </div>
          </div>
        )}

        {donorId && (
          <>
            <div style={{ marginTop: 14 }}>
              {rows.length === 0 ? (
                <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                  No students allocated to {donor?.name || "this donor"} yet.
                </div>
              ) : (
                <table className="table">
                  <thead><tr><th>Student</th><th>Class</th><th>Allocated by</th><th></th></tr></thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr key={s.id}>
                        <td style={{ fontSize: 12.5, fontWeight: 500 }}>{nameOf(s.studentId)}</td>
                        <td><span className="chip">{clsOf(s.studentId)}</span></td>
                        <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{s.allocatedBy || "—"}</td>
                        <td style={{ textAlign: "right" }}>
                          <button className="icon-btn" onClick={() => end(s.id)} disabled={busy} title="End this sponsorship">
                            <Icon name="x" size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div style={{ marginTop: 14, borderTop: "1px solid var(--rule)", paddingTop: 12 }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={myClasses ? "Find a student in your classes…" : "Find a student to allocate…"}
                style={{
                  width: "100%", maxWidth: 320, padding: "7px 11px", fontSize: 12.5,
                  border: "1px solid var(--rule)", borderRadius: 7,
                  background: "var(--bg)", color: "var(--ink)",
                }}
              />
              {query.trim() && (
                <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {allocatable.length === 0 && (
                    <span style={{ fontSize: 12, color: "var(--ink-4)" }}>No matching students.</span>
                  )}
                  {allocatable.map((s) => (
                    <button key={s.id} className="btn sm ghost" onClick={() => allocate(s.id)} disabled={busy}>
                      {s.name} <span style={{ color: "var(--ink-4)" }}>· {s.cls ? formatClassLabel(s.cls) : "—"}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
