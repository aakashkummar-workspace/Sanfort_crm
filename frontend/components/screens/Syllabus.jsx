"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import Icon from "../Icon";
import { KPI } from "../ui";
import { formatClassLabel } from "@/lib/format";

// Same alias-to-canonical-field map as the Library importer — covers the
// most common header spellings ("Class", "CLASS_ID", "section_class", …)
// so a teacher can hand back the file with whatever capitalisation they
// prefer and the importer still latches on.
const COLUMN_ALIASES = {
  cls:     ["class", "cls", "classid", "section", "classsection", "grade"],
  subject: ["subject", "sub", "course"],
  chapter: ["chapter", "unit", "module"],
  topic:   ["topic", "lesson", "title", "name"],
  term:    ["term", "semester", "quarter"],
  weekNo:  ["week", "weekno", "weeknumber", "wk"],
  notes:   ["notes", "note", "remarks", "reference", "ref", "page", "pages"],
};

function normHeader(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function inferColumnMap(headers) {
  const map = {};
  const norm = headers.map(normHeader);
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const idx = norm.indexOf(alias);
      if (idx !== -1) { map[field] = idx; break; }
    }
  }
  return map;
}

// ---------- toast & modal shell (same pattern used elsewhere in the app) ----
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

function Field({ label, hint, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{hint}</span>}
    </label>
  );
}

// Build "1-A, 1-B, 2-A, ..." strings from the live CLASSES roster. Falls
// back to the bundled 1-8 list with sections A/B if the API hasn't returned
// any classes yet (typical on a totally fresh install).
function buildClassOptions(classes) {
  const list = (Array.isArray(classes) && classes.length)
    ? classes
    : Array.from({ length: 8 }, (_, i) => ({ n: i + 1, sections: ["A", "B"] }));
  const out = [];
  for (const c of list) {
    const sections = Array.isArray(c.sections) && c.sections.length ? c.sections : ["A"];
    for (const sec of sections) out.push(`${c.n}-${sec}`);
  }
  // Numeric-aware sort so 12-C comes after 2-A, not between 1-B and 2-A.
  return out.sort((a, b) => {
    const [an, as] = a.split("-");
    const [bn, bs] = b.split("-");
    const dn = Number(an) - Number(bn);
    return dn !== 0 ? dn : String(as || "").localeCompare(String(bs || ""));
  });
}

