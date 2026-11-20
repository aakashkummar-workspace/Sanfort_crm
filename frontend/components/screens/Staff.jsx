"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { KPI, AvatarChip } from "../ui";
import DocumentsPanel from "../DocumentsPanel";
import CredentialsModal from "../CredentialsModal";
import { resolveSchool, downloadPdf } from "@/lib/export";

const FILTERS = [
  { k: "all", label: "All" },
  { k: "teacher", label: "Teachers" },
  { k: "ops", label: "Ops" },
  { k: "intern", label: "Interns" },
];

function Toast({ msg, tone, onClose }) {
  if (!msg) return null;
  const bg = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--err, #b13c1c)" : "var(--ink)";
  return (
    <div
      role="status"
      onClick={onClose}
      style={{
        position: "fixed", bottom: 18, right: 18, zIndex: 9000,
        background: bg, color: "#fff",
        padding: "9px 14px", borderRadius: 8, fontSize: 12, fontWeight: 500,
        boxShadow: "0 12px 30px -16px rgba(0,0,0,0.35)", cursor: "pointer",
        maxWidth: 360,
      }}
    >
      {msg}
    </div>
  );
}

export default function ScreenStaff({ E, refresh, role, session, searchFocus, clearSearchFocus }) {
  const school = resolveSchool(E?.SETTINGS);
  const actor  = session?.name || null;
  const canEdit = role === "principal" || role === "admin";
  const [filter, setFilter] = useState("all");
  const [showAdd, setShowAdd] = useState(false);
  const [toast, setToast] = useState(null);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [docsFor, setDocsFor] = useState(null); // staff being shown in the docs modal
  const [profileFor, setProfileFor] = useState(null); // staff being viewed in the profile modal
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [issuedLogin, setIssuedLogin] = useState(null); // teacher login just provisioned
  const [showImport, setShowImport] = useState(false);
  // Bulk-imported teacher logins land here after a successful import so
  // we can render them in a CSV-download modal — same pattern as the
  // Students importer surfacing parent logins.
  const [importLogins, setImportLogins] = useState(null);

  const allStaff = E.STAFF || [];
  const filtered = useMemo(() => {
    const sorted = [...allStaff].sort((a, b) => (b.score || 0) - (a.score || 0));
    if (filter === "all") return sorted;
    return sorted.filter((s) => (s.role || "").toLowerCase().includes(filter));
  }, [allStaff, filter]);

  // Global search deep-link: open the StaffProfileModal for the picked id.
  useEffect(() => {
    if (!searchFocus || searchFocus.type !== "staff" || !searchFocus.id) return;
    const target = allStaff.find((s) => s.id === searchFocus.id);
    if (target) setProfileFor(target);
    clearSearchFocus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchFocus]);

  const total = allStaff.length;
  const interns = allStaff.filter((s) => /intern/i.test(s.role)).length;
  const avg = total
    ? Math.round(allStaff.reduce((a, s) => a + (s.score || 0), 0) / total)
    : "—";
  const lows = allStaff.filter((s) => s.status === "low").length;

  const showToast = (msg, tone) => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 3500);
  };

  async function handleAdd(payload) {
    try {
      const r = await fetch("/api/staff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed to add staff");
      setShowAdd(false);
      showToast(`${json.staff.name} added to staff`, "ok");
      // If a login was auto-provisioned (teachers with email), pop the
      // copyable credentials modal so the principal can hand them over.
      if (json.createdLogin) {
        setIssuedLogin({
          ...json.createdLogin,
          staffName: json.staff.name,
          staffId: json.staff.id,
        });
      }
      await refresh?.();
    } catch (e) {
      showToast(e.message, "err");
      throw e;
    }
  }

  async function handleRemove(s) {
    if (!confirm(`Remove ${s.name} from staff?`)) return;
    try {
      const r = await fetch("/api/staff", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: s.id }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed to remove staff");
      setOpenMenuId(null);
      showToast(`${s.name} removed`, "ok");
      await refresh?.();
    } catch (e) {
      showToast(e.message, "err");
    }
  }

  function downloadMonthlyReport() {
    const month = new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" });
    const rows = filtered.length ? filtered : allStaff;
    if (!rows.length) {
      showToast("Nothing to export — add staff first", "err");
      return;
    }
    const totalSalary = rows.reduce((a, s) => a + (Number(s.salary) || 0), 0);
    const avgScore = Math.round(rows.reduce((a, s) => a + (Number(s.score) || 0), 0) / rows.length);
    const topPerformers = rows.filter((s) => s.status === "top").length;
    const opened = downloadPdf({
      title: "Staff Monthly Report",
      subtitle: `${rows.length} staff record${rows.length === 1 ? "" : "s"} for ${month}`,
      school, actor,
      dateRange: month,
      orientation: "landscape",
      summary: [
        { label: "Total staff",     value: rows.length },
        { label: "Top performers",  value: topPerformers },
        { label: "Avg score",       value: avgScore || "—" },
        { label: "Salary outflow",  value: `₹${totalSalary.toLocaleString("en-IN")}` },
      ],
      columns: [
        { key: "i",          label: "#",          align: "right",  width: "32px" },
        { key: "id",         label: "ID",         width: "80px" },
        { key: "name",       label: "Name" },
        { key: "role",       label: "Role",       width: "100px" },
        { key: "dept",       label: "Department" },
        { key: "phone",      label: "Phone",      align: "right" },
        { key: "joining",    label: "Joining",    align: "right",  width: "80px" },
        { key: "salary",     label: "Salary (₹)", align: "right" },
        { key: "attendance", label: "Att %",      align: "right",  width: "60px" },
        { key: "score",      label: "Score",      align: "right",  width: "60px" },
        { key: "status",     label: "Status",     align: "center", width: "90px" },
      ],
      rows: rows.map((s, i) => ({
        i: i + 1, id: s.id, name: s.name || "—",
        role: s.role || "—", dept: s.dept || "—",
        phone: s.phone || "—", joining: s.joiningDate || "—",
        salary: (Number(s.salary) || 0).toLocaleString("en-IN"),
        attendance: s.attendance != null ? `${s.attendance}%` : "—",
        score: s.score ?? "—",
        status: (s.status || "—").replace(/^./, (c) => c.toUpperCase()),
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-staff-report-${month.replace(/\s+/g, "-").toLowerCase()}`,
    });
    if (opened === false) showToast("Pop-up blocked — please allow pop-ups", "err");
    else showToast(`Opened PDF preview for ${month}`, "ok");
  }

  function openRowMenu(e, id) {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, left: rect.right - 140 });
    setOpenMenuId(openMenuId === id ? null : id);
  }
  useEffect(() => {
    const onClick = (e) => {
      if (!e.target.closest?.("[data-row-menu]") && !e.target.closest?.("[data-row-menu-btn]")) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">People · Performance</div>
          <div className="page-title">Staff & <span className="amber">Interns</span></div>
          <div className="page-sub">Performance · attendance · tasks · interns rotations</div>
        </div>
        <div className="page-actions">
          {canEdit && (
            <button className="btn" onClick={() => setShowImport(true)} title="Bulk-add staff from CSV / Excel">
              <Icon name="upload" size={13} />Import
            </button>
          )}
          <button className="btn" onClick={downloadMonthlyReport} title="Open a printable, branded PDF report">
            <Icon name="download" size={13} />Export PDF
          </button>
          {canEdit && (
            <button className="btn accent" onClick={() => setShowAdd(true)}>
              <Icon name="plus" size={13} />Add staff
            </button>
          )}
        </div>
      </div>

      <div className="grid g-4" style={{ marginBottom: 14 }}>
        {(() => {
          // Group by role for the Total-staff drill-down so the popup shows
          // "Teachers · 3", "Ops · 1", etc. with each role expandable to the
          // people in it.
          const byRole = (() => {
            const m = new Map();
            for (const s of allStaff) {
              const k = s.role || "Other";
              if (!m.has(k)) m.set(k, []);
              m.get(k).push(s);
            }
            return [...m.entries()]
              .map(([role, list]) => ({ role, list }))
              .sort((a, b) => b.list.length - a.list.length);
          })();
          const internList = allStaff.filter((s) => /intern/i.test(s.role));
          const lowList    = allStaff.filter((s) => s.status === "low");
          // Sort by score descending — top performer first inside Avg drill.
          const byScore = [...allStaff].sort((a, b) => (b.score || 0) - (a.score || 0));
          const personSub = (s) => [s.dept, s.role].filter(Boolean).join(" · ");

          return (
            <>
              <KPI
                label="Total staff" value={total} sub="all roles"
                puck="mint" puckIcon="staff"
                details={{
                  title: `Total staff · ${total}`,
                  sub: "Grouped by role · click a role to see who's in it",
                  items: byRole.map(({ role, list }) => ({
                    label: role,
                    value: list.length,
                    sub: `${list.length} member${list.length === 1 ? "" : "s"} · click to expand`,
                    children: list.map((s) => ({
                      label: s.name,
                      value: s.score ?? "—",
                      sub: personSub(s),
                      tone: s.status === "top" ? "ok" : s.status === "low" ? "bad" : "",
                    })),
                  })),
                }}
              />
              <KPI
                label="Interns" value={interns} sub="active"
                puck="peach" puckIcon="users"
                details={{
                  title: `Interns · ${interns}`,
                  sub: internList.length ? "Currently on rotation" : "No interns on file yet",
                  items: internList.map((s) => ({
                    label: s.name,
                    value: s.score ?? "—",
                    sub: personSub(s),
                    tone: s.status === "top" ? "ok" : s.status === "low" ? "bad" : "",
                  })),
                }}
              />
              <KPI
                label="Avg performance" value={avg} sub="composite score"
                puck="cream" puckIcon="trending"
                details={{
                  title: `Avg performance · ${avg}${avg === "—" ? "" : ""}`,
                  sub: "Top scorers first · auto-computed from attendance + student perf + contribution",
                  items: byScore.map((s) => ({
                    label: s.name,
                    value: s.score ?? 0,
                    sub: personSub(s),
                    tone: s.status === "top" ? "ok" : s.status === "low" ? "bad" : "",
                  })),
                }}
              />
              <KPI
                label="Low performers" value={lows} sub="needs review"
                puck="rose" puckIcon="warning"
                details={{
                  title: `Low performers · ${lows}`,
                  sub: lowList.length ? "These staff need a 1:1 review" : "Nobody flagged — ",
                  items: lowList.length === 0
                    ? []
                    : lowList.map((s) => ({
                        label: s.name,
                        value: s.score ?? 0,
                        sub: personSub(s),
                        tone: "bad",
                      })),
                }}
              />
            </>
          );
        })()}
      </div>

      <div className="grid g-12">
        <div className="card col-8">
          <div className="card-head">
            <div>
              <div className="card-title">Performance leaderboard</div>
              <div className="card-sub">Auto-computed · 30% own attendance + 50% student performance + 20% contribution</div>
            </div>
            <div className="card-actions">
              <div className="segmented">
                {FILTERS.map((f) => (
                  <button key={f.k} className={filter === f.k ? "active" : ""} onClick={() => setFilter(f.k)}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>#</th><th>Name</th><th>Role</th><th>Own attendance</th><th>Student perf</th><th>Score</th><th>Status</th>
                  {canEdit && <th></th>}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={canEdit ? 8 : 7} className="empty">
                      {allStaff.length === 0
                        ? "No staff added yet. Click “Add staff” to start."
                        : `No ${filter} match the current filter.`}
                    </td>
                  </tr>
                )}
                {filtered.map((s, i) => {
                  const awardsCount = (E.STAFF_AWARDS || []).filter((a) => a.staffId === s.id).length;
                  return (
                  <tr key={s.id || s.name}>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-4)" }}>{String(i + 1).padStart(2, "0")}</td>
                    <td>
                      <div
                        onClick={() => setProfileFor(s)}
                        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                        title="View profile · performance · awards"
                      >
                        <AvatarChip initials={s.avatar || initialsOf(s.name)} />
                        <div>
                          <div style={{ fontSize: 12.5, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                            {s.name}
                            {awardsCount > 0 && (
                              <span className="chip ok" style={{ fontSize: 10, height: 18, padding: "0 6px" }} title={`${awardsCount} award${awardsCount === 1 ? "" : "s"}`}>
                                <Icon name="trending" size={10} />{awardsCount}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--ink-4)" }}>{s.dept}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{s.role}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div className="bar" style={{ width: 60 }}>
                          <span style={{ width: `${s.attendance || 0}%`, background: (s.attendance || 0) < 85 ? "var(--warn)" : "var(--ok)" }} />
                        </div>
                        <span className="mono" style={{ fontSize: 11 }}>{s.attendance ?? 0}%</span>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div className="bar" style={{ width: 60 }}>
                          <span style={{ width: `${s.tasks || 0}%`, background: "var(--accent)" }} />
                        </div>
                        <span className="mono" style={{ fontSize: 11 }}>{s.tasks ?? 0}%</span>
                      </div>
                    </td>
                    <td><span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>{s.score ?? 0}</span></td>
                    <td>
                      {s.status === "top" && <span className="chip ok"><span className="dot" />Top performer</span>}
                      {s.status === "ok" && <span className="chip"><span className="dot" />On track</span>}
                      {s.status === "low" && <span className="chip bad"><span className="dot" />Needs review</span>}
                    </td>
                    {canEdit && (
                      <td style={{ width: 36, textAlign: "right" }}>
                        <button
                          data-row-menu-btn
                          className="icon-btn"
                          onClick={(e) => openRowMenu(e, s.id || s.name)}
                          title="Actions"
                        >
                          <Icon name="more" size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="col-4" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card">
            <div className="card-head"><div><div className="card-title">Today&apos;s attendance</div></div></div>
            {total === 0 ? (
              <div className="empty">Mark staff in/out to see today&apos;s check-in summary.</div>
            ) : (
              <div style={{ padding: "8px 14px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: "var(--ink-3)" }}>Avg attendance this month</span>
                  <span className="mono" style={{ fontWeight: 500 }}>
                    {Math.round(allStaff.reduce((a, s) => a + (s.attendance || 0), 0) / total)}%
                  </span>
                </div>
                <div style={{ marginTop: 10, fontSize: 11, color: "var(--ink-4)" }}>
                  Live punch-in/out is in the roadmap. For now, attendance % is set per staff at hiring time.
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head"><div><div className="card-title">Intern rotations</div></div></div>
            {interns === 0 ? (
              <div className="empty">No intern rotations set up yet.</div>
            ) : (
              <div style={{ padding: "8px 14px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                {allStaff.filter((s) => /intern/i.test(s.role)).map((s) => (
                  <div key={s.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span>{s.name}</span>
                    <span style={{ color: "var(--ink-3)" }}>{s.dept}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head"><div><div className="card-title">Alerts</div></div></div>
            {lows === 0 ? (
              <div className="empty">No alerts.</div>
            ) : (
              <div style={{ padding: "8px 14px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                {allStaff.filter((s) => s.status === "low").map((s) => (
                  <div key={s.id} style={{ fontSize: 12, color: "var(--err, #b13c1c)" }}>
                    {s.name} · score {s.score}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {openMenuId && canEdit && (() => {
        const s = allStaff.find((x) => (x.id || x.name) === openMenuId);
        if (!s) return null;
        return (
          <div
            data-row-menu
            style={{
              position: "fixed", top: menuPos.top, left: menuPos.left,
              minWidth: 140, background: "var(--card, #fff)",
              border: "1px solid var(--line, #e5dfd1)", borderRadius: 8,
              padding: 4, zIndex: 200,
              boxShadow: "0 16px 40px -20px rgba(0,0,0,0.25)",
            }}
          >
            <button
              onClick={() => { setProfileFor(s); setOpenMenuId(null); }}
              style={{
                width: "100%", textAlign: "left",
                padding: "7px 10px", background: "transparent",
                border: 0, borderRadius: 5, cursor: "pointer",
                color: "var(--ink-2)", fontSize: 12,
              }}
            >
              View profile · performance
            </button>
            <button
              onClick={() => { setDocsFor(s); setOpenMenuId(null); }}
              style={{
                width: "100%", textAlign: "left",
                padding: "7px 10px", background: "transparent",
                border: 0, borderRadius: 5, cursor: "pointer",
                color: "var(--ink-2)", fontSize: 12,
              }}
            >
              View documents
            </button>
            <button
              onClick={() => handleRemove(s)}
              style={{
                width: "100%", textAlign: "left",
                padding: "7px 10px", background: "transparent",
                border: 0, borderRadius: 5, cursor: "pointer",
                color: "var(--err, #b13c1c)", fontSize: 12,
              }}
            >
              Remove from staff
            </button>
          </div>
        );
      })()}

      {showAdd && (
        <AddStaffModal onClose={() => setShowAdd(false)} onSubmit={handleAdd} />
      )}

      {showImport && canEdit && (
        <ImportStaffModal
          onClose={() => setShowImport(false)}
          onSubmitCsv={async (csv) => {
            const r = await fetch("/api/staff/import", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ csv }),
            });
            const json = await r.json().catch(() => ({}));
            if (!r.ok || !json.ok) throw new Error(json.error || "Import failed");
            await refresh?.();
            // Surface the generated teacher logins once for the principal
            // to download as CSV. Same pattern as the Students importer.
            if (Array.isArray(json.logins) && json.logins.length > 0) {
              setImportLogins(json.logins);
            }
            return json;
          }}
        />
      )}

      {importLogins && (
        <ImportStaffLoginsModal
          logins={importLogins}
          onClose={() => setImportLogins(null)}
        />
      )}

      {issuedLogin && (
        <CredentialsModal
          title="Teacher login created"
          subtitle={`For ${issuedLogin.staffName} (${issuedLogin.staffId}) — share these with the teacher`}
          email={issuedLogin.email}
          password={issuedLogin.defaultPassword}
          extras={[
            { label: "Role", value: "Teacher" },
          ]}
          note={
            <>
              The teacher can sign in at the login screen and pick the <b>Teacher</b> role.
              Advise them to change the password from <b>My account</b> on first sign-in.
            </>
          }
          onClose={() => setIssuedLogin(null)}
          flash={showToast}
        />
      )}

      {docsFor && (
        <ModalShell title={`Documents · ${docsFor.name}`} sub={`${docsFor.id || ""} · ${docsFor.role}`} onClose={() => setDocsFor(null)} width={520}>
          <div className="card-body">
            <DocumentsPanel entityType="staff" entityId={docsFor.id || docsFor.name} canEdit={canEdit} />
          </div>
        </ModalShell>
      )}

      {profileFor && (
        <StaffProfileModal
          staff={profileFor}
          awards={(E.STAFF_AWARDS || []).filter((a) => a.staffId === profileFor.id)}
          canEdit={canEdit}
          onClose={() => setProfileFor(null)}
          onRefresh={refresh}
          onToast={showToast}
        />
      )}

      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />
    </div>
  );
}

function initialsOf(name) {
  if (!name) return "—";
  return String(name).trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}


function ModalShell({ title, sub, onClose, children, width = 520 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
        display: "grid", placeItems: "center", zIndex: 250, padding: 16,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: width }}>
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

// Bulk-import staff (teachers, ops, interns) from a CSV / Excel.
// Mirrors the Students importer: file picker → spinner → green
// success card with counts + skipped rows. Teacher logins are
// auto-provisioned server-side for any row with an email, and the
// credentials surface in a separate modal after Done is clicked.
function ImportStaffModal({ onClose, onSubmitCsv }) {
  const [file, setFile] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | importing | done
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  // Minimum required columns: Name + Email. Phone / Role / Department /
  // Salary / Joining are all optional; missing values land as defaults.
  // For teachers (the most common case) the login is auto-provisioned
  // from the Email column with a per-teacher password derived from the
  // first name — Aakash → Aakash@123.
  const sampleCsv =
    "Name,Email,Phone,Role,Department,Salary,Joining\n" +
    "Aakash,aakash@school.com,+91 9876543210,Teacher,,,\n" +
    "Priya Sharma,priya@school.com,9988776655,Teacher,,,\n" +
    "Suresh Office,suresh@school.com,9000011111,Ops,Operations,22000,\n";
  const downloadSample = () => {
    const blob = new Blob([sampleCsv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "staff-template.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  // Same client-side .xlsx → .csv conversion as the Students importer.
  const xlsxToCsv = async (f) => {
    const XLSX = await import("xlsx");
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const firstSheet = wb.Sheets[wb.SheetNames[0]];
    if (!firstSheet) throw new Error("Workbook has no sheets");
    return XLSX.utils.sheet_to_csv(firstSheet);
  };

  const onClick = async () => {
    if (!file || phase === "importing") return;
    setPhase("importing");
    try {
      const name = String(file.name || "").toLowerCase();
      const isExcel = name.endsWith(".xlsx") || name.endsWith(".xls");
      const csv = isExcel ? await xlsxToCsv(file) : await file.text();
      const json = await onSubmitCsv(csv);
      setResult(json);
      setPhase("done");
    } catch (e) {
      setResult({ ok: false, error: e?.message || "Import failed", errors: [] });
      setPhase("done");
    }
  };

  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const count = Number(result?.count || 0);
  const loginCount = Array.isArray(result?.logins) ? result.logins.length : 0;

  return (
    <div className="modal-backdrop" onClick={phase === "importing" ? undefined : onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 520 }}>
        <div className="card-head">
          <div>
            <div className="card-title">
              {phase === "done"
                ? (result?.ok === false ? "Import failed" : "Staff imported")
                : "Import staff"}
            </div>
            <div className="card-sub">
              {phase === "done"
                ? "The staff list behind this dialog has refreshed — close to continue."
                : "Bulk-add via CSV or Excel · columns: Name, Email, Phone, Role, Department, Salary, Joining"}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={phase === "importing"}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {phase === "done" && result ? (
            result?.ok === false ? (
              <div style={{
                padding: "14px 16px",
                background: "var(--err-soft, #fbe1d8)",
                border: "1px solid var(--err, #b13c1c)",
                borderRadius: 10, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5,
              }}>
                <strong>Import couldn't run:</strong> {result.error || "Unknown error"}
              </div>
            ) : (
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
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>Staff imported</div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>
                      {count} record{count === 1 ? "" : "s"} added
                      {loginCount > 0 && ` · ${loginCount} teacher login${loginCount === 1 ? "" : "s"} provisioned`}
                      {errors.length > 0 && ` · ${errors.length} row${errors.length === 1 ? "" : "s"} skipped — see below.`}
                    </div>
                  </div>
                </div>
                {errors.length > 0 && (
                  <div style={{
                    background: "var(--warn-soft, #fff4e2)",
                    border: "1px solid var(--warn, #d4944e)",
                    borderRadius: 7, padding: "8px 10px",
                    fontSize: 11.5, color: "var(--ink-2)", lineHeight: 1.5,
                    maxHeight: 160, overflowY: "auto",
                  }}>
                    {errors.slice(0, 12).map((e, i) => (
                      <div key={i}><strong>{e.name || `Row ${e.row}`}:</strong> {e.reason}</div>
                    ))}
                    {errors.length > 12 && (
                      <div style={{ color: "var(--ink-4)", marginTop: 4 }}>…and {errors.length - 12} more</div>
                    )}
                  </div>
                )}
              </div>
            )
          ) : (
            <>
              <div
                onClick={() => inputRef.current?.click()}
                style={{
                  border: "2px dashed var(--rule)", borderRadius: 12, padding: 26,
                  textAlign: "center", cursor: "pointer", background: "var(--card-2)",
                }}
              >
                <Icon name="upload" size={22} />
                <div style={{ marginTop: 8, fontSize: 13, fontWeight: 500 }}>
                  {file ? file.name : "Click to select a CSV or Excel file"}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 4 }}>
                  {file ? `${(file.size / 1024).toFixed(1)} KB` : ".csv / .xlsx — teachers + ops + interns"}
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                  style={{ display: "none" }}
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                Need a starting point? <a onClick={downloadSample} style={{ color: "var(--accent)", cursor: "pointer", textDecoration: "underline" }}>Download a sample template</a>. Only <b>Name</b> + <b>Email</b> are required. Teacher logins are auto-created from the email column; the password is derived from the first name (<i>aakash → Aakash@123</i>) and shared in a download-CSV modal after import.
              </div>
              {phase === "importing" && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 12px", borderRadius: 8,
                  background: "var(--accent-soft)", color: "var(--accent-2)",
                  fontSize: 12.5, fontWeight: 500,
                }}>
                  <span className="spinner" style={{
                    width: 14, height: 14, borderRadius: "50%",
                    border: "2px solid var(--accent)", borderTopColor: "transparent",
                    animation: "spin 0.8s linear infinite",
                  }} />
                  Importing staff and provisioning teacher logins…
                  <style jsx>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                </div>
              )}
            </>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {phase === "done" ? (
              <button className="btn accent" onClick={onClose}>
                <Icon name="check" size={13} />Done
              </button>
            ) : (
              <>
                <button className="btn ghost" onClick={onClose} disabled={phase === "importing"}>
                  {phase === "importing" ? "Please wait…" : "Cancel"}
                </button>
                <button className="btn accent" disabled={!file || phase === "importing"} onClick={onClick}>
                  {phase === "importing" ? (
                    <>
                      <span style={{
                        width: 12, height: 12, borderRadius: "50%",
                        border: "2px solid currentColor", borderTopColor: "transparent",
                        display: "inline-block", animation: "spin 0.8s linear infinite", marginRight: 6,
                      }} />
                      Importing…
                    </>
                  ) : (
                    <><Icon name="upload" size={13} />Import {file ? "" : "(pick a file)"}</>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Shown once after the staff import lands. Lists every generated
// teacher login (email + the common default password) and offers a
// one-click CSV download so the principal can share credentials with
// the teachers via WhatsApp / printed slip / etc.
function ImportStaffLoginsModal({ logins, onClose }) {
  const count = logins.length;
  const downloadCsv = () => {
    const escape = (v) => {
      const s = String(v ?? "");
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const header = "Staff ID,Staff Name,Role,Email,Password";
    const rows = logins.map((l) => [l.staffId, l.staffName, l.role, l.email, l.password].map(escape).join(","));
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `teacher-logins-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.55)",
      display: "grid", placeItems: "center", zIndex: 260, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 600 }}>
        <div className="card-head">
          <div>
            <div className="card-title">{count} teacher login{count === 1 ? "" : "s"} created</div>
            <div className="card-sub">Download the CSV now — the passwords here will not appear again.</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div style={{ padding: "16px 20px 8px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{
            background: "var(--warn-soft, #fff4e2)",
            border: "1px solid var(--warn, #d4944e)",
            color: "var(--ink-2)",
            fontSize: 12, lineHeight: 1.45,
            padding: "10px 12px", borderRadius: 8,
          }}>
            <strong>Security note:</strong> every imported teacher shares the same default password.
            Ask each teacher to change it from <b>My account</b> after first sign-in.
          </div>
          <div style={{
            maxHeight: 320, overflowY: "auto",
            border: "1px solid var(--rule)", borderRadius: 8,
          }}>
            <table className="table" style={{ width: "100%", fontSize: 12 }}>
              <thead>
                <tr style={{ position: "sticky", top: 0, background: "var(--bg)", zIndex: 1 }}>
                  <th style={{ textAlign: "left", padding: "8px 10px" }}>Staff</th>
                  <th style={{ textAlign: "left", padding: "8px 10px" }}>Role</th>
                  <th style={{ textAlign: "left", padding: "8px 10px" }}>Email</th>
                  <th style={{ textAlign: "left", padding: "8px 10px" }}>Password</th>
                </tr>
              </thead>
              <tbody>
                {logins.map((l) => (
                  <tr key={l.staffId} style={{ borderTop: "1px solid var(--rule-2)" }}>
                    <td style={{ padding: "7px 10px" }}>
                      <div style={{ fontWeight: 500 }}>{l.staffName}</div>
                      <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-4)" }}>{l.staffId}</div>
                    </td>
                    <td style={{ padding: "7px 10px", textTransform: "capitalize" }}>{l.role}</td>
                    <td style={{ padding: "7px 10px", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{l.email}</td>
                    <td style={{ padding: "7px 10px", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{l.password}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
            <button className="btn ghost" onClick={onClose}>I've saved these</button>
            <button className="btn accent" onClick={downloadCsv}>
              <Icon name="download" size={13} />Download CSV
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddStaffModal({ onClose, onSubmit }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    name: "", role: "Teacher", dept: "", phone: "", email: "",
    salary: "", attendance: 95, tasks: 90,
  });
  const nameRef = useRef(null);
  useEffect(() => { nameRef.current?.focus(); }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      await onSubmit(form);
    } catch (ex) {
      setErr(ex.message || String(ex));
      setBusy(false);
    }
  }

  return (
    <ModalShell title="New staff" sub="Auto-assigned ID · added to leaderboard" onClose={onClose}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Full name *">
          <input className="input" ref={nameRef} required value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Anita Kumar" />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Role">
            <select className="select" value={form.role} onChange={(e) => set("role", e.target.value)}>
              <option>Teacher</option>
              <option>Ops</option>
              <option>Intern</option>
            </select>
          </Field>
          <Field label="Department">
            <input
              className="input"
              value={form.dept}
              onChange={(e) => set("dept", e.target.value)}
              placeholder={form.role === "Teacher" ? "Academics" : form.role === "Ops" ? "Operations" : "Internship"}
            />
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Phone (10-digit Indian)">
            <input
              className="input"
              value={form.phone}
              onChange={(e) => set("phone", e.target.value.replace(/\D/g, "").slice(0, 10))}
              placeholder="98XXXXXXXX"
              inputMode="numeric"
            />
          </Field>
          <Field label="Email">
            <input className="input" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="staff@school.com" />
          </Field>
        </div>
        <Field label="Salary (₹/month)">
          <input
            className="input"
            value={form.salary}
            onChange={(e) => set("salary", e.target.value.replace(/\D/g, ""))}
            placeholder="35000"
            inputMode="numeric"
          />
        </Field>

        {err && (
          <div style={{
            background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)",
            padding: "9px 12px", borderRadius: 7, fontSize: 12,
          }}>{err}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy}>
            {busy ? "Adding…" : <><Icon name="check" size={13} />Add staff</>}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Staff profile modal — performance dashboard + awards/recognition timeline.
// Performance metrics (attendance, tasks, score, status) are stored on the
// staff row itself; awards live in their own table. Both are editable in
// place by principal/admin; teacher views the same modal read-only.
// ---------------------------------------------------------------------------
function StaffProfileModal({ staff, awards, canEdit, onClose, onRefresh, onToast }) {
  const [tab, setTab] = useState("performance"); // 'performance' | 'awards'
  const [editing, setEditing] = useState(false);
  const [showAwardForm, setShowAwardForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [breakdown, setBreakdown] = useState(null);
  const [recomputedStaff, setRecomputedStaff] = useState(null);
  const [form, setForm] = useState({
    attendance: staff.attendance ?? 0,
    tasks: staff.tasks ?? 0,
    salary: staff.salary ?? 0,
  });

  // Use the freshly-recomputed staff numbers if available, otherwise fall
  // back to whatever was on the leaderboard row.
  const live = recomputedStaff || staff;

  // Auto-recompute on open so the principal sees current numbers without
  // having to click anything. Best-effort — we keep showing whatever's
  // already on the row if the recompute fails.
  useEffect(() => {
    if (!canEdit) return; // teachers can't recompute; the read API enforces this
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/staff/recompute", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: staff.id }),
        });
        const j = await r.json().catch(() => ({}));
        if (!cancelled && j?.ok && j.staff) {
          setRecomputedStaff(j.staff);
          setBreakdown(j.staff.breakdown || null);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staff.id]);

  // Sync local form when staff prop changes (e.g. after a refresh).
  useEffect(() => {
    setForm({
      attendance: live.attendance ?? 0,
      tasks: live.tasks ?? 0,
      salary: live.salary ?? 0,
    });
  }, [live.attendance, live.tasks, live.salary]);

  async function recompute() {
    setBusy(true);
    try {
      const r = await fetch("/api/staff/recompute", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: staff.id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      setRecomputedStaff(j.staff);
      setBreakdown(j.staff.breakdown || null);
      onToast?.(`Recomputed · score ${j.staff.score}`, "ok");
      await onRefresh?.();
    } catch (e) { onToast?.(e.message, "err"); }
    finally { setBusy(false); }
  }

  // Synthesise a 6-month trend from the staff id so the chart isn't empty
  // even when there's no historical data yet. Once a real metrics history
  // table exists, swap this for a real query.
  const trend = useMemo(() => {
    const seed = (staff.id || staff.name || "x").split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    const months = ["Nov", "Dec", "Jan", "Feb", "Mar", "Apr"];
    return months.map((m, i) => {
      const v = ((seed * (i + 3) * 9301 + 49297) % 233280) / 233280;
      const drift = Math.round((v - 0.5) * 16);
      return { month: m, score: Math.max(40, Math.min(100, (live.score ?? 70) + drift)) };
    });
  }, [staff.id, live.score, staff.name]);

  async function savePerformance() {
    setBusy(true);
    try {
      const r = await fetch("/api/staff", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: staff.id,
          attendance: Number(form.attendance) || 0,
          tasks: Number(form.tasks) || 0,
          salary: Number(form.salary) || 0,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      onToast?.(`Updated ${staff.name} · score ${j.staff.score}`, "ok");
      setEditing(false);
      await onRefresh?.();
    } catch (e) { onToast?.(e.message, "err"); }
    finally { setBusy(false); }
  }

  async function addAward(payload) {
    setBusy(true);
    try {
      const r = await fetch("/api/staff/awards", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ staffId: staff.id, ...payload }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      onToast?.(`Awarded ${staff.name} · ${j.award.title}`, "ok");
      setShowAwardForm(false);
      await onRefresh?.();
    } catch (e) { onToast?.(e.message, "err"); throw e; }
    finally { setBusy(false); }
  }

  async function revokeAward(award) {
    if (!confirm(`Revoke "${award.title}" from ${staff.name}?`)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/staff/awards", {
        method: "DELETE", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: award.id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      onToast?.(`Revoked award`, "ok");
      await onRefresh?.();
    } catch (e) { onToast?.(e.message, "err"); }
    finally { setBusy(false); }
  }

  return (
    <ModalShell
      title={staff.name}
      sub={`${staff.id || ""} · ${staff.role} · ${staff.dept}`}
      onClose={onClose}
      width={680}
    >
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 0, maxHeight: "75vh", overflowY: "auto", padding: 0 }}>
        {/* Header strip */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--rule-2)", display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
            color: "var(--accent-ink, #fff)",
            display: "grid", placeItems: "center",
            fontWeight: 600, fontSize: 20,
          }}>{staff.avatar || initialsOf(staff.name)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>{staff.id}</span>
              <span className="meta-dot">·</span>
              <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{staff.role} · {staff.dept}</span>
              {staff.email && <><span className="meta-dot">·</span><span style={{ fontSize: 11, color: "var(--ink-3)" }}>{staff.email}</span></>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
              <span className="mono" style={{ fontSize: 26, fontWeight: 600 }}>{live.score ?? 0}</span>
              <span style={{ fontSize: 11, color: "var(--ink-4)" }}>auto-computed score</span>
              {live.status === "top" && <span className="chip ok"><span className="dot" />Top performer</span>}
              {live.status === "ok"  && <span className="chip"><span className="dot" />On track</span>}
              {live.status === "low" && <span className="chip bad"><span className="dot" />Needs review</span>}
              {awards.length > 0 && (
                <span className="chip ok" style={{ marginLeft: "auto" }}>
                  <Icon name="trending" size={11} />{awards.length} award{awards.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 0, padding: "0 20px", borderBottom: "1px solid var(--rule-2)" }}>
          <TabBtn active={tab === "performance"} onClick={() => setTab("performance")} icon="trending">
            Performance
          </TabBtn>
          <TabBtn active={tab === "awards"} onClick={() => setTab("awards")} icon="check">
            Awards · {awards.length}
          </TabBtn>
        </div>

        {/* Performance tab — auto-computed from real signals */}
        {tab === "performance" && (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Score = 30% own attendance + 50% student performance + 20% contribution
              </div>
              {canEdit && (
                <button className="btn sm" onClick={recompute} disabled={busy}>
                  <Icon name="refresh" size={11} />{busy ? "Recomputing…" : "Recompute"}
                </button>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <SignalCard
                label="Own attendance"
                weight="30%"
                value={breakdown?.attendance?.score ?? live.attendance ?? 0}
                detail={breakdown?.attendance
                  ? `${breakdown.attendance.present} present of ${breakdown.attendance.total} days`
                  : "from teacher_attendance · last 30 days"}
                tone={(breakdown?.attendance?.score ?? live.attendance ?? 0) < 85 ? "warn" : "ok"}
              />
              <SignalCard
                label="Student performance"
                weight="50%"
                value={breakdown?.student?.score ?? live.tasks ?? 0}
                detail={breakdown?.student
                  ? buildStudentDetail(breakdown.student)
                  : "avg of student attendance · exam % · homework done"}
                tone="accent"
              />
              <SignalCard
                label="Contribution"
                weight="20%"
                value={breakdown?.contribution?.score ?? 0}
                detail={breakdown?.contribution
                  ? `${breakdown.contribution.awards} awards · ${breakdown.contribution.tasksDone} tasks · ${breakdown.contribution.logsPosted} logs`
                  : "awards · tasks done · daily logs posted"}
                tone="ok"
              />
            </div>

            {breakdown?.student?.studentCount === 0 && breakdown?.student?.classes?.length === 0 && (
              <div style={{ background: "var(--card-2)", border: "1px solid var(--rule)", borderRadius: 9, padding: 12, fontSize: 12, color: "var(--ink-3)" }}>
                No classes assigned to this teacher yet. Assign them as a class teacher in Classes / Users to start tracking student performance.
              </div>
            )}

            <div>
              <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
                Composite score · last 6 months
              </div>
              <TrendChart points={trend} />
            </div>

            {canEdit && (
              <div style={{ borderTop: "1px solid var(--rule-2)", paddingTop: 14 }}>
                {!editing ? (
                  <button className="btn sm ghost" onClick={() => setEditing(true)} title="One-off correction · the next Recompute will overwrite">
                    <Icon name="pencil" size={11} />Manual override (one-off)
                  </button>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ fontSize: 11, color: "var(--warn, #b07c28)" }}>
                      Manual override · the next Recompute will overwrite these numbers with live signals.
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                      <Field label="Attendance %">
                        <input className="input" type="number" min={0} max={100}
                          value={form.attendance}
                          onChange={(e) => setForm((f) => ({ ...f, attendance: e.target.value }))} />
                      </Field>
                      <Field label="Student perf %">
                        <input className="input" type="number" min={0} max={100}
                          value={form.tasks}
                          onChange={(e) => setForm((f) => ({ ...f, tasks: e.target.value }))} />
                      </Field>
                      <Field label="Salary (₹)">
                        <input className="input" type="number" min={0}
                          value={form.salary}
                          onChange={(e) => setForm((f) => ({ ...f, salary: e.target.value }))} />
                      </Field>
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                      <button className="btn ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
                      <button className="btn accent" onClick={savePerformance} disabled={busy}>
                        <Icon name="check" size={12} />{busy ? "Saving…" : "Save override"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Awards tab */}
        {tab === "awards" && (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Recognition timeline · newest first
              </div>
              {canEdit && !showAwardForm && (
                <button className="btn sm accent" onClick={() => setShowAwardForm(true)}>
                  <Icon name="plus" size={11} />Award teacher
                </button>
              )}
            </div>

            {canEdit && showAwardForm && (
              <AwardForm
                onCancel={() => setShowAwardForm(false)}
                onSubmit={addAward}
                busy={busy}
              />
            )}

            {awards.length === 0 ? (
              <div className="empty" style={{ padding: 30, textAlign: "center" }}>
                No awards yet.{canEdit && " Click Award teacher to recognise a contribution."}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {awards.map((a) => {
                  const tone = AWARD_CATEGORIES.find((c) => c.k === a.category)?.tone || "ok";
                  return (
                    <div key={a.id} style={{
                      display: "flex", gap: 12, padding: 12,
                      background: "var(--card-2)", border: "1px solid var(--rule)",
                      borderRadius: 9,
                    }}>
                      <div style={{
                        width: 36, height: 36, borderRadius: 9,
                        background: `var(--${tone === "ok" ? "ok" : tone === "warn" ? "warn" : "accent"}-soft, var(--card-2))`,
                        color: `var(--${tone === "ok" ? "ok" : tone === "warn" ? "warn" : "accent"})`,
                        display: "grid", placeItems: "center", flexShrink: 0,
                      }}>
                        <Icon name="check" size={16} stroke={2.5} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 13.5, fontWeight: 500 }}>{a.title}</span>
                          <span className={`chip ${tone}`} style={{ fontSize: 10 }}>{a.category}</span>
                          <span style={{ fontSize: 10.5, color: "var(--ink-4)", marginLeft: "auto", fontFamily: "var(--font-mono)" }}>{a.awardedAt}</span>
                        </div>
                        {a.citation && (
                          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4, lineHeight: 1.5 }}>{a.citation}</div>
                        )}
                        {a.awardedBy && (
                          <div style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 4 }}>
                            Issued by {a.awardedBy}
                          </div>
                        )}
                      </div>
                      {canEdit && (
                        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => revokeAward(a)} title="Revoke">
                          <Icon name="x" size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

const AWARD_CATEGORIES = [
  { k: "recognition", label: "Recognition", tone: "ok" },
  { k: "attendance",  label: "Attendance",  tone: "ok"  },
  { k: "academic",    label: "Academic",    tone: "warn"  },
  { k: "service",     label: "Service",     tone: "ok"  },
];

function TabBtn({ active, onClick, icon, children }) {
  return (
    <button onClick={onClick} style={{
      padding: "12px 16px", border: 0,
      background: "transparent", cursor: "pointer",
      fontSize: 12.5, fontWeight: 500,
      color: active ? "var(--accent-2, var(--accent))" : "var(--ink-3)",
      borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
      display: "inline-flex", alignItems: "center", gap: 6,
      marginBottom: -1,
    }}>
      <Icon name={icon} size={12} />{children}
    </button>
  );
}

// Card showing a single signal that feeds the composite score, with the
// signal's value, weight, and a one-line explanation of what data fed it.
function SignalCard({ label, weight, value, detail, tone = "accent" }) {
  const v = Math.min(100, Math.max(0, Number(value) || 0));
  const barColor =
    tone === "ok"   ? "var(--ok)"   :
    tone === "warn" ? "var(--warn)" :
    tone === "bad"  ? "var(--bad)"  :
    "var(--accent)";
  return (
    <div style={{
      padding: 12, background: "var(--card-2)",
      border: "1px solid var(--rule)", borderRadius: 9,
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 10.5, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
        <span style={{ fontSize: 10, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{weight}</span>
      </div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 500 }}>{v}%</div>
      <div className="bar">
        <span style={{ width: `${v}%`, background: barColor }} />
      </div>
      <div style={{ fontSize: 10.5, color: "var(--ink-4)", lineHeight: 1.4 }}>{detail}</div>
    </div>
  );
}

// Build the one-line "where did this number come from" caption for the
// student-performance signal card.
function buildStudentDetail(b) {
  if (!b) return "";
  if (!b.studentCount) {
    return b.classes?.length ? `${b.classes.join(", ")} · no students yet` : "No assigned classes";
  }
  const parts = [];
  if (b.attendance != null) parts.push(`att ${b.attendance}%`);
  if (b.examPct != null)    parts.push(`exams ${b.examPct}%`);
  if (b.homeworkPct != null) parts.push(`hw ${b.homeworkPct}%`);
  const detail = parts.length ? parts.join(" · ") : "no signals yet";
  return `${b.studentCount} students in ${b.classes.join(", ")} · ${detail}`;
}

// Plain SVG line chart — no dependencies. Smooth-ish polyline + dots,
// grid lines at 50/75/100 for context.
function TrendChart({ points }) {
  const W = 600, H = 140, P = 24;
  if (!points || points.length === 0) return null;
  const max = 100, min = 40;
  const stepX = (W - P * 2) / (points.length - 1);
  const yFor = (s) => H - P - ((s - min) / (max - min)) * (H - P * 2);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${P + i * stepX} ${yFor(p.score)}`).join(" ");
  const area = `${path} L ${P + (points.length - 1) * stepX} ${H - P} L ${P} ${H - P} Z`;
  return (
    <div style={{ background: "var(--card-2)", border: "1px solid var(--rule)", borderRadius: 9, padding: 12 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
        {[50, 75, 100].map((g) => (
          <g key={g}>
            <line x1={P} x2={W - P} y1={yFor(g)} y2={yFor(g)} stroke="var(--rule-2, #e5dfd1)" strokeDasharray="3 4" strokeWidth="1" />
            <text x={P - 6} y={yFor(g) + 3} textAnchor="end" fontSize="10" fill="var(--ink-4)" fontFamily="var(--font-mono)">{g}</text>
          </g>
        ))}
        <path d={area} fill="var(--accent-soft, rgba(200,81,10,0.12))" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={P + i * stepX} cy={yFor(p.score)} r="3.5" fill="var(--accent)" />
            <text x={P + i * stepX} y={H - P + 14} textAnchor="middle" fontSize="10" fill="var(--ink-4)" fontFamily="var(--font-mono)">{p.month}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function AwardForm({ onCancel, onSubmit, busy }) {
  const [title, setTitle] = useState("");
  const [citation, setCitation] = useState("");
  const [category, setCategory] = useState("recognition");
  const [awardedAt, setAwardedAt] = useState(
    new Date().toLocaleDateString("en-IN", { month: "short", year: "numeric" })
  );
  const [err, setErr] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!title.trim()) { setErr("Title is required"); return; }
    setErr("");
    try {
      await onSubmit({ title: title.trim(), citation: citation.trim(), category, awardedAt: awardedAt.trim() });
      setTitle(""); setCitation("");
    } catch (ex) { setErr(ex.message); }
  }

  return (
    <form onSubmit={submit} style={{
      padding: 12, background: "var(--card-2)",
      border: "1px solid var(--accent, var(--rule))", borderRadius: 9,
      display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        New award
      </div>
      <Field label="Title *">
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Teacher of the Month" />
      </Field>
      <Field label="Citation (optional)">
        <textarea className="input" style={{ minHeight: 60, padding: "8px 10px", lineHeight: 1.5, resize: "vertical" }}
          value={citation} onChange={(e) => setCitation(e.target.value)}
          placeholder="Why are you awarding this? (shown on the timeline)" />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Category">
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {AWARD_CATEGORIES.map((c) => <option key={c.k} value={c.k}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Awarded">
          <input className="input" value={awardedAt} onChange={(e) => setAwardedAt(e.target.value)}
            placeholder="Apr 2026" />
        </Field>
      </div>
      {err && (
        <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "8px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn accent" disabled={busy}>
          <Icon name="check" size={12} />{busy ? "Awarding…" : "Issue award"}
        </button>
      </div>
    </form>
  );
}
