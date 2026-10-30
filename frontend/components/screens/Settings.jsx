"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { formatClassLabel, parseHolidays, getWorkingDays } from "@/backend/lib/format.js";

function normalizeSettings(raw) {
  const s = raw && typeof raw === "object" ? { ...raw } : {};
  const academic = { ...(s.academic || {}) };
  academic.holidays = parseHolidays({ academic: { holidays: academic.holidays } });
  return { ...s, academic };
}

function serializeSettings(draft) {
  const academic = { ...(draft?.academic || {}) };
  const holidays = parseHolidays({ academic: { holidays: academic.holidays } });
  academic.holidays = JSON.stringify(holidays);
  // Drop blank per-class overrides so they don't block the school default.
  for (const key of Object.keys(academic)) {
    if (key.startsWith("workingDays_") && String(academic[key] ?? "").trim() === "") {
      delete academic[key];
    }
  }
  return { ...draft, academic };
}

const SECTIONS = [
  {
    key: "trust",
    t: "Trust identity",
    fields: [
      { k: "name",      label: "Trust name" },
      { k: "regNo",     label: "Registration no." },
      { k: "pan80g",    label: "PAN · 80G status" },
      { k: "contact",   label: "Primary contact" },
    ],
  },
  {
    key: "finance",
    t: "Finance",
    fields: [
      { k: "academicYear", label: "Academic year" },
      { k: "feeCycle",     label: "Fee cycle" },
      // These two drive the Fees · Monthly schedule view. They live in the
      // "fees" section (alongside fees.structure) rather than "finance", so
      // the server reads them from one place — hence the explicit `section`.
      { k: "scheduleMonths",  section: "fees", label: "Monthly schedule · billable months",
        hint: "How many months transport is spread over in the Monthly view. Default 11" },
      { k: "yearStartMonth",  section: "fees", label: "Monthly schedule · year starts (month no.)",
        hint: "1 = January … 4 = April. Default 4" },
      // UPI ID + payee name drive the QR shown on the Fees · Collect screen
      // and the Pay-online checkout. Set both for the QR to be scannable.
      { k: "upi",          label: "UPI ID",          hint: "e.g. sanfort@hdfc — used for the fees QR scanner" },
      { k: "upiPayeeName", label: "UPI payee name",  hint: "Shown to the parent's UPI app (max 40 chars)" },
      { k: "gstPan",       label: "GST · PAN for invoices" },
    ],
  },
  {
    key: "communication",
    t: "Communication",
    fields: [
      { k: "smsProvider",    label: "SMS provider" },
      { k: "whatsappNumber", label: "WhatsApp" },
      { k: "emailSender",    label: "Email sender" },
      { k: "officeHours",    label: "Office hours for auto-call" },
    ],
  },
  {
    key: "parent",
    t: "Parent dashboard",
    fields: [
      { k: "headerContact1Label", label: "Header contact 1 · label", hint: "e.g. Office, Reception" },
      { k: "headerContact1Number", label: "Header contact 1 · number", hint: "e.g. +91 98765 43210 — shown in the parent header" },
      { k: "headerContact2Label", label: "Header contact 2 · label", hint: "e.g. Emergency, Principal" },
      { k: "headerContact2Number", label: "Header contact 2 · number", hint: "Optional second number" },
    ],
  },
  {
    key: "security",
    t: "Security",
    fields: [
      { k: "mfa",            label: "MFA for admins" },
      { k: "sessionTimeout", label: "Session timeout" },
      { k: "ipAllowlist",    label: "IP allowlist" },
      { k: "backup",         label: "Backup" },
    ],
  },
];

function Toast({ msg, tone, onClose }) {
  if (!msg) return null;
  const bg = tone === "ok" ? "var(--ok)" : tone === "err" ? "var(--err, #b13c1c)" : "var(--ink)";
  return (
    <div onClick={onClose} role="status" style={{
      position: "fixed", bottom: 18, right: 18, zIndex: 9000,
      background: bg, color: "#fff", padding: "9px 14px", borderRadius: 8,
      fontSize: 12, fontWeight: 500, cursor: "pointer", maxWidth: 360,
    }}>{msg}</div>
  );
}

