"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import Icon from "../Icon";
import { KPI } from "../ui";
import { formatClassLabel } from "@/lib/format";

// Standard 14-day loan period — matches what most school libraries use.
const DEFAULT_DUE_DAYS = 14;

// Headers we accept in an uploaded spreadsheet, mapped to canonical book
// fields. Lower-case + stripped of non-letters before lookup so "Book Title",
// "BOOK_TITLE", "title" etc. all resolve to the same column.
//
// Total vs Available: spreadsheets often have BOTH "Total_Copies" (ever
// bought) and "Available_Copies" (currently on the shelf). We capture them
// as two separate canonical fields. At submit time, if both exist the
// importer prefers Available_Copies — that's the honest on-shelf count to
// seed the catalog with, since the system can't reconstruct loans from
// just an Excel sheet.
const COLUMN_ALIASES = {
  title:           ["title", "booktitle", "bookname", "name"],
  author:          ["author", "writer", "by"],
  category:        ["category", "type", "genre", "subject"],
  isbn:            ["isbn", "isbnno", "isbnnumber"],
  shelf:           ["shelf", "rack", "location", "bin"],
  totalCopies:     ["totalcopies", "totalcopy", "copies", "quantity", "qty", "stock", "count"],
  availableCopies: ["availablecopies", "available", "availablecopy", "onshelf", "inhand"],
};

function normHeader(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Given a spreadsheet's first-row headers, build a map from canonical book
// field → column index. Unmatched fields stay undefined and the row falls
// back to the field's default (e.g. totalCopies = 1).
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

function prettyCat(c) {
  if (!c) return "—";
  const s = String(c).replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function daysUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / 86400000);
}

