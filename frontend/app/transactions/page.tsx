"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useReadContract } from "wagmi";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { Icon } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, fmtUsdc } from "../../lib/contract";
import { fetchHistory, fetchWithdrawals } from "../../lib/history";
import { loadCountry, fmtFiat } from "../../lib/countries";
import { fetchUsdcRate } from "../../lib/rates";
import { useT } from "../../lib/i18n";

const STATUS_STYLE = { matching: "locked", settled: "available", cancelled: "withdrawn" };
// Map on-chain status → translation key (resolved inside the component via t()).
const STATUS_LABEL_KEY = { matching: "dash.waiting", settled: "dash.received", cancelled: "dash.cancelled" };
const SCAN = "https://sepolia.basescan.org";

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// Date-range menu options.
const RANGES = [
  { id: "today", key: "tx.today" },
  { id: "week", key: "tx.week" },
  { id: "month", key: "tx.month" },
  { id: "all", key: "tx.all" },
];

// Menu filter options — plain words, resolved via t().
const FILTERS = [
  { id: "all", key: "tx.filterAll" },
  { id: "settled", key: "tx.fReceived" },
  { id: "settling", key: "tx.fLocked" },
  { id: "withdraw", key: "tx.fWithdrawn" },
  { id: "cancelled", key: "tx.fCancelled" },
];

