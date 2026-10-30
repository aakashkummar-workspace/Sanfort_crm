"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { KPI } from "../ui";
import { formatClassLabel } from "@/lib/format";

const MB = 1048576;

function fmtSize(b) {
  if (!b && b !== 0) return "—";
  if (b < MB) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / MB).toFixed(1)} MB`;
}

function periodLabel(p) {
  if (!/^\d{4}-\d{2}$/.test(String(p || ""))) return p || "—";
  const [y, m] = p.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

// Last 12 months, newest first — the window a monthly video actually lives in.
function recentPeriods(n = 12) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export default function ProgressVideos({ E = {}, session = {}, showToast }) {
  const students = useMemo(() => E.ADDED_STUDENTS || [], [E.ADDED_STUDENTS]);
  const role = session.role;
  const canManage = role === "admin" || role === "principal";

  const periods = useMemo(() => recentPeriods(12), []);
  const [period, setPeriod] = useState(periods[0]);
  const [cls, setCls] = useState("all");
  const [q, setQ] = useState("");

  const [videos, setVideos] = useState([]);
  const [disk, setDisk] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [uploadFor, setUploadFor] = useState(null);
  const [playing, setPlaying] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const r = await fetch(`/api/progress-videos?period=${encodeURIComponent(period)}&limit=200`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Could not load videos");
      setVideos(j.videos || []);
      if (j.disk) setDisk(j.disk);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setLoading(false); }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const byStudent = useMemo(() => {
    const m = new Map();
    for (const v of videos) m.set(v.studentId, v);
    return m;
  }, [videos]);

  const classes = useMemo(() => {
    const s = new Set(students.map((x) => x.cls).filter(Boolean));
    return [...s].sort();
  }, [students]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return students
      .filter((s) => cls === "all" || s.cls === cls)
      .filter((s) => !needle || `${s.name} ${s.id}`.toLowerCase().includes(needle))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [students, cls, q]);

  const done = rows.filter((s) => byStudent.has(s.id)).length;
  const sharedWithDonor = videos.filter((v) => v.visibleToDonor).length;

  async function setVisibility(video, patch) {
    try {
      const r = await fetch(`/api/progress-videos/${video.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Could not change visibility");
      setVideos((prev) => prev.map((v) => (v.id === video.id ? j.video : v)));
    } catch (e) { showToast?.(e.message || String(e), "err"); }
  }

  async function remove(video) {
    const s = students.find((x) => x.id === video.studentId);
    if (!window.confirm(`Delete ${s?.name || video.studentId}'s ${periodLabel(video.period)} video? The file is removed permanently.`)) return;
    try {
      const r = await fetch(`/api/progress-videos/${video.id}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Could not delete");
      setVideos((prev) => prev.filter((v) => v.id !== video.id));
      showToast?.("Video deleted", "ok");
    } catch (e) { showToast?.(e.message || String(e), "err"); }
  }

  const lowDisk = disk && disk.freeBytes < 5 * 1024 * MB;

  return (
    <div className="screen">
      <div className="kpi-row">
        <KPI label="Students" value={rows.length} sub={cls === "all" ? "All classes" : formatClassLabel(cls)} />
        <KPI label={`Uploaded · ${periodLabel(period)}`} value={done} sub={`of ${rows.length}`} />
        <KPI label="Shared with donors" value={sharedWithDonor} sub="this month" />
        <KPI
          label="Storage free"
          value={disk ? `${(disk.freeBytes / (1024 * MB)).toFixed(1)} GB` : "—"}
          sub={disk ? `of ${(disk.totalBytes / (1024 * MB)).toFixed(0)} GB` : "unknown"}
          tone={lowDisk ? "warn" : undefined}
        />
      </div>

      {lowDisk && (
        <div className="card" style={{ borderColor: "var(--warn)", marginBottom: 12 }}>
          <div className="card-body" style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
            <Icon name="warning" size={15} />
            <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
              <strong>Storage is running low.</strong> Videos are large and this
              disk is nearly full. Tell your administrator before uploading more —
              a full disk stops uploads and can affect the rest of the CRM.
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Monthly progress videos</div>
            <div className="card-sub">
              One short video per student per month. Re-uploading a month replaces it.
            </div>
          </div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            <select className="input sm" value={period} onChange={(e) => setPeriod(e.target.value)}>
              {periods.map((p) => <option key={p} value={p}>{periodLabel(p)}</option>)}
            </select>
            <select className="input sm" value={cls} onChange={(e) => setCls(e.target.value)}>
              <option value="all">All classes</option>
              {classes.map((c) => <option key={c} value={c}>{formatClassLabel(c)}</option>)}
            </select>
            <input
              className="input sm" placeholder="Search student…"
              value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 160 }}
            />
          </div>
        </div>

        {err && (
          <div className="card-body" style={{ color: "var(--err)", fontSize: 12.5 }}>{err}</div>
        )}

        {loading ? (
          <div className="card-body" style={{ fontSize: 12.5, color: "var(--ink-4)" }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div className="card-body" style={{ fontSize: 12.5, color: "var(--ink-4)" }}>
            No students match that filter.
          </div>
        ) : (
          <div className="card-body" style={{ padding: 0 }}>
            {rows.map((s) => {
              const v = byStudent.get(s.id);
              return (
                <div key={s.id} className="lrow" style={{ alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{s.name}</div>
                    <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
                      {s.id} · {formatClassLabel(s.cls)}
                    </div>
                  </div>

                  {v ? (
                    <>
                      <div style={{ fontSize: 11, color: "var(--ink-4)", textAlign: "right", minWidth: 120 }}>
                        {fmtSize(v.sizeBytes)}
                        <div>by {v.uploadedBy || "—"}</div>
                      </div>

                      <label title="Parents can watch this video"
                        style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, cursor: canManage ? "pointer" : "default" }}>
                        <input type="checkbox" checked={v.visibleToParent !== false} disabled={!canManage}
                          onChange={(e) => setVisibility(v, { visibleToParent: e.target.checked })} />
                        Parent
                      </label>

                      {/* Donor access is per video and off by default. A sponsor
                          is a third party and the family has not been told the
                          sponsorship exists, so this stays a deliberate tick. */}
                      <label title="Sponsoring donor can watch this video"
                        style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, cursor: canManage ? "pointer" : "default" }}>
                        <input type="checkbox" checked={v.visibleToDonor === true} disabled={!canManage}
                          onChange={(e) => setVisibility(v, { visibleToDonor: e.target.checked })} />
                        Donor
                      </label>

                      <button className="btn sm ghost" onClick={() => setPlaying(v)}>
                        <Icon name="play" size={12} />Watch
                      </button>
                      <button className="btn sm ghost" onClick={() => setUploadFor(s)}>
                        <Icon name="upload" size={12} />Replace
                      </button>
                      {canManage && (
                        <button className="btn sm ghost" onClick={() => remove(v)}
                          style={{ color: "var(--err)" }}>
                          <Icon name="x" size={12} />
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: 11, color: "var(--ink-4)" }}>Not uploaded</span>
                      <button className="btn sm accent" onClick={() => setUploadFor(s)}>
                        <Icon name="upload" size={12} />Upload
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {uploadFor && (
        <UploadModal
          student={uploadFor}
          period={period}
          existing={byStudent.get(uploadFor.id) || null}
          onClose={() => setUploadFor(null)}
          onDone={(v) => {
            setVideos((prev) => {
              const without = prev.filter((x) => x.id !== v.id && x.studentId !== v.studentId);
              return [v, ...without];
            });
            setUploadFor(null);
            showToast?.("Video uploaded", "ok");
          }}
        />
      )}

      {playing && (
        <PlayerModal video={playing} student={students.find((s) => s.id === playing.studentId)}
          onClose={() => setPlaying(null)} />
      )}
    </div>
  );
}

// Upload with real progress. XMLHttpRequest rather than fetch because fetch
// gives no upload progress event, and a 25 MB upload with no feedback looks
// like a hung screen.
function UploadModal({ student, period, existing, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [toParent, setToParent] = useState(true);
  const [toDonor, setToDonor] = useState(false);
  const [pct, setPct] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const xhrRef = useRef(null);

  useEffect(() => () => { try { xhrRef.current?.abort(); } catch {} }, []);

  function submit(e) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true); setErr(""); setPct(0);

    const fd = new FormData();
    fd.append("file", file);
    fd.append("studentId", student.id);
    fd.append("period", period);
    fd.append("title", title.trim());
    fd.append("note", note.trim());
    fd.append("visibleToParent", String(toParent));
    fd.append("visibleToDonor", String(toDonor));

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", "/api/progress-videos");
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) setPct(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      setBusy(false);
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && j.ok) onDone(j.video);
      else setErr(j.error || `Upload failed (${xhr.status})`);
    };
    xhr.onerror = () => { setBusy(false); setErr("Upload failed — check the connection and try again."); };
    xhr.send(fd);
  }

  return (
    <div onClick={busy ? undefined : onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 520 }}>
        <div className="card-head">
          <div>
            <div className="card-title">{existing ? "Replace" : "Upload"} · {student.name}</div>
            <div className="card-sub">{periodLabel(period)} · {formatClassLabel(student.cls)}</div>
          </div>
          {!busy && <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>}
        </div>

        <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {existing && (
            <div style={{ fontSize: 12, color: "var(--ink-4)", lineHeight: 1.6 }}>
              This month already has a video ({fmtSize(existing.sizeBytes)}). Uploading
              replaces it — the old file is deleted.
            </div>
          )}

          <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>
              Video file
            </span>
            <input type="file" className="input" accept="video/*" disabled={busy}
              onChange={(e) => { setFile(e.target.files?.[0] || null); setErr(""); }} />
            {file && (
              <span style={{ fontSize: 11, color: "var(--ink-4)" }}>
                {file.name} · {fmtSize(file.size)}
              </span>
            )}
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>
              Title (optional)
            </span>
            <input className="input" value={title} disabled={busy}
              onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Reading progress" />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>
              What this month showed (optional)
            </span>
            <textarea className="input" rows={3} value={note} disabled={busy}
              onChange={(e) => setNote(e.target.value)} />
          </label>

          <div style={{ display: "flex", flexDirection: "column", gap: 7, fontSize: 12.5 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <input type="checkbox" checked={toParent} disabled={busy}
                onChange={(e) => setToParent(e.target.checked)} />
              Parents can watch this
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <input type="checkbox" checked={toDonor} disabled={busy}
                onChange={(e) => setToDonor(e.target.checked)} />
              Sponsoring donor can watch this
            </label>
            {toDonor && (
              <div style={{
                fontSize: 11.5, color: "var(--ink-4)", lineHeight: 1.6,
                paddingLeft: 24,
              }}>
                The sponsor will see this child on video. The family has not been
                told the sponsorship exists, so tick this only if the school is
                comfortable with that.
              </div>
            )}
          </div>

          {err && <div style={{ color: "var(--err)", fontSize: 12.5, lineHeight: 1.6 }}>{err}</div>}

          {busy && (
            <div>
              <div style={{ height: 6, background: "var(--bg-2)", borderRadius: 999, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)", transition: "width .2s" }} />
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 5 }}>
                {pct < 100 ? `Uploading… ${pct}%` : "Saving…"}
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 7, justifyContent: "flex-end" }}>
            {!busy && <button type="button" className="btn sm ghost" onClick={onClose}>Cancel</button>}
            <button type="submit" className="btn sm accent" disabled={!file || busy}>
              <Icon name="upload" size={12} />{busy ? "Uploading…" : existing ? "Replace video" : "Upload"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PlayerModal({ video, student, onClose }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.6)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 680 }}>
        <div className="card-head">
          <div>
            <div className="card-title">{student?.name || video.studentId}</div>
            <div className="card-sub">
              {periodLabel(video.period)}
              {video.title ? ` · ${video.title}` : ""}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          <video
            src={`/api/progress-videos/${video.id}?play=1`}
            controls playsInline preload="metadata"
            style={{ width: "100%", borderRadius: 8, background: "#000", maxHeight: "60vh" }}
          />
          {video.note && (
            <div style={{ fontSize: 12.5, lineHeight: 1.65, color: "var(--ink-2)" }}>{video.note}</div>
          )}
          <div style={{ fontSize: 11, color: "var(--ink-4)" }}>
            {fmtSize(video.sizeBytes)} · uploaded by {video.uploadedBy || "—"}
            {video.uploadedAt ? ` on ${new Date(video.uploadedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
