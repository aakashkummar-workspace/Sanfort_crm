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

const CHIP_TONE = {
  ok:     { bg: "rgba(34,139,94,0.12)",  fg: "var(--ok, #1f7a52)" },
  warn:   { bg: "rgba(201,124,32,0.14)", fg: "var(--warn, #a66414)" },
  muted:  { bg: "var(--bg-2)",           fg: "var(--ink-4)" },
};

function Chip({ tone = "muted", children }) {
  const t = CHIP_TONE[tone] || CHIP_TONE.muted;
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 600, letterSpacing: 0.2,
      padding: "3px 8px", borderRadius: 999,
      background: t.bg, color: t.fg, whiteSpace: "nowrap",
    }}>{children}</span>
  );
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

  // The videos the player can step through: those of the students currently
  // visible, in the same order the list shows them.
  const watchable = useMemo(
    () => rows.map((s) => byStudent.get(s.id)).filter(Boolean),
    [rows, byStudent]
  );
  const playIndex = playing ? watchable.findIndex((v) => v.id === playing.id) : -1;

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

                  {/* Who can see it reads as a status, not two form controls.
                      Changing it is rare; knowing it at a glance is not, and a
                      checkbox per row for a rarely-touched setting is what made
                      this list hard to scan. Both toggles live in the player. */}
                  {v ? (
                    <>
                      <div style={{
                        display: "flex", alignItems: "center", gap: 6,
                        flexShrink: 0,
                      }}>
                        <Chip tone="ok">Parents</Chip>
                        {v.visibleToDonor && <Chip tone="warn">Donor</Chip>}
                        {v.visibleToParent === false && !v.visibleToDonor && (
                          <Chip tone="muted">Hidden</Chip>
                        )}
                      </div>

                      <div style={{
                        fontSize: 11, color: "var(--ink-4)",
                        textAlign: "right", flexShrink: 0, whiteSpace: "nowrap",
                      }}>
                        {fmtSize(v.sizeBytes)} · {v.uploadedBy || "—"}
                      </div>

                      <button className="btn sm ghost" style={{ flexShrink: 0 }}
                        onClick={() => setPlaying(v)}>
                        <Icon name="play" size={12} />Watch
                      </button>
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: 11.5, color: "var(--ink-4)", flexShrink: 0 }}>
                        Not uploaded
                      </span>
                      <button className="btn sm accent" style={{ flexShrink: 0 }}
                        onClick={() => setUploadFor(s)}>
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
        <PlayerModal
          video={videos.find((v) => v.id === playing.id) || playing}
          student={students.find((s) => s.id === playing.studentId)}
          canManage={canManage}
          // Step through the videos in the order they appear on screen, so
          // next/previous follows the current filter and sort rather than
          // some hidden ordering of its own.
          position={playIndex >= 0 ? { at: playIndex + 1, of: watchable.length } : null}
          onPrev={playIndex > 0 ? () => setPlaying(watchable[playIndex - 1]) : null}
          onNext={playIndex >= 0 && playIndex < watchable.length - 1
            ? () => setPlaying(watchable[playIndex + 1]) : null}
          onVisibility={setVisibility}
          onReplace={() => {
            const s = students.find((x) => x.id === playing.studentId);
            setPlaying(null);
            if (s) setUploadFor(s);
          }}
          onDelete={async () => {
            const v = playing;
            setPlaying(null);
            await remove(v);
          }}
          onClose={() => setPlaying(null)}
        />
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

// The player is also where a video is managed. Visibility, replace and delete
// live here rather than on every list row: they are occasional actions, and
// putting six controls on each of 277 rows is what made the list unreadable.
function PlayerModal({
  video, student, canManage, position, onPrev, onNext,
  onVisibility, onReplace, onDelete, onClose,
}) {
  // Arrow keys step through the month without reaching for the mouse — the
  // point of this screen is reviewing many videos in a sitting.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "ArrowLeft" && onPrev) onPrev();
      if (e.key === "ArrowRight" && onNext) onNext();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onPrev, onNext]);

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
              {position ? ` · ${position.at} of ${position.of}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button className="icon-btn" onClick={onPrev || undefined} disabled={!onPrev}
              title="Previous student (←)"
              style={{ opacity: onPrev ? 1 : 0.35, cursor: onPrev ? "pointer" : "default" }}>
              <Icon name="arrowLeft" size={14} />
            </button>
            <button className="icon-btn" onClick={onNext || undefined} disabled={!onNext}
              title="Next student (→)"
              style={{ opacity: onNext ? 1 : 0.35, cursor: onNext ? "pointer" : "default" }}>
              <Icon name="arrowRight" size={14} />
            </button>
            <button className="icon-btn" onClick={onClose} title="Close">
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          {/* Keyed on the video id: without it React reuses the same element
              when stepping to the next student and the previous video keeps
              playing behind the new metadata. */}
          <video
            key={video.id}
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

          <div style={{ borderTop: "1px solid var(--rule)", paddingTop: 13, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{
              fontSize: 11, fontWeight: 500, color: "var(--ink-2)",
              textTransform: "uppercase", letterSpacing: 0.4,
            }}>Who can watch this</div>

            <label style={{
              display: "flex", alignItems: "center", gap: 8, fontSize: 12.5,
              cursor: canManage ? "pointer" : "default", opacity: canManage ? 1 : 0.65,
            }}>
              <input type="checkbox" checked={video.visibleToParent !== false} disabled={!canManage}
                onChange={(e) => onVisibility?.(video, { visibleToParent: e.target.checked })} />
              Parents
            </label>

            {/* Off by default. A sponsor is a third party and the family has
                not been told the sponsorship exists, so this stays a
                deliberate tick with the consequence spelled out. */}
            <label style={{
              display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5,
              cursor: canManage ? "pointer" : "default", opacity: canManage ? 1 : 0.65,
            }}>
              <input type="checkbox" checked={video.visibleToDonor === true} disabled={!canManage}
                onChange={(e) => onVisibility?.(video, { visibleToDonor: e.target.checked })}
                style={{ marginTop: 2 }} />
              <span>
                Sponsoring donor
                <span style={{ display: "block", fontSize: 11, color: "var(--ink-4)", lineHeight: 1.5 }}>
                  The sponsor will see this child on video. The family has not been told.
                </span>
              </span>
            </label>

            {/* Replace is available to anyone who may upload; deleting a
                child's video is admin/principal only. */}
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 2 }}>
              <button className="btn sm ghost" onClick={onReplace}>
                <Icon name="upload" size={12} />Replace video
              </button>
              {canManage && (
                <button className="btn sm ghost" onClick={onDelete} style={{ color: "var(--err)" }}>
                  <Icon name="x" size={12} />Delete
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