// ---------- main screen --------------------------------------------------
export default function ScreenLibrary({ E, refresh, role, session }) {
  // Only librarian-class roles get the full management UI (catalog, KPIs,
  // import, issue/return). Teachers and parents see a focused "my borrowed
  // books" view — no catalog, no system-wide stock numbers, no other
  // borrowers' names. They consume the library; they don't run it.
  const canManage = ["admin", "principal", "academic_director"].includes(role);
  const isParent  = role === "parent";
  const isTeacher = role === "teacher";
  const isBorrowerOnly = isParent || isTeacher;

  const [tab, setTab] = useState(isBorrowerOnly ? "loans" : "books");
  const [toast, setToast] = useState(null);
  const showToast = (msg, tone) => { setToast({ msg, tone }); setTimeout(() => setToast(null), 3000); };

  const books  = E.LIBRARY || [];
  const loans  = E.LOANS || [];
  const students = E.ADDED_STUDENTS || [];
  // Staff includes teachers — anyone non-parent on the staff roster can borrow.
  const staff   = (E.STAFF || []).filter((s) => !s.archivedAt);

  // Per-book active loan count, used everywhere we show "available". Cheap
  // because we recompute on every render — the in-memory loan list is small.
  const activeByBook = useMemo(() => {
    const m = new Map();
    for (const l of loans) {
      if (l.returnedAt) continue;
      m.set(l.bookId, (m.get(l.bookId) || 0) + 1);
    }
    return m;
  }, [loans]);

  // Scope the loan list down to whoever is signed in:
  //   parent  → only their child's student-borrower rows
  //   teacher → only their own teacher-borrower rows (matched by staff id)
  //   manager → every loan in the system
  // linkedId on a teacher login can be a staff id ("STF-XXXX") or a class
  // list ("2-A,1-A"), so we fall back to matching the staff roster by email
  // when linkedId isn't actually a staff id.
  const myChildId = isParent && students[0] ? students[0].id : null;
  const myStaffId = useMemo(() => {
    if (!isTeacher) return null;
    if (session?.staffId) return session.staffId;
    const lid = session?.linkedId || "";
    if (typeof lid === "string" && lid.startsWith("STF-")) return lid;
    if (session?.email) {
      const match = staff.find((s) => (s.email || "").toLowerCase() === session.email.toLowerCase());
      if (match) return match.id;
    }
    return session?.id || null;
  }, [isTeacher, session, staff]);
  const visibleLoans = useMemo(() => {
    if (myChildId) {
      return loans.filter((l) => l.borrowerType === "student" && l.borrowerId === myChildId);
    }
    if (myStaffId) {
      return loans.filter((l) => (l.borrowerType === "teacher" || l.borrowerType === "staff") && l.borrowerId === myStaffId);
    }
    return loans;
  }, [loans, myChildId, myStaffId]);

  // KPIs differ by role: managers see system-wide stock; borrowers see
  // their personal loan stats (active + overdue + ever-returned).
  const totalTitles    = books.length;
  const totalCopies    = books.reduce((a, b) => a + (b.totalCopies || 0), 0);
  const activeLoans    = loans.filter((l) => !l.returnedAt).length;
  const overdueLoans   = loans.filter((l) => !l.returnedAt && new Date(l.dueAt) < new Date()).length;
  const availableTotal = Math.max(0, totalCopies - activeLoans);
  const myActive   = visibleLoans.filter((l) => !l.returnedAt).length;
  const myOverdue  = visibleLoans.filter((l) => !l.returnedAt && new Date(l.dueAt) < new Date()).length;
  const myReturned = visibleLoans.filter((l) =>  l.returnedAt).length;
  const nextDue    = visibleLoans
    .filter((l) => !l.returnedAt)
    .map((l) => new Date(l.dueAt).getTime())
    .sort((a, b) => a - b)[0];

  // ---------- modal state ----------
  const [showAddBook, setShowAddBook] = useState(false);
  const [editingBook, setEditingBook] = useState(null);
  const [borrowingBook, setBorrowingBook] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [showRemoveAll, setShowRemoveAll] = useState(false);
  const canWipe = role === "admin" || role === "principal";

  // ---------- actions --------------
  async function handleAddBook(payload) {
    const r = await fetch("/api/library/books", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    showToast(`Added "${j.book.title}"`, "ok");
    setShowAddBook(false);
    await refresh?.();
  }

  async function handleEditBook(payload) {
    const r = await fetch("/api/library/books", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    showToast(`Updated "${j.book.title}"`, "ok");
    setEditingBook(null);
    await refresh?.();
  }

  async function handleRemoveBook(book) {
    if (!confirm(`Remove "${book.title}" from the library?`)) return;
    try {
      const r = await fetch("/api/library/books", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: book.id }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      showToast(`Removed "${book.title}"`, "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
  }

  // Bulk wipe — admin / principal only. Always behind a typed-confirm
  // dialog so a fat-finger can't take out the whole catalogue.
  async function handleRemoveAllBooks() {
    const r = await fetch("/api/library/books", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true, confirm: "REMOVE ALL BOOKS" }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    showToast(`Removed all ${j.removed || 0} books`, "ok");
    await refresh?.();
  }

  async function handleBorrow(payload) {
    const r = await fetch("/api/library/loans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
    showToast(`Issued to ${j.loan.borrowerName} · due ${fmtDate(j.loan.dueAt)}`, "ok");
    setBorrowingBook(null);
    await refresh?.();
  }

  async function handleImportBooks(rows) {
    const r = await fetch("/api/library/books/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "Import failed");
    const okN = j.imported?.length || 0;
    const errN = j.errors?.length || 0;
    showToast(
      errN === 0
        ? `Imported ${okN} book${okN === 1 ? "" : "s"}`
        : `Imported ${okN} · ${errN} skipped`,
      errN === 0 ? "ok" : "err"
    );
    await refresh?.();
    return j;
  }

  async function handleReturn(loan) {
    if (!confirm(`Mark "${loan.bookTitle}" as returned?`)) return;
    try {
      const r = await fetch("/api/library/loans", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: loan.id }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed");
      showToast(`Returned "${loan.bookTitle}"`, "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
  }

  return (
    <div className="page">
      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />

      <div className="page-head">
        <div>
          <div className="page-eyebrow">{isBorrowerOnly ? "My family · Library" : "Operations · Library"}</div>
          <div className="page-title">
            {isBorrowerOnly
              ? <>Library <span className="amber">books I borrowed</span></>
              : <>Library <span className="amber">management</span></>}
          </div>
          <div className="page-sub">
            {isParent  ? "Browse the school catalog · track books your child has borrowed." :
             isTeacher ? "Browse the school catalog · track books you have borrowed." :
                         "Books · loans · stock · borrowers"}
          </div>
        </div>
        {canManage && (
          <div className="page-actions">
            <button className="btn" onClick={() => setShowImport(true)} title="Bulk-import books from an Excel/CSV file">
              <Icon name="upload" size={13} />Import Excel
            </button>
            {canWipe && (E.LIBRARY || []).length > 0 && (
              <button
                className="btn"
                onClick={() => setShowRemoveAll(true)}
                title="Wipe the entire library catalogue. Cannot be undone."
                style={{ color: "var(--bad, #b13c1c)", borderColor: "var(--bad, #b13c1c)" }}
              >
                <Icon name="x" size={13} />Remove all books
              </button>
            )}
            <button className="btn accent" onClick={() => setShowAddBook(true)}>
              <Icon name="plus" size={13} />Add book
            </button>
          </div>
        )}
      </div>

      {/* KPIs: managers see system-wide stock; borrowers see their own loans. */}
      {isBorrowerOnly ? (
        <div className="grid g-4" style={{ marginBottom: 14 }}>
          {(() => {
            const activeRows  = visibleLoans.filter((l) => !l.returnedAt);
            const overdueRows = visibleLoans.filter((l) => !l.returnedAt && new Date(l.dueAt) < new Date());
            const returnedRows = visibleLoans.filter((l) => l.returnedAt);
            const loanItem = (l) => ({
              label: l.bookTitle || l.title || "Book",
              value: l.dueAt ? new Date(l.dueAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—",
              sub: l.borrowerName || l.studentName || "",
              tone: !l.returnedAt && new Date(l.dueAt) < new Date() ? "bad" : "",
            });
            const dueLabel = nextDue ? (() => {
              const d = Math.ceil((nextDue - Date.now()) / 86400000);
              return d < 0 ? `${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} overdue` :
                     d === 0 ? "due today" :
                     `${d} day${d === 1 ? "" : "s"} left`;
            })() : "no active loans";
            return (
              <>
                <KPI
                  label={isParent ? "Books on loan" : "My books on loan"}
                  value={myActive}
                  sub={myActive ? (myOverdue ? `${myOverdue} overdue · return soon` : "all on time") : "none borrowed right now"}
                  puck={myOverdue ? "rose" : "mint"}
                  puckIcon="book"
                  details={{
                    title: `On loan · ${myActive}`,
                    sub: myActive ? "Active loans · earliest due first" : "No active loans",
                    items: activeRows.slice().sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt)).map(loanItem),
                  }}
                />
                <KPI
                  label="Next due"
                  value={nextDue ? new Date(nextDue).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—"}
                  sub={dueLabel}
                  puck="cream"
                  puckIcon="clock"
                  details={{
                    title: `Next due · ${dueLabel}`,
                    sub: "Upcoming returns",
                    items: activeRows.slice().sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt)).slice(0, 12).map(loanItem),
                  }}
                />
                <KPI
                  label="Overdue" value={myOverdue}
                  sub={myOverdue ? "please return" : "none overdue"}
                  puck={myOverdue ? "rose" : "mint"} puckIcon="warning"
                  details={{
                    title: `Overdue · ${myOverdue}`,
                    sub: myOverdue === 0 ? "Nothing overdue" : "Books past their due date",
                    items: overdueRows.map(loanItem),
                  }}
                />
                <KPI
                  label="Returned" value={myReturned} sub="lifetime"
                  puck="sky" puckIcon="check"
                  details={{
                    title: `Returned · ${myReturned}`,
                    sub: "Past loans",
                    items: returnedRows.slice(0, 12).map((l) => ({
                      label: l.bookTitle || l.title || "Book",
                      value: l.returnedAt ? new Date(l.returnedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—",
                      sub: l.borrowerName || l.studentName || "",
                      tone: "ok",
                    })),
                  }}
                />
              </>
            );
          })()}
        </div>
      ) : (
        <div className="grid g-4" style={{ marginBottom: 14 }}>
          {(() => {
            const activeLoanRows  = loans.filter((l) => !l.returnedAt);
            const overdueLoanRows = loans.filter((l) => !l.returnedAt && new Date(l.dueAt) < new Date());
            const titleItem = (b) => ({
              label: b.title || "—",
              value: b.copies ?? b.totalCopies ?? "—",
              sub: b.author || "",
            });
            const loanItem = (l) => ({
              label: l.bookTitle || l.title || "Book",
              value: l.borrowerName || l.studentName || "—",
              sub: l.dueAt ? `Due ${new Date(l.dueAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}` : "",
              tone: !l.returnedAt && new Date(l.dueAt) < new Date() ? "bad" : "",
            });
            return (
              <>
                <KPI
                  label="Titles" value={totalTitles}
                  sub={totalCopies ? `${totalCopies} copies total` : "no books yet"}
                  puck="mint" puckIcon="book"
                  details={{
                    title: `Titles · ${totalTitles}`,
                    sub: `${totalCopies} cop${totalCopies === 1 ? "y" : "ies"} in stock`,
                    items: books.slice(0, 12).map(titleItem),
                  }}
                />
                <KPI
                  label="Available" value={availableTotal} sub={`out of ${totalCopies}`}
                  puck="cream" puckIcon="check"
                  details={{
                    title: `Available · ${availableTotal} of ${totalCopies}`,
                    sub: `${activeLoans} cop${activeLoans === 1 ? "y" : "ies"} currently on loan`,
                    items: [
                      { label: "On shelf",  value: availableTotal, tone: "ok",  sub: `${availableTotal} ready to lend` },
                      { label: "On loan",   value: activeLoans,    tone: "warn", sub: `${activeLoans} currently borrowed` },
                      { label: "Overdue",   value: overdueLoans,   tone: overdueLoans > 0 ? "bad" : "", sub: overdueLoans > 0 ? "needs follow-up" : "none overdue" },
                    ],
                  }}
                />
                <KPI
                  label="On loan" value={activeLoans}
                  sub={activeLoans ? "currently borrowed" : "all returned"}
                  puck="peach" puckIcon="users"
                  details={{
                    title: `On loan · ${activeLoans}`,
                    sub: activeLoans ? "Active borrowers · earliest due first" : "Nothing currently borrowed",
                    items: activeLoanRows.slice().sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt)).slice(0, 12).map(loanItem),
                  }}
                />
                <KPI
                  label="Overdue" value={overdueLoans}
                  sub={overdueLoans ? "needs follow-up" : "none overdue"}
                  puck="rose" puckIcon="warning"
                  details={{
                    title: `Overdue · ${overdueLoans}`,
                    sub: overdueLoans === 0 ? "All loans on time" : "Borrowers past due — message them to return",
                    items: overdueLoanRows.map(loanItem),
                  }}
                />
              </>
            );
          })()}
        </div>
      )}

      {/* Tab strip — everyone (managers + borrowers) can flip between the
          catalog (read-only for borrowers) and their loans. Lets parents
          and teachers browse what books exist without losing the focused
          "my loans" view they default to. Action buttons in the catalog
          (Issue / Edit / Remove) are gated by canManage further down. */}
      {(
        <div className="card" style={{ padding: "10px 14px", marginBottom: 14, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {[
            { k: "books", label: isBorrowerOnly ? "Browse catalog" : "Books" },
            { k: "loans", label: isBorrowerOnly ? "My loans"       : "Loans" },
          ].map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              style={{
                padding: "6px 14px", borderRadius: 999,
                background: tab === t.k ? "var(--accent)" : "var(--bg-2)",
                color: tab === t.k ? "#fff" : "var(--ink-2)",
                border: 0, cursor: "pointer", fontSize: 12.5, fontWeight: 500,
              }}
            >{t.label}</button>
          ))}
        </div>
      )}

      {/* Catalog (Books tab) — managers get the full edit UI, borrowers see
          a read-only browse. BooksTab gates Issue / Edit / Remove buttons
          on canManage internally, so borrowers see just the catalog rows. */}
      {tab === "books" && (
        <BooksTab
          books={books}
          activeByBook={activeByBook}
          canManage={canManage}
          onBorrow={(b) => setBorrowingBook(b)}
          onEdit={(b) => setEditingBook(b)}
          onRemove={handleRemoveBook}
        />
      )}

      {/* Loans — managers see all loans, borrowers see only their own. */}
      {tab === "loans" && (
        <LoansTab
          loans={visibleLoans}
          canManage={canManage}
          onReturn={handleReturn}
          headingTitle={isParent  ? "My child's borrowed books" :
                        isTeacher ? "My borrowed books" :
                                    "Loans"}
          headingSub={isBorrowerOnly
            ? (visibleLoans.length === 0 ? "No books borrowed yet" : `${myActive} active · ${myReturned} returned`)
            : undefined}
          hideBorrower={isBorrowerOnly}
        />
      )}

      {showAddBook && canManage && (
        <BookFormModal
          title="Add book"
          sub="Catalog one title — copies = how many physical books on the shelf"
          onClose={() => setShowAddBook(false)}
          onSubmit={handleAddBook}
        />
      )}
      {editingBook && canManage && (
        <BookFormModal
          title="Edit book"
          sub={editingBook.id}
          initial={editingBook}
          onClose={() => setEditingBook(null)}
          onSubmit={(p) => handleEditBook({ ...p, id: editingBook.id })}
        />
      )}
      {borrowingBook && canManage && (
        <BorrowModal
          book={borrowingBook}
          students={students}
          staff={staff}
          activeByBook={activeByBook}
          onClose={() => setBorrowingBook(null)}
          onSubmit={handleBorrow}
        />
      )}
      {showImport && canManage && (
        <ImportBooksModal
          onClose={() => setShowImport(false)}
          onSubmit={async (rows) => {
            // Do NOT auto-close after success — the modal stays open with
            // a clear success card so the admin can read the counts and
            // any skipped-row warnings before dismissing. The parent's
            // refresh has already run, so the table behind the modal is
            // up to date the moment Close is clicked.
            return await handleImportBooks(rows);
          }}
        />
      )}
      {showRemoveAll && canWipe && (
        <RemoveAllBooksModal
          totalBooks={(E.LIBRARY || []).length}
          activeLoans={(E.LOANS || []).filter((l) => !l.returnedAt).length}
          onClose={() => setShowRemoveAll(false)}
          onConfirm={async () => {
            await handleRemoveAllBooks();
            setShowRemoveAll(false);
          }}
        />
      )}
    </div>
  );
}

// ---------- Remove-all confirm modal -----------------------------------
// Destructive bulk action — typed-confirm pattern (user must type the
// exact phrase) so it's almost impossible to fire by accident.
function RemoveAllBooksModal({ totalBooks, activeLoans, onClose, onConfirm }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const PHRASE = "REMOVE ALL BOOKS";
  const blocked = activeLoans > 0;
  const canFire = !blocked && typed === PHRASE && !busy;

  async function fire() {
    if (!canFire) return;
    setBusy(true); setErr("");
    try { await onConfirm(); }
    catch (e) { setErr(e.message || "Failed"); setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(20,16,10,0.55)",
      display: "grid", placeItems: "center", zIndex: 250, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{
        width: "100%", maxWidth: 480,
        borderTop: "3px solid var(--bad, #b13c1c)",
      }}>
        <div className="card-head">
          <div>
            <div className="card-title" style={{ color: "var(--bad, #b13c1c)" }}>
              <Icon name="warning" size={14} style={{ marginRight: 6 }} />
              Remove all library books?
            </div>
            <div className="card-sub">
              {blocked
                ? `Cannot proceed — ${activeLoans} active loan${activeLoans === 1 ? "" : "s"} still out. Return them first.`
                : `This will permanently delete all ${totalBooks} book${totalBooks === 1 ? "" : "s"} from the catalogue. Loan history is preserved, but the books themselves cannot be recovered.`}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {!blocked && (
            <>
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
            </>
          )}
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
              {busy ? "Removing…" : <><Icon name="x" size={13} />Remove all books</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Books tab ----------------------------------------------------
function BooksTab({ books, activeByBook, canManage, onBorrow, onEdit, onRemove }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;

  const cats = useMemo(() => {
    const set = new Set();
    for (const b of books) if (b.category) set.add(b.category);
    return ["all", ...[...set].sort()];
  }, [books]);

  // Sort ascending — by title (numeric-aware) so 1, 2, 3 come before 10,
  // 11. Falls back to id for books with the same title.
  const sortedBooks = useMemo(() => {
    return [...books].sort((a, b) => {
      const t = String(a.title || "").localeCompare(String(b.title || ""), undefined, { numeric: true, sensitivity: "base" });
      if (t !== 0) return t;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
  }, [books]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sortedBooks.filter((b) => {
      if (cat !== "all" && b.category !== cat) return false;
      if (!needle) return true;
      return `${b.title} ${b.author} ${b.id} ${b.isbn || ""}`.toLowerCase().includes(needle);
    });
  }, [sortedBooks, q, cat]);

  // Reset to page 1 whenever the search/category changes so the user
  // doesn't end up on an out-of-range page after narrowing the list.
  useEffect(() => { setPage(1); }, [q, cat]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const paged = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Catalog</div>
          <div className="card-sub">
            {books.length} title{books.length === 1 ? "" : "s"} · {filtered.length} shown
            {totalPages > 1 && <> · page {safePage} of {totalPages}</>}
          </div>
        </div>
        <div className="card-actions">
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, author, ISBN…"
            style={{ width: 220 }}
          />
          <select className="select" value={cat} onChange={(e) => setCat(e.target.value)} style={{ minWidth: 140 }}>
            {cats.map((c) => <option key={c} value={c}>{c === "all" ? "All categories" : prettyCat(c)}</option>)}
          </select>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Title / Author</th>
              <th>Category</th>
              <th>Shelf</th>
              <th className="num">Copies</th>
              <th className="num">Available</th>
              <th>Status</th>
              {canManage && <th></th>}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={canManage ? 7 : 6} className="empty">
                {books.length === 0
                  ? "No books in the catalog yet. Click “Add book” to start."
                  : "No matches for the current filter."}
              </td></tr>
            )}
            {paged.map((b) => {
              const active = activeByBook.get(b.id) || 0;
              const available = Math.max(0, (b.totalCopies || 0) - active);
              const out = available === 0;
              return (
                <tr key={b.id}>
                  <td>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{b.title}</div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{b.author || "Unknown author"}</div>
                    <div style={{ fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>
                      {b.id}{b.isbn ? ` · ISBN ${b.isbn}` : ""}
                    </div>
                  </td>
                  <td><span className="chip">{prettyCat(b.category)}</span></td>
                  <td style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{b.shelf || "—"}</td>
                  <td className="num">{b.totalCopies}</td>
                  <td className="num" style={{ color: out ? "var(--err, #b13c1c)" : "inherit", fontWeight: out ? 500 : 400 }}>{available}</td>
                  <td>
                    {out
                      ? <span className="chip bad"><span className="dot" />All on loan</span>
                      : <span className="chip ok"><span className="dot" />{available} on shelf</span>}
                  </td>
                  {canManage && (
                    <td style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button className="btn sm accent" disabled={out} onClick={() => onBorrow(b)} title={out ? "All copies on loan" : "Issue this book"}>
                        <Icon name="upload" size={11} />Issue
                      </button>
                      <button className="btn sm ghost" onClick={() => onEdit(b)} title="Edit">
                        <Icon name="pencil" size={11} />
                      </button>
                      <button className="icon-btn" onClick={() => onRemove(b)} title="Remove">
                        <Icon name="x" size={12} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "12px 16px", borderTop: "1px solid var(--rule)", flexWrap: "wrap", gap: 8,
        }}>
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            Showing <strong style={{ color: "var(--ink)" }}>{pageStart + 1}</strong>–<strong style={{ color: "var(--ink)" }}>{Math.min(pageStart + PAGE_SIZE, filtered.length)}</strong> of {filtered.length}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button className="btn sm" onClick={() => setPage(1)} disabled={safePage === 1}>« First</button>
            <button className="btn sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage === 1}>← Prev</button>
            {/* Compact page-number strip — always shows current ± 2, with
                first/last and ellipses when needed. */}
            {(() => {
              const pages = new Set([1, totalPages, safePage, safePage - 1, safePage + 1, safePage - 2, safePage + 2]);
              const list = [...pages].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
              const out = [];
              let prev = 0;
              for (const n of list) {
                if (prev && n - prev > 1) out.push(<span key={`gap-${n}`} style={{ padding: "0 4px", color: "var(--ink-4)" }}>…</span>);
                out.push(
                  <button
                    key={n}
                    className="btn sm"
                    onClick={() => setPage(n)}
                    style={{
                      background: n === safePage ? "var(--accent)" : "var(--card)",
                      color:      n === safePage ? "#fff" : "var(--ink-2)",
                      borderColor: n === safePage ? "var(--accent)" : "var(--rule)",
                      minWidth: 32,
                    }}
                  >{n}</button>
                );
                prev = n;
              }
              return out;
            })()}
            <button className="btn sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}>Next →</button>
            <button className="btn sm" onClick={() => setPage(totalPages)} disabled={safePage === totalPages}>Last »</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Loans tab ----------------------------------------------------
function LoansTab({ loans, canManage, onReturn, headingTitle = "Loans", headingSub, hideBorrower = false }) {
  const [filter, setFilter] = useState("active");

  const filtered = useMemo(() => {
    return [...loans].sort((a, b) => (b.borrowedAt || "").localeCompare(a.borrowedAt || ""))
      .filter((l) => {
        const overdue = !l.returnedAt && new Date(l.dueAt) < new Date();
        if (filter === "active")  return !l.returnedAt;
        if (filter === "overdue") return overdue;
        if (filter === "returned") return !!l.returnedAt;
        return true;
      });
  }, [loans, filter]);

  const counts = useMemo(() => ({
    all: loans.length,
    active: loans.filter((l) => !l.returnedAt).length,
    overdue: loans.filter((l) => !l.returnedAt && new Date(l.dueAt) < new Date()).length,
    returned: loans.filter((l) => l.returnedAt).length,
  }), [loans]);

  // Column count varies with two booleans (canManage adds Action col;
  // hideBorrower drops the Borrower col). Used for the empty-state colspan.
  const colCount = 4 + (hideBorrower ? 0 : 1) + (canManage ? 1 : 0);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{headingTitle}</div>
          <div className="card-sub">
            {headingSub ?? `${filtered.length} of ${loans.length} loan${loans.length === 1 ? "" : "s"} shown`}
          </div>
        </div>
        <div className="card-actions">
          <div className="segmented">
            {[
              { k: "active",  label: `Active · ${counts.active}` },
              { k: "overdue", label: `Overdue · ${counts.overdue}` },
              { k: "returned", label: `Returned · ${counts.returned}` },
              { k: "all",     label: `All · ${counts.all}` },
            ].map((b) => (
              <button key={b.k} className={filter === b.k ? "active" : ""} onClick={() => setFilter(b.k)}>{b.label}</button>
            ))}
          </div>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Book</th>
              {!hideBorrower && <th>Borrower</th>}
              <th>Borrowed</th>
              <th>Due</th>
              <th>Status</th>
              {canManage && <th></th>}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={colCount} className="empty">No loans match this filter.</td></tr>
            )}
            {filtered.map((l) => {
              const overdue = !l.returnedAt && new Date(l.dueAt) < new Date();
              const dleft = !l.returnedAt ? daysUntil(l.dueAt) : null;
              return (
                <tr key={l.id}>
                  <td>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{l.bookTitle}</div>
                    <div style={{ fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{l.bookId}</div>
                  </td>
                  {!hideBorrower && (
                    <td>
                      <div style={{ fontSize: 12.5, fontWeight: 500 }}>{l.borrowerName}</div>
                      <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
                        <span className="chip" style={{ fontSize: 10, marginRight: 4 }}>{l.borrowerType}</span>
                        {l.borrowerId}
                      </div>
                    </td>
                  )}
                  <td style={{ fontSize: 11.5, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{fmtDate(l.borrowedAt)}</td>
                  <td style={{ fontSize: 11.5, whiteSpace: "nowrap", color: overdue ? "var(--err, #b13c1c)" : "var(--ink-3)", fontWeight: overdue ? 600 : 400 }}>
                    {fmtDate(l.dueAt)}
                    {dleft !== null && !l.returnedAt && (
                      <div style={{ fontSize: 10, color: overdue ? "var(--err, #b13c1c)" : "var(--ink-4)" }}>
                        {overdue ? `${Math.abs(dleft)} day${Math.abs(dleft) === 1 ? "" : "s"} overdue` : `${dleft} day${dleft === 1 ? "" : "s"} left`}
                      </div>
                    )}
                  </td>
                  <td>
                    {l.returnedAt
                      ? <span className="chip ok"><span className="dot" />Returned {fmtDate(l.returnedAt)}</span>
                      : overdue
                        ? <span className="chip bad"><span className="dot" />Overdue</span>
                        : <span className="chip"><span className="dot" />On loan</span>}
                  </td>
                  {canManage && (
                    <td style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      {!l.returnedAt && (
                        <button className="btn sm accent" onClick={() => onReturn(l)}>
                          <Icon name="check" size={11} />Mark returned
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Add / Edit book ----------------------------------------------
function BookFormModal({ title, sub, initial, onClose, onSubmit }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState("");
  const [form, setForm] = useState({
    title:    initial?.title    || "",
    author:   initial?.author   || "",
    category: initial?.category || "general",
    isbn:     initial?.isbn     || "",
    shelf:    initial?.shelf    || "",
    totalCopies: initial?.totalCopies ?? 1,
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const titleRef = useRef(null);
  useEffect(() => { titleRef.current?.focus(); }, []);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      if (!form.title.trim()) throw new Error("Title is required");
      await onSubmit({
        ...form,
        totalCopies: Math.max(1, Number(form.totalCopies) || 1),
      });
    } catch (ex) { setErr(ex.message || String(ex)); setBusy(false); }
  }

  return (
    <ModalShell title={title} sub={sub} onClose={onClose} width={520}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Title *">
          <input className="input" ref={titleRef} value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. The Wings of Fire" />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Author">
            <input className="input" value={form.author} onChange={(e) => set("author", e.target.value)} placeholder="e.g. APJ Abdul Kalam" />
          </Field>
          <Field label="Category">
            <input className="input" value={form.category} onChange={(e) => set("category", e.target.value)} placeholder="fiction · textbook · reference…" />
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 110px", gap: 10 }}>
          <Field label="ISBN (optional)">
            <input className="input" value={form.isbn} onChange={(e) => set("isbn", e.target.value)} placeholder="978-…" />
          </Field>
          <Field label="Shelf (optional)">
            <input className="input" value={form.shelf} onChange={(e) => set("shelf", e.target.value)} placeholder="e.g. B-3" />
          </Field>
          <Field label="Total copies">
            <input
              className="input"
              type="number"
              min={1}
              value={form.totalCopies}
              onChange={(e) => set("totalCopies", e.target.value.replace(/\D/g, ""))}
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

// ---------- Bulk import (Excel / CSV) -----------------------------------
function ImportBooksModal({ onClose, onSubmit }) {
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders]   = useState([]);
  const [rows, setRows]         = useState([]);            // raw parsed rows (cells)
  const [colMap, setColMap]     = useState({});            // canonical field -> col index
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState("");
  const [result, setResult]     = useState(null);          // { imported, errors } after submit
  const fileRef = useRef(null);

  // ---- file pick + parse ----
  async function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr(""); setResult(null);
    setFileName(f.name);
    try {
      const buf = await f.arrayBuffer();
      const wb  = XLSX.read(buf, { type: "array" });
      // Take the first sheet — that's where 99% of imports live. If the
      // teacher needs multi-sheet handling we can add a sheet picker later.
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

  // ---- preview rows shaped to canonical fields ----
  // Resolve a single per-row "copies" number from whichever column(s) the
  // sheet provides. Preference order: explicit Available_Copies → Total_Copies
  // → 1. This matches what we'll send on submit.
  function resolveCopies(r) {
    const a = colMap.availableCopies != null ? Number(r[colMap.availableCopies]) : NaN;
    const t = colMap.totalCopies     != null ? Number(r[colMap.totalCopies])     : NaN;
    if (Number.isFinite(a) && a > 0) return a;
    if (Number.isFinite(t) && t > 0) return t;
    return 1;
  }
  const previewRows = useMemo(() => {
    return rows.slice(0, 50).map((r) => ({
      title:       colMap.title       != null ? r[colMap.title] : "",
      author:      colMap.author      != null ? r[colMap.author] : "",
      category:    colMap.category    != null ? r[colMap.category] : "",
      isbn:        colMap.isbn        != null ? r[colMap.isbn] : "",
      shelf:       colMap.shelf       != null ? r[colMap.shelf] : "",
      totalCopies: resolveCopies(r),
      // Surface the raw values too so the preview can show the difference
      // when both columns are present.
      _rawTotal:     colMap.totalCopies     != null ? r[colMap.totalCopies]     : null,
      _rawAvailable: colMap.availableCopies != null ? r[colMap.availableCopies] : null,
    }));
  }, [rows, colMap]);

  const validCount   = previewRows.filter((r) => r.title && String(r.title).trim()).length;
  const missingTitle = previewRows.length - validCount;

  // Switch a canonical field to a different column (or "none") via dropdown.
  const remap = (field, idx) => setColMap((m) => ({ ...m, [field]: idx === "" ? undefined : Number(idx) }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!rows.length) { setErr("Pick a file first"); return; }
    if (colMap.title == null) { setErr("Map a column to “Title” — it's required"); return; }
    setBusy(true); setErr("");
    try {
      // Map every row (not just the preview slice) before sending, then drop
      // rows that have no title at all so the server doesn't churn through them.
      const payload = rows.map((r) => ({
        title:       r[colMap.title],
        author:      colMap.author      != null ? r[colMap.author]      : "",
        category:    colMap.category    != null ? r[colMap.category]    : "general",
        isbn:        colMap.isbn        != null ? r[colMap.isbn]        : null,
        shelf:       colMap.shelf       != null ? r[colMap.shelf]       : null,
        // Same preference as the preview: Available_Copies wins over
        // Total_Copies when both are provided.
        totalCopies: resolveCopies(r),
      })).filter((r) => r.title && String(r.title).trim());
      if (!payload.length) throw new Error("No rows had a title");
      const j = await onSubmit(payload);
      setResult(j);
    } catch (ex) { setErr(ex.message || String(ex)); }
    finally { setBusy(false); }
  }

  function downloadSample() {
    // Matches the column names the school's existing register uses:
    // Book_Title · Author · Category · Total_Copies · Available_Copies.
    // Generated client-side via SheetJS so no template file ships with
    // the app and the headers stay in sync with the importer's aliases.
    const data = [
      ["Book_Title", "Author", "Category", "Total_Copies", "Available_Copies"],
      ["The Wings of Fire", "APJ Abdul Kalam", "biography", 4, 4],
      ["Ramayana", "C. Rajagopalachari", "literature", 6, 5],
      ["Class 5 Science", "NCERT", "textbook", 30, 28],
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Books");
    XLSX.writeFile(wb, "library-import-template.xlsx");
  }

  return (
    <ModalShell title="Import books" sub="Upload an Excel or CSV file — preview before importing" onClose={onClose} width={760}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* File picker */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFile}
            style={{ display: "none" }}
          />
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
                  title: "Title",
                  author: "Author",
                  category: "Category",
                  isbn: "ISBN",
                  shelf: "Shelf",
                  totalCopies: "Total Copies",
                  availableCopies: "Available Copies",
                };
                return (
                  <label key={field} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
                    <span style={{ color: "var(--ink-3)" }}>
                      {labels[field]}
                      {field === "title" && <span style={{ color: "var(--err, #b13c1c)" }}> *</span>}
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
            {colMap.totalCopies != null && colMap.availableCopies != null && (
              <div style={{ fontSize: 10.5, color: "var(--ink-4)", marginTop: 8, lineHeight: 1.5 }}>
                Both <b>Total Copies</b> and <b>Available Copies</b> are mapped. The catalog will be seeded with the
                <b> Available Copies</b> count (what's currently on the shelf). Loans recorded in the app afterwards
                will reduce that number over time.
              </div>
            )}
          </div>
        )}

        {/* Preview */}
        {previewRows.length > 0 && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>
                Preview · first {previewRows.length} of {rows.length}
              </div>
              <div style={{ fontSize: 11, color: missingTitle ? "var(--warn)" : "var(--ink-3)" }}>
                {validCount} importable{missingTitle ? ` · ${missingTitle} skipped (no title)` : ""}
              </div>
            </div>
            <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--rule)", borderRadius: 7 }}>
              <table className="table" style={{ fontSize: 11.5 }}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Title</th>
                    <th>Author</th>
                    <th>Category</th>
                    {colMap.isbn != null && <th>ISBN</th>}
                    {colMap.shelf != null && <th>Shelf</th>}
                    {colMap.totalCopies != null && <th className="num">Total</th>}
                    {colMap.availableCopies != null && <th className="num">Available</th>}
                    <th className="num" title="The number actually saved in the catalog (Available wins when both are present)">Will save</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r, i) => {
                    const ok = !!String(r.title || "").trim();
                    return (
                      <tr key={i} style={ok ? undefined : { background: "var(--err-soft, #fbe1d8)" }}>
                        <td style={{ color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{i + 1}</td>
                        <td style={{ fontWeight: 500 }}>{String(r.title || "—")}</td>
                        <td style={{ color: "var(--ink-3)" }}>{String(r.author || "—")}</td>
                        <td style={{ color: "var(--ink-3)" }}>{String(r.category || "general")}</td>
                        {colMap.isbn  != null && <td style={{ color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>{String(r.isbn || "—")}</td>}
                        {colMap.shelf != null && <td style={{ color: "var(--ink-3)" }}>{String(r.shelf || "—")}</td>}
                        {colMap.totalCopies     != null && <td className="num" style={{ color: "var(--ink-4)" }}>{r._rawTotal     ?? "—"}</td>}
                        {colMap.availableCopies != null && <td className="num" style={{ color: "var(--ink-4)" }}>{r._rawAvailable ?? "—"}</td>}
                        <td className="num" style={{ fontWeight: 600 }}>{Number(r.totalCopies) || 1}</td>
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
            refreshed, so closing reveals the updated table. */}
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
                  {(result.imported?.length || 0)} book{(result.imported?.length || 0) === 1 ? "" : "s"} added · the library shelf behind this dialog is already updated.
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
              <button type="submit" className="btn accent" disabled={busy || !rows.length || colMap.title == null}>
                <Icon name="upload" size={13} />
                {busy ? "Importing…" : `Import ${validCount} book${validCount === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
      </form>
    </ModalShell>
  );
}

// ---------- Borrow modal -------------------------------------------------
function BorrowModal({ book, students, staff, activeByBook, onClose, onSubmit }) {
  const [borrowerType, setBorrowerType] = useState("student");
  const [borrowerId, setBorrowerId]     = useState("");
  const [q, setQ]               = useState("");
  const [dueDays, setDueDays]   = useState(DEFAULT_DUE_DAYS);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState("");

  const list = borrowerType === "student" ? students : staff;
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((p) => `${p.name} ${p.id} ${p.cls || p.role || ""}`.toLowerCase().includes(needle));
  }, [list, q]);
  const selected = list.find((p) => p.id === borrowerId);

  const available = Math.max(0, (book.totalCopies || 0) - (activeByBook.get(book.id) || 0));
  const dueDate = useMemo(() => {
    const d = new Date(Date.now() + Math.max(1, Math.min(60, Number(dueDays) || DEFAULT_DUE_DAYS)) * 86400000);
    return d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  }, [dueDays]);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!selected) { setErr("Pick a borrower"); return; }
    setBusy(true); setErr("");
    try {
      await onSubmit({
        bookId: book.id,
        borrowerType,
        borrowerId: selected.id,
        borrowerName: selected.name,
        dueDays: Math.max(1, Math.min(60, Number(dueDays) || DEFAULT_DUE_DAYS)),
      });
    } catch (ex) { setErr(ex.message || String(ex)); setBusy(false); }
  }

  return (
    <ModalShell title="Issue book" sub={`${book.title} · ${available} of ${book.totalCopies} available`} onClose={onClose} width={560}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="segmented">
          <button type="button" className={borrowerType === "student" ? "active" : ""} onClick={() => { setBorrowerType("student"); setBorrowerId(""); }}>Student ({students.length})</button>
          <button type="button" className={borrowerType === "teacher" ? "active" : ""} onClick={() => { setBorrowerType("teacher"); setBorrowerId(""); }}>Teacher / Staff ({staff.length})</button>
        </div>

        <Field label="Borrower *">
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={borrowerType === "student" ? "Search by name, reg ID, class…" : "Search by name, role…"}
            style={{ marginBottom: 6 }}
            autoFocus
          />
          <div style={{
            border: "1px solid var(--rule)",
            borderRadius: 9,
            maxHeight: 200,
            overflowY: "auto",
            background: "var(--card-2)",
          }}>
            {filtered.length === 0 ? (
              <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--ink-4)", textAlign: "center" }}>
                No {borrowerType}s match "{q}"
              </div>
            ) : filtered.map((p) => {
              const active = p.id === borrowerId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setBorrowerId(p.id)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 12px", border: 0,
                    borderBottom: "1px solid var(--rule-2)",
                    background: active ? "var(--accent-soft)" : "transparent",
                    cursor: "pointer", textAlign: "left",
                  }}
                >
                  <span style={{
                    width: 26, height: 26, borderRadius: "50%",
                    background: active ? "var(--accent)" : "var(--bg-2)",
                    color: active ? "#fff" : "var(--ink-2)",
                    display: "grid", placeItems: "center",
                    fontWeight: 600, fontSize: 11, flexShrink: 0,
                  }}>
                    {p.name.split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase()}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 12.5, fontWeight: 500, color: active ? "var(--accent-2)" : "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                    <span style={{ display: "block", fontSize: 10.5, color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>
                      {p.id}{p.cls ? ` · ${formatClassLabel(p.cls)}` : p.role ? ` · ${p.role}` : ""}
                    </span>
                  </span>
                  {active && <Icon name="check" size={13} />}
                </button>
              );
            })}
          </div>
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 10, alignItems: "end" }}>
          <Field label="Loan days">
            <input
              className="input"
              type="number"
              min={1} max={60}
              value={dueDays}
              onChange={(e) => setDueDays(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <div style={{ fontSize: 11.5, color: "var(--ink-3)", padding: "8px 10px", background: "var(--bg-2)", borderRadius: 7 }}>
            Due back by <b>{dueDate}</b>. Standard loan is {DEFAULT_DUE_DAYS} days.
          </div>
        </div>

        {err && <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy || !selected || available === 0}>
            <Icon name="check" size={13} />{busy ? "Issuing…" : "Issue book"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