export default function Transactions() {
  const { t } = useT();
  const { ready, address } = useMerchant();
  const [country, setCountry] = useState(null);
  const [rate, setRate] = useState(null);
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [range, setRange] = useState("all"); // today | week | month | all
  const [rangeOpen, setRangeOpen] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => { setCountry(loadCountry()); }, []);
  useEffect(() => {
    if (!country) return;
    fetchUsdcRate(country).then(setRate).catch(() => {});
  }, [country]);

  const { data: balance } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantBalance",
    args: [address], query: { enabled: !!address, refetchInterval: 20000 },
  });
  const [pending, available] = balance ?? [0n, 0n];

  // The merchant's per-merchant proxy — fiat withdrawals (SELL orders) are
  // indexed in the subgraph under THIS address, so we read it to fetch them.
  const { data: proxyAddr } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "proxyAddress",
    args: [address], query: { enabled: !!address },
  });

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      // Payments (BUY orders, keyed by merchant) + fiat withdrawals (SELL
      // orders, keyed by the merchant's proxy). Merge into one timeline.
      const [payments, withdrawals] = await Promise.all([
        fetchHistory(address),
        proxyAddr ? fetchWithdrawals(proxyAddr) : Promise.resolve([]),
      ]);
      const merged = [...payments.map((r) => ({ ...r, kind: "payment" })), ...withdrawals]
        .sort((a, b) => b.placedAt - a.placedAt);
      setRows(merged);
    } catch (e) { console.error(e); }
    finally { setLoaded(true); }
  }, [address, proxyAddr]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  // map each row to a normalized shape with a "type"
  const all = useMemo(
    () => rows.map((tx) => ({ ...tx, type: "sale" })),
    [rows]
  );

  // Multi-day report: restrict to today / last 7 days / last 30 days / all.
  const items = useMemo(() => {
    if (range === "all") return all;
    const now = Date.now();
    const span = range === "today" ? 1 : range === "week" ? 7 : 30;
    // "today" = since local midnight; week/month = rolling N days.
    const cutoff = range === "today"
      ? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
      : now - span * 86400_000;
    return all.filter((t) => new Date(t.createdAt).getTime() >= cutoff);
  }, [all, range]);

  const filtered = useMemo(() => {
    let list = items;
    if (filter === "withdraw") list = list.filter((t) => t.kind === "withdraw");
    else if (filter === "settled") list = list.filter((t) => t.kind !== "withdraw" && t.status === "settled");
    else if (filter === "settling") list = list.filter((t) => t.kind !== "withdraw" && t.status === "matching");
    else if (filter === "cancelled") list = list.filter((t) => t.kind !== "withdraw" && t.status === "cancelled");
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      list = list.filter((t) => `#${t.orderId}`.includes(needle) || fmtUsdc(t.amount).includes(needle));
    }
    return list;
  }, [items, filter, q]);

  // Report totals are over RECEIVED sales in the chosen range (money in hand).
  const received = items.filter((t) => t.status === "settled");
  const totalUsdc = received.reduce((a, t) => a + Number(t.amount) / 1e6, 0);
  const totalFiat = rate && country ? totalUsdc * rate.rate : null;

  // Export a clean PDF statement. We render a print-ready document and trigger
  // the browser's print dialog → "Save as PDF" — works on every device with no
  // library or download of a raw file. Shopkeeper gets a real statement.
  function exportPdf() {
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const today = new Date().toLocaleDateString(country?.locale || undefined, {
      day: "numeric", month: "long", year: "numeric",
    });
    const label = (s) =>
      s === "settled" ? "Received" : s === "cancelled" ? "Cancelled" : "Waiting";
    const rowsHtml = items.map((t) => {
      const d = new Date(t.createdAt).toLocaleString(country?.locale || undefined,
        { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      return `<tr>
        <td>#${esc(t.orderId)}</td>
        <td>${esc(d)}</td>
        <td class="r">${fmtUsdc(t.amount)} USDC</td>
        <td>${label(t.status)}</td>
      </tr>`;
    }).join("");

    const totalLine = totalFiat != null
      ? `${fmtFiat(country, totalFiat)} ${country.code} · ${totalUsdc.toFixed(2)} USDC`
      : `${totalUsdc.toFixed(2)} USDC`;

    const html = `<!doctype html><html><head><meta charset="utf-8">
      <title>PayQR statement</title>
      <style>
        * { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        body { color: #14141d; padding: 28px; }
        .top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
        .brand { font-size: 20px; font-weight: 700; color: #1488ff; }
        .sub { color: #71717f; font-size: 12px; margin-top: 2px; }
        .sum { background: #eef5ff; border: 1px solid #cfe5ff; border-radius: 10px; padding: 14px 16px; margin-bottom: 18px; }
        .sum .k { font-size: 11px; color: #71717f; text-transform: uppercase; letter-spacing: .06em; }
        .sum .v { font-size: 20px; font-weight: 700; margin-top: 2px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { text-align: left; color: #71717f; font-weight: 600; font-size: 10px;
             text-transform: uppercase; letter-spacing: .05em; padding: 8px 6px; border-bottom: 1.5px solid #e0e0ec; }
        td { padding: 9px 6px; border-bottom: 1px solid #ececf4; }
        td.r, th.r { text-align: right; }
        .foot { margin-top: 20px; font-size: 10px; color: #a4a4b3; }
      </style></head><body>
      <div class="top">
        <div><div class="brand">PayQR</div><div class="sub">Sales statement · ${esc(today)}</div></div>
        <div class="sub">${items.length} transaction${items.length === 1 ? "" : "s"}</div>
      </div>
      <div class="sum"><div class="k">Total received</div><div class="v">${esc(totalLine)}</div></div>
      <table>
        <thead><tr><th>Order</th><th>Date</th><th class="r">Amount</th><th>Status</th></tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="4" style="text-align:center;color:#a4a4b3;padding:20px">No transactions</td></tr>`}</tbody>
      </table>
      <div class="foot">Settled in USDC on Base · powered by p2p.me. Generated by the merchant from their PayQR terminal.</div>
      <script>window.onload = () => { window.print(); }</script>
      </body></html>`;

    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
  }

  if (!country) return <><Nav back /><div className="screen"><p className="muted" style={{ textAlign: "center" }}>{t("common.loading")}</p></div></>;

  return (
    <>
      <Nav back />
      <div className="screen">
        <h1 style={{ textAlign: "center", marginBottom: 2 }}>{t("tx.title")}</h1>
        <p className="muted" style={{ textAlign: "center", fontSize: 13, marginBottom: 14 }}>
          {t("tx.subtitle")}
        </p>

        {/* report summary for the chosen range */}
        <div className="strip" style={{ marginTop: 12 }}>
          <div>
            <span className="muted">{t("tx.received")} ({received.length} sale{received.length === 1 ? "" : "s"})</span>
            <strong>{totalFiat != null ? fmtFiat(country, totalFiat) : `${totalUsdc.toFixed(2)} USDC`}</strong>
          </div>
          <div>
            <span className="muted">{t("tx.inUsdc")}</span>
            <strong>{totalUsdc.toFixed(2)}</strong>
          </div>
        </div>

        {/* range + filter menus, then search */}
        <div className="hist-tools">
          {/* date-range menu */}
          <div className="hist-filter">
            <button className={`hist-filter-btn ${rangeOpen ? "on" : ""}`}
              onClick={() => { setRangeOpen((o) => !o); setFilterOpen(false); }}>
              <Icon.Clock width="15" height="15" />
              {t(RANGES.find((r) => r.id === range)?.key || "tx.all")}
              <span className="hf-car">▾</span>
            </button>
            {rangeOpen && (
              <div className="hist-filter-pop">
                {RANGES.map((r) => (
                  <button key={r.id} className={`hist-filter-item ${range === r.id ? "sel" : ""}`}
                    onClick={() => { setRange(r.id); setRangeOpen(false); }}>
                    {t(r.key)}
                    {range === r.id && <span className="hf-chk">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* status filter menu */}
          <div className="hist-filter">
            <button className={`hist-filter-btn ${filterOpen ? "on" : ""}`}
              onClick={() => { setFilterOpen((o) => !o); setRangeOpen(false); }}>
              <Icon.Chart width="15" height="15" />
              {t(FILTERS.find((f) => f.id === filter)?.key || "tx.filterAll")}
              <span className="hf-car">▾</span>
            </button>
            {filterOpen && (
              <div className="hist-filter-pop">
                {FILTERS.map((f) => (
                  <button key={f.id} className={`hist-filter-item ${filter === f.id ? "sel" : ""}`}
                    onClick={() => { setFilter(f.id); setFilterOpen(false); }}>
                    {t(f.key)}
                    {filter === f.id && <span className="hf-chk">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* search */}
        <input
          className="input hist-search-full"
          placeholder={t("tx.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        {!ready || !loaded ? (
          <p className="muted" style={{ textAlign: "center", marginTop: 24 }}>{t("common.loading")}</p>
        ) : filtered.length === 0 ? (
          <div className="recent-empty" style={{ marginTop: 18 }}>
            {items.length === 0 ? t("tx.none") : t("tx.noMatch")}
          </div>
        ) : (
          <div className="hist-list">
            {filtered.map((tx) => {
              const usdc = Number(tx.amount) / 1e6;
              const fiat = rate && country ? usdc * rate.rate : null;
              const isWithdraw = tx.kind === "withdraw";
              const settled = tx.status === "settled";
              const cancelled = tx.status === "cancelled";
              // money OUT (withdrawal) vs money IN (payment)
              const cls = isWithdraw ? "out" : settled ? "ok" : cancelled ? "bad" : "wait";
              const stateKey = isWithdraw ? "tx.withdrew"
                : settled ? "tx.received" : cancelled ? "dash.cancelled" : "tx.locked";
              const sub = isWithdraw
                ? `${fmtUsdc(tx.amount)} USDC → ${country.fiat} · #${tx.orderId}`
                : `${fmtUsdc(tx.amount)} USDC · #${tx.orderId}`;
              return (
                <a key={`${tx.kind}-${tx.orderId}`} className="hist-row"
                  href={tx.txHash ? `${SCAN}/tx/${tx.txHash}` : `${SCAN}/address/${CONTRACT_ADDRESS}`}
                  target="_blank" rel="noopener noreferrer">
                  <span className={`hist-ico ${cls}`}>
                    {isWithdraw ? <Icon.Up width="18" height="18" />
                      : cancelled ? <Icon.Back width="18" height="18" />
                      : <Icon.Down width="18" height="18" />}
                  </span>
                  <div className="hist-mid">
                    <div className="hist-fiat">
                      {isWithdraw ? "− " : ""}{fiat != null ? fmtFiat(country, fiat) : "—"}
                    </div>
                    <div className="hist-crypto">{sub}</div>
                  </div>
                  <div className="hist-right">
                    <span className={`hist-badge ${cls}`}>{t(stateKey)}</span>
                    <span className="hist-time">{timeAgo(tx.createdAt)}</span>
                  </div>
                </a>
              );
            })}
          </div>
        )}

        {items.length > 0 && (
          <button className="btn ghost act-export" onClick={exportPdf}>
            <Icon.Receipt /> {t("tx.downloadPdf")}
          </button>
        )}
      </div>

      <div className="bottombar">
        <a className="btn" href="/qr" style={{ flex: 1, textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Icon.Plus /> {t("common.acceptPayment")}
        </a>
        <a className="btn secondary" href="/withdraw" style={{ flex: 1, textAlign: "center" }}>{t("nav.withdraw")}</a>
      </div>
    </>
  );
}
