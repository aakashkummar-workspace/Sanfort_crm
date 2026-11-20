"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { KPI, AvatarChip } from "../ui";
import DocumentsPanel from "../DocumentsPanel";

// Mirror the Sanvi paper form. Order matters — the same order is used in
// the printed PDF and the on-screen pickers so what staff fill on screen
// matches what comes out of the printer.
const AVAIL_OPTIONS    = ["weekdays", "weekends", "both"];
const DURATION_OPTIONS = [{ k: "short", label: "Short-term" }, { k: "long", label: "Long-term" }];
const ID_TYPES         = ["Aadhaar", "Voter ID", "Passport", "Driving License"];
const GENDER_OPTIONS   = ["Male", "Female", "Other"];
const SKILL_SUGGESTIONS = ["Teaching", "Computer Skills", "Event Management", "Social Work", "Fundraising"];
const INTEREST_OPTIONS  = ["Education", "Administration", "Field Work", "Awareness Programs"];

// Compute completed-years age from a YYYY-MM-DD string. Same helper used by
// the admission enquiry modal.
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

// Section divider — matches the printed form's "1. Personal Details" headers.
function SectionHead({ n, children }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
        {n}. {children}
      </div>
      <div style={{ height: 1, background: "var(--rule)", marginTop: 5 }} />
    </div>
  );
}

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
    <div className="modal-backdrop" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,16,10,0.45)", display: "grid", placeItems: "center", zIndex: 250, padding: 16, overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} className="card modal-panel" style={{ width: "100%", maxWidth: width, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
        <div className="card-head">
          <div><div className="card-title">{title}</div>{sub && <div className="card-sub">{sub}</div>}</div>
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

