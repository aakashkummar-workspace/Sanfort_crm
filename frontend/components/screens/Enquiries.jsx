"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { resolveSchool, downloadPdf } from "@/lib/export";
import { KPI, AvatarChip } from "../ui";
import { formatClassLabel } from "@/lib/format";

const SOURCES = ["Website", "Walk-in", "Referral", "Phone", "Instagram", "Facebook", "Google", "Other"];
const COLUMNS = [
  { s: "New",       tone: "info", desc: "Just in · needs first call" },
  { s: "Contacted", tone: "warn", desc: "Follow-up in progress" },
  { s: "Converted", tone: "ok",   desc: "Admission confirmed" },
  { s: "Rejected",  tone: "bad",  desc: "Not a fit · archived" },
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

export default function ScreenEnquiries({ E, refresh, role, session }) {
  const school = resolveSchool(E?.SETTINGS);
  const actor  = session?.name || null;
  const canEdit = role === "principal" || role === "admin" || role === "academic_director";
  const [showAdd, setShowAdd] = useState(false);
  const [toast, setToast] = useState(null);
  // Set after a successful "Convert" — shows the parent's login email +
  // generated temp password so the office can hand it to them on the spot.
  const [credModal, setCredModal] = useState(null);
  // Pending Convert action — caches the enquiry while we ask the user to
  // confirm. Conversion is a one-way trip (creates the student row, raises
  // a fee, provisions a parent login), so we never run it on a single
  // accidental click of a menu item.
  const [convertAsk, setConvertAsk] = useState(null);

  const data = E.ENQUIRIES || [];
  const classes = E.CLASSES || [];

  const counts = useMemo(() => {
    const c = { New: 0, Contacted: 0, Converted: 0, Rejected: 0 };
    data.forEach((e) => { if (c[e.status] !== undefined) c[e.status]++; });
    return c;
  }, [data]);

  const showToast = (msg, tone) => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 3500);
  };

  // Wrapper called by the row menu / forward button. Special-cases two
  // transitions:
  //   1. Already Converted → block ALL moves. Conversion is terminal:
  //      a student row + parent login were created, undoing it cleanly
  //      would mean rolling back a real admission. Surface that as a
  //      toast instead of silently moving the row.
  //   2. Target = Converted → ask for confirmation before firing, since
  //      it has heavy side-effects (admission, fee, parent account).
  function requestStatus(id, status) {
    const enquiry = data.find((e) => e.id === id);
    if (!enquiry) return;
    if (enquiry.status === "Converted") {
      showToast("Converted enquiries can't be moved — admission already confirmed", "err");
      return;
    }
    if (status === "Converted") {
      setConvertAsk(enquiry);
      return;
    }
    setStatus(id, status);
  }

  async function setStatus(id, status) {
    try {
      const r = await fetch("/api/enquiries", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      // Conversion: backend additionally creates a student row + parent login.
      // Pop a credentials modal so staff can copy/share before it's gone.
      if (status === "Converted" && json.parentLogin) {
        setCredModal({
          enquiry: json.enquiry,
          student: json.student,
          email: json.parentLogin.email,
          tempPassword: json.parentLogin.tempPassword,
          alreadyExisted: json.parentLogin.alreadyExisted,
        });
        showToast(
          json.parentLogin.alreadyExisted
            ? `${json.enquiry.name}: parent login already provisioned`
            : `${json.enquiry.name} admitted · parent login created`,
          "ok"
        );
      } else {
        showToast(`${json.enquiry.name} → ${status}`, "ok");
      }
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
  }

  async function handleAdd(payload) {
    const r = await fetch("/api/enquiries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) throw new Error(json.error || "Failed to add");
    setShowAdd(false);
    showToast(`Enquiry added: ${json.enquiry.name}`, "ok");
    await refresh?.();
  }

  function exportPdf() {
    if (data.length === 0) {
      showToast("No enquiries to export", "err");
      return;
    }
    const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    downloadPdf({
      title: "Admission Enquiries",
      subtitle: `${data.length} enquir${data.length === 1 ? "y" : "ies"} on file`,
      school, actor,
      dateRange: today,
      orientation: "landscape",
      summary: [
        { label: "New",       value: counts.New || 0 },
        { label: "Contacted", value: counts.Contacted || 0 },
        { label: "Converted", value: counts.Converted || 0 },
        { label: "Rejected",  value: counts.Rejected || 0 },
      ],
      columns: [
        { key: "i",      label: "#",        align: "right",  width: "32px" },
        { key: "id",     label: "ID",       width: "100px" },
        { key: "name",   label: "Student" },
        { key: "parent", label: "Parent" },
        { key: "phone",  label: "Phone",    align: "right" },
        { key: "cls",    label: "Class",    align: "center", width: "70px" },
        { key: "source", label: "Source",   width: "110px" },
        { key: "status", label: "Status",   align: "center", width: "100px" },
        { key: "date",   label: "Received", align: "right",  width: "110px" },
      ],
      rows: data.map((e, i) => ({
        i: i + 1, id: e.id, name: e.name || "—", parent: e.parent || "—",
        phone: e.phone || "—",
        cls: e.cls ? formatClassLabel(`${e.cls}-A`) : "—",
        source: e.source || "—", status: e.status || "—",
        date: e.date || "—",
      })),
      filename: `${school.name.replace(/\s+/g, "-").toLowerCase()}-enquiries-${today.replace(/\s+/g, "-").toLowerCase()}`,
    });
    showToast(`Opened PDF preview · ${data.length} enquiries`, "ok");
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">CRM · Admissions</div>
          <div className="page-title">Admission <span className="amber">enquiries</span></div>
          <div className="page-sub">Pipeline · source tracking · conversion</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={exportPdf} disabled={data.length === 0} title="Open a printable, branded PDF report">
            <Icon name="download" size={13} />Export PDF
          </button>
          {canEdit && (
            <button className="btn accent" onClick={() => setShowAdd(true)}>
              <Icon name="plus" size={13} />New enquiry
            </button>
          )}
        </div>
      </div>

      <div className="grid g-4" style={{ marginBottom: 14 }}>
        {(() => {
          const byStatus = (s) => data.filter((e) => e.status === s);
          const open = [...byStatus("New"), ...byStatus("Contacted")];
          const itemFor = (e, tone) => ({
            label: e.name,
            value: e.cls ? formatClassLabel(`${e.cls}-A`) : "—",
            sub: `${e.source || "—"} · ${e.date || ""}${e.phone ? ` · ${e.phone}` : ""}`,
            tone,
          });
          return (
            <>
              <KPI
                label="Open pipeline" value={counts.New + counts.Contacted}
                sub="awaiting follow-up"
                puck="mint" puckIcon="enquiry"
                details={{
                  title: `Open pipeline · ${open.length}`,
                  sub: `${counts.New} new · ${counts.Contacted} contacted`,
                  items: open.map((e) => itemFor(e, e.status === "New" ? "warn" : "")),
                }}
              />
              <KPI
                label="Converted" value={counts.Converted} sub="admissions confirmed"
                puck="cream" puckIcon="check"
                details={{
                  title: `Converted · ${counts.Converted}`,
                  sub: "Now admitted students",
                  items: byStatus("Converted").map((e) => itemFor(e, "ok")),
                }}
              />
              <KPI
                label="Rejected" value={counts.Rejected} sub="archived"
                puck="peach" puckIcon="x"
                details={{
                  title: `Rejected · ${counts.Rejected}`,
                  sub: counts.Rejected === 0 ? "No enquiries rejected" : "Archived enquiries",
                  items: byStatus("Rejected").map((e) => itemFor(e, "bad")),
                }}
              />
              <KPI
                label="Total enquiries" value={data.length} sub="all-time"
                puck="sky" puckIcon="trending"
                details={{
                  title: `Enquiries · ${data.length} all-time`,
                  sub: "Conversion rate at a glance",
                  items: [
                    { label: "New",       value: counts.New,       tone: "warn", sub: "first contact pending" },
                    { label: "Contacted", value: counts.Contacted, tone: "",     sub: "in conversation" },
                    { label: "Converted", value: counts.Converted, tone: "ok",   sub: data.length > 0 ? `${Math.round((counts.Converted / data.length) * 100)}% of total` : "" },
                    { label: "Rejected",  value: counts.Rejected,  tone: "bad",  sub: data.length > 0 ? `${Math.round((counts.Rejected / data.length) * 100)}% of total` : "" },
                  ],
                }}
              />
            </>
          );
        })()}
      </div>

      <div className="grid g-12">
        <div className="col-12" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
          {COLUMNS.map((col) => {
            const items = data.filter((e) => e.status === col.s);
            return (
              <div key={col.s} className="card">
                <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--rule)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={`chip ${col.tone}`}><span className="dot" />{col.s}</span>
                    <span className="mono" style={{ marginLeft: "auto", fontSize: 12, color: "var(--ink-3)" }}>{items.length}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 4 }}>{col.desc}</div>
                </div>
                <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6, minHeight: 220 }}>
                  {items.length === 0 && (
                    <div className="empty" style={{ padding: "20px 8px", fontSize: 11.5 }}>
                      {col.s === "New" ? "Add enquiries to start the pipeline" : `No ${col.s.toLowerCase()} enquiries`}
                    </div>
                  )}
                  {items.map((e) => (
                    <EnquiryCard
                      key={e.id} enquiry={e} status={col.s} canEdit={canEdit}
                      onSetStatus={requestStatus}
                      onCall={() => showToast(`Calling ${e.parent} (${e.phone})…`, "ok")}
                      onWhatsApp={() => showToast(`WhatsApp drafted to ${e.parent}`, "ok")}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showAdd && canEdit && (
        <NewEnquiryModal classes={classes} onClose={() => setShowAdd(false)} onSubmit={handleAdd} />
      )}
      {credModal && (
        <ParentCredentialsModal
          info={credModal}
          onClose={() => setCredModal(null)}
          onToast={(msg, tone) => showToast(msg, tone)}
        />
      )}
      {convertAsk && (
        <ConvertConfirmModal
          enquiry={convertAsk}
          onCancel={() => setConvertAsk(null)}
          onConfirm={async () => {
            const target = convertAsk;
            setConvertAsk(null);
            await setStatus(target.id, "Converted");
          }}
        />
      )}

      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />
    </div>
  );
}


function EnquiryCard({ enquiry, status, canEdit, onSetStatus, onCall, onWhatsApp }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  const e = enquiry;
  // Forward action depends on column.
  const fwd = status === "New" ? "Contacted" : status === "Contacted" ? "Converted" : null;
  // Converted enquiries are terminal — admission already happened, parent
  // login provisioned, fee raised. Hide every control that could move
  // the row to a different state.
  const isLocked = status === "Converted";

  return (
    <div style={{ background: "var(--card-2)", border: "1px solid var(--rule-2)", borderRadius: 8, padding: 10, position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <AvatarChip initials={(e.name || "?").split(" ").map((n) => n[0]).join("")} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>{e.name}</div>
          <div style={{ fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{e.id} · {e.date}</div>
        </div>
        {canEdit && !isLocked && (
          <div ref={menuRef} style={{ position: "relative" }}>
            <button className="icon-btn" onClick={() => setMenuOpen((s) => !s)} title="Move to…"><Icon name="more" size={13} /></button>
            {menuOpen && (
              <div style={{
                position: "absolute", right: 0, top: "calc(100% + 4px)", minWidth: 160,
                background: "var(--card, #fff)", border: "1px solid var(--rule, #e5dfd1)",
                borderRadius: 8, padding: 4, zIndex: 50,
                boxShadow: "0 16px 40px -20px rgba(0,0,0,0.25)",
              }}>
                {COLUMNS.filter((c) => c.s !== status).map((c) => (
                  <button
                    key={c.s}
                    onClick={() => { setMenuOpen(false); onSetStatus(e.id, c.s); }}
                    style={{
                      width: "100%", textAlign: "left",
                      padding: "7px 10px", background: "transparent", border: 0, borderRadius: 5,
                      cursor: "pointer", color: "var(--ink-2)", fontSize: 12,
                      display: "flex", alignItems: "center", gap: 8,
                    }}
                    onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--bg-2)")}
                    onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
                  >
                    Move to {c.s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {isLocked && (
          <span className="chip ok" title="Converted enquiries are locked — admission already confirmed" style={{ fontSize: 10 }}>
            <Icon name="check" size={10} stroke={2.5} />Locked
          </span>
        )}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.5 }}>
        {e.cls ? formatClassLabel(`${e.cls}-A`) : "—"} · {e.source}
        <br />
        {e.parent} · <span className="mono">{e.phone}</span>
      </div>
      <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
        <button className="btn sm" onClick={onCall} title="Call parent"><Icon name="phone" size={11} /></button>
        <button className="btn sm" onClick={onWhatsApp} title="WhatsApp parent"><Icon name="whatsapp" size={11} /></button>
        {canEdit && fwd && (
          <button className="btn sm accent" style={{ marginLeft: "auto" }} onClick={() => onSetStatus(e.id, fwd)}>
            {fwd === "Contacted" ? "Contact" : "Convert"}
          </button>
        )}
        {canEdit && status !== "Rejected" && status !== "Converted" && (
          <button className="btn sm ghost" onClick={() => onSetStatus(e.id, "Rejected")} title="Reject">
            <Icon name="x" size={11} />
          </button>
        )}
        {canEdit && status === "Rejected" && (
          <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => onSetStatus(e.id, "New")}>
            Re-open
          </button>
        )}
        {canEdit && status === "Converted" && (
          <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--ink-4)" }}>
            Admission confirmed
          </span>
        )}
      </div>
    </div>
  );
}

// Compute the borrower's age in completed years from a YYYY-MM-DD string.
// Returns "" if the date is missing or can't be parsed — keeps the read-only
// "Auto-calculated" placeholder visible until a valid DOB is typed.
function ageFromDob(dob) {
  if (!dob) return "";
  const d = new Date(dob);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  let years = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) years -= 1;
  return years >= 0 && years < 120 ? years : "";
}

function NewEnquiryModal({ classes, onClose, onSubmit }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    name: "",
    dob: "",                                                  // YYYY-MM-DD from <input type="date">
    street: "",
    city: "",
    pin: "",
    cls: classes[0]?.n ? String(classes[0].n) : "1",
  });
  const nameRef = useRef(null);
  useEffect(() => { nameRef.current?.focus(); }, []);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const age = ageFromDob(form.dob);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      if (!form.name.trim()) throw new Error("Full name is required");
      if (!form.dob)         throw new Error("Date of birth is required");
      if (!form.street.trim()) throw new Error("Street / area is required");
      if (form.pin && !/^\d{6}$/.test(form.pin)) throw new Error("PIN code must be 6 digits");
      await onSubmit({
        name: form.name.trim(),
        dob: form.dob,
        age: age === "" ? null : age,
        address: {
          street: form.street.trim(),
          city: form.city.trim() || null,
          pin: form.pin || null,
        },
        cls: Number(form.cls),
        source: "Form",
      });
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }

  // Section heading — visual separator with an uppercase mini-label, matches
  // the printed-form template the school uses.
  const SectionHead = ({ children }) => (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.6 }}>{children}</div>
      <div style={{ height: 1, background: "var(--rule)", marginTop: 6 }} />
    </div>
  );

  return (
    <ModalShell title="New admission enquiry" sub="Sanfort International School · Pooranankuppam, Pondicherry" onClose={onClose} width={560}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        <SectionHead>Student details</SectionHead>
        <Field label="Full name *">
          <input
            className="input"
            ref={nameRef}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="As per birth certificate"
          />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Date of birth *">
            <input
              className="input"
              type="date"
              value={form.dob}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => set("dob", e.target.value)}
            />
          </Field>
          <Field label="Age (years)">
            <input
              className="input"
              value={age}
              readOnly
              tabIndex={-1}
              placeholder="Auto-calculated"
              style={{ background: "var(--bg-2)", color: "var(--ink-3)", cursor: "not-allowed" }}
            />
          </Field>
        </div>

        <SectionHead>Address</SectionHead>
        <Field label="Street / Area *">
          <input
            className="input"
            value={form.street}
            onChange={(e) => set("street", e.target.value)}
            placeholder="Door no., street, locality"
          />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 10 }}>
          <Field label="City">
            <input
              className="input"
              value={form.city}
              onChange={(e) => set("city", e.target.value)}
              placeholder="City"
            />
          </Field>
          <Field label="PIN code">
            <input
              className="input"
              inputMode="numeric"
              value={form.pin}
              onChange={(e) => set("pin", e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="6-digit PIN"
            />
          </Field>
        </div>

        <SectionHead>Admission</SectionHead>
        <Field label="Class applying for *">
          <select className="select" value={form.cls} onChange={(e) => set("cls", e.target.value)}>
            <option value="">— select class —</option>
            {(classes.length ? classes : [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }, { n: 6 }, { n: 7 }, { n: 8 }]).map((c) => (
              <option key={c.n} value={c.n}>{c.label || formatClassLabel(String(c.n))}</option>
            ))}
          </select>
        </Field>

        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy || !form.name.trim() || !form.dob || !form.street.trim() || !form.cls}>
            {busy ? "Submitting…" : <><Icon name="check" size={13} />Submit enquiry</>}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// Shown immediately after a successful "Convert" so the office can hand
// the parent their first-time login. The temp password is only ever
// available HERE — closing the modal is the last chance to copy it (the
// server stores only the bcrypt hash). Re-converting an enquiry returns
// `alreadyExisted: true` and we just confirm the email without showing
// a fresh password.
function ParentCredentialsModal({ info, onClose, onToast }) {
  const { enquiry, student, email, tempPassword, alreadyExisted } = info;
  const phoneDigits = (enquiry?.phone || "").replace(/\D/g, "");
  const message =
    `Welcome to Sanfort International — admission confirmed for ${student.name} (${formatClassLabel(student.cls)}).\n\n` +
    `Parent portal login:\n` +
    `Email: ${email}\n` +
    (tempPassword ? `Temporary password: ${tempPassword}\n\n` : "") +
    `Please change your password after first sign-in.`;

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(`Copied ${label}`, "ok");
    } catch {
      onToast("Copy failed — long-press to select instead", "err");
    }
  };

  const sendWhatsApp = () => {
    if (!phoneDigits) { onToast("No parent phone on file", "err"); return; }
    const url = `https://wa.me/${phoneDigits}?text=${encodeURIComponent(message)}`;
    window.open(url, "_blank");
  };
  const sendSms = () => {
    if (!phoneDigits) { onToast("No parent phone on file", "err"); return; }
    window.open(`sms:${phoneDigits}?body=${encodeURIComponent(message)}`, "_self");
  };

  return (
    <ModalShell
      title={alreadyExisted ? "Parent already provisioned" : "Parent login created"}
      sub={`${student.name} · ${student.id} · ${formatClassLabel(student.cls)}`}
      onClose={onClose}
      width={520}
    >
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{
          padding: 12, background: "var(--accent-soft, #fff4dc)",
          border: "1px solid var(--accent, #c8510a)", borderRadius: 9,
          display: "flex", flexDirection: "column", gap: 8,
        }}>
          <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Email
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ flex: 1, fontSize: 13.5, wordBreak: "break-all" }}>{email}</span>
            <button className="btn sm" onClick={() => copy(email, "email")}>
              <Icon name="copy" size={11} />Copy
            </button>
          </div>
          <div className="hr" style={{ margin: "2px 0" }} />
          <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Temporary password
          </div>
          {tempPassword ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="mono" style={{
                flex: 1, fontSize: 18, letterSpacing: "0.1em", fontWeight: 600,
              }}>{tempPassword}</span>
              <button className="btn sm" onClick={() => copy(tempPassword, "password")}>
                <Icon name="copy" size={11} />Copy
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
              Already issued earlier — use the password from the original handover.
              If lost, reset it from <b>Staff → Users</b>.
            </div>
          )}
        </div>

        <div style={{ fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.5 }}>
          {tempPassword ? (
            <>
              This password is shown <b>only once</b>. Copy it now or share via WhatsApp / SMS below —
              the server stores only the hash. Ask the parent to change it after first sign-in.
            </>
          ) : (
            <>This parent already has an account. The original temp password isn't recoverable.</>
          )}
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn sm" onClick={() => copy(message, "full message")}>
            <Icon name="copy" size={11} />Copy full message
          </button>
          <button className="btn sm" onClick={sendWhatsApp} disabled={!phoneDigits}>
            <Icon name="whatsapp" size={11} />WhatsApp
          </button>
          <button className="btn sm" onClick={sendSms} disabled={!phoneDigits}>
            <Icon name="sms" size={11} />SMS
          </button>
          <button className="btn accent" style={{ marginLeft: "auto" }} onClick={onClose}>
            <Icon name="check" size={12} />Done
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// Confirmation dialog before promoting an enquiry to "Converted". The
// conversion has heavy side-effects (creates the student row, raises a
// pending fee, provisions a parent login) and is irreversible — the row
// becomes locked once it lands in the Converted column. Worth a single
// click of intent before firing.
function ConvertConfirmModal({ enquiry, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  async function go() {
    if (busy) return;
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: 460 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Convert {enquiry.name} to admission?</div>
            <div className="card-sub">{enquiry.id} · {enquiry.cls ? formatClassLabel(`${enquiry.cls}-A`) : "—"}</div>
          </div>
          <button className="icon-btn" onClick={onCancel}><Icon name="x" size={14} /></button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13, lineHeight: 1.55 }}>
            Converting an enquiry confirms the admission. The system will:
          </div>
          <div style={{
            background: "var(--card-2)", border: "1px solid var(--rule)",
            borderRadius: 9, padding: 12, fontSize: 12, color: "var(--ink-2)", lineHeight: 1.7,
          }}>
            <div>• Create a student record (auto-assigned ID, {enquiry.cls ? formatClassLabel(`${enquiry.cls}-A`) : "—"})</div>
            <div>• Raise the term fee against the new student</div>
            <div>• Generate a parent login email + temporary password</div>
            <div>• Lock this enquiry — it can't be moved to another column afterwards</div>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--warn, #b07c28)" }}>
            This action can't be undone from here. To unwind, you'd have to archive the
            student manually.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
            <button className="btn accent" onClick={go} disabled={busy}>
              <Icon name="check" size={13} />{busy ? "Converting…" : "Yes, confirm admission"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
