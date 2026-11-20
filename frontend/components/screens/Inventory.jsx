"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import Icon from "../Icon";
import { KPI } from "../ui";
import { formatClassLabel } from "@/lib/format";

// Built-in category buckets. Schools can also add their own — those show up
// alongside these in the filter strip via `extraCatsFromItems` below.
const BUILTIN_CATS = [
  { k: "book",    label: "Books" },
  { k: "uniform", label: "Uniforms" },
  { k: "asset",   label: "Assets" },
];
const BASE_FILTERS = [{ k: "all", label: "All" }];
const TAIL_FILTERS = [{ k: "out", label: "Out of stock" }];

// Spreadsheet header aliases → canonical stock-register fields.
const COLUMN_ALIASES = {
  id:              ["stockid", "id", "skuid", "itemid"],
  name:            ["itemname", "name", "item", "product", "sku"],
  category:        ["category", "type", "bucket", "group"],
  description:     ["description", "specification", "desc", "descriptionspecification"],
  cls:             ["class", "cls", "section", "classname", "classsection"],
  onHand:          ["balancestock", "balance", "onhand", "onhandqty", "stock"],
  qtyPurchased:    ["qtypurchased", "purchased", "qtybought", "quantitypurchased"],
  issued:          ["qtyissuedused", "qtyissued", "issued", "qtyused", "used"],
  min:             ["reorderlevel", "reorder", "min", "minimum", "minstock"],
  unitPrice:       ["unitcost", "unitprice", "price", "rate", "mrp", "cost"],
  totalCost:       ["totalcost", "total", "amount"],
  supplier:        ["suppliervendor", "supplier", "vendor", "dealer"],
  storageLocation: ["storagelocation", "location", "storage", "custody"],
};