export default function ScreenVolunteers({ E, refresh, role }) {
  const canEdit = role === "admin" || role === "principal";
  const [volunteers, setVolunteers] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [logFor, setLogFor] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (m, t) => { setToast({ msg: m, tone: t }); setTimeout(() => setToast(null), 2800); };

  async function load() {
    try {
      const r = await fetch("/api/volunteers", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setVolunteers(j.volunteers || []);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  const totalHours = useMemo(() => volunteers.reduce((a, v) => a + (Number(v.hours) || 0), 0), [volunteers]);

  async function handleAdd(payload) {
    const r = await fetch("/api/volunteers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    setShowAdd(false);
    showToast(`Volunteer ${j.volunteer.name} added`, "ok");
    await load();
    await refresh?.();
  }

  async function handleLog(payload) {
    const r = await fetch("/api/volunteers", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    setLogFor(null);
    showToast(`+${payload.hours}h logged`, "ok");
    await load();
  }

  async function handleRemove(v) {
    if (!confirm(`Remove ${v.name} from volunteers?`)) return;
    const r = await fetch("/api/volunteers", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: v.id }) });
    const j = await r.json();
    if (!r.ok || !j.ok) { showToast(j.error || "Failed", "err"); return; }
    showToast("Removed", "ok");
    await load();
  }

  return (
    <div className="page">
      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />

      <div className="page-head">
        <div>
          <div className="page-eyebrow">CRM · Volunteers</div>
          <div className="page-title">Volunteers <span className="amber">network</span></div>
          <div className="page-sub">Track skills, availability, and contributed hours</div>
        </div>
        {canEdit && (
          <div className="page-actions">
            <button className="btn accent" onClick={() => setShowAdd(true)}>
              <Icon name="plus" size={13} />Add volunteer
            </button>
          </div>
        )}
      </div>

      <div className="grid g-4" style={{ marginBottom: 14 }}>
        {(() => {
          const active = volunteers.filter((v) => (v.assignments || []).length > 0);
          const sortedByHours = volunteers.slice().sort((a, b) => (b.hours || 0) - (a.hours || 0));
          const skillCount = {};
          for (const v of volunteers) for (const sk of (v.skills || [])) skillCount[sk] = (skillCount[sk] || 0) + 1;
          return (
            <>
              <KPI
                label="Volunteers" value={volunteers.length} sub="on file"
                puck="mint" puckIcon="users"
                details={{
                  title: `Volunteers · ${volunteers.length}`,
                  sub: "On file · most hours first",
                  items: sortedByHours.slice(0, 12).map((v) => ({
                    label: v.name,
                    value: `${v.hours || 0}h`,
                    sub: (v.skills || []).slice(0, 3).join(", ") || v.email || "",
                  })),
                }}
              />
              <KPI
                label="Total hours" value={totalHours} sub="contributed"
                puck="cream" puckIcon="clock"
                details={{
                  title: `Total hours · ${totalHours}`,
                  sub: "Top contributors",
                  items: sortedByHours.slice(0, 12).map((v) => ({
                    label: v.name,
                    value: `${v.hours || 0}h`,
                    sub: v.availability || v.email || "",
                    tone: "ok",
                  })),
                }}
              />
              <KPI
                label="Active" value={active.length} sub="have logged time"
                puck="peach" puckIcon="check"
                details={{
                  title: `Active · ${active.length}`,
                  sub: active.length === 0 ? "Nobody has logged time yet" : "Currently engaged",
                  items: active.map((v) => ({
                    label: v.name,
                    value: `${v.hours || 0}h`,
                    sub: `${(v.assignments || []).length} assignment${(v.assignments || []).length === 1 ? "" : "s"}`,
                  })),
                }}
              />
              <KPI
                label="Skills covered" value={Object.keys(skillCount).length} sub="distinct"
                puck="sky" puckIcon="academic"
                details={{
                  title: `Skills · ${Object.keys(skillCount).length} distinct`,
                  sub: "Volunteers per skill",
                  items: Object.entries(skillCount)
                    .sort((a, b) => b[1] - a[1])
                    .map(([skill, n]) => ({ label: skill, value: n, sub: `${n} volunteer${n === 1 ? "" : "s"}` })),
                }}
              />
            </>
          );
        })()}
      </div>

      <div className="card">
        <div className="card-head">
          <div><div className="card-title">Volunteer directory</div></div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr><th>Volunteer</th><th>Contact</th><th>Skills</th><th>Availability</th><th className="num">Hours</th><th></th></tr>
            </thead>
            <tbody>
              {volunteers.length === 0 && <tr><td colSpan={6} className="empty">No volunteers yet. {canEdit && "Click Add volunteer."}</td></tr>}
              {volunteers.map((v) => (
                <tr key={v.id}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <AvatarChip initials={(v.name || "?").split(" ").map((n) => n[0]).slice(0, 2).join("")} />
                      <div>
                        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{v.name}</div>
                        <div style={{ fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{v.id}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    {v.email || "—"}
                    {v.phone && <div style={{ fontSize: 10.5 }}>{v.phone}</div>}
                  </td>
                  <td style={{ display: "flex", gap: 4, flexWrap: "wrap", maxWidth: 220 }}>
                    {(v.skills || []).map((s) => <span key={s} className="chip" style={{ fontSize: 10 }}>{s}</span>)}
                    {(v.skills || []).length === 0 && <span style={{ fontSize: 11, color: "var(--ink-4)" }}>—</span>}
                  </td>
                  <td><span className="chip"><span className="dot" />{v.availability}</span></td>
                  <td className="num" style={{ fontWeight: 500 }}>{v.hours || 0}h</td>
                  <td>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button className="btn sm ghost" onClick={() => printVolunteerForm(v)} title="Print registration form">
                        <Icon name="download" size={11} />Form
                      </button>
                      {canEdit && <button className="btn sm" onClick={() => setLogFor(v)}><Icon name="plus" size={11} />Log hours</button>}
                      {canEdit && <button className="icon-btn" onClick={() => handleRemove(v)} title="Remove"><Icon name="x" size={12} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && canEdit && <AddVolunteerModal onClose={() => setShowAdd(false)} onSubmit={handleAdd} />}
      {logFor && canEdit && <LogHoursModal volunteer={logFor} onClose={() => setLogFor(null)} onSubmit={(p) => handleLog({ id: logFor.id, ...p })} />}
    </div>
  );
}

// Full Sanvi Volunteer Registration form — eight sections matching the
// printed template (Personal · KYC · Emergency · Education & Skills ·
// Preferences · References · Medical · Declaration). All fields except
// Full Name and Phone are optional so staff can save partial entries.
function AddVolunteerModal({ onClose, onSubmit }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    // 1. Personal
    name: "", dob: "", gender: "", phone: "", email: "", address: "",
    // 2. KYC
    idType: "Aadhaar", idNumber: "", panNumber: "",
    // 3. Emergency
    emergencyName: "", emergencyRelationship: "", emergencyPhone: "",
    // 4. Education & Skills
    qualification: "", skills: [], otherSkill: "", previousExperience: "",
    // 5. Preferences
    interests: [], otherInterest: "", availability: "weekends",
    preferredTime: "", duration: "long",
    // 6. References
    ref1: "", ref2: "",
    // 7. Medical
    health: "",
    // 8. Declaration
    declarationAgreed: false, signatureName: "", signatureDate: today,
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleIn = (key, val) => setForm((f) => ({ ...f, [key]: f[key].includes(val) ? f[key].filter((x) => x !== val) : [...f[key], val] }));
  const age = ageFromDob(form.dob);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      if (!form.name.trim()) throw new Error("Full name is required");
      if (!form.phone || form.phone.length !== 10) throw new Error("10-digit phone number is required");
      if (!form.declarationAgreed) throw new Error("Please tick the declaration to continue");
      await onSubmit({
        name: form.name.trim(),
        email: form.email.trim() || null,
        phone: form.phone || null,
        dob: form.dob || null,
        age: age === "" ? null : age,
        gender: form.gender || null,
        address: form.address.trim() || null,
        idType: form.idType,
        idNumber: form.idNumber.trim() || null,
        panNumber: form.panNumber.trim() || null,
        emergency: (form.emergencyName || form.emergencyPhone) ? {
          name: form.emergencyName.trim() || null,
          relationship: form.emergencyRelationship.trim() || null,
          phone: form.emergencyPhone.trim() || null,
        } : null,
        qualification: form.qualification.trim() || null,
        skills: form.skills,
        otherSkill: form.otherSkill.trim() || null,
        previousExperience: form.previousExperience.trim() || null,
        interests: form.interests,
        otherInterest: form.otherInterest.trim() || null,
        availability: form.availability,
        preferredTime: form.preferredTime.trim() || null,
        duration: form.duration,
        references: [form.ref1.trim(), form.ref2.trim()].filter(Boolean),
        health: form.health.trim() || null,
        declarationAgreed: true,
        signatureName: form.signatureName.trim() || form.name.trim(),
        signatureDate: form.signatureDate || today,
      });
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }

  return (
    <ModalShell title="Volunteer Registration" sub="Sanvi Educational and Charitable Trust" onClose={onClose} width={680}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>

        {/* 1. Personal Details */}
        <SectionHead n={1}>Personal Details</SectionHead>
        <Field label="Full Name *">
          <input className="input" autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="As per ID proof" />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 1fr", gap: 10 }}>
          <Field label="Date of Birth">
            <input className="input" type="date" max={today} value={form.dob} onChange={(e) => set("dob", e.target.value)} />
          </Field>
          <Field label="Age">
            <input className="input" value={age} readOnly tabIndex={-1} placeholder="auto" style={{ background: "var(--bg-2)", color: "var(--ink-3)", cursor: "not-allowed" }} />
          </Field>
          <Field label="Gender">
            <select className="select" value={form.gender} onChange={(e) => set("gender", e.target.value)}>
              <option value="">— select —</option>
              {GENDER_OPTIONS.map((g) => <option key={g}>{g}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Phone Number *">
            <input className="input" inputMode="numeric" value={form.phone} onChange={(e) => set("phone", e.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="98XXXXXXXX" />
          </Field>
          <Field label="Email ID">
            <input className="input" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="name@example.com" />
          </Field>
        </div>
        <Field label="Address">
          <textarea className="input" style={{ height: 50, padding: "8px 10px", resize: "vertical" }} value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="Door no., street, city, PIN" />
        </Field>

        {/* 2. KYC */}
        <SectionHead n={2}>Identity Details (KYC)</SectionHead>
        <Field label="ID Proof Type">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {ID_TYPES.map((t) => (
              <button
                key={t} type="button" onClick={() => set("idType", t)}
                className={`chip ${form.idType === t ? "accent" : ""}`}
                style={{ cursor: "pointer", padding: "4px 10px" }}
              >{t}</button>
            ))}
          </div>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="ID Number">
            <input className="input" value={form.idNumber} onChange={(e) => set("idNumber", e.target.value)} placeholder={`${form.idType} number`} />
          </Field>
          <Field label="PAN Number (if applicable)">
            <input className="input" value={form.panNumber} onChange={(e) => set("panNumber", e.target.value.toUpperCase())} maxLength={10} placeholder="ABCDE1234F" />
          </Field>
        </div>

        {/* 3. Emergency */}
        <SectionHead n={3}>Emergency Contact Details</SectionHead>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <Field label="Name">
            <input className="input" value={form.emergencyName} onChange={(e) => set("emergencyName", e.target.value)} />
          </Field>
          <Field label="Relationship">
            <input className="input" value={form.emergencyRelationship} onChange={(e) => set("emergencyRelationship", e.target.value)} placeholder="e.g. Spouse, Parent" />
          </Field>
          <Field label="Phone Number">
            <input className="input" inputMode="numeric" value={form.emergencyPhone} onChange={(e) => set("emergencyPhone", e.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="98XXXXXXXX" />
          </Field>
        </div>

        {/* 4. Education & Skills */}
        <SectionHead n={4}>Educational &amp; Skill Details</SectionHead>
        <Field label="Highest Qualification">
          <input className="input" value={form.qualification} onChange={(e) => set("qualification", e.target.value)} placeholder="e.g. B.Sc, M.Ed" />
        </Field>
        <Field label="Skills (tick or specify)">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {SKILL_SUGGESTIONS.map((s) => (
              <button
                key={s} type="button" onClick={() => toggleIn("skills", s)}
                className={`chip ${form.skills.includes(s) ? "accent" : ""}`}
                style={{ cursor: "pointer", padding: "4px 10px" }}
              >{s}</button>
            ))}
          </div>
          <input
            className="input"
            value={form.otherSkill}
            onChange={(e) => set("otherSkill", e.target.value)}
            placeholder="Others (specify)…"
            style={{ marginTop: 6 }}
          />
        </Field>
        <Field label="Previous Volunteer / Work Experience (if any)">
          <textarea className="input" style={{ height: 50, padding: "8px 10px", resize: "vertical" }} value={form.previousExperience} onChange={(e) => set("previousExperience", e.target.value)} />
        </Field>

        {/* 5. Preferences */}
        <SectionHead n={5}>Volunteer Preferences</SectionHead>
        <Field label="Area of Interest">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {INTEREST_OPTIONS.map((s) => (
              <button
                key={s} type="button" onClick={() => toggleIn("interests", s)}
                className={`chip ${form.interests.includes(s) ? "accent" : ""}`}
                style={{ cursor: "pointer", padding: "4px 10px" }}
              >{s}</button>
            ))}
          </div>
          <input
            className="input"
            value={form.otherInterest}
            onChange={(e) => set("otherInterest", e.target.value)}
            placeholder="Others (specify)…"
            style={{ marginTop: 6 }}
          />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <Field label="Availability">
            <select className="select" value={form.availability} onChange={(e) => set("availability", e.target.value)}>
              {AVAIL_OPTIONS.map((a) => <option key={a}>{a}</option>)}
            </select>
          </Field>
          <Field label="Preferred Time">
            <input className="input" value={form.preferredTime} onChange={(e) => set("preferredTime", e.target.value)} placeholder="e.g. 4-6 pm" />
          </Field>
          <Field label="Duration">
            <select className="select" value={form.duration} onChange={(e) => set("duration", e.target.value)}>
              {DURATION_OPTIONS.map((d) => <option key={d.k} value={d.k}>{d.label}</option>)}
            </select>
          </Field>
        </div>

        {/* 6. References */}
        <SectionHead n={6}>Reference Details (Optional)</SectionHead>
        <Field label="Reference 1 — Name &amp; Contact">
          <input className="input" value={form.ref1} onChange={(e) => set("ref1", e.target.value)} placeholder="Name · phone" />
        </Field>
        <Field label="Reference 2 — Name &amp; Contact">
          <input className="input" value={form.ref2} onChange={(e) => set("ref2", e.target.value)} placeholder="Name · phone" />
        </Field>

        {/* 7. Medical */}
        <SectionHead n={7}>Medical Information (Optional)</SectionHead>
        <Field label="Any health condition / allergy (if relevant)">
          <textarea className="input" style={{ height: 50, padding: "8px 10px", resize: "vertical" }} value={form.health} onChange={(e) => set("health", e.target.value)} />
        </Field>

        {/* 8. Declaration */}
        <SectionHead n={8}>Declaration</SectionHead>
        <label style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: 1.5, padding: "8px 10px", background: "var(--bg-2)", borderRadius: 7, cursor: "pointer" }}>
          <input type="checkbox" checked={form.declarationAgreed} onChange={(e) => set("declarationAgreed", e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            I hereby declare that the information provided is true and correct. I agree to abide by the rules and
            regulations of <b>Sanvi Educational and Charitable Trust</b>. I understand that my services are voluntary
            and I may not be entitled to any remuneration unless otherwise stated.
          </span>
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 10 }}>
          <Field label="Signature of Volunteer (typed name)">
            <input className="input" value={form.signatureName} onChange={(e) => set("signatureName", e.target.value)} placeholder={form.name || "Your name"} />
          </Field>
          <Field label="Date">
            <input className="input" type="date" value={form.signatureDate} onChange={(e) => set("signatureDate", e.target.value)} />
          </Field>
        </div>

        {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4, position: "sticky", bottom: 0, background: "var(--card)", paddingTop: 10 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy}>{busy ? "Saving…" : "Register volunteer"}</button>
        </div>
      </form>
    </ModalShell>
  );
}

// Open a print window with the Sanvi Volunteer Registration form, filled in
// from the saved record. Empty fields render as dotted-line blanks so the
// office can still hand-fill missing info if needed.
function printVolunteerForm(v) {
  const w = window.open("", "_blank", "width=820,height=1100");
  if (!w) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (iso) => iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
  const tick = (on) => on ? "☑" : "☐";
  const filled = (s) => s ? `<u>${esc(s)}</u>` : `<span class="blank"></span>`;
  const e = v.emergency || {};
  const refs = v.references || [];
  const skills = v.skills || [];
  const interests = v.interests || [];
  const allSkills = ["Teaching", "Computer Skills", "Event Management", "Social Work", "Fundraising"];
  const allInterests = ["Education", "Administration", "Field Work", "Awareness Programs"];
  const html = `<!doctype html><html><head><meta charset="utf-8"/>
<title>Volunteer Form · ${esc(v.name)}</title>
<style>
  @page { size: A4; margin: 14mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #000; font-size: 12.5px; line-height: 1.5; padding: 0; }
  .head { display: flex; align-items: center; gap: 14px; border-bottom: 1.5px solid #000; padding-bottom: 8px; }
  .head img { width: 60px; height: 60px; object-fit: contain; flex-shrink: 0; }
  .head .t { flex: 1; text-align: center; }
  .head .trust { font-size: 18px; font-weight: 700; letter-spacing: 0.5px; }
  .head .reg { font-size: 11.5px; font-weight: 700; text-decoration: underline; margin-top: 2px; }
  .head .addr { font-size: 11px; margin-top: 2px; }
  .title { text-align: center; font-size: 14px; font-weight: 700; margin: 10px 0 14px; }
  .sect { font-weight: 700; margin-top: 14px; margin-bottom: 6px; font-size: 12.5px; }
  .row { padding: 3px 0; }
  .blank { display: inline-block; border-bottom: 1px dotted #555; min-width: 180px; height: 14px; vertical-align: bottom; }
  .pair { display: inline-block; margin-right: 18px; }
  u { text-decoration: none; border-bottom: 1px solid #000; padding: 0 2px; }
  .declar { margin-top: 10px; font-size: 12px; line-height: 1.6; }
  .office { margin-top: 18px; padding-top: 8px; border-top: 1px dashed #999; }
  .office .title2 { font-weight: 700; margin-bottom: 6px; }
</style></head><body>
  <div class="head">
    <img src="${window.location.origin}/logo.png" alt="logo" />
    <div class="t">
      <div class="trust">SANVI EDUCATIONAL AND CHARITABLE TRUST</div>
      <div class="reg">Reg.No: 2640/2016</div>
      <div class="addr">Kamaraj Salai, (Le PondyRoad), Pooranankuppam, Puducherry – 605 007.</div>
    </div>
  </div>
  <div class="title"><u>VOLUNTEER REGISTRATION FORM</u></div>

  <div class="sect">1. Personal Details</div>
  <div class="row">Full Name: ${filled(v.name)}</div>
  <div class="row">
    <span class="pair">Date of Birth: ${filled(fmt(v.dob))}</span>
    <span class="pair">Age: ${filled(v.age)}</span>
  </div>
  <div class="row">Gender: ${tick(v.gender === "Male")} Male &nbsp; ${tick(v.gender === "Female")} Female &nbsp; ${tick(v.gender === "Other")} Other</div>
  <div class="row">Phone Number: ${filled(v.phone)}</div>
  <div class="row">Email ID: ${filled(v.email)}</div>
  <div class="row">Address: ${filled(v.address)}</div>

  <div class="sect">2. Identity Details (KYC)</div>
  <div class="row">ID Proof Type: ${tick(v.idType === "Aadhaar")} Aadhaar &nbsp; ${tick(v.idType === "Voter ID")} Voter ID &nbsp; ${tick(v.idType === "Passport")} Passport &nbsp; ${tick(v.idType === "Driving License")} Driving License</div>
  <div class="row">ID Number: ${filled(v.idNumber)}</div>
  <div class="row">PAN Number (if applicable): ${filled(v.panNumber)}</div>

  <div class="sect">3. Emergency Contact Details</div>
  <div class="row">Name: ${filled(e.name)}</div>
  <div class="row">Relationship: ${filled(e.relationship)}</div>
  <div class="row">Phone Number: ${filled(e.phone)}</div>

  <div class="sect">4. Educational &amp; Skill Details</div>
  <div class="row">Highest Qualification: ${filled(v.qualification)}</div>
  <div class="row">Skills (Tick or Specify):</div>
  <div class="row">${allSkills.map((s) => `${tick(skills.includes(s))} ${s}`).join(" &nbsp; ")} &nbsp; ${tick(!!v.otherSkill)} Others: ${filled(v.otherSkill)}</div>
  <div class="row">Previous Volunteer/Work Experience (if any): ${filled(v.previousExperience)}</div>

  <div class="sect">5. Volunteer Preferences</div>
  <div class="row">Area of Interest:</div>
  <div class="row">${allInterests.map((i) => `${tick(interests.includes(i))} ${i}`).join(" &nbsp; ")} &nbsp; ${tick(!!v.otherInterest)} Others: ${filled(v.otherInterest)}</div>
  <div class="row">Availability: ${tick(v.availability === "weekdays")} Weekdays &nbsp; ${tick(v.availability === "weekends")} Weekends &nbsp; ${tick(v.availability === "both")} Both</div>
  <div class="row">Preferred Time: ${filled(v.preferredTime)}</div>
  <div class="row">Duration: ${tick(v.duration === "short")} Short-term &nbsp; ${tick(v.duration === "long")} Long-term</div>

  <div class="sect">6. Reference Details (Optional)</div>
  <div class="row">Reference 1 Name &amp; Contact: ${filled(refs[0])}</div>
  <div class="row">Reference 2 Name &amp; Contact: ${filled(refs[1])}</div>

  <div class="sect">7. Medical Information (Optional)</div>
  <div class="row">Any health condition/allergy (if relevant): ${filled(v.health)}</div>

  <div class="sect">8. Declaration</div>
  <div class="declar">
    I hereby declare that the information provided is true and correct. I agree to abide by the rules and
    regulations of Sanvi Educational and Charitable Trust. I understand that my services are voluntary
    and I may not be entitled to any remuneration unless otherwise stated.
  </div>
  <div class="row" style="margin-top:10px;">Signature of Volunteer: ${filled(v.signatureName || v.name)}</div>
  <div class="row">Date: ${filled(fmt(v.signatureDate || v.createdAt))}</div>

  <div class="office">
    <div class="title2">For Office Use Only</div>
    <div class="row">Volunteer ID: ${filled(v.id)}</div>
    <div class="row">Date of Joining: ${filled(fmt(v.dateOfJoining || v.createdAt))}</div>
    <div class="row">Assigned Role: ${filled(v.assignedRole)}</div>
    <div class="row">Approved By: ${filled(v.approvedBy)}</div>
    <div class="row">Signature &amp; Seal: ${filled("")}</div>
  </div>

  <script>window.addEventListener("load",()=>{setTimeout(()=>{window.print();},120);});</script>
</body></html>`;
  w.document.open(); w.document.write(html); w.document.close();
}

function LogHoursModal({ volunteer, onClose, onSubmit }) {
  const [hours, setHours] = useState("");
  const [activity, setActivity] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const h = Number(hours);
      if (!h || h <= 0) throw new Error("Enter a positive number of hours");
      await onSubmit({ hours: h, activity: activity.trim() || null, date });
    } catch (ex) { setErr(ex.message); setBusy(false); }
  }
  return (
    <ModalShell title={`Log hours · ${volunteer.name}`} sub={`Currently: ${volunteer.hours || 0}h`} onClose={onClose}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Hours *">
            <input className="input" autoFocus inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value.replace(/[^\d.]/g, ""))} placeholder="2" />
          </Field>
          <Field label="Date">
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Activity">
          <input className="input" value={activity} onChange={(e) => setActivity(e.target.value)} placeholder="e.g. Library shelving" />
        </Field>
        {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy}>{busy ? "Saving…" : "Log hours"}</button>
        </div>
      </form>
    </ModalShell>
  );
}
