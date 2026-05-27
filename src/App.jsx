import React, { useState, useEffect, useRef } from "react";
import { supabase, isSupabaseConfigured, rowToStock, stockToRow } from "./supabase";

const TWELVE_BASE = "https://api.twelvedata.com";
const TWELVE_KEY = import.meta.env.VITE_TWELVEDATA_API_KEY;

const INDICES = [
  { symbol: "KOSPI",  label: "코스피",  type: "krx" },
  { symbol: "KOSDAQ", label: "코스닥",  type: "krx" },
  { symbol: "IXIC",   label: "나스닥",  type: "us"  },
  { symbol: "SPX",    label: "S&P 500", type: "us"  },
];

const COLORS = [
  "#6366f1", "#f59e0b", "#10b981", "#ef4444", "#3b82f6",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#a855f7",
];

const EMPTY_FORM = {
  name: "",
  ticker: "",
  market: "KOSPI",
  quantity: "",
  avgPrice: "",
  currentPrice: "",
  groupName: "",
};


function formatKRW(value) {
  return Math.round(value).toLocaleString("ko-KR") + "원";
}

function formatPercent(value) {
  return (value >= 0 ? "+" : "") + value.toFixed(2) + "%";
}

export default function App() {
  const [stocks, setStocks] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // { id, name }
  const [showForm, setShowForm] = useState(false);
  const [errors, setErrors] = useState({});
  const [isFetching, setIsFetching] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [indices, setIndices] = useState([]);
  const [submitError, setSubmitError] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [usdToKrw, setUsdToKrw] = useState(1400);
  const [forexRates, setForexRates] = useState({ usd: null, eur: null, jpy: null });
  const [goldPrice, setGoldPrice] = useState(null);
  const searchTimer = useRef(null);

  const enriched = stocks.map((s) => {
    const evalAmount = s.quantity * s.currentPrice;
    const costAmount = s.quantity * s.avgPrice;
    const profitLoss = evalAmount - costAmount;
    const returnRate = costAmount > 0 ? (profitLoss / costAmount) * 100 : 0;
    return { ...s, evalAmount, costAmount, profitLoss, returnRate };
  });

  const totalEval = enriched.reduce((sum, s) => sum + s.evalAmount, 0);
  const totalCost = enriched.reduce((sum, s) => sum + s.costAmount, 0);
  const totalPL = totalEval - totalCost;
  const totalReturn = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

  async function loadStocks(rate) {
    if (!isSupabaseConfigured) { setIsLoading(false); return; }
    setIsLoading(true);
    const { data, error } = await supabase
      .from("stocks")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) {
      console.error("Supabase 불러오기 실패", error);
      setSubmitError(`DB 연결 실패: ${error.message}`);
      setIsLoading(false);
      return;
    }
    const mapped = data.map(rowToStock);
    setStocks(mapped);
    setIsLoading(false);
    if (mapped.length > 0) fetchCurrentPrices(mapped, rate);
  }

  async function fetchUsdToKrw() {
    try {
      const res = await fetch("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json");
      const d = await res.json();
      if (d?.usd?.krw) {
        const usd = d.usd.krw;
        const eur = d.usd.eur ? Math.round(usd / d.usd.eur) : null;
        const jpy = d.usd.jpy ? Math.round(usd / d.usd.jpy * 100) : null;
        setUsdToKrw(usd);
        setForexRates({ usd: Math.round(usd), eur, jpy });
        return usd;
      }
    } catch {}
    return null;
  }

  async function fetchCurrentPrices(targetStocks, rate) {
    if (!targetStocks || targetStocks.length === 0) return;
    setIsFetching(true);
    setFetchError(null);
    try {
      let successCount = 0;
      const updated = await Promise.all(
        targetStocks.map(async (s) => {
          // 6자리 숫자 티커는 시장 설정 무관하게 Naver로 조회
          const isKRX = s.market === "KOSPI" || s.market === "KOSDAQ" || /^\d{6}$/.test(s.ticker);
          try {
            if (isKRX) {
              // KIS API (실시간) → Naver 순으로 시도
              let price = 0;
              try {
                const kisRes = await fetch(`/api/kis?ticker=${encodeURIComponent(s.ticker)}`);
                const kisD = await kisRes.json();
                if (kisD.price > 0) price = kisD.price;
              } catch {}
              if (!price) {
                const navRes = await fetch(`/api/naver?type=stock&ticker=${encodeURIComponent(s.ticker)}`);
                const navD = await navRes.json();
                price = parseInt((navD.closePrice ?? "").replace(/,/g, ""), 10);
              }
              if (price > 0) { successCount++; return { ...s, currentPrice: price }; }
            } else {
              const fx = rate ?? usdToKrw;
              let usdPrice = 0;
              // Yahoo Finance (무료, 우선)
              try {
                const yRes = await fetch(`/api/yahoo/v7/finance/quote?symbols=${encodeURIComponent(s.ticker)}`);
                const yD = await yRes.json();
                const p = yD?.quoteResponse?.result?.[0]?.regularMarketPrice;
                if (p > 0) usdPrice = p;
              } catch {}
              // Twelve Data (폴백)
              if (!usdPrice && TWELVE_KEY) {
                try {
                  const tRes = await fetch(`${TWELVE_BASE}/quote?symbol=${encodeURIComponent(s.ticker)}&apikey=${TWELVE_KEY}`);
                  const tD = await tRes.json();
                  if (tD.close && !tD.code) usdPrice = parseFloat(tD.close);
                } catch {}
              }
              if (usdPrice > 0) {
                successCount++;
                return { ...s, currentPrice: Math.round(usdPrice * fx), currentPriceUsd: usdPrice };
              }
            }
          } catch {
            // 개별 실패 무시, 다음 종목 계속
          }
          return s;
        })
      );
      setStocks(updated);
      setLastUpdated(new Date());
      if (successCount === 0) {
        setFetchError("시세 조회 실패 — 티커를 확인하세요");
      } else if (isSupabaseConfigured && supabase) {
        const changed = updated.filter((s) => {
          const orig = targetStocks.find((t) => t.id === s.id);
          return orig && s.currentPrice !== orig.currentPrice && s.currentPrice > 0;
        });
        changed.forEach((s) =>
          supabase.from("stocks").update({ current_price: s.currentPrice }).eq("id", s.id)
        );
      }
    } catch {
      setFetchError("시세 조회에 실패했습니다.");
    } finally {
      setIsFetching(false);
    }
  }

  async function fetchIndices() {
    try {
      const krxIndices = INDICES.filter((i) => i.type === "krx");
      const usIndices  = INDICES.filter((i) => i.type === "us");

      const [krxResults, usData] = await Promise.all([
        Promise.all(
          krxIndices.map(async (idx) => {
            const [basicRes, chartRes] = await Promise.all([
              fetch(`/api/naver?type=index&code=${idx.symbol}`),
              fetch(`/api/naver?type=chart&symbol=${idx.symbol}&count=22`),
            ]);
            const basic = await basicRes.json();
            const chart = await chartRes.json();
            if (!basic.closePrice) return { ...idx, price: null, failed: true };
            const price = parseFloat(basic.closePrice.replace(/,/g, ""));
            const change = parseFloat((basic.compareToPreviousClosePrice ?? "0").replace(/,/g, ""));
            const changePct = parseFloat(basic.fluctuationsRatio ?? "0");
            const up = basic.compareToPreviousPrice?.code === "2";
            return { ...idx, price, change: up ? change : -change, changePct: up ? changePct : -changePct, closes: chart.closes ?? [] };
          })
        ),
        fetch("/api/us-indices").then((r) => r.json()).catch(() => ({})),
      ]);

      const usResults = usIndices.map((idx) => {
        const d = usData[idx.symbol];
        if (!d) return { ...idx, price: null, failed: true };
        return { ...idx, ...d };
      });

      setIndices([...krxResults, ...usResults]);
    } catch (e) {
      console.error("fetchIndices 오류", e);
    }
  }

  async function fetchGoldPrice() {
    try {
      const res = await fetch("/api/yahoo/v7/finance/quote?symbols=GC%3DF");
      const d = await res.json();
      const usdPerOz = d?.quoteResponse?.result?.[0]?.regularMarketPrice;
      if (usdPerOz > 0) setGoldPrice(usdPerOz);
    } catch {}
  }

  useEffect(() => {
    fetchUsdToKrw().then((rate) => loadStocks(rate));
    fetchIndices();
    fetchGoldPrice();
  }, []);

  const coloredEnriched = enriched.map((s, i) => ({
    ...s,
    pct: totalEval > 0 ? (s.evalAmount / totalEval) * 100 : 0,
    color: COLORS[i % COLORS.length],
  }));

  const sortedEnriched = coloredEnriched
    .slice()
    .sort((a, b) => b.evalAmount - a.evalAmount);

  // 그룹별 묶기: 등장 순서 유지
  const groupOrder = [];
  const groupMap = {};
  for (const s of coloredEnriched) {
    const g = s.groupName || "기타";
    if (!groupMap[g]) { groupMap[g] = []; groupOrder.push(g); }
    groupMap[g].push(s);
  }

  function validate(f) {
    const e = {};
    if (!f.name.trim()) e.name = "종목명을 입력하세요";
    if (!f.ticker.trim()) e.ticker = "티커를 입력하세요";
    if (!f.quantity || isNaN(f.quantity) || Number(f.quantity) <= 0 || Number(f.quantity) < 0.000001) e.quantity = "유효한 수량을 입력하세요";
    if (!f.avgPrice || isNaN(f.avgPrice) || Number(f.avgPrice) <= 0) e.avgPrice = "유효한 평균단가를 입력하세요";
    // 현재가는 선택 — 미입력 시 Yahoo Finance에서 자동 조회
    return e;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const errs = validate(form);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    setSubmitError(null);
    const parsed = {
      name: form.name.trim(),
      ticker: form.ticker.trim().toUpperCase(),
      market: form.market,
      quantity: Number(form.quantity),
      avgPrice: Number(form.avgPrice),
      currentPrice: Number(form.currentPrice) || 0,
      groupName: form.groupName.trim() || "기타",
    };
    let nextStocks;
    if (editingId !== null) {
      if (isSupabaseConfigured) {
        const { error } = await supabase
          .from("stocks")
          .update(stockToRow(parsed))
          .eq("id", editingId);
        if (error) {
          console.error("수정 실패", error);
          setSubmitError(`저장 실패: ${error.message}`);
          return;
        }
      }
      nextStocks = stocks.map((s) => s.id === editingId ? { ...s, ...parsed } : s);
      setEditingId(null);
    } else {
      if (isSupabaseConfigured) {
        const { data, error } = await supabase
          .from("stocks")
          .insert(stockToRow(parsed))
          .select()
          .single();
        if (error) {
          console.error("추가 실패", error);
          setSubmitError(`저장 실패: ${error.message}`);
          return;
        }
        nextStocks = [...stocks, { id: data.id, ...parsed }];
      } else {
        nextStocks = [...stocks, { id: Date.now(), ...parsed }];
      }
    }
    setStocks(nextStocks);
    setForm(EMPTY_FORM);
    setErrors({});
    setShowForm(false);
    fetchCurrentPrices(nextStocks, usdToKrw);
  }

  function handleEdit(stock) {
    setForm({
      name: stock.name,
      ticker: stock.ticker,
      market: stock.market ?? "KOSPI",
      quantity: String(stock.quantity),
      avgPrice: String(stock.avgPrice),
      currentPrice: String(stock.currentPrice),
      groupName: stock.groupName ?? "",
    });
    setEditingId(stock.id);
    setErrors({});
    setShowForm(true);
  }

  async function handleDelete(id) {
    if (isSupabaseConfigured) {
      const { error } = await supabase.from("stocks").delete().eq("id", id);
      if (error) { console.error("삭제 실패", error); return; }
    }
    setStocks(stocks.filter((s) => s.id !== id));
    if (editingId === id) { setEditingId(null); setForm(EMPTY_FORM); setShowForm(false); }
  }

  function handleCancel() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setErrors({});
    setShowForm(false);
  }

  function handleChange(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => { const e = { ...prev }; delete e[field]; return e; });
    if (field === "name") {
      setShowSuggestions(true);
      clearTimeout(searchTimer.current);
      if (value.length < 1) { setSuggestions([]); return; }
      searchTimer.current = setTimeout(async () => {
        try {
          const res = await fetch(`/api/naver?type=search&query=${encodeURIComponent(value)}`);
          const data = await res.json();
          const items = (data?.items ?? []).slice(0, 7);
          setSuggestions(items.map((q) => {
            const tc = q.typeCode ?? "";
            const market = tc === "KOSPI" ? "KOSPI" : tc === "KOSDAQ" ? "KOSDAQ" : "US";
            return { symbol: q.code, name: q.name, ticker: q.code, market, exchange: q.typeName };
          }));
        } catch { setSuggestions([]); }
      }, 250);
    }
  }

  function handleSelectSuggestion(s) {
    setForm((prev) => ({ ...prev, name: s.name, ticker: s.ticker, market: s.market }));
    setSuggestions([]);
    setShowSuggestions(false);
  }

  return (
    <div className="min-h-screen bg-slate-100 p-3 md:p-8 tracking-tight">
      <div className="max-w-6xl mx-auto flex gap-6 items-start">

        {/* 사이드바: 시장 지수 */}
        <div className="hidden md:block w-44 shrink-0">
          <div className="sticky top-8 space-y-3">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider px-1">시장 지수</p>
            {INDICES.map((idx) => {
              const d = indices.find((i) => i.symbol === idx.symbol);
              const up = d?.change >= 0;
              return (
                <div key={idx.symbol} className="bg-white rounded-2xl shadow px-4 py-3">
                  <p className="text-xs text-slate-400 mb-1">{idx.label}</p>
                  {d?.price != null ? (
                    <>
                      <p className="text-base font-bold text-slate-800">
                        {d.price.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}
                      </p>
                      <p className={`text-xs font-medium mt-0.5 ${up ? "text-red-500" : "text-blue-500"}`}>
                        {up ? "▲" : "▼"} {Math.abs(d.change).toLocaleString("ko-KR", { maximumFractionDigits: 2 })} ({up ? "+" : ""}{d.changePct.toFixed(2)}%)
                      </p>
                      {d.closes?.length > 1 && <Sparkline data={d.closes} up={up} />}
                    </>
                  ) : d?.failed ? (
                    <p className="text-xs text-red-400">조회 실패 — 콘솔 확인</p>
                  ) : (
                    <p className="text-xs text-slate-400">조회 중...</p>
                  )}
                </div>
              );
            })}
            {/* 환율 */}
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider px-1 pt-1">환율</p>
            {[
              { label: "달러 (USD)", value: forexRates.usd, unit: "1달러" },
              { label: "유로 (EUR)", value: forexRates.eur, unit: "1유로" },
              { label: "엔 (JPY)", value: forexRates.jpy, unit: "100엔" },
            ].map(({ label, value, unit }) => (
              <div key={label} className="bg-white rounded-2xl shadow px-4 py-3">
                <p className="text-xs text-slate-400 mb-1">{label}</p>
                {value ? (
                  <>
                    <p className="text-base font-bold text-slate-800 tabular-nums">
                      {value.toLocaleString("ko-KR")}원
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">{unit}</p>
                  </>
                ) : (
                  <p className="text-xs text-slate-400">조회 중...</p>
                )}
              </div>
            ))}
            {/* 금 시세 */}
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider px-1 pt-1">금 시세</p>
            <div className="bg-white rounded-2xl shadow px-4 py-3">
              <p className="text-xs text-slate-400 mb-1">금 (Gold)</p>
              {goldPrice ? (
                <>
                  <p className="text-base font-bold text-slate-800 tabular-nums">
                    {Math.round(goldPrice * usdToKrw / 31.1035).toLocaleString("ko-KR")}원
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">${goldPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })} · 1g</p>
                </>
              ) : (
                <p className="text-xs text-slate-400">조회 중...</p>
              )}
            </div>
          </div>
        </div>

        {/* 메인 콘텐츠 */}
        <div className="flex-1 min-w-0 space-y-4 md:space-y-6">

        {/* 모바일 전용: 시장 지수 가로 스크롤 스트립 */}
        <div className="md:hidden overflow-x-auto -mx-3 px-3">
          <div className="flex gap-2 pb-1" style={{ minWidth: "max-content" }}>
            {INDICES.map((idx) => {
              const d = indices.find((i) => i.symbol === idx.symbol);
              const up = d?.change >= 0;
              return (
                <div key={idx.symbol} className="bg-white rounded-xl shadow px-3 py-2 min-w-[88px]">
                  <p className="text-xs text-slate-400">{idx.label}</p>
                  {d?.price != null ? (
                    <>
                      <p className="text-sm font-bold text-slate-800 tabular-nums">
                        {d.price.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}
                      </p>
                      <p className={`text-xs font-medium ${up ? "text-red-500" : "text-blue-500"}`}>
                        {up ? "▲" : "▼"} {d.changePct.toFixed(2)}%
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-slate-400">{d?.failed ? "실패" : "조회중"}</p>
                  )}
                </div>
              );
            })}
            {[
              { label: "달러", value: forexRates.usd },
              { label: "유로", value: forexRates.eur },
              { label: "100엔", value: forexRates.jpy },
            ].map(({ label, value }) => (
              <div key={label} className="bg-white rounded-xl shadow px-3 py-2 min-w-[80px]">
                <p className="text-xs text-slate-400">{label}</p>
                {value ? (
                  <p className="text-sm font-bold text-slate-800 tabular-nums">
                    {value.toLocaleString("ko-KR")}원
                  </p>
                ) : (
                  <p className="text-xs text-slate-400">조회중</p>
                )}
              </div>
            ))}
            <div className="bg-white rounded-xl shadow px-3 py-2 min-w-[80px]">
              <p className="text-xs text-slate-400">금 1g</p>
              {goldPrice ? (
                <p className="text-sm font-bold text-slate-800 tabular-nums">
                  {Math.round(goldPrice * usdToKrw / 31.1035).toLocaleString("ko-KR")}원
                </p>
              ) : (
                <p className="text-xs text-slate-400">조회중</p>
              )}
            </div>
          </div>
        </div>

        {/* 헤더 */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl md:text-3xl font-bold text-slate-800">자산관리</h1>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${isSupabaseConfigured ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                {isSupabaseConfigured ? "● Supabase 연결됨" : "● 로컬 모드"}
              </span>
            </div>
            <p className="text-slate-500 text-xs md:text-sm mt-1">
              {lastUpdated
                ? `마지막 업데이트: ${lastUpdated.toLocaleTimeString("ko-KR")}`
                : isFetching ? "시세 조회 중..." : "내 주식 포트폴리오 현황"}
              {fetchError && <span className="text-red-400 ml-2">{fetchError}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { fetchUsdToKrw().then((rate) => fetchCurrentPrices([...stocks], rate)); fetchIndices(); }}
              disabled={isFetching}
              className="flex items-center gap-1 bg-slate-200 hover:bg-slate-300 disabled:opacity-50 text-slate-700 font-semibold px-3 py-2 rounded-xl shadow transition"
            >
              <span className={`text-base ${isFetching ? "animate-spin inline-block" : ""}`}>↻</span>
              <span className="hidden sm:inline text-sm ml-0.5">새로고침</span>
            </button>
            <button
              onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); setErrors({}); setSubmitError(null); }}
              className="flex items-center gap-1 bg-slate-900 hover:bg-slate-700 text-white font-semibold px-3 py-2 rounded-xl shadow transition"
            >
              <span className="text-base leading-none">+</span>
              <span className="sm:hidden text-sm ml-0.5">추가</span>
              <span className="hidden sm:inline text-sm ml-0.5">종목 추가</span>
            </button>
          </div>
        </div>

        

        {/* 요약 카드 */}
        <div className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center gap-3 text-xs text-slate-400 mb-2">
            <span>원금 <span className="text-slate-600 font-medium">{formatKRW(totalCost)}</span></span>
            <span>·</span>
            <span>종목 <span className="text-slate-600 font-medium">{stocks.length}개</span></span>
          </div>
          <div className="text-2xl md:text-3xl font-bold text-slate-800 tabular-nums">{formatKRW(totalEval)}</div>
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`text-sm font-semibold tabular-nums ${totalPL >= 0 ? "text-red-500" : "text-blue-500"}`}>
              {totalPL >= 0 ? "+" : ""}{formatKRW(totalPL)}
            </span>
            <span className={`text-sm font-medium ${totalReturn >= 0 ? "text-red-500" : "text-blue-500"}`}>
              ({formatPercent(totalReturn)})
            </span>
          </div>
        </div>

        {/* 종목 추가/수정 모달 */}
        {showForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" onClick={handleCancel}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl p-6" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-semibold text-slate-800">
                  {editingId !== null ? "종목 수정" : "종목 추가"}
                </h2>
                <button onClick={handleCancel} className="text-slate-400 hover:text-slate-600 transition text-xl leading-none">×</button>
              </div>
              <form onSubmit={handleSubmit} noValidate>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField label="종목명" error={errors.name}>
                    <div className="relative">
                      <input
                        type="text"
                        value={form.name}
                        onChange={(e) => handleChange("name", e.target.value)}
                        onBlur={() => setTimeout(() => setShowSuggestions(false), 300)}
                        placeholder="삼성전자"
                        className={inputClass(errors.name)}
                        autoComplete="off"
                      />
                      {showSuggestions && suggestions.length > 0 && (
                        <ul className="absolute z-20 w-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-52 overflow-y-auto">
                          {suggestions.map((s) => (
                            <li
                              key={s.symbol}
                              onMouseDown={(e) => { e.preventDefault(); handleSelectSuggestion(s); }}
                              onTouchEnd={(e) => { e.preventDefault(); handleSelectSuggestion(s); }}
                              className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-slate-50 text-sm"
                            >
                              <span className="font-medium text-slate-800 truncate">{s.name}</span>
                              <span className="ml-2 text-xs text-slate-400 shrink-0">{s.ticker} · {s.market}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="text"
                        value={form.ticker}
                        onChange={(e) => handleChange("ticker", e.target.value)}
                        placeholder="티커 (자동입력)"
                        className={`flex-1 border rounded-lg px-2.5 py-1.5 text-xs outline-none transition focus:ring-2 ${errors.ticker ? "border-red-400 focus:ring-red-200" : "border-slate-200 focus:border-slate-400 focus:ring-slate-100"} text-slate-600`}
                      />
                      <select
                        value={form.market}
                        onChange={(e) => handleChange("market", e.target.value)}
                        className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-600 outline-none focus:ring-2 focus:border-slate-400 focus:ring-slate-100"
                      >
                        <option value="KOSPI">KOSPI</option>
                        <option value="KOSDAQ">KOSDAQ</option>
                        <option value="US">미국</option>
                      </select>
                    </div>
                    {errors.ticker && <p className="text-xs text-red-500 mt-1">{errors.ticker}</p>}
                  </FormField>
                  <FormField label="수량 (주)" error={errors.quantity}>
                    <input
                      type="number"
                      value={form.quantity}
                      onChange={(e) => handleChange("quantity", e.target.value)}
                      placeholder="100"
                      min="0.000001"
                      step="any"
                      className={inputClass(errors.quantity)}
                    />
                  </FormField>
                  <FormField label="평균단가 (원)" error={errors.avgPrice}>
                    <input
                      type="number"
                      value={form.avgPrice}
                      onChange={(e) => handleChange("avgPrice", e.target.value)}
                      placeholder="65000"
                      min="1"
                      className={inputClass(errors.avgPrice)}
                    />
                  </FormField>
                  <FormField label="그룹">
                    <input
                      type="text"
                      list="group-list"
                      value={form.groupName}
                      onChange={(e) => handleChange("groupName", e.target.value)}
                      placeholder="예: 성장주, 배당주, ETF"
                      className={inputClass(false)}
                    />
                    <datalist id="group-list">
                      {[...new Set(stocks.map((s) => s.groupName).filter(Boolean))].map((g) => (
                        <option key={g} value={g} />
                      ))}
                    </datalist>
                  </FormField>
                </div>
                {submitError && (
                  <p className="mt-4 text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{submitError}</p>
                )}
                <div className="flex gap-3 mt-5">
                  <button
                    type="submit"
                    className="flex-1 bg-slate-900 hover:bg-slate-700 text-white font-semibold py-2.5 rounded-xl transition"
                  >
                    {editingId !== null ? "수정 완료" : "추가"}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-2.5 rounded-xl transition"
                  >
                    취소
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* 그룹 필터 버튼 */}
        {groupOrder.length > 1 && (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setSelectedGroup(null)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${
                selectedGroup === null
                  ? "bg-slate-900 text-white shadow"
                  : "bg-white text-slate-600 hover:bg-slate-100 shadow"
              }`}
            >
              전체
            </button>
            {groupOrder.map((g) => (
              <button
                key={g}
                onClick={() => setSelectedGroup(g)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${
                  selectedGroup === g
                    ? "bg-slate-900 text-white shadow"
                    : "bg-white text-slate-600 hover:bg-slate-100 shadow"
                }`}
              >
                {g}
              </button>
            ))}
          </div>
        )}

        {/* 종목 테이블 */}
        <div className="bg-white rounded-2xl shadow overflow-hidden">
          <div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left text-xs px-3 md:px-4 py-3 font-semibold text-slate-400">종목</th>
                  <th className="hidden text-xs md:table-cell text-right px-4 py-3 font-semibold text-slate-400">현재가</th>
                  <th className="text-right text-xs px-3 md:px-4 py-3 font-semibold text-slate-400">
                    <span className="hidden md:inline">평가금액 / 손익 / 수익률</span>
                    <span className="md:hidden">평가 / 손익</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={3} className="text-center py-12 text-slate-400">
                      데이터 불러오는 중...
                    </td>
                  </tr>
                ) : enriched.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-center py-12 text-slate-400">
                      종목을 추가해보세요
                    </td>
                  </tr>
                ) : (
                  (selectedGroup ? [selectedGroup] : groupOrder).map((group) => {
                    const rows = groupMap[group];
                    const gEval = rows.reduce((s, r) => s + r.evalAmount, 0);
                    const gCost = rows.reduce((s, r) => s + r.costAmount, 0);
                    const gPL   = gEval - gCost;
                    const gRet  = gCost > 0 ? (gPL / gCost) * 100 : 0;
                    return (
                      <React.Fragment key={group}>
                        {/* 그룹 헤더 */}
                        <tr className="bg-slate-50 border-t border-slate-200">
                          <td colSpan={3} className="px-3 md:px-4 py-2">
                            <div className="flex items-center justify-between">
                              <div>
                                <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">{group}</span>
                                <span className="ml-2 text-xs text-slate-400">{rows.length}종목</span>
                              </div>
                              <div className="text-right tabular-nums whitespace-nowrap">
                                <div className="text-xs font-semibold text-slate-700">{formatKRW(gEval)}</div>
                                <div className={`text-[11px] font-semibold ${gPL >= 0 ? "text-red-500" : "text-blue-500"}`}>
                                  {gPL >= 0 ? "+" : ""}{Math.round(gPL).toLocaleString()}원 ({formatPercent(gRet)})
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                        {/* 종목 행 */}
                        {rows.map((s) => {
                          const isExpanded = expandedId === s.id;
                          return (
                            <React.Fragment key={s.id}>
                              <tr
                                className="border-b border-slate-100 hover:bg-slate-50 transition cursor-pointer select-none"
                                onClick={() => setExpandedId(isExpanded ? null : s.id)}
                              >
                                <td className="px-4" >
                                  <div className="flex items-center gap-2">
                                    {/* <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} /> */}
                                    <div>
                                      <div className="font-semibold text-slate-800 md:whitespace-nowrap leading-snug">{s.name}</div>
                                      <div className="text-xs text-slate-400">
                                        {s.quantity.toLocaleString()}주
                                        </div>
                                    </div>
                                    <svg className={`ml-1 w-3.5 h-3.5 text-slate-400 transition-transform shrink-0 ${isExpanded ? "rotate-180" : ""}`} viewBox="0 0 20 20" fill="currentColor">
                                      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                                    </svg>
                                  </div>
                                </td>
                                <td className="hidden md:table-cell px-4 py-3 text-right text-slate-700 tabular-nums whitespace-nowrap">
                                  <div>{Math.round(s.currentPrice).toLocaleString()}원</div>
                                  {s.currentPriceUsd && (
                                    <div className="text-xs text-slate-400">${s.currentPriceUsd.toFixed(2)}</div>
                                  )}
                                </td>
                                <td className="px-3 md:px-4 py-3 text-right tabular-nums whitespace-nowrap">
                                  <div className="font-medium text-slate-800">{formatKRW(s.evalAmount)}</div>
                                  <div className="flex items-center gap-1 justify-end">
                                    <div className={`text-[11px] font-medium ${s.profitLoss >= 0 ? "text-red-500" : "text-blue-500"}`}>
                                      {s.profitLoss >= 0 ? "+" : ""}{Math.round(s.profitLoss).toLocaleString()}원
                                    </div>
                                    <div className={`text-[11px] font-semibold ${s.returnRate >= 0 ? "text-red-500" : "text-blue-500"}`}>
                                      ({formatPercent(s.returnRate)})
                                    </div>
                                  </div>
                                </td>
                              </tr>
                              {/* 상세 펼침 행 */}
                              {isExpanded && (
                                <tr className="bg-slate-50 border-b border-slate-100">
                                  <td colSpan={3} className="px-6 md:px-8 py-2.5">
                                    <div className="flex items-center gap-4 text-xs text-slate-600">
                                      <span><span className="text-slate-400">티커</span> {s.ticker}</span>
                                      <span className="md:hidden">
                                        <span className="text-slate-400">현재가</span> {Math.round(s.currentPrice).toLocaleString()}원
                                        {s.currentPriceUsd && <span className="text-slate-400 ml-1">(${s.currentPriceUsd.toFixed(2)})</span>}
                                      </span>
                                      <span><span className="text-slate-400">평균단가</span> {Math.round(s.avgPrice).toLocaleString()}원</span>
                                      <div className="ml-auto flex gap-1">
                                        <button
                                          onClick={(e) => { e.stopPropagation(); handleEdit(s); }}
                                          className="text-xs text-indigo-600 hover:text-indigo-800 font-medium px-2 py-1 rounded hover:bg-indigo-100 transition"
                                        >수정</button>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); setConfirmDelete({ id: s.id, name: s.name }); }}
                                          className="text-xs text-red-500 hover:text-red-700 font-medium px-2 py-1 rounded hover:bg-red-100 transition"
                                        >삭제</button>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
              {enriched.length > 0 && (
                <tfoot>
                  {/* <tr className="bg-slate-50 border-t-2 border-slate-200 font-semibold">
                    <td className="px-3 md:px-4 py-3 text-slate-700" colSpan={2}>합계</td>
                    <td className="px-3 md:px-4 py-3 text-right tabular-nums whitespace-nowrap">
                      <div className="text-slate-800">{formatKRW(totalEval)}</div>
                      <div className="flex items-center gap-1 justify-end">
                        <div className={`text-[11px] font-medium ${totalPL >= 0 ? "text-red-500" : "text-blue-500"}`}>
                          {totalPL >= 0 ? "+" : ""}{Math.round(totalPL).toLocaleString()}원
                        </div>
                        <div className={`text-[11px] font-semibold ${totalReturn >= 0 ? "text-red-500" : "text-blue-500"}`}>
                          {formatPercent(totalReturn)}
                        </div>
                      </div>
                    </td>
                  </tr> */}
                </tfoot>
              )}
            </table>
          </div>
        </div>

        {/* 삭제 확인 모달 */}
        {confirmDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => setConfirmDelete(null)}>
            <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-base font-semibold text-slate-800 mb-1">종목 삭제</h3>
              <p className="text-sm text-slate-500 mb-5">
                <span className="font-medium text-slate-700">{confirmDelete.name}</span>을(를) 삭제하시겠습니까?<br />
                삭제 후 복구할 수 없습니다.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="px-4 py-2 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition"
                >취소</button>
                <button
                  onClick={() => { handleDelete(confirmDelete.id); setConfirmDelete(null); }}
                  className="px-4 py-2 text-sm rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 transition"
                >삭제</button>
              </div>
            </div>
          </div>
        )}

        {/* 포트폴리오 비중 차트 */}
        {enriched.length > 0 && (
          <div className="bg-white rounded-2xl shadow p-5">
            <h2 className="text-base font-semibold text-slate-700 mb-4">포트폴리오 비중</h2>
            <div className="flex flex-col md:flex-row items-center gap-8">
              <div className="w-44 h-44 shrink-0">
                <PieChart slices={sortedEnriched} />
              </div>
              <div className="flex-1 w-full space-y-2.5">
                {sortedEnriched.map((s) => (
                  <div key={s.id} className="flex items-center gap-3">
                    <span
                      className="inline-block w-3 h-3 rounded-sm shrink-0"
                      style={{ backgroundColor: s.color }}
                    />
                    <span className="text-sm font-medium text-slate-700 w-20 truncate shrink-0">{s.name}</span>
                    <div className="flex-1 bg-slate-100 rounded-full h-1.5 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: s.pct + "%", backgroundColor: s.color }}
                      />
                    </div>
                    <span className="text-sm font-semibold text-slate-700 w-12 text-right shrink-0">{s.pct.toFixed(1)}%</span>
                    <span className="text-sm text-slate-500 w-28 text-right shrink-0 hidden sm:block">{formatKRW(s.evalAmount)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <p className="text-center text-xs text-slate-400 pb-4">
          * 한국 주식은 Naver Finance, 미국 주식은 Twelve Data 기준으로 현재가를 불러옵니다.
        </p>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color, sub, subColor }) {
  return (
    <div className="bg-white rounded-2xl shadow p-3 md:p-4">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className={`text-sm md:text-lg font-bold ${color} tabular-nums`}>{value}</p>
      {sub && <p className={`text-xs font-medium mt-0.5 ${subColor}`}>{sub}</p>}
    </div>
  );
}

function FormField({ label, error, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-600 mb-1">{label}</label>
      {children}
      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  );
}

function inputClass(hasError) {
  return `w-full border rounded-lg px-3 py-2 text-sm outline-none transition focus:ring-2 ${
    hasError
      ? "border-red-400 focus:ring-red-200"
      : "border-slate-300 focus:border-indigo-400 focus:ring-indigo-100"
  }`;
}

function Sparkline({ data, up }) {
  const w = 120, h = 36;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * (h - 4) - 2}`)
    .join(" ");
  const color = up ? "#ef4444" : "#3b82f6";
  const fillId = `fill-${up ? "up" : "dn"}`;
  const first = `0,${h}`;
  const last = `${w},${h}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-9 mt-2" preserveAspectRatio="none">
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`${first} ${points} ${last}`} fill={`url(#${fillId})`} />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function PieChart({ slices }) {
  const size = 200;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = 82;
  const innerR = 50;

  if (slices.length === 1) {
    return (
      <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-full">
        <circle cx={cx} cy={cy} r={outerR} fill={slices[0].color} />
        <circle cx={cx} cy={cy} r={innerR} fill="white" />
      </svg>
    );
  }

  let cumAngle = -Math.PI / 2;
  const paths = slices.map((s) => {
    const angle = (s.pct / 100) * 2 * Math.PI;
    const startAngle = cumAngle;
    const endAngle = cumAngle + angle;
    cumAngle = endAngle;

    const x1 = cx + outerR * Math.cos(startAngle);
    const y1 = cy + outerR * Math.sin(startAngle);
    const x2 = cx + outerR * Math.cos(endAngle);
    const y2 = cy + outerR * Math.sin(endAngle);
    const x3 = cx + innerR * Math.cos(endAngle);
    const y3 = cy + innerR * Math.sin(endAngle);
    const x4 = cx + innerR * Math.cos(startAngle);
    const y4 = cy + innerR * Math.sin(startAngle);

    const largeArc = angle > Math.PI ? 1 : 0;
    const d = `M ${x1} ${y1} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4} ${y4} Z`;
    return { d, color: s.color };
  });

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-full">
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill={p.color} stroke="white" strokeWidth="2" />
      ))}
    </svg>
  );
}
