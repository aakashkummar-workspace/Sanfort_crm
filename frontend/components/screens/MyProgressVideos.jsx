"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "../Icon";

function periodLabel(p) {
  if (!/^\d{4}-\d{2}$/.test(String(p || ""))) return p || "—";
  const [y, m] = p.split("-");
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

// The timeline a parent or a sponsoring donor sees. Both roles get the same
// screen because they want the same thing — the months, newest first — and
// the server has already decided which videos each may receive. Nothing here
// filters on visibility: doing it client-side would imply the data arrived.
export default function MyProgressVideos({ E = {}, session = {} }) {
  const students = useMemo(() => E.ADDED_STUDENTS || [], [E.ADDED_STUDENTS]);
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const r = await fetch("/api/progress-videos?limit=120", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Could not load videos");
      setVideos(j.videos || []);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const nameFor = useCallback(
    (id) => students.find((s) => s.id === id)?.name || id,
    [students]
  );

  // Donors may sponsor more than one child, so group by student. A parent
  // with one child simply gets one group.
  const groups = useMemo(() => {
    const m = new Map();
    for (const v of videos) {
      if (!m.has(v.studentId)) m.set(v.studentId, []);
      m.get(v.studentId).push(v);
    }
    for (const list of m.values()) {
      list.sort((a, b) => String(b.period).localeCompare(String(a.period)));
    }
    return [...m.entries()];
  }, [videos]);

  return (
    <div className="screen">
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Progress videos</div>
            <div className="card-sub">
              A short video from the teachers, month by month.
            </div>
          </div>
          <button className="btn sm ghost" onClick={load} disabled={loading}>
            <Icon name="refresh" size={12} />Refresh
          </button>
        </div>

        {err ? (
          <div className="card-body" style={{ color: "var(--err)", fontSize: 12.5 }}>{err}</div>
        ) : loading ? (
          <div className="card-body" style={{ fontSize: 12.5, color: "var(--ink-4)" }}>Loading…</div>
        ) : groups.length === 0 ? (
          <div className="card-body" style={{ fontSize: 12.5, color: "var(--ink-4)", lineHeight: 1.65 }}>
            No videos have been shared yet. The school adds these month by month —
            please check back later.
          </div>
        ) : (
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {groups.map(([studentId, list]) => (
              <div key={studentId}>
                {groups.length > 1 && (
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 9 }}>
                    {nameFor(studentId)}
                  </div>
                )}
                <div style={{
                  display: "grid", gap: 11,
                  gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
                }}>
                  {list.map((v) => (
                    <button key={v.id} onClick={() => setOpen(v)}
                      style={{
                        textAlign: "left", cursor: "pointer",
                        background: "var(--bg-2)", border: "1px solid var(--rule)",
                        borderRadius: 10, padding: 12, display: "flex",
                        flexDirection: "column", gap: 7,
                      }}>
                      <div style={{
                        display: "grid", placeItems: "center",
                        height: 74, borderRadius: 7, background: "var(--bg-3, rgba(0,0,0,.18))",
                      }}>
                        <Icon name="play" size={22} />
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 12.5 }}>{periodLabel(v.period)}</div>
                      {v.title && (
                        <div style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{v.title}</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {open && (
        <div onClick={() => setOpen(null)} style={{
          position: "fixed", inset: 0, background: "rgba(20,16,10,0.6)",
          display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
        }}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 680 }}>
            <div className="card-head">
              <div>
                <div className="card-title">{periodLabel(open.period)}</div>
                <div className="card-sub">
                  {nameFor(open.studentId)}{open.title ? ` · ${open.title}` : ""}
                </div>
              </div>
              <button className="icon-btn" onClick={() => setOpen(null)}><Icon name="x" size={14} /></button>
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
              <video
                src={`/api/progress-videos/${open.id}?play=1`}
                controls playsInline preload="metadata" autoPlay
                style={{ width: "100%", borderRadius: 8, background: "#000", maxHeight: "60vh" }}
              />
              {open.note && (
                <div style={{ fontSize: 12.5, lineHeight: 1.65, color: "var(--ink-2)" }}>{open.note}</div>
              )}
              {session.role === "donor" && (
                <div style={{ fontSize: 11.5, color: "var(--ink-4)", lineHeight: 1.6 }}>
                  Shared with you by the school because you sponsor this student.
                  Please keep it private — do not forward or post it.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