const inputStyle = {
  marginTop: 4, width: "100%", fontSize: 13,
  padding: "6px 8px", border: "1px solid var(--rule-2)",
  borderRadius: 6, background: "var(--card)",
  color: "var(--ink)",
};

export default function ScreenSettings({ role, E, refresh }) {
  const [settings, setSettings] = useState(() => normalizeSettings({}));
  const [draft, setDraft] = useState(() => normalizeSettings({}));
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [newHolidayDate, setNewHolidayDate] = useState("");
  const [newHolidayReason, setNewHolidayReason] = useState("");
  const canEdit = role === "admin";

  const classes = [...(E?.CLASSES || [])].sort((a, b) => Number(a.n) - Number(b.n));
  const holidays = useMemo(
    () => parseHolidays({ academic: { holidays: draft?.academic?.holidays } }),
    [draft?.academic?.holidays]
  );

  const showToast = (msg, tone) => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 2500);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/settings", { cache: "no-store" });
        const json = await r.json();
        if (!cancelled && json.ok) {
          const normalized = normalizeSettings(json.settings || {});
          setSettings(normalized);
          setDraft(normalized);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  const setField = (section, key, value) => {
    setDraft((d) => ({ ...d, [section]: { ...(d[section] || {}), [key]: value } }));
  };

  const addHoliday = () => {
    if (!canEdit) return;
    const date = String(newHolidayDate || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      showToast("Pick a holiday date", "err");
      return;
    }
    if (holidays.some((h) => h.date === date)) {
      showToast("That date is already listed", "err");
      return;
    }
    const next = [...holidays, { date, reason: newHolidayReason.trim() }]
      .sort((a, b) => a.date.localeCompare(b.date));
    setField("academic", "holidays", next);
    setNewHolidayDate("");
    setNewHolidayReason("");
  };

  const removeHoliday = (date) => {
    if (!canEdit) return;
    setField("academic", "holidays", holidays.filter((h) => h.date !== date));
  };

  const save = async () => {
    if (!canEdit) return;
    setBusy(true);
    try {
      const payload = serializeSettings(draft);
      const r = await fetch("/api/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: payload }),
      });
      const json = await r.json();
      if (json.ok) {
        const normalized = normalizeSettings(json.settings || payload);
        setSettings(normalized);
        setDraft(normalized);
        showToast("Settings saved", "ok");
        try { await refresh?.(); } catch {}
      } else {
        showToast(json.error || "Save failed", "err");
      }
    } catch (e) {
      showToast(e.message || "Network error", "err");
    } finally {
      setBusy(false);
    }
  };

  const revert = () => setDraft(settings);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">System</div>
          <div className="page-title">Settings</div>
          <div className="page-sub">Trust-wide defaults. Individual schools can override finance and communication settings.</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={revert} disabled={busy}><Icon name="refresh" size={13} />Revert</button>
          {canEdit && (
            <button className="btn accent" onClick={save} disabled={busy}>
              <Icon name="check" size={13} />{busy ? "Saving…" : "Save changes"}
            </button>
          )}
        </div>
      </div>

      {/* Holidays / sudden leave — subtract from every class's base working days */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Academic · Holidays &amp; sudden leave</div>
            <div className="card-sub">
              Add festival or sudden school-closed dates. These are subtracted from each class&apos;s working days automatically.
              {holidays.length > 0 ? ` · ${holidays.length} day${holidays.length === 1 ? "" : "s"} listed` : ""}
            </div>
          </div>
        </div>
        <div>
          {canEdit && (
            <div className="lrow" style={{ alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
              <div style={{ minWidth: 150 }}>
                <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 500 }}>Date</div>
                <input
                  type="date"
                  value={newHolidayDate}
                  onChange={(e) => setNewHolidayDate(e.target.value)}
                  style={{ ...inputStyle, width: 160 }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 500 }}>Reason</div>
                <input
                  type="text"
                  value={newHolidayReason}
                  onChange={(e) => setNewHolidayReason(e.target.value)}
                  placeholder="e.g. Diwali / sudden local holiday"
                  style={inputStyle}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addHoliday(); } }}
                />
              </div>
              <button type="button" className="btn accent" onClick={addHoliday} style={{ marginBottom: 2 }}>
                <Icon name="plus" size={13} />Add
              </button>
            </div>
          )}
          {holidays.length === 0 ? (
            <div className="empty" style={{ padding: 16 }}>No holidays listed yet. Planned Saturdays/Sundays stay out of the base working-days number; use this list for festivals and sudden leave.</div>
          ) : (
            holidays.map((h) => {
              const label = (() => {
                try {
                  return new Date(`${h.date}T00:00:00`).toLocaleDateString("en-IN", {
                    weekday: "short", day: "numeric", month: "short", year: "numeric",
                  });
                } catch { return h.date; }
              })();
              return (
                <div className="lrow" key={h.date} style={{ alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{label}</div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{h.reason || "School closed"} · <span className="mono">{h.date}</span></div>
                  </div>
                  {canEdit && (
                    <button type="button" className="btn sm ghost" onClick={() => removeHoliday(h.date)} title="Remove">
                      <Icon name="x" size={13} />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Working days — per class; effective = base − holidays */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Academic · Working days by class</div>
            <div className="card-sub">
              Enter planned working days per class. Effective days = planned − holidays above. Attendance % uses effective days.
            </div>
          </div>
        </div>
        <div>
          <div className="lrow">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 500 }}>
                Default planned days (if a class has no value)
              </div>
              {canEdit ? (
                <input
                  type="text"
                  inputMode="numeric"
                  value={draft?.academic?.workingDays ?? ""}
                  onChange={(e) => setField("academic", "workingDays", e.target.value)}
                  placeholder="e.g. 240"
                  style={{ ...inputStyle, maxWidth: 160 }}
                />
              ) : (
                <div style={{ fontSize: 13, marginTop: 3 }}>{draft?.academic?.workingDays || "—"}</div>
              )}
            </div>
            {holidays.length > 0 && (
              <div style={{ fontSize: 11.5, color: "var(--ink-3)", textAlign: "right" }}>
                −{holidays.length} holiday{holidays.length === 1 ? "" : "s"}
              </div>
            )}
          </div>
          {classes.length === 0 ? (
            <div className="empty" style={{ padding: 16 }}>No classes yet. Add classes on the Classes screen first.</div>
          ) : (
            classes.map((c) => {
              const key = `workingDays_${c.n}`;
              const value = draft?.academic?.[key] ?? "";
              const label = c.label || formatClassLabel(String(c.n));
              const effective = getWorkingDays(draft, String(c.n));
              return (
                <div className="lrow" key={c.n} style={{ alignItems: "center", gap: 16 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{label}</div>
                    <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
                      {effective != null
                        ? `Effective ${effective} working days`
                        : "No planned days set"}
                    </div>
                  </div>
                  {canEdit ? (
                    <input
                      type="text"
                      inputMode="numeric"
                      value={value}
                      onChange={(e) => setField("academic", key, e.target.value)}
                      placeholder={draft?.academic?.workingDays || "e.g. 240"}
                      style={{ ...inputStyle, marginTop: 0, width: 100, textAlign: "center" }}
                      title="Planned working days before holidays"
                    />
                  ) : (
                    <div style={{ fontSize: 13, fontWeight: 600, minWidth: 60, textAlign: "right" }}>
                      {effective != null ? effective : "—"}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="grid g-2">
        {SECTIONS.map((s) => (
          <div className="card" key={s.key}>
            <div className="card-head">
              <div><div className="card-title">{s.t}</div></div>
            </div>
            <div>
              {s.fields.map((it) => {
                // A field may store into a different settings section than the
                // card it is displayed under (see fees.scheduleMonths).
                const sect = it.section || s.key;
                const value = draft?.[sect]?.[it.k] ?? "";
                return (
                  <div className="lrow" key={it.k}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 500 }}>{it.label}</div>
                      {canEdit ? (
                        <input
                          type="text"
                          value={value}
                          onChange={(e) => setField(sect, it.k, e.target.value)}
                          placeholder={it.placeholder || "—"}
                          style={inputStyle}
                        />
                      ) : (
                        <div style={{ fontSize: 13, marginTop: 3 }}>{value || "—"}</div>
                      )}
                      {it.hint && (
                        <div style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 4 }}>{it.hint}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />
    </div>
  );
}
