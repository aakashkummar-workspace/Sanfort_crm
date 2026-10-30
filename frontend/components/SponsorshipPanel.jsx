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
// The donor needs somewhere to go, not just a password. Built from the
// browser's own origin so it is right on localhost and on the live site
// without a hardcoded address to drift.
function loginUrl() {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}/login`;
}

function shareMessage(info) {
  return [
    "You can now see the progress of the student you support.",
    "",
    info.url,
    "",
    "Just open the link — no password needed.",
    "Please keep it private and do not forward it.",
  ].join("\n");
}

export default function SponsorshipPanel({ E, role, session, donors = [] }) {
  const canAllocate = ["admin", "principal", "academic_director", "teacher"].includes(role);

  const [donorId, setDonorId] = useState("");
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [clsFilter, setClsFilter] = useState("");
  const [loginInfo, setLoginInfo] = useState(null);
  // Status of any existing link. The link itself cannot be shown again — only
  // its hash is stored — so this reports whether one is live, not what it is.
  const [linkStatus, setLinkStatus] = useState(null);
  const [copied, setCopied] = useState(false);

  async function copyShare(info) {
    try {
      await navigator.clipboard.writeText(shareMessage(info));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("Could not copy — select the text above and copy it manually.");
    }
  }

  const students = E.ADDED_STUDENTS || [];

  const myClasses = useMemo(() => {
    if (role !== "teacher") return null;
    const list = Array.isArray(session?.linkedClasses) ? session.linkedClasses : [];
    return list.length ? new Set(list) : null;
  }, [role, session]);

  const allocatable = useMemo(() => {
    let out = students;
    if (myClasses) out = out.filter((s) => myClasses.has(s.cls));
    if (clsFilter) out = out.filter((s) => s.cls === clsFilter);
    const q = query.trim().toLowerCase();
    if (q) out = out.filter((s) => (s.name || "").toLowerCase().includes(q));
    const taken = new Set(rows.map((r) => r.studentId));
    return out.filter((s) => !taken.has(s.id))
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
      .slice(0, 60);
  }, [students, myClasses, clsFilter, query, rows]);

  // Classes present in the roster this user may allocate from.
  const classOptions = useMemo(() => {
    let pool = students;
    if (myClasses) pool = pool.filter((s) => myClasses.has(s.cls));
    return [...new Set(pool.map((s) => s.cls).filter(Boolean))].sort((a, b) => {
      // Montessori grades are stored as 13/14/15 but sit below Class I.
      const rank = (c) => { const n = Number(String(c).split("-")[0]) || 0; return n >= 13 ? n - 100 : n; };
      return rank(a) - rank(b) || String(a).localeCompare(String(b));
    });
  }, [students, myClasses]);

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

  const loadLinkStatus = useCallback(async (id) => {
    if (!id) { setLinkStatus(null); return; }
    try {
      const r = await fetch(`/api/donors/access-link?donorId=${encodeURIComponent(id)}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setLinkStatus(null); return; }
      const now = Date.now();
      const live = (j.links || []).find(
        (l) => !l.revokedAt && l.expiresAt && new Date(l.expiresAt).getTime() > now
      );
      setLinkStatus(live || null);
    } catch { setLinkStatus(null); }
  }, []);

  useEffect(() => { load(donorId); loadLinkStatus(donorId); }, [donorId, load, loadLinkStatus]);

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

  // Issue a one-click link. Creates the donor's account if they have none, and
  // revokes any previous link — so "send them a new one" also means the old one
  // stops working, which is what someone reaches for when a link has gone astray.
  async function createLink() {
    if (!donorId || busy) return;
    setBusy(true); setErr(""); setLoginInfo(null);
    try {
      const r = await fetch("/api/donors/access-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ donorId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to create link");
      setLoginInfo({
        url: `${window.location.origin}/api/donor-access?t=${j.token}`,
        email: j.email,
        expiresAt: j.link?.expiresAt || null,
        revokedPrevious: j.revokedPrevious || 0,
      });
      loadLinkStatus(donorId);
    } catch (e) { setErr(e.message || String(e)); }
    setBusy(false);
  }

  async function revokeLink() {
    if (!donorId || busy) return;
    if (!confirm("Revoke this donor's link? It stops working immediately.")) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/donors/access-link", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ donorId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      setLoginInfo(null);
      loadLinkStatus(donorId);
      setErr(j.revoked ? `Revoked ${j.revoked} link${j.revoked === 1 ? "" : "s"}.` : "No active link to revoke.");
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
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn sm accent" onClick={createLink} disabled={busy}
              title="Create a link this donor can open to see their students">
              <Icon name="link" size={12} />Share link
            </button>
            <button className="btn sm ghost" onClick={revokeLink} disabled={busy}
              title="Stop any existing link from working">
              <Icon name="x" size={12} />Revoke
            </button>
          </div>
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

        {/* Always-visible link status. The link itself cannot be redisplayed —
            only its hash is kept — so this says whether one is live, not what
            it is. Generating a new one is how you get a shareable copy again. */}
        {donorId && !loginInfo && (
          <div style={{
            marginTop: 11, padding: "10px 13px", borderRadius: 8,
            background: linkStatus ? "var(--ok-soft, #dfecd8)" : "var(--bg-2)",
            border: "1px solid var(--rule)",
            fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55,
          }}>
            {linkStatus ? (
              <>
                <Icon name="link" size={12} />{" "}
                <strong>{donor?.name} has a live link.</strong>{" "}
                Works until{" "}
                {new Date(linkStatus.expiresAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                {linkStatus.useCount
                  ? ` · opened ${linkStatus.useCount} time${linkStatus.useCount === 1 ? "" : "s"}`
                  : " · not opened yet"}.
                <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--ink-3)" }}>
                  The link cannot be shown again for safety. Use <em>Share link</em> to
                  issue a fresh one — the current link stops working when you do.
                </div>
              </>
            ) : (
              <>
                <strong>No link yet for {donor?.name}.</strong>{" "}
                Use <em>Share link</em> above to create one you can send them.
              </>
            )}
          </div>
        )}

        {loginInfo && (
          <div style={{ marginTop: 12, padding: "12px 14px", background: "var(--accent-soft)", borderRadius: 8, fontSize: 12.5 }}>
            <strong>Link ready for {donor?.name}.</strong> Send it to them — anyone
            holding this link can see the students allocated above, so it should not be
            forwarded or posted anywhere.
            {loginInfo.expiresAt && (
              <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--ink-3)" }}>
                Works until {new Date(loginInfo.expiresAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                {loginInfo.revokedPrevious ? " · any earlier link has stopped working" : ""}
              </div>
            )}
            <div style={{
              marginTop: 9, padding: "10px 12px", background: "var(--bg)",
              border: "1px solid var(--rule)", borderRadius: 7,
              fontFamily: "var(--font-mono)", fontSize: 11.5, whiteSpace: "pre-wrap",
              lineHeight: 1.7,
            }}>{shareMessage(loginInfo)}</div>
            <div style={{ display: "flex", gap: 7, marginTop: 9, flexWrap: "wrap" }}>
              <button className="btn sm accent" onClick={() => copyShare(loginInfo)}>
                <Icon name="copy" size={12} />{copied ? "Copied" : "Copy message"}
              </button>
              <a
                className="btn sm ghost"
                href={`https://wa.me/?text=${encodeURIComponent(shareMessage(loginInfo))}`}
                target="_blank" rel="noopener noreferrer"
              >
                <Icon name="whatsapp" size={12} />Send on WhatsApp
              </a>
              <a
                className="btn sm ghost"
                href={`mailto:${encodeURIComponent(loginInfo.email)}?subject=${encodeURIComponent("Your sponsor login")}&body=${encodeURIComponent(shareMessage(loginInfo))}`}
              >
                <Icon name="mail" size={12} />Email it
              </a>
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
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                <select className="select" value={clsFilter} onChange={(e) => setClsFilter(e.target.value)}>
                  <option value="">All classes</option>
                  {classOptions.map((c) => (
                    <option key={c} value={c}>{formatClassLabel(c)}</option>
                  ))}
                </select>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name…"
                  style={{
                    flex: "1 1 200px", minWidth: 160, maxWidth: 300,
                    padding: "7px 11px", fontSize: 12.5,
                    border: "1px solid var(--rule)", borderRadius: 7,
                    background: "var(--bg)", color: "var(--ink)",
                  }}
                />
                <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>
                  {allocatable.length === 0
                    ? "none available"
                    : `${allocatable.length} shown${allocatable.length === 60 ? " (narrow to see more)" : ""}`}
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 260, overflowY: "auto" }}>
                {allocatable.length === 0 && (
                  <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
                    {query.trim() || clsFilter
                      ? "No students match."
                      : "Every student is already allocated to this donor."}
                  </span>
                )}
                {allocatable.map((s) => (
                  <button key={s.id} className="btn sm ghost" onClick={() => allocate(s.id)} disabled={busy}
                    title={`Allocate ${s.name} to this donor`}>
                    {s.name} <span style={{ color: "var(--ink-4)" }}>· {s.cls ? formatClassLabel(s.cls) : "—"}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