// ---------- main screen --------------------------------------------------
export default function ScreenSyllabus({ E, refresh, role, session }) {
  // Write access mirrors the API: admin / principal / academic_director by
  // default; custom roles via E.ACCESS.syllabus.canEdit. Teachers / parents
  // are read-only (they consume the syllabus, they don't author it).
  const canManage = (() => {
    if (["admin", "principal", "academic_director"].includes(role)) return true;
    const a = E?.ACCESS?.[role]?.syllabus;
    return !!(a && a.canEdit);
  })();
  const isTeacher = role === "teacher";
  const isParent  = role === "parent";

  const allRows = useMemo(() => {
    const rows = E?.SYLLABUS || [];
    return rows.map((r) => ({ ...r, cls: String(r.cls || "").toUpperCase() }));
  }, [E?.SYLLABUS]);

  // Class scope. Teachers see only the section(s) they're assigned to,
  // parents only their child's class. Managers see everything.
  const myClasses = useMemo(() => {
    if (isTeacher) {
      const lc = Array.isArray(session?.linkedClasses) ? session.linkedClasses : [];
      const all = lc.length ? lc : (session?.linkedId ? [session.linkedId] : []);
      return new Set(all.map((c) => String(c).toUpperCase()));
    }
    if (isParent) {
      const child = (E?.ADDED_STUDENTS || [])[0];
      return child?.cls ? new Set([String(child.cls).toUpperCase()]) : new Set();
    }
    return null; // null = no scope filter
  }, [isTeacher, isParent, session, E?.ADDED_STUDENTS]);

  const visibleRows = useMemo(() => {
    if (!myClasses) return allRows;
    if (myClasses.size === 0) return [];
    return allRows.filter((r) => myClasses.has(r.cls));
  }, [allRows, myClasses]);

  // Class picker options:
  //  - managers see every class from the live roster (so they can seed
  //    a brand-new class even before any rows exist) PLUS any "orphan"
  //    class ids that exist in the data but aren't in the canonical
  //    roster (e.g. an Excel import that landed under "GRADE1" or "16").
  //    Without this, a bad import becomes invisible — there's no chip
  //    to navigate to and no way to wipe it.
  //  - teachers/parents are limited to whatever classes they're scoped to.
  const orphanClasses = useMemo(() => {
    const canonical = new Set(buildClassOptions(E?.CLASSES || []));
    const fromData = new Set(visibleRows.map((r) => r.cls));
    const out = [];
    for (const c of fromData) if (!canonical.has(c)) out.push(c);
    return out.sort();
  }, [E?.CLASSES, visibleRows]);

  const classOptions = useMemo(() => {
    if (myClasses && myClasses.size > 0) return [...myClasses].sort();
    if (myClasses && myClasses.size === 0) return [];
    return [...buildClassOptions(E?.CLASSES || []), ...orphanClasses];
  }, [E?.CLASSES, myClasses, orphanClasses]);

  const [selectedClass, setSelectedClass] = useState(() => classOptions[0] || "");
  // Re-snap to a valid class when the option list changes (e.g. data refresh
  // adds a new section). Keeps the user's pick if it still exists.
  useEffect(() => {
    if (classOptions.length === 0) { setSelectedClass(""); return; }
    if (!classOptions.includes(selectedClass)) setSelectedClass(classOptions[0]);
  }, [classOptions, selectedClass]);

  const rowsForClass = useMemo(
    () => visibleRows.filter((r) => r.cls === selectedClass),
    [visibleRows, selectedClass]
  );

  // ---------- modal / toast state ----------
  const [toast, setToast] = useState(null);
  const showToast = (msg, tone) => { setToast({ msg, tone }); setTimeout(() => setToast(null), 3000); };
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showWipe, setShowWipe] = useState(false);
  const [showWipeAll, setShowWipeAll] = useState(false);

  // ---------- KPI numbers (across whatever the user can see) ----------
  const totalTopics    = visibleRows.length;
  const classesCovered = useMemo(() => new Set(visibleRows.map((r) => r.cls)).size, [visibleRows]);
  const subjectsCount  = useMemo(() => new Set(visibleRows.map((r) => r.subject)).size, [visibleRows]);
  const lastUpdate     = useMemo(() => {
    let max = 0;
    for (const r of visibleRows) {
      const t = r.addedAt ? Date.parse(r.addedAt) : 0;
      if (t > max) max = t;
    }
    return max;
  }, [visibleRows]);

  // ---------- actions ----------
  async function handleAdd(payload) {
    const r = await fetch("/api/syllabus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    showToast(`Added "${j.entry.topic}"`, "ok");
    setShowAdd(false);
    if (j.entry?.cls) setSelectedClass(j.entry.cls);
    await refresh?.();
  }

  async function handleRemove(row) {
    if (!confirm(`Remove "${row.topic}" from ${row.cls} ${row.subject}?`)) return;
    try {
      const r = await fetch("/api/syllabus", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: row.id }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      showToast(`Removed "${row.topic}"`, "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
  }

  async function handleWipeClass() {
    const r = await fetch("/api/syllabus", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allForClass: selectedClass }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    showToast(`Wiped ${j.removed || 0} row${j.removed === 1 ? "" : "s"} from ${selectedClass}`, "ok");
    await refresh?.();
  }

  // Wipe every syllabus row across every class. Used to recover from a bad
  // import where rows landed under bogus class ids — going one-by-one
  // through "Wipe class" would mean clicking the typed-confirm 16 times.
  async function handleWipeAll() {
    const all = visibleRows;
    const classes = [...new Set(all.map((r) => r.cls))];
    let total = 0;
    for (const cls of classes) {
      const r = await fetch("/api/syllabus", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allForClass: cls }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) total += (j.removed || 0);
    }
    showToast(`Wiped ${total} row${total === 1 ? "" : "s"} across ${classes.length} class${classes.length === 1 ? "" : "es"}`, "ok");
    await refresh?.();
  }

  async function handleImport(rows, replace) {
    const r = await fetch("/api/syllabus/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows, replaceClasses: replace }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Import failed");
    const okN = j.imported?.length || 0;
    const errN = j.errors?.length || 0;
    showToast(
      errN === 0
        ? `Imported ${okN} topic${okN === 1 ? "" : "s"}${j.wiped ? ` · replaced ${j.wiped}` : ""}`
        : `Imported ${okN} · ${errN} skipped`,
      errN === 0 ? "ok" : "err"
    );
    await refresh?.();
    return j;
  }

  return (
    <div className="page">
      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />

      <div className="page-head">
        <div>
          <div className="page-eyebrow">Academics · Syllabus</div>
          <div className="page-title">
            Class <span className="amber">syllabus</span>
          </div>
          <div className="page-sub">
            {isParent  ? "Topics planned for your child's class this year." :
             isTeacher ? "Topics planned for the classes you teach." :
                         "Per-class topic plan · subject · chapter · term · week"}
          </div>
        </div>
        {canManage && (
          <div className="page-actions">
            <button className="btn" onClick={() => setShowImport(true)} title="Bulk-import topics from an Excel/CSV file">
              <Icon name="upload" size={13} />Import Excel
            </button>
            {selectedClass && rowsForClass.length > 0 && (
              <button
                className="btn"
                onClick={() => setShowWipe(true)}
                title={`Wipe every syllabus row for ${selectedClass}`}
                style={{ color: "var(--bad, #b13c1c)", borderColor: "var(--bad, #b13c1c)" }}
              >
                <Icon name="x" size={13} />Wipe class
              </button>
            )}
            {totalTopics > 0 && (
              <button
                className="btn"
                onClick={() => setShowWipeAll(true)}
                title={`Wipe every syllabus row across all classes (${totalTopics} total)`}
                style={{ color: "var(--bad, #b13c1c)", borderColor: "var(--bad, #b13c1c)" }}
              >
                <Icon name="x" size={13} />Wipe all
              </button>
            )}
            <button className="btn accent" onClick={() => setShowAdd(true)}>
              <Icon name="plus" size={13} />Add topic
            </button>
          </div>
        )}
      </div>

      {/* KPI strip */}
      <div className="grid g-4" style={{ marginBottom: 14 }}>
        <KPI
          label="Classes covered" value={classesCovered}
          sub={classesCovered ? "with at least one topic" : "no plans imported yet"}
          puck="mint" puckIcon="academic"
          details={{
            title: `Classes covered · ${classesCovered}`,
            sub: "Pick one from the strip below to view its plan",
            items: [...new Set(visibleRows.map((r) => r.cls))].sort().slice(0, 16).map((cls) => ({
              label: formatClassLabel(cls),
              value: visibleRows.filter((r) => r.cls === cls).length,
              sub: "topics",
            })),
          }}
        />
        <KPI
          label="Total topics" value={totalTopics}
          sub={subjectsCount ? `across ${subjectsCount} subject${subjectsCount === 1 ? "" : "s"}` : "no topics"}
          puck="cream" puckIcon="book"
        />
        <KPI
          label="Subjects" value={subjectsCount}
          sub={subjectsCount ? "distinct subjects in plan" : "—"}
          puck="peach" puckIcon="reports"
          details={{
            title: `Subjects · ${subjectsCount}`,
            sub: "Topic count by subject",
            items: (() => {
              const m = new Map();
              for (const r of visibleRows) m.set(r.subject, (m.get(r.subject) || 0) + 1);
              return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
                .map(([sub, n]) => ({ label: sub, value: n, sub: "topics" }));
            })(),
          }}
        />
        <KPI
          label="Last updated"
          value={lastUpdate ? new Date(lastUpdate).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—"}
          sub={lastUpdate
            ? new Date(lastUpdate).toLocaleDateString("en-IN", { weekday: "short", year: "numeric" })
            : "no edits yet"}
          puck="sky" puckIcon="clock"
        />
      </div>

      {/* Class picker — chip strip with topic counts. Unobtrusive; the table
          below reflects whichever chip is active. */}
      {classOptions.length > 0 ? (
        <div className="card" style={{ padding: "10px 14px", marginBottom: 14, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.4, marginRight: 6 }}>
            Class
          </span>
          {classOptions.map((cls) => {
            const n = visibleRows.filter((r) => r.cls === cls).length;
            const active = cls === selectedClass;
            const isOrphan = orphanClasses.includes(cls);
            return (
              <button
                key={cls}
                onClick={() => setSelectedClass(cls)}
                style={{
                  padding: "5px 12px", borderRadius: 999,
                  background: active
                    ? (isOrphan ? "var(--bad, #b13c1c)" : "var(--accent)")
                    : (isOrphan ? "var(--err-soft, #fbe1d8)" : "var(--bg-2)"),
                  color: active ? "#fff" : (isOrphan ? "var(--bad, #b13c1c)" : "var(--ink-2)"),
                  border: 0, cursor: "pointer", fontSize: 12, fontWeight: 500,
                  display: "inline-flex", alignItems: "center", gap: 6,
                }}
                title={isOrphan
                  ? `Bad class id "${cls}" (${n} row${n === 1 ? "" : "s"}) — not in your class roster. Likely a wrong column was mapped on import.`
                  : `${n} topic${n === 1 ? "" : "s"} planned`}
              >
                {isOrphan && <Icon name="warning" size={11} />}
                {formatClassLabel(cls)}
                <span style={{
                  fontSize: 10, padding: "1px 6px", borderRadius: 999,
                  background: active ? "rgba(255,255,255,0.25)" : "var(--rule)",
                  color: active ? "#fff" : "var(--ink-3)",
                  fontFamily: "var(--font-mono)",
                }}>{n}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="card" style={{ padding: 14, marginBottom: 14, fontSize: 12.5, color: "var(--ink-3)" }}>
          {isTeacher
            ? "You aren't assigned to a class yet. Ask the principal to set your class assignment, or use Class tracker to see your linked sections."
            : isParent
              ? "Your child's class isn't set yet. Once an admin links the class, the syllabus for that section will appear here."
              : "No classes configured. Add one from the Classes screen first."}
        </div>
      )}

      {/* Topic table for selected class */}
      {selectedClass && (
        <SyllabusTable
          cls={selectedClass}
          rows={rowsForClass}
          canManage={canManage}
          onRemove={handleRemove}
        />
      )}

      {showAdd && canManage && (
        <AddTopicModal
          classOptions={classOptions}
          defaultClass={selectedClass}
          subjectSuggestions={(E?.SUBJECTS || []).map((s) => s.name)}
          onClose={() => setShowAdd(false)}
          onSubmit={handleAdd}
          onSwitchToImport={() => { setShowAdd(false); setShowImport(true); }}
        />
      )}
      {showImport && canManage && (
        <ImportSyllabusModal
          rosterClasses={buildClassOptions(E?.CLASSES || [])}
          subjectSuggestions={(E?.SUBJECTS || []).map((s) => s.name)}
          defaultClass={selectedClass}
          onClose={() => setShowImport(false)}
          onSubmit={async (rows, replace) => {
            // Do NOT auto-close — the modal stays open with a success
            // card so the admin can read the counts and any
            // skipped-row warnings before dismissing. The page behind
            // has already refreshed.
            return await handleImport(rows, replace);
          }}
        />
      )}
      {showWipe && canManage && (
        <WipeClassModal
          cls={selectedClass}
          rowCount={rowsForClass.length}
          onClose={() => setShowWipe(false)}
          onConfirm={async () => { await handleWipeClass(); setShowWipe(false); }}
        />
      )}
      {showWipeAll && canManage && (
        <WipeClassModal
          cls="ALL"
          rowCount={totalTopics}
          onClose={() => setShowWipeAll(false)}
          onConfirm={async () => { await handleWipeAll(); setShowWipeAll(false); }}
        />
      )}
    </div>
  );
}

// ---------- Topic table -------------------------------------------------
function SyllabusTable({ cls, rows, canManage, onRemove }) {
  const [q, setQ] = useState("");
  const [subjectFilter, setSubjectFilter] = useState("all");
  const [termFilter, setTermFilter] = useState("all");

  const subjects = useMemo(() => {
    const s = new Set();
    for (const r of rows) if (r.subject) s.add(r.subject);
    return ["all", ...[...s].sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (subjectFilter !== "all" && r.subject !== subjectFilter) return false;
        if (termFilter !== "all" && String(r.term ?? "") !== String(termFilter)) return false;
        if (!needle) return true;
        return `${r.subject} ${r.chapter || ""} ${r.topic} ${r.notes || ""}`
          .toLowerCase().includes(needle);
      })
      // Stable order: term → week → numeric-notes (page no.) → subject → topic.
      // Untagged terms / weeks sink to the bottom so the planned ones read
      // top-down naturally. Notes is included as a numeric tiebreaker so a
      // textbook-style import (no term/week, page numbers in Notes) lands
      // in book order — lesson on page 2 above lesson on page 164.
      .sort((a, b) => {
        const at = a.term == null ? 99 : a.term;
        const bt = b.term == null ? 99 : b.term;
        if (at !== bt) return at - bt;
        const aw = a.weekNo == null ? 99 : a.weekNo;
        const bw = b.weekNo == null ? 99 : b.weekNo;
        if (aw !== bw) return aw - bw;
        // Pull the first number out of Notes (handles "2", "p.2", "Page 2",
        // "pp.1-12" → 1). If either row has no number, skip this tier so
        // free-text Notes don't break the alphabetical fallback below.
        const an = parseInt(String(a.notes ?? "").match(/\d+/)?.[0] ?? "", 10);
        const bn = parseInt(String(b.notes ?? "").match(/\d+/)?.[0] ?? "", 10);
        if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
        const sub = String(a.subject || "").localeCompare(String(b.subject || ""), undefined, { sensitivity: "base" });
        if (sub !== 0) return sub;
        return String(a.topic || "").localeCompare(String(b.topic || ""), undefined, { sensitivity: "base" });
      });
  }, [rows, q, subjectFilter, termFilter]);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{formatClassLabel(cls)}</div>
          <div className="card-sub">
            {rows.length} topic{rows.length === 1 ? "" : "s"} planned
            {filtered.length !== rows.length && <> · {filtered.length} shown</>}
          </div>
        </div>
        <div className="card-actions">
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search topic, chapter, notes…"
            style={{ width: 220 }}
          />
          <select className="select" value={subjectFilter} onChange={(e) => setSubjectFilter(e.target.value)} style={{ minWidth: 130 }}>
            {subjects.map((s) => <option key={s} value={s}>{s === "all" ? "All subjects" : s}</option>)}
          </select>
          <select className="select" value={termFilter} onChange={(e) => setTermFilter(e.target.value)} style={{ minWidth: 100 }}>
            <option value="all">All terms</option>
            <option value="1">Term 1</option>
            <option value="2">Term 2</option>
            <option value="3">Term 3</option>
            <option value="4">Term 4</option>
          </select>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Chapter</th>
              <th>Topic</th>
              <th className="num">Term</th>
              <th className="num">Week</th>
              <th>Notes</th>
              {canManage && <th></th>}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={canManage ? 7 : 6} className="empty">
                {rows.length === 0
                  ? `No syllabus rows for ${cls} yet. Click “Import Excel” or “Add topic” to seed it.`
                  : "No rows match the current filter."}
              </td></tr>
            )}
            {filtered.map((r) => (
              <tr key={r.id}>
                <td><span className="chip">{r.subject}</span></td>
                <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{r.chapter || "—"}</td>
                <td>
                  <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.topic}</div>
                  {r.addedAt && (
                    <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
                      added {new Date(r.addedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                      {r.addedBy ? ` · ${r.addedBy}` : ""}
                    </div>
                  )}
                </td>
                <td className="num" style={{ fontWeight: r.term != null ? 500 : 400, color: r.term == null ? "var(--ink-4)" : "inherit" }}>
                  {r.term ?? "—"}
                </td>
                <td className="num" style={{ color: r.weekNo == null ? "var(--ink-4)" : "inherit" }}>
                  {r.weekNo ?? "—"}
                </td>
                <td style={{ fontSize: 11.5, color: "var(--ink-3)", maxWidth: 280, whiteSpace: "normal" }}>
                  {r.notes || "—"}
                </td>
                {canManage && (
                  <td style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                    <button className="icon-btn" onClick={() => onRemove(r)} title="Remove">
                      <Icon name="x" size={12} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Add topic modal --------------------------------------------
function AddTopicModal({ classOptions, defaultClass, subjectSuggestions, onClose, onSubmit, onSwitchToImport }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState("");
  const [form, setForm] = useState({
    cls: defaultClass || classOptions[0] || "",
    subject: "",
    chapter: "",
    topic: "",
    term: "",
    weekNo: "",
    notes: "",
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const topicRef = useRef(null);
  useEffect(() => { topicRef.current?.focus(); }, []);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      if (!form.cls)     throw new Error("Pick a class");
      if (!form.subject.trim()) throw new Error("Subject is required");
      if (!form.topic.trim())   throw new Error("Topic is required");
      await onSubmit({
        cls:     form.cls,
        subject: form.subject.trim(),
        chapter: form.chapter.trim() || null,
        topic:   form.topic.trim(),
        term:    form.term ? Number(form.term) : null,
        weekNo:  form.weekNo ? Number(form.weekNo) : null,
        notes:   form.notes.trim() || null,
      });
    } catch (ex) { setErr(ex.message || String(ex)); setBusy(false); }
  }

  return (
    <ModalShell title="Add syllabus topic" sub="One row = one lesson / topic" onClose={onClose} width={560}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Bulk-import shortcut. Surfaces the Excel flow right where someone
            who's about to type a single topic might realise they actually
            have the whole year's plan in a spreadsheet already. */}
        {onSwitchToImport && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
            padding: "9px 12px", borderRadius: 8,
            background: "var(--accent-soft, #fff1e6)",
            border: "1px solid var(--accent, #e8530e)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <Icon name="upload" size={13} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent, #e8530e)" }}>
                  Have the whole year in an Excel?
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 1 }}>
                  Bulk-import 100s of topics in one go instead of typing them.
                </div>
              </div>
            </div>
            <button
              type="button"
              className="btn sm accent"
              onClick={onSwitchToImport}
              title="Open the bulk Excel import flow"
              style={{ flexShrink: 0 }}
            >
              <Icon name="upload" size={11} />Upload Excel
            </button>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
          <Field label="Class *">
            <select className="select" value={form.cls} onChange={(e) => set("cls", e.target.value)}>
              {classOptions.length === 0 && <option value="">— no classes —</option>}
              {classOptions.map((c) => <option key={c} value={c}>{formatClassLabel(c)}</option>)}
            </select>
          </Field>
          <Field label="Subject *">
            <input
              className="input"
              list="syllabus-subject-list"
              value={form.subject}
              onChange={(e) => set("subject", e.target.value)}
              placeholder="e.g. Science"
            />
            <datalist id="syllabus-subject-list">
              {(subjectSuggestions || []).map((s) => <option key={s} value={s} />)}
            </datalist>
          </Field>
        </div>
        <Field label="Chapter">
          <input
            className="input"
            value={form.chapter}
            onChange={(e) => set("chapter", e.target.value)}
            placeholder="e.g. Ch 1 — Living Things"
          />
        </Field>
        <Field label="Topic *">
          <input
            className="input"
            ref={topicRef}
            value={form.topic}
            onChange={(e) => set("topic", e.target.value)}
            placeholder="e.g. Plants vs animals"
          />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "100px 100px 1fr", gap: 10 }}>
          <Field label="Term">
            <select className="select" value={form.term} onChange={(e) => set("term", e.target.value)}>
              <option value="">—</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
            </select>
          </Field>
          <Field label="Week">
            <input
              className="input"
              type="number"
              min={1} max={60}
              value={form.weekNo}
              onChange={(e) => set("weekNo", e.target.value.replace(/\D/g, ""))}
              placeholder="e.g. 3"
            />
          </Field>
          <Field label="Notes">
            <input
              className="input"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="NCERT Ch.1 pp.1-12 · activity, video link, etc."
            />
          </Field>
        </div>
        {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy}>
            <Icon name="check" size={13} />{busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ---------- Wipe class modal --------------------------------------------
function WipeClassModal({ cls, rowCount, onClose, onConfirm }) {
  const PHRASE = `WIPE ${cls}`;
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState("");
  const canFire = typed === PHRASE && !busy;

  async function fire() {
    if (!canFire) return;
    setBusy(true); setErr("");
    try { await onConfirm(); }
    catch (e) { setErr(e.message || "Failed"); setBusy(false); }
  }

  return (
    <ModalShell
      title={`Wipe syllabus for ${cls}?`}
      sub={`Permanently deletes all ${rowCount} planned topic${rowCount === 1 ? "" : "s"} for this class. Can't be undone.`}
      onClose={onClose}
      width={460}
    >
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
          To confirm, type <strong style={{ fontFamily: "var(--font-mono)", color: "var(--bad, #b13c1c)" }}>{PHRASE}</strong> below.
        </div>
        <input
          className="input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={PHRASE}
          autoFocus
          style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.04em" }}
        />
        {err && (
          <div style={{ background: "var(--bad-soft, #fbe1d8)", color: "var(--bad, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12, fontWeight: 700 }}>
            {err}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="btn"
            onClick={fire}
            disabled={!canFire}
            style={{
              background: canFire ? "var(--bad, #b13c1c)" : "var(--bg-2)",
              color: canFire ? "#fff" : "var(--ink-4)",
              borderColor: canFire ? "var(--bad, #b13c1c)" : "var(--rule)",
            }}
          >
            {busy ? "Wiping…" : <><Icon name="x" size={13} />Wipe class</>}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ---------- Bulk import (Excel / CSV) -----------------------------------
function ImportSyllabusModal({ onClose, onSubmit, rosterClasses = [], subjectSuggestions = [], defaultClass = "" }) {
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders]   = useState([]);
  const [rows, setRows]         = useState([]);
  const [colMap, setColMap]     = useState({});
  const [replace, setReplace]   = useState(false);
  // Default-class override: when the Excel has no Class column (single-grade
  // file like "GRADE 1.xlsx") OR the column has bad values, picking a class
  // here applies it to every row that's missing one. The "force" toggle
  // overrides even rows that DO have a class — useful when the auto-mapper
  // grabbed the wrong column.
  const [defaultCls, setDefaultCls] = useState(defaultClass || "");
  const [forceDefault, setForceDefault] = useState(false);
  // Default-subject override: same reasoning. Many subject-specific
  // workbooks (Tamil reader, Maths workbook) only list lessons + pages and
  // expect the importer to know what subject they're for.
  const [defaultSubj, setDefaultSubj]       = useState("");
  const [forceDefaultSubj, setForceDefaultSubj] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState("");
  const [result, setResult]     = useState(null);
  const fileRef = useRef(null);

  async function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr(""); setResult(null);
    setFileName(f.name);
    try {
      const buf = await f.arrayBuffer();
      const wb  = XLSX.read(buf, { type: "array" });
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: false });
      if (!arr.length) throw new Error("Spreadsheet is empty");
      const [head, ...body] = arr;
      const headerArr = head.map((h) => String(h || "").trim());
      setHeaders(headerArr);
      setRows(body);
      setColMap(inferColumnMap(headerArr));
    } catch (ex) {
      setHeaders([]); setRows([]); setColMap({});
      setErr(ex.message || "Couldn't read the file");
    }
  }

  // Shape parsed rows into the canonical fields the API expects.
  // Default-class / default-subject overrides are applied here too so the
  // preview / count match what the server will actually save.
  const applyDefault = (raw) => {
    if (forceDefault && defaultCls) return defaultCls;
    const v = String(raw || "").trim();
    return v || defaultCls || "";
  };
  const applyDefaultSubj = (raw) => {
    if (forceDefaultSubj && defaultSubj) return defaultSubj;
    const v = String(raw || "").trim();
    return v || defaultSubj || "";
  };
  const previewRows = useMemo(() => {
    return rows.slice(0, 50).map((r) => ({
      cls:     applyDefault(colMap.cls != null ? r[colMap.cls] : ""),
      subject: applyDefaultSubj(colMap.subject != null ? r[colMap.subject] : ""),
      chapter: colMap.chapter != null ? r[colMap.chapter] : "",
      topic:   colMap.topic   != null ? r[colMap.topic]   : "",
      term:    colMap.term    != null ? r[colMap.term]    : "",
      weekNo:  colMap.weekNo  != null ? r[colMap.weekNo]  : "",
      notes:   colMap.notes   != null ? r[colMap.notes]   : "",
    }));
  // applyDefault* close over the override state; including them as deps
  // keeps the preview reactive when the user flips the toggles.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, colMap, forceDefault, defaultCls, forceDefaultSubj, defaultSubj]);

  // A row is importable if it has the three required fields.
  const isValid = (r) => !!(String(r.cls || "").trim() && String(r.subject || "").trim() && String(r.topic || "").trim());
  const validCount = previewRows.filter(isValid).length;
  const invalidCount = previewRows.length - validCount;

  // Distinct classes in the upload — surfaced so the "replace" option's
  // blast radius is obvious before the user clicks Import.
  const distinctClasses = useMemo(() => {
    const s = new Set();
    for (const r of previewRows) {
      const c = String(r.cls || "").trim().toUpperCase().replace(/\s+/g, "");
      if (c) s.add(c);
    }
    return [...s].sort();
  }, [previewRows]);

  const remap = (field, idx) => setColMap((m) => ({ ...m, [field]: idx === "" ? undefined : Number(idx) }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!rows.length) { setErr("Pick a file first"); return; }
    // Class can come from either a mapped column OR the default-class
    // override. Subject / Topic still need a column.
    if (colMap.cls == null && !defaultCls) {
      setErr("Either map a column to “Class”, or pick a Default class below");
      return;
    }
    if (colMap.subject == null && !defaultSubj) {
      setErr("Either map a column to “Subject”, or pick a Default subject below");
      return;
    }
    if (colMap.topic == null)   { setErr("Map a column to “Topic” — it's required");   return; }
    setBusy(true); setErr("");
    try {
      const payload = rows.map((r) => ({
        cls:     applyDefault(colMap.cls != null ? r[colMap.cls] : ""),
        subject: applyDefaultSubj(colMap.subject != null ? r[colMap.subject] : ""),
        chapter: colMap.chapter != null ? r[colMap.chapter] : "",
        topic:   colMap.topic   != null ? r[colMap.topic]   : "",
        term:    colMap.term    != null ? r[colMap.term]    : "",
        weekNo:  colMap.weekNo  != null ? r[colMap.weekNo]  : "",
        notes:   colMap.notes   != null ? r[colMap.notes]   : "",
      })).filter(isValid);
      if (!payload.length) throw new Error("No rows had Class + Subject + Topic filled in");
      const j = await onSubmit(payload, replace);
      setResult(j);
    } catch (ex) { setErr(ex.message || String(ex)); }
    finally { setBusy(false); }
  }

  function downloadSample() {
    // Headers match the importer's aliases. Sample shows two classes so the
    // "replace" toggle's per-class semantics are obvious from the file.
    const data = [
      ["Class", "Subject", "Chapter", "Topic", "Term", "Week", "Notes"],
      ["5-A", "Science", "Ch 1 — Living Things", "Plants vs animals", 1, 1, "NCERT Ch.1 pp.1-12"],
      ["5-A", "Science", "Ch 1 — Living Things", "Habitats around us", 1, 2, "Field walk worksheet"],
      ["5-A", "English", "Unit 1 — Friendship", "Read: 'My friend the parrot'", 1, 1, "Pair reading"],
      ["5-B", "Maths",   "Ch 1 — Place Value",   "Lakhs and crores",          1, 1, "Workbook ex.1"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Syllabus");
    XLSX.writeFile(wb, "syllabus-import-template.xlsx");
  }

  return (
    <ModalShell title="Import syllabus" sub="Upload an Excel or CSV file — preview before importing" onClose={onClose} width={780}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* File picker */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{ display: "none" }} />
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={13} />Choose file
          </button>
          <div style={{ fontSize: 12, color: "var(--ink-3)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {fileName || "No file selected · accepts .xlsx, .xls, .csv"}
          </div>
          <button type="button" className="btn ghost sm" onClick={downloadSample} title="Download a starter template">
            <Icon name="download" size={11} />Sample template
          </button>
        </div>

        {/* Column mapping */}
        {headers.length > 0 && (
          <div style={{ background: "var(--bg-2)", padding: 10, borderRadius: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
              Match your columns
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {Object.keys(COLUMN_ALIASES).map((field) => {
                const labels = {
                  cls: "Class", subject: "Subject", chapter: "Chapter",
                  topic: "Topic", term: "Term", weekNo: "Week", notes: "Notes",
                };
                const required = field === "cls" || field === "subject" || field === "topic";
                return (
                  <label key={field} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
                    <span style={{ color: "var(--ink-3)" }}>
                      {labels[field]}
                      {required && <span style={{ color: "var(--err, #b13c1c)" }}> *</span>}
                    </span>
                    <select
                      className="select"
                      value={colMap[field] == null ? "" : colMap[field]}
                      onChange={(e) => remap(field, e.target.value)}
                      style={{ fontSize: 12, padding: "4px 6px", height: 30 }}
                    >
                      <option value="">— ignore —</option>
                      {headers.map((h, i) => (
                        <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* Default-class override. Lives outside the file's column mapping
            because the most common case is a single-grade workbook where
            "Class" simply isn't a column. Picking one here also lets the
            user rescue an import where the auto-mapper grabbed the wrong
            column (e.g. a serial-number column landed as "Class"). */}
        {(headers.length > 0 || rows.length > 0) && rosterClasses.length > 0 && (
          <div style={{
            display: "flex", flexDirection: "column", gap: 10,
            padding: "10px 12px", border: "1px solid var(--rule)", borderRadius: 8,
            background: "var(--bg-2)",
          }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>
              Defaults for missing columns
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {/* --- Default class --- */}
              <Field label="Default class">
                <select
                  className="select"
                  value={defaultCls}
                  onChange={(e) => setDefaultCls(e.target.value)}
                >
                  <option value="">— none (use the file's Class column) —</option>
                  {rosterClasses.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <label style={{
                  display: "flex", alignItems: "center", gap: 6, fontSize: 11,
                  color: "var(--ink-3)", marginTop: 4,
                  opacity: defaultCls ? 1 : 0.5,
                }}>
                  <input
                    type="checkbox"
                    checked={forceDefault}
                    onChange={(e) => setForceDefault(e.target.checked)}
                    disabled={!defaultCls}
                  />
                  Force for every row (ignore file's Class column)
                </label>
              </Field>

              {/* --- Default subject --- */}
              <Field label="Default subject">
                <input
                  className="input"
                  list="syllabus-default-subject"
                  value={defaultSubj}
                  onChange={(e) => setDefaultSubj(e.target.value)}
                  placeholder="e.g. Tamil, Maths, Science"
                />
                <datalist id="syllabus-default-subject">
                  {(subjectSuggestions || []).map((s) => <option key={s} value={s} />)}
                </datalist>
                <label style={{
                  display: "flex", alignItems: "center", gap: 6, fontSize: 11,
                  color: "var(--ink-3)", marginTop: 4,
                  opacity: defaultSubj ? 1 : 0.5,
                }}>
                  <input
                    type="checkbox"
                    checked={forceDefaultSubj}
                    onChange={(e) => setForceDefaultSubj(e.target.checked)}
                    disabled={!defaultSubj}
                  />
                  Force for every row (ignore file's Subject column)
                </label>
              </Field>
            </div>
          </div>
        )}

        {/* Replace toggle — destructive, so we lay out the blast radius. */}
        {previewRows.length > 0 && distinctClasses.length > 0 && (
          <label style={{
            display: "flex", alignItems: "flex-start", gap: 10,
            padding: "10px 12px", border: "1px solid var(--rule)", borderRadius: 8,
            background: replace ? "var(--err-soft, #fbe1d8)" : "var(--bg-2)",
          }}>
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} style={{ marginTop: 2 }} />
            <span style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.4 }}>
              <b>Replace existing rows for these classes</b>
              <span style={{ display: "block", fontSize: 11, color: "var(--ink-4)", marginTop: 2 }}>
                Wipes every previously-imported topic for{" "}
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {distinctClasses.slice(0, 6).join(", ")}{distinctClasses.length > 6 && ` +${distinctClasses.length - 6} more`}
                </span>{" "}
                before adding the new rows. Use this when re-uploading a corrected plan.
              </span>
            </span>
          </label>
        )}

        {/* Preview */}
        {previewRows.length > 0 && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>
                Preview · first {previewRows.length} of {rows.length}
              </div>
              <div style={{ fontSize: 11, color: invalidCount ? "var(--warn)" : "var(--ink-3)" }}>
                {validCount} importable{invalidCount ? ` · ${invalidCount} skipped (missing class/subject/topic)` : ""}
              </div>
            </div>
            <div style={{ maxHeight: 260, overflow: "auto", border: "1px solid var(--rule)", borderRadius: 7 }}>
              <table className="table" style={{ fontSize: 11.5 }}>
                <thead>
                  <tr>
                    <th>#</th><th>Class</th><th>Subject</th><th>Topic</th>
                    {colMap.chapter != null && <th>Chapter</th>}
                    {colMap.term    != null && <th className="num">Term</th>}
                    {colMap.weekNo  != null && <th className="num">Week</th>}
                    {colMap.notes   != null && <th>Notes</th>}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r, i) => {
                    const ok = isValid(r);
                    return (
                      <tr key={i} style={ok ? undefined : { background: "var(--err-soft, #fbe1d8)" }}>
                        <td style={{ color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{i + 1}</td>
                        <td style={{ fontFamily: "var(--font-mono)" }}>{String(r.cls || "—")}</td>
                        <td>{String(r.subject || "—")}</td>
                        <td style={{ fontWeight: 500 }}>{String(r.topic || "—")}</td>
                        {colMap.chapter != null && <td style={{ color: "var(--ink-3)" }}>{String(r.chapter || "—")}</td>}
                        {colMap.term    != null && <td className="num" style={{ color: "var(--ink-4)" }}>{r.term ?? "—"}</td>}
                        {colMap.weekNo  != null && <td className="num" style={{ color: "var(--ink-4)" }}>{r.weekNo ?? "—"}</td>}
                        {colMap.notes   != null && <td style={{ color: "var(--ink-3)" }}>{String(r.notes || "—")}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Result summary after submit. Modal stays open once we land
            here so the admin can read the counts and any skipped-row
            errors before dismissing. The page behind has already
            refreshed, so closing reveals the updated syllabus. */}
        {result && (
          <div style={{
            display: "flex", flexDirection: "column", gap: 10,
            padding: "14px 16px",
            background: "var(--ok-soft, #e6f4ec)",
            border: "1px solid var(--ok, #2f8854)",
            borderRadius: 10,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{
                width: 28, height: 28, borderRadius: "50%",
                background: "var(--ok, #2f8854)", color: "#fff",
                display: "grid", placeItems: "center", flexShrink: 0,
              }}>
                <Icon name="check" size={14} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>Import successful</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>
                  {(result.imported?.length || 0)} topic{(result.imported?.length || 0) === 1 ? "" : "s"} added · the syllabus behind this dialog is already updated.
                  {result.wiped ? ` · replaced ${result.wiped} prior row${result.wiped === 1 ? "" : "s"}.` : ""}
                  {result.errors?.length ? ` · ${result.errors.length} row${result.errors.length === 1 ? "" : "s"} skipped — see below.` : ""}
                </div>
              </div>
            </div>
            {result.errors?.length > 0 && (
              <div style={{
                background: "var(--warn-soft, #fff4e2)",
                border: "1px solid var(--warn, #d4944e)",
                borderRadius: 7, padding: "8px 10px",
                fontSize: 11.5, color: "var(--ink-2)", lineHeight: 1.5,
                maxHeight: 120, overflowY: "auto",
              }}>
                {result.errors.slice(0, 8).map((e, i) => (
                  <div key={i}>Row {e.row}: {e.reason}</div>
                ))}
                {result.errors.length > 8 && (
                  <div style={{ color: "var(--ink-4)", marginTop: 4 }}>…and {result.errors.length - 8} more</div>
                )}
              </div>
            )}
          </div>
        )}

        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {result ? (
            <button type="button" className="btn accent" onClick={onClose}>
              <Icon name="check" size={13} />Done
            </button>
          ) : (
            <>
              <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
              <button
                type="submit"
                className="btn accent"
                disabled={
                  busy
                  || !rows.length
                  // Class can come from a column OR the Default-class override.
                  || (colMap.cls == null && !defaultCls)
                  // Same for Subject.
                  || (colMap.subject == null && !defaultSubj)
                  // Topic must always be mapped — there's no sensible default.
                  || colMap.topic == null
                }
              >
                <Icon name="upload" size={13} />
                {busy
                  ? "Importing…"
                  : `${replace ? "Replace + import" : "Import"} ${validCount} topic${validCount === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
      </form>
    </ModalShell>
  );
}