function normHeader(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseMoneyCell(raw) {
  if (raw == null || raw === "") return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const s = String(raw).trim();
  if (!s) return 0;
  const cleaned = s.replace(/,/g, "").replace(/[^\d.-].*$/, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
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

// Sanfort register sheets often have title rows above the real header.
function findHeaderRow(matrix) {
  for (let i = 0; i < Math.min(12, matrix.length); i++) {
    const norms = (matrix[i] || []).map(normHeader);
    if (norms.some((h) => h === "stockid" || h === "itemname" || h === "balancestock")) return i;
    if (norms.includes("name") && (norms.includes("category") || norms.includes("supplier"))) return i;
  }
  return 0;
}

function totalCostOf(it) {
  const purchased = Number(it.qtyPurchased) || 0;
  const unit = Number(it.unitPrice) || 0;
  if (purchased > 0 && unit > 0) return purchased * unit;
  const bal = Number(it.onHand) || 0;
  return bal * unit;
}

// Stock status from balance vs reorder level: Out (0) / Low (≤ reorder) / In.
function stockStatusOf(it) {
  const bal = Number(it.onHand) || 0;
  const min = Number(it.min) || 0;
  if (bal <= 0) return { key: "out", label: "Out of stock", cls: "bad" };
  if (min > 0 && bal <= min) return { key: "low", label: "Low stock", cls: "warn" };
  return { key: "in", label: "In stock", cls: "ok" };
}

// Pretty-print a category id ("lab_equipment" → "Lab equipment") for chips,
// the filter strip, and the table.
function prettyCat(c) {
  if (!c) return "—";
  const s = String(c).replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
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

function ModalShell({ title, sub, onClose, children, width = 460 }) {
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

export default function ScreenInventory({ E, refresh, role }) {
  const canEdit = role === "principal" || role === "admin";
  const [filter, setFilter] = useState("all");
  // "" = no class filter; "all" = only shared (cls === "all") items; any other
  // value = that specific class-section plus the shared items (since shared
  // items are available to every class).
  const [classFilter, setClassFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showMove, setShowMove] = useState(null); // 'in' | 'out' | 'return' | null
  const [movePreset, setMovePreset] = useState(null); // pre-selected itemId
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const items = E.INVENTORY || [];
  const movements = E.MOVEMENTS || [];
  const classes = E.CLASSES || [];
  // Categories the user explicitly saved via the "Save category" button.
  // Persisted server-side so they show up even before any item uses them.
  const savedCats = E.INVENTORY_CATEGORIES || [];

  const isOut = (it) => (it.onHand ?? 0) === 0;

  // Merge: built-in buckets + explicitly-saved + categories derived from
  // existing items (back-compat — older items had categories that were never
  // saved separately). Dedupe by id, preserving order.
  const allCats = useMemo(() => {
    const seen = new Set(BUILTIN_CATS.map((c) => c.k));
    const extras = [];
    const addOne = (k) => {
      if (!k || seen.has(k)) return;
      seen.add(k); extras.push(k);
    };
    savedCats.forEach(addOne);
    for (const i of items) addOne(i.category);
    return [...BUILTIN_CATS, ...extras.map((k) => ({ k, label: prettyCat(k) }))];
  }, [items, savedCats]);
  const FILTERS = useMemo(
    () => [...BASE_FILTERS, ...allCats, ...TAIL_FILTERS],
    [allCats]
  );

  // Dropdown options: every distinct cls seen on items. "all" is filtered out
  // because it's offered as a dedicated "All-class items only" entry; actual
  // class sections ("2-A", "5-A", …) are listed separately.
  const classOptions = useMemo(() => {
    const set = new Set();
    for (const i of items) if (i.cls) set.add(i.cls);
    return [...set].filter((c) => c !== "all").sort();
  }, [items]);

  const filtered = useMemo(() => {
    let list = items;
    if (filter === "out") list = list.filter(isOut);
    else if (filter !== "all") list = list.filter((i) => i.category === filter);
    if (classFilter) {
      list = list.filter((i) => {
        if (classFilter === "all") return i.cls === "all";
        // A specific class sees its own items and everything tagged "all".
        return i.cls === classFilter || i.cls === "all";
      });
    }
    return list;
  }, [items, filter, classFilter]);

  const totalSkus = items.length;
  const outCount  = items.filter(isOut).length;
  const stockValue = items.reduce((a, i) => a + totalCostOf(i), 0);
  const supplierCount = new Set(items.map((i) => i.supplier).filter(Boolean)).size;

  // Class-wise health — bucketed by out-of-stock count.
  const classHealth = useMemo(() => {
    const map = new Map();
    for (const i of items) {
      const key = i.cls || "Unassigned";
      if (!map.has(key)) map.set(key, { items: 0, out: 0 });
      const e = map.get(key);
      e.items += 1;
      if (isOut(i)) e.out += 1;
    }
    return [...map.entries()].sort((a, b) => b[1].out - a[1].out);
  }, [items]);

  const showToast = (msg, tone) => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 3500);
  };

  async function handleAdd(payload) {
    const r = await fetch("/api/inventory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) throw new Error(json.error || "Failed to add item");
    setShowAdd(false);
    showToast(`${json.item.name} added (${json.item.id})`, "ok");
    await refresh?.();
  }

  async function handleImport(rows) {
    const r = await fetch("/api/inventory/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) throw new Error(json.error || "Import failed");
    const okN = json.imported?.length || 0;
    const errN = json.errors?.length || 0;
    showToast(
      errN
        ? `Imported ${okN} · ${errN} skipped`
        : `Imported ${okN} item${okN === 1 ? "" : "s"}`,
      errN && !okN ? "err" : "ok",
    );
    await refresh?.();
    return json;
  }

  // Persist a new category id (without needing to add an item). Returns the
  // canonical slug the server stored, so the modal can preselect it.
  async function handleSaveCategory(rawCategory) {
    const r = await fetch("/api/inventory/categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: rawCategory }),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) throw new Error(json.error || "Failed to save category");
    showToast(`Category "${prettyCat(json.category)}" saved`, "ok");
    await refresh?.();
    return json.category;
  }

  async function handleMove(type, payload) {
    const r = await fetch("/api/inventory/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, ...payload }),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
    setShowMove(null); setMovePreset(null);
    const sign = (type === "in" || type === "return") ? "+" : "-";
    showToast(`${json.item.name}: ${sign}${payload.qty} (now ${json.item.onHand} on hand)`, "ok");
    await refresh?.();
  }

  // Save an item's remarks inline (best-effort; persists via the override map
  // even before the DB column migration).
  async function saveRemarks(id, remarks) {
    const r = await fetch("/api/inventory", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, remarks }),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok || !json.ok) { showToast(json.error || "Couldn't save remarks", "err"); return; }
    showToast("Remarks saved", "ok");
    await refresh?.();
  }

  async function handleRemove(it) {
    if (!confirm(`Remove ${it.name} from inventory?`)) return;
    try {
      const r = await fetch("/api/inventory", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: it.id }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Failed");
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(it.id);
        return next;
      });
      showToast(`${it.name} removed`, "ok");
      await refresh?.();
    } catch (e) { showToast(e.message, "err"); }
  }

  const filteredIds = useMemo(() => filtered.map((i) => i.id), [filtered]);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const selectedCount = selectedIds.size;

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const id of filteredIds) next.delete(id);
      } else {
        for (const id of filteredIds) next.add(id);
      }
      return next;
    });
  }

  async function handleBulkDelete() {
    if (!selectedCount || bulkBusy) return;
    if (!confirm(`Delete ${selectedCount} selected item${selectedCount === 1 ? "" : "s"} from inventory?`)) return;
    setBulkBusy(true);
    try {
      const r = await fetch("/api/inventory", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) throw new Error(json.error || "Bulk delete failed");
      setSelectedIds(new Set());
      showToast(`Deleted ${json.removed || selectedCount} item${(json.removed || selectedCount) === 1 ? "" : "s"}`, "ok");
      await refresh?.();
    } catch (e) {
      showToast(e.message, "err");
    } finally {
      setBulkBusy(false);
    }
  }

  const itemMap = useMemo(() => Object.fromEntries(items.map((i) => [i.id, i])), [items]);
  const fmtRupees = (n) => `₹${Math.round(n || 0).toLocaleString("en-IN")}`;
  const fmtQty = (n) => {
    const v = Number(n) || 0;
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  };
  const iconForCat = (c) => c === "book" || String(c).includes("book") ? "book" : c === "uniform" ? "user" : "box";
  const colourSoftForCat = (c) => c === "book" || String(c).includes("book") ? "var(--info-soft, #dfe9f3)" : c === "uniform" ? "var(--accent-soft)" : "var(--card-2)";
  const colourInkForCat = (c) => c === "book" || String(c).includes("book") ? "var(--info, #4a6b8c)" : c === "uniform" ? "var(--accent-2)" : "var(--ink-3)";

  function exportRegister() {
    const data = [
      ["Stock ID", "Item Name", "Category", "Description / Specification", "Supplier / Vendor", "Unit Cost (₹)", "Total Cost (₹)", "Qty Purchased", "Qty Issued / Used", "Balance Stock", "Reorder Level", "Stock Status", "Storage Location", "Remarks"],
      ...items.map((it) => [
        it.id,
        it.name,
        prettyCat(it.category),
        it.description || "",
        it.supplier || "",
        it.unitPrice || 0,
        Math.round(totalCostOf(it)),
        it.qtyPurchased ?? "",
        it.issued ?? 0,
        it.onHand ?? 0,
        it.min ?? 0,
        stockStatusOf(it).label,
        it.storageLocation || "",
        it.remarks || "",
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Stock Register");
    XLSX.writeFile(wb, `stock-register-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">Operations · Inventory</div>
          <div className="page-title">Stock register</div>
          <div className="page-sub">Purchased · issued · balance · import Excel or add items</div>
        </div>
        <div className="page-actions">
          {canEdit && selectedCount > 0 && (
            <button
              className="btn"
              onClick={handleBulkDelete}
              disabled={bulkBusy}
              title="Delete selected items"
              style={{ borderColor: "var(--err, #b13c1c)", color: "var(--err, #b13c1c)" }}
            >
              <Icon name="x" size={13} />
              {bulkBusy ? "Deleting…" : `Delete ${selectedCount}`}
            </button>
          )}
          {items.length > 0 && (
            <button className="btn" onClick={exportRegister} title="Download current register as Excel">
              <Icon name="download" size={13} />Export
            </button>
          )}
          {canEdit && (
            <>
              <button className="btn" onClick={() => setShowImport(true)} title="Import Sanfort stock register Excel/CSV">
                <Icon name="upload" size={13} />Import Excel
              </button>
              <button className="btn" onClick={() => { setMovePreset(null); setShowMove("in"); }} disabled={items.length === 0} title="Purchase / restock — increases balance & purchased">
                <Icon name="upload" size={13} />Stock in
              </button>
              <button className="btn" onClick={() => { setMovePreset(null); setShowMove("out"); }} disabled={items.length === 0} title="Issue stock to a person / class">
                <Icon name="download" size={13} />Issue
              </button>
              <button className="btn" onClick={() => { setMovePreset(null); setShowMove("return"); }} disabled={items.length === 0} title="Return issued stock">
                <Icon name="upload" size={13} />Return
              </button>
              <button className="btn accent" onClick={() => setShowAdd(true)}>
                <Icon name="plus" size={13} />Add item
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid g-4" style={{ marginBottom: 14 }}>
        <KPI
          label="SKUs tracked" value={totalSkus} sub="across classes"
          puck="mint" puckIcon="box"
          details={{
            title: `Inventory · ${totalSkus} SKUs`,
            items: items.slice(0, 12).map((i) => ({
              label: i.name, value: `${i.onHand} on hand`,
              sub: `${i.category} · ${i.cls || "all"}`,
            })),
          }}
        />
        <KPI
          label="Out of stock items" value={outCount}
          sub={outCount ? "need re-order" : "all in stock"}
          puck="rose" puckIcon="warning"
          details={{
            title: `Out of stock · ${outCount} items`,
            sub: "Need re-order — currently at zero on-hand",
            items: items.filter(isOut).map((i) => ({
              label: i.name, value: "0 on hand", sub: `${i.category}`, tone: "bad",
            })),
          }}
        />
        <KPI
          label="Stock value" value={stockValue ? fmtRupees(stockValue) : "—"}
          sub={stockValue ? "based on unit prices" : "set unit prices"}
          puck="cream" puckIcon="trending"
          details={{
            title: `Stock value · ${stockValue ? fmtRupees(stockValue) : "₹0"}`,
            sub: "Purchased × unit price (fallback Balance × unit), top items first",
            items: [...items]
              .map((i) => ({ ...i, total: totalCostOf(i) }))
              .sort((a, b) => b.total - a.total)
              .slice(0, 10)
              .map((i) => ({ label: i.name, value: fmtRupees(i.total), sub: `${i.qtyPurchased || i.onHand || 0} × ₹${i.unitPrice || 0}` })),
          }}
        />
        <KPI label="Suppliers" value={supplierCount} sub={supplierCount ? "unique" : "add suppliers"} puck="sky" puckIcon="users" />
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head" style={{ flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 220px", minWidth: 0 }}>
            <div className="card-title">Stock register</div>
            <div className="card-sub">
              {filtered.length} shown
              {items.length !== filtered.length ? ` of ${items.length}` : ""}
              {" · "}Balance is live on-hand
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginLeft: "auto" }}>
            {selectedCount > 0 && (
              <span className="chip" style={{ fontSize: 11 }}>{selectedCount} selected</span>
            )}
            <select
              className="select"
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              title="Filter by class"
              style={{ minWidth: 160 }}
            >
              <option value="">All classes</option>
              <option value="all">All-class items only</option>
              {classOptions.map((c) => (
                <option key={c} value={c}>{formatClassLabel(String(c))}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{
          display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center",
          padding: "10px 16px", borderBottom: "1px solid var(--rule-2)",
        }}>
          {FILTERS.map((f) => {
            const active = filter === f.k;
            return (
              <button
                key={f.k}
                type="button"
                onClick={() => setFilter(f.k)}
                className="btn sm"
                style={{
                  height: 28,
                  padding: "0 10px",
                  fontSize: 11.5,
                  background: active ? "var(--ink)" : "var(--card)",
                  color: active ? "var(--bg)" : "var(--ink-2)",
                  borderColor: active ? "var(--ink)" : "var(--rule)",
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        {filtered.length === 0 ? (
          <div className="empty" style={{ padding: 40 }}>
            {items.length === 0
              ? "No items yet. Import the stock register Excel or click “Add item”."
              : (() => {
                  const catLbl = FILTERS.find((f) => f.k === filter)?.label;
                  const clsLbl = !classFilter
                    ? null
                    : classFilter === "all" ? "All-class items only" : `${formatClassLabel(String(classFilter))} items only`;
                  const bits = [];
                  if (filter !== "all") bits.push(`“${catLbl}”`);
                  if (clsLbl) bits.push(`“${clsLbl}”`);
                  return bits.length
                    ? `No items match the ${bits.join(" + ")} filter${bits.length > 1 ? "s" : ""}.`
                    : "No items to show.";
                })()}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ minWidth: 960 }}>
              <thead>
                <tr>
                  {canEdit && (
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleSelectAllFiltered}
                        title={allFilteredSelected ? "Clear selection" : "Select all visible"}
                        aria-label="Select all visible items"
                      />
                    </th>
                  )}
                  <th>Stock ID</th>
                  <th>Item</th>
                  <th>Category</th>
                  <th>Supplier</th>
                  <th className="num">Unit ₹</th>
                  <th className="num">Total ₹</th>
                  <th className="num">Purchased</th>
                  <th className="num">Issued</th>
                  <th className="num">Balance</th>
                  <th className="num">Reorder</th>
                  <th>Status</th>
                  <th>Location</th>
                  <th>Remarks</th>
                  {canEdit && <th></th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => {
                  const out = isOut(it);
                  const low = !out && (Number(it.min) || 0) > 0 && (Number(it.onHand) || 0) <= (Number(it.min) || 0);
                  const checked = selectedIds.has(it.id);
                  return (
                    <tr key={it.id} style={checked ? { background: "var(--accent-soft)" } : undefined}>
                      {canEdit && (
                        <td>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSelect(it.id)}
                            aria-label={`Select ${it.name}`}
                          />
                        </td>
                      )}
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{it.id}</td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 140 }}>
                          <div style={{ width: 28, height: 28, borderRadius: 7, background: colourSoftForCat(it.category), color: colourInkForCat(it.category), display: "grid", placeItems: "center", flexShrink: 0 }}>
                            <Icon name={iconForCat(it.category)} size={14} />
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12.5, fontWeight: 500 }}>{it.name}</div>
                            {it.description ? (
                              <div style={{ fontSize: 10.5, color: "var(--ink-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{it.description}</div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td><span className="chip">{prettyCat(it.category)}</span></td>
                      <td style={{ fontSize: 11.5, color: "var(--ink-3)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={it.supplier || ""}>{it.supplier || "—"}</td>
                      <td className="num" style={{ color: "var(--ink-3)" }}>{it.unitPrice ? fmtRupees(it.unitPrice) : "—"}</td>
                      <td className="num">{totalCostOf(it) ? fmtRupees(totalCostOf(it)) : "—"}</td>
                      <td className="num" style={{ color: "var(--ink-3)" }}>{fmtQty(it.qtyPurchased)}</td>
                      <td className="num" style={{ color: "var(--ink-3)" }}>{fmtQty(it.issued)}</td>
                      <td className="num" style={{ color: out ? "var(--err, #b13c1c)" : low ? "var(--warn, #b07a18)" : "inherit", fontWeight: out || low ? 600 : 400 }}>{fmtQty(it.onHand)}</td>
                      <td className="num" style={{ color: "var(--ink-3)" }}>{fmtQty(it.min)}</td>
                      <td>
                        {(() => { const s = stockStatusOf(it); return <span className={`chip ${s.cls}`}><span className="dot" />{s.label}</span>; })()}
                      </td>
                      <td style={{ fontSize: 11.5, color: "var(--ink-3)", maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.storageLocation || "—"}</td>
                      <td><RemarksCell item={it} canEdit={canEdit} onSave={saveRemarks} /></td>
                      {canEdit && (
                        <td>
                          <div style={{ display: "inline-flex", gap: 4, justifyContent: "flex-end" }}>
                            <button className="btn sm" onClick={() => { setMovePreset(it.id); setShowMove("out"); }} title="Issue to a person / class" disabled={(it.onHand || 0) === 0}>
                              <Icon name="download" size={11} />Issue
                            </button>
                            <button className="btn sm" onClick={() => { setMovePreset(it.id); setShowMove("return"); }} title="Return issued stock">
                              <Icon name="upload" size={11} />Return
                            </button>
                            <button className="icon-btn" onClick={() => handleRemove(it)} title="Remove"><Icon name="x" size={12} /></button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid g-2" style={{ gap: 14 }}>
        <div className="card">
          <div className="card-head"><div><div className="card-title">Class-wise stock health</div></div></div>
          {classHealth.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}>Stock health appears once items are tagged to classes.</div>
          ) : (
            <div style={{ padding: "8px 14px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
              {classHealth.map(([cls, info]) => (
                <div key={cls} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, alignItems: "center" }}>
                  <span style={{ color: "var(--ink-2)" }}>{formatClassLabel(String(cls))}</span>
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <span className="mono" style={{ color: "var(--ink-3)" }}>{info.items} item{info.items === 1 ? "" : "s"}</span>
                    {info.out > 0 ? (
                      <span className="chip bad"><span className="dot" />{info.out} out</span>
                    ) : (
                      <span className="chip ok"><span className="dot" />In stock</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head"><div><div className="card-title">Recent stock movements</div></div></div>
          {movements.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}>No stock-in / stock-out movements logged yet.</div>
          ) : (
            <div style={{ padding: "8px 14px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
              {movements.slice(0, 8).map((m) => {
                const item = itemMap[m.itemId];
                const positive = m.type === "in" || m.type === "return";
                const label = m.type === "in" ? "Stocked in" : m.type === "return" ? "Returned" : "Issued";
                return (
                  <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span style={{
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      width: 22, height: 22, borderRadius: 5,
                      background: positive ? "var(--ok-soft, #dfecd8)" : "var(--err-soft, #fbe1d8)",
                      color: positive ? "var(--ok)" : "var(--err, #b13c1c)",
                    }}>
                      <Icon name={positive ? "upload" : "download"} size={11} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {item?.name || m.itemId}
                      </div>
                      <div style={{ fontSize: 10.5, color: "var(--ink-4)" }}>
                        {label}
                        {m.issuedTo ? ` ${m.type === "return" ? "from" : "→"} ${m.issuedTo}` : ""}
                        {" · "}{m.who}{m.note ? ` · ${m.note}` : ""}
                      </div>
                    </div>
                    <div className="mono" style={{ fontSize: 12, fontWeight: 500, color: positive ? "var(--ok)" : "var(--err, #b13c1c)" }}>
                      {positive ? "+" : "−"}{m.qty}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showAdd && canEdit && (
        <AddItemModal
          classes={classes}
          existingCats={allCats}
          onClose={() => setShowAdd(false)}
          onSubmit={handleAdd}
          onSaveCategory={handleSaveCategory}
        />
      )}
      {showImport && canEdit && (
        <ImportInventoryModal
          onClose={() => setShowImport(false)}
          onSubmit={handleImport}
        />
      )}
      {showMove && canEdit && (
        <MoveModal
          items={items}
          type={showMove}
          presetItemId={movePreset}
          onClose={() => { setShowMove(null); setMovePreset(null); }}
          onSubmit={(payload) => handleMove(showMove, payload)}
        />
      )}

      <Toast msg={toast?.msg} tone={toast?.tone} onClose={() => setToast(null)} />
    </div>
  );
}

function AddItemModal({ classes, existingCats, onClose, onSubmit, onSaveCategory }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    id: "", name: "", category: "asset", cls: "all",
    description: "", storageLocation: "",
    onHand: "", qtyPurchased: "", issued: "", min: "", unitPrice: "", supplier: "", remarks: "",
  });
  // When the user picks "Add new…" from the category dropdown we flip into a
  // text-entry mode so they can type whatever bucket they want.
  const [customCat, setCustomCat] = useState(false);
  const [customCatVal, setCustomCatVal] = useState("");
  const [savingCat, setSavingCat] = useState(false);
  const nameRef = useRef(null);
  useEffect(() => { nameRef.current?.focus(); }, []);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      if (!form.name.trim()) throw new Error("Name is required");
      const cat = customCat ? customCatVal.trim() : form.category;
      if (!cat) throw new Error("Category is required");
      await onSubmit({
        id: form.id.trim() || null,
        name: form.name.trim(),
        category: cat,
        description: form.description.trim() || "",
        storageLocation: form.storageLocation.trim() || "",
        cls: form.cls === "all" ? "all" : form.cls,
        onHand: parseMoneyCell(form.onHand),
        qtyPurchased: form.qtyPurchased === "" ? undefined : parseMoneyCell(form.qtyPurchased),
        issued: parseMoneyCell(form.issued),
        min: parseMoneyCell(form.min),
        unitPrice: parseMoneyCell(form.unitPrice),
        supplier: form.supplier.trim() || null,
        remarks: form.remarks.trim() || "",
      });
    } catch (ex) { setErr(ex.message || String(ex)); setBusy(false); }
  }

  // Build flat list of class-section options.
  const classOpts = ["all", ...classes.flatMap((c) =>
    (c.sections || ["A"]).map((s) => `${c.n}-${s}`)
  )];

  return (
    <ModalShell title="Add stock item" sub="Optional Stock ID (e.g. SIS-001) · else auto INV-…" onClose={onClose} width={560}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 10 }}>
          <Field label="Stock ID">
            <input className="input" value={form.id} onChange={(e) => set("id", e.target.value)} placeholder="SIS-001" />
          </Field>
          <Field label="Item name *">
            <input className="input" ref={nameRef} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Fan / Plastic Chair" />
          </Field>
        </div>
        <Field label="Description / Specification">
          <input className="input" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="e.g. Half Pant & Shirt" />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Category" hint={customCat ? "Letters, numbers, _ and - · Save to keep this option for next time" : undefined}>
            {customCat ? (
              <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                <input
                  className="input"
                  autoFocus
                  value={customCatVal}
                  onChange={(e) => setCustomCatVal(e.target.value)}
                  placeholder="e.g. stationery, lab, sports"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn sm"
                  disabled={!customCatVal.trim() || savingCat}
                  onClick={async () => {
                    if (!onSaveCategory) return;
                    setErr(""); setSavingCat(true);
                    try {
                      const slug = await onSaveCategory(customCatVal);
                      // Switch back to dropdown with the new category preselected
                      // — the parent's refresh will surface it via existingCats.
                      setForm((f) => ({ ...f, category: slug }));
                      setCustomCat(false);
                      setCustomCatVal("");
                    } catch (ex) { setErr(ex.message || String(ex)); }
                    finally { setSavingCat(false); }
                  }}
                  title="Save this category as a permanent option"
                >
                  <Icon name="check" size={11} />{savingCat ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => { setCustomCat(false); setCustomCatVal(""); }}
                  title="Pick from existing categories"
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            ) : (
              <select
                className="select"
                value={form.category}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__new__") { setCustomCat(true); setCustomCatVal(""); }
                  else set("category", v);
                }}
              >
                {(existingCats || []).map((c) => (
                  <option key={c.k} value={c.k}>{c.label}</option>
                ))}
                <option value="__new__">+ Add new category…</option>
              </select>
            )}
          </Field>
          <Field label="Class">
            <select className="select" value={form.cls} onChange={(e) => set("cls", e.target.value)}>
              <option value="all">All classes</option>
              {classOpts.filter((o) => o !== "all").map((o) => (
                <option key={o} value={o}>Class {o}</option>
              ))}
            </select>
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
          <Field label="Balance stock" hint="Current on-hand">
            <input className="input" inputMode="decimal" value={form.onHand} onChange={(e) => set("onHand", e.target.value)} placeholder="0" />
          </Field>
          <Field label="Qty purchased" hint="Blank = same as balance">
            <input className="input" inputMode="decimal" value={form.qtyPurchased} onChange={(e) => set("qtyPurchased", e.target.value)} placeholder="=" />
          </Field>
          <Field label="Qty issued">
            <input className="input" inputMode="decimal" value={form.issued} onChange={(e) => set("issued", e.target.value)} placeholder="0" />
          </Field>
          <Field label="Reorder level">
            <input className="input" inputMode="decimal" value={form.min} onChange={(e) => set("min", e.target.value)} placeholder="0" />
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Unit cost (₹)">
            <input className="input" inputMode="decimal" value={form.unitPrice} onChange={(e) => set("unitPrice", e.target.value)} placeholder="0" />
          </Field>
          <Field label="Storage location">
            <input className="input" value={form.storageLocation} onChange={(e) => set("storageLocation", e.target.value)} placeholder="e.g. Store room" />
          </Field>
        </div>
        <Field label="Supplier / Vendor">
          <input className="input" value={form.supplier} onChange={(e) => set("supplier", e.target.value)} placeholder="e.g. NIVA uniform" />
        </Field>
        <Field label="Remarks" hint="Condition, specification, or any note">
          <input className="input" value={form.remarks} onChange={(e) => set("remarks", e.target.value)} placeholder="e.g. 2 pcs damaged · size L" />
        </Field>

        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy}>
            {busy ? "Adding…" : <><Icon name="check" size={13} />Add item</>}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// type: "in" (Stock in / purchase) · "out" (Issue to a person/class) ·
// "return" (issued stock comes back). Issue caps at current balance; Return
// adds back and clears the issued count.
const MOVE_META = {
  in:     { title: "Stock in",  sub: "Increases Balance + Qty Purchased",       icon: "upload",   cta: "Stock in" },
  out:    { title: "Issue",     sub: "Decreases Balance · increases Qty Issued", icon: "download", cta: "Issue" },
  return: { title: "Return",    sub: "Increases Balance · decreases Qty Issued", icon: "upload",   cta: "Return" },
};
function MoveModal({ items, type, presetItemId, onClose, onSubmit }) {
  const meta = MOVE_META[type] || MOVE_META.in;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    itemId: presetItemId || items[0]?.id || "",
    qty: "1",
    issuedTo: "",
    note: "",
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const selected = items.find((i) => i.id === form.itemId);
  const max = type === "out" ? (selected?.onHand || 0) : Infinity;
  const holderField = type === "out" || type === "return";

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const q = parseMoneyCell(form.qty);
      if (q <= 0) throw new Error("Quantity must be positive");
      if (type === "out" && q > max) throw new Error(`Only ${max} on hand`);
      await onSubmit({
        itemId: form.itemId,
        qty: q,
        issuedTo: holderField ? (form.issuedTo.trim() || null) : null,
        note: form.note.trim() || null,
      });
    } catch (ex) { setErr(ex.message || String(ex)); setBusy(false); }
  }

  return (
    <ModalShell title={meta.title} sub={meta.sub} onClose={onClose} width={460}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Item">
          <select className="select" value={form.itemId} onChange={(e) => set("itemId", e.target.value)}>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} · {i.id} · balance {i.onHand ?? 0}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quantity" hint={type === "out" ? `Max ${max} (current balance)` : undefined}>
          <input
            className="input" type="number" min={0.001} step="any"
            max={type === "out" ? max : undefined}
            value={form.qty}
            onChange={(e) => set("qty", e.target.value)}
          />
        </Field>
        {holderField && (
          <Field label={type === "return" ? "Returned by / from" : "Issued to / Dept"} hint="e.g. Class 5-A · Office · Lab">
            <input
              className="input"
              value={form.issuedTo}
              onChange={(e) => set("issuedTo", e.target.value)}
              placeholder={type === "return" ? "Who returned the stock" : "Who received the stock"}
            />
          </Field>
        )}
        <Field label="Note (optional)" hint={type === "in" ? "e.g. PO #4521 · supplier delivery" : "Optional extra note"}>
          <input className="input" value={form.note} onChange={(e) => set("note", e.target.value)} placeholder={type === "in" ? "PO / delivery note" : "Reason"} />
        </Field>

        {err && (
          <div style={{ background: "var(--err-soft, #fbe1d8)", color: "var(--err, #b13c1c)", padding: "9px 12px", borderRadius: 7, fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn accent" disabled={busy || !form.itemId}>
            {busy ? "Saving…" : <><Icon name={meta.icon} size={13} />{meta.cta}</>}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// Inline-editable remarks cell. Read-only text for non-editors; click-to-edit
// input for admin/principal that saves on blur / Enter.
function RemarksCell({ item, canEdit, onSave }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(item.remarks || "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!editing) setVal(item.remarks || ""); }, [item.remarks, editing]);

  if (!canEdit) {
    return (
      <span style={{ fontSize: 11.5, color: item.remarks ? "var(--ink-3)" : "var(--ink-4)", display: "inline-block", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.remarks || ""}>
        {item.remarks || "—"}
      </span>
    );
  }
  if (!editing) {
    return (
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => setEditing(true)}
        title={item.remarks || "Add remarks"}
        style={{ height: 24, padding: "0 6px", fontSize: 11.5, maxWidth: 170, justifyContent: "flex-start", color: item.remarks ? "var(--ink-2)" : "var(--ink-4)" }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {item.remarks || "+ Add"}
        </span>
      </button>
    );
  }
  const commit = async () => {
    if (busy) return;
    if ((val || "").trim() === (item.remarks || "").trim()) { setEditing(false); return; }
    setBusy(true);
    try { await onSave(item.id, val.trim()); setEditing(false); }
    finally { setBusy(false); }
  };
  return (
    <input
      autoFocus
      className="input"
      value={val}
      disabled={busy}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { setVal(item.remarks || ""); setEditing(false); }
      }}
      placeholder="Remarks…"
      style={{ height: 26, fontSize: 11.5, minWidth: 130 }}
    />
  );
}

function ImportInventoryModal({ onClose, onSubmit }) {
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [colMap, setColMap] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  const FIELD_LABELS = {
    id: "Stock ID",
    name: "Item name",
    category: "Category",
    description: "Description",
    cls: "Class",
    onHand: "Balance stock",
    qtyPurchased: "Qty purchased",
    issued: "Qty issued",
    min: "Reorder level",
    unitPrice: "Unit cost",
    totalCost: "Total cost",
    supplier: "Supplier",
    storageLocation: "Storage location",
  };

  async function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr(""); setResult(null);
    setFileName(f.name);
    try {
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: false });
      if (!arr.length) throw new Error("Spreadsheet is empty");
      const headerIdx = findHeaderRow(arr);
      const head = arr[headerIdx] || [];
      const headerArr = head.map((h) => String(h || "").trim());
      const map = inferColumnMap(headerArr);
      const nameIdx = map.name;
      // Drop blank spreadsheet rows early — registers often pad to hundreds of empty lines.
      const body = arr.slice(headerIdx + 1).filter((r) => {
        if (!Array.isArray(r)) return false;
        if (nameIdx != null) return String(r[nameIdx] ?? "").trim();
        return r.some((c) => String(c ?? "").trim());
      });
      setHeaders(headerArr);
      setRows(body);
      setColMap(map);
    } catch (ex) {
      setHeaders([]); setRows([]); setColMap({});
      setErr(ex.message || "Couldn't read the file");
    }
  }

  const cell = (r, field, fallback = "") =>
    colMap[field] != null ? r[colMap[field]] : fallback;

  const previewRows = useMemo(() => {
    return rows.slice(0, 50).map((r) => ({
      id: cell(r, "id"),
      name: cell(r, "name"),
      category: cell(r, "category", "asset"),
      description: cell(r, "description"),
      onHand: parseMoneyCell(cell(r, "onHand", 0)),
      qtyPurchased: parseMoneyCell(cell(r, "qtyPurchased", "")),
      issued: parseMoneyCell(cell(r, "issued", 0)),
      unitPrice: parseMoneyCell(cell(r, "unitPrice", 0)),
      supplier: cell(r, "supplier"),
    }));
  }, [rows, colMap]); // eslint-disable-line react-hooks/exhaustive-deps

  const validCount = previewRows.filter((r) => r.name && String(r.name).trim()).length;
  const missingName = previewRows.length - validCount;
  const remap = (field, idx) => setColMap((m) => ({ ...m, [field]: idx === "" ? undefined : Number(idx) }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!rows.length) { setErr("Pick a file first"); return; }
    if (colMap.name == null) { setErr("Map a column to “Item name” — it's required"); return; }
    setBusy(true); setErr("");
    try {
      const payload = rows.map((r) => {
        const purchasedCell = cell(r, "qtyPurchased", "");
        return {
          id: cell(r, "id") || null,
          name: cell(r, "name"),
          category: cell(r, "category", "asset") || "asset",
          description: cell(r, "description") || "",
          cls: cell(r, "cls", "all") || "all",
          onHand: parseMoneyCell(cell(r, "onHand", 0)),
          qtyPurchased: purchasedCell === "" || purchasedCell == null ? undefined : parseMoneyCell(purchasedCell),
          issued: parseMoneyCell(cell(r, "issued", 0)),
          min: parseMoneyCell(cell(r, "min", 0)),
          unitPrice: parseMoneyCell(cell(r, "unitPrice", 0)),
          totalCost: parseMoneyCell(cell(r, "totalCost", 0)),
          supplier: cell(r, "supplier") || null,
          storageLocation: cell(r, "storageLocation") || "",
        };
      }).filter((r) => r.name && String(r.name).trim());
      if (!payload.length) throw new Error("No rows had an item name");
      const j = await onSubmit(payload);
      setResult(j);
    } catch (ex) { setErr(ex.message || String(ex)); }
    finally { setBusy(false); }
  }

  function downloadSample() {
    const data = [
      ["Stock ID", "Item Name", "Category", "Description / Specification", "Supplier / Vendor", "Unit Cost (₹)", "Total Cost (₹)", "Qty Purchased", "Qty Issued / Used", "Balance Stock", "Reorder Level", "Storage Location"],
      ["SIS-001", "Fan", "Electronics", "", "", "", "", 44, "", 44, "", ""],
      ["SIS-073", "TCL(Tv 43 inch)", "Electronics", "", "Darling digtal world", 61500, 184500, 3, "", 3, "", ""],
      ["SIS-091", "KG(boys)", "Other", "Half Pant&Shirt", "NIVA uniform", 595, 26180, 44, "", 44, "", ""],
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Stock Register");
    XLSX.writeFile(wb, "stock-register-import-template.xlsx");
  }

  return (
    <ModalShell title="Import stock register" sub="Sanfort Excel layout · blank rows skipped · batch insert" onClose={onClose} width={860}>
      <form onSubmit={submit} className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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

        {headers.length > 0 && (
          <div style={{ background: "var(--bg-2)", padding: 10, borderRadius: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
              Match your columns
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {Object.keys(COLUMN_ALIASES).map((field) => (
                <label key={field} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
                  <span style={{ color: "var(--ink-3)" }}>
                    {FIELD_LABELS[field]}
                    {field === "name" && <span style={{ color: "var(--err, #b13c1c)" }}> *</span>}
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
              ))}
            </div>
          </div>
        )}

        {previewRows.length > 0 && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 500, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: 0.4 }}>
                Preview · first {previewRows.length} of {rows.length}
              </div>
              <div style={{ fontSize: 11, color: missingName ? "var(--warn)" : "var(--ink-3)" }}>
                {validCount} importable{missingName ? ` · ${missingName} skipped (no name)` : ""}
              </div>
            </div>
            <div style={{ maxHeight: 220, overflow: "auto", border: "1px solid var(--rule)", borderRadius: 7 }}>
              <table className="table" style={{ fontSize: 11.5 }}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Stock ID</th>
                    <th>Item</th>
                    <th>Category</th>
                    <th className="num">Purchased</th>
                    <th className="num">Issued</th>
                    <th className="num">Balance</th>
                    <th className="num">Unit ₹</th>
                    <th>Supplier</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r, i) => {
                    const ok = !!String(r.name || "").trim();
                    return (
                      <tr key={i} style={ok ? undefined : { background: "var(--err-soft, #fbe1d8)" }}>
                        <td style={{ color: "var(--ink-4)", fontFamily: "var(--font-mono)" }}>{i + 1}</td>
                        <td style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{String(r.id || "—")}</td>
                        <td style={{ fontWeight: 500 }}>
                          {String(r.name || "—")}
                          {r.description ? <div style={{ fontSize: 10, color: "var(--ink-4)" }}>{String(r.description)}</div> : null}
                        </td>
                        <td style={{ color: "var(--ink-3)" }}>{String(r.category || "asset")}</td>
                        <td className="num">{r.qtyPurchased || "—"}</td>
                        <td className="num">{r.issued || 0}</td>
                        <td className="num">{r.onHand}</td>
                        <td className="num">{r.unitPrice || "—"}</td>
                        <td style={{ color: "var(--ink-3)" }}>{String(r.supplier || "—")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

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
                  {(result.imported?.length || 0)} item{(result.imported?.length || 0) === 1 ? "" : "s"} added · the register behind this dialog is already updated.
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
              <button type="submit" className="btn accent" disabled={busy || !rows.length || colMap.name == null}>
                <Icon name="upload" size={13} />
                {busy ? "Importing…" : `Import ${validCount} item${validCount === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
      </form>
    </ModalShell>
  );
}
