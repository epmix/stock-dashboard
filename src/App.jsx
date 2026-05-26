import { useState, useEffect, useRef } from "react";
import { supabase, isSupabaseConfigured, rowToStock, stockToRow } from "./supabase";

const INDICES = [
  { symbol: "^KS11",  label: "코스피" },
  { symbol: "^KQ11",  label: "코스닥" },
  { symbol: "^IXIC",  label: "나스닥" },
  { symbol: "^GSPC",  label: "S&P 500" },
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
};

function toYahooSymbol(ticker, market) {
  if (market === "KOSPI") return ticker + ".KS";
  if (market === "KOSDAQ") return ticker + ".KQ";
  return ticker;
}

function formatKRW(value) {
  return value.toLocaleString("ko-KR") + "원";
}

function formatPercent(value) {
  return (value >= 0 ? "+" : "") + value.toFixed(2) + "%";
}

export default function App() {
  const [stocks, setStocks] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [errors, setErrors] = useState({});
  const [isFetching, setIsFetching] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [indices, setIndices] = useState([]);
  const [submitError, setSubmitError] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
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

  async function loadStocks() {
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
    if (mapped.length > 0) fetchCurrentPrices(mapped);
  }

  async function fetchCurrentPrices(targetStocks) {
    if (!targetStocks || targetStocks.length === 0) return;
    setIsFetching(true);
    setFetchError(null);
    try {
      let successCount = 0;
      const updated = await Promise.all(
        targetStocks.map(async (s) => {
          const symbol = toYahooSymbol(s.ticker, s.market ?? "KOSPI");
          try {
            const res = await fetch(`/api/yahoo/v8/finance/chart/${symbol}?interval=1d&range=1d`);
            if (!res.ok) return s;
            const data = await res.json();
            const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
            if (price) { successCount++; return { ...s, currentPrice: Math.round(price) }; }
            return s;
          } catch {
            return s;
          }
        })
      );
      setStocks(updated);
      setLastUpdated(new Date());
      if (successCount === 0) setFetchError("시세 조회 실패 — Yahoo Finance 응답 없음");
    } catch {
      setFetchError("시세 조회에 실패했습니다.");
    } finally {
      setIsFetching(false);
    }
  }

  async function fetchIndices() {
    try {
      const results = await Promise.all(
        INDICES.map(async (idx) => {
          try {
            const url = `/api/yahoo/v8/finance/chart/${encodeURIComponent(idx.symbol)}?interval=1d&range=1mo`;
            const res = await fetch(url);
            if (!res.ok) {
              console.error(`[${idx.label}] HTTP ${res.status}`, url);
              return { ...idx, price: null, failed: true };
            }
            const data = await res.json();
            const result = data?.chart?.result?.[0];
            const meta = result?.meta;
            if (!meta) {
              console.error(`[${idx.label}] meta 없음`, data);
              return { ...idx, price: null, failed: true };
            }
            const price = meta.regularMarketPrice;
            const prev = meta.chartPreviousClose;
            const change = price - prev;
            const changePct = (change / prev) * 100;
            const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter(v => v != null);
            return { ...idx, price, change, changePct, closes };
          } catch (e) {
            console.error(`[${idx.label}] fetch 오류`, e);
            return { ...idx, price: null, failed: true };
          }
        })
      );
      setIndices(results);
    } catch (e) {
      console.error("fetchIndices 전체 오류", e);
    }
  }

  useEffect(() => {
    loadStocks();
    fetchIndices();
  }, []);

  const sortedEnriched = enriched
    .slice()
    .sort((a, b) => b.evalAmount - a.evalAmount)
    .map((s) => ({
      ...s,
      pct: totalEval > 0 ? (s.evalAmount / totalEval) * 100 : 0,
      color: COLORS[enriched.findIndex((x) => x.id === s.id) % COLORS.length],
    }));

  function validate(f) {
    const e = {};
    if (!f.name.trim()) e.name = "종목명을 입력하세요";
    if (!f.ticker.trim()) e.ticker = "티커를 입력하세요";
    if (!f.quantity || isNaN(f.quantity) || Number(f.quantity) <= 0) e.quantity = "유효한 수량을 입력하세요";
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
    fetchCurrentPrices(nextStocks);
  }

  function handleEdit(stock) {
    setForm({
      name: stock.name,
      ticker: stock.ticker,
      market: stock.market ?? "KOSPI",
      quantity: String(stock.quantity),
      avgPrice: String(stock.avgPrice),
      currentPrice: String(stock.currentPrice),
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
          const res = await fetch(
            `/api/yahoo/v1/finance/search?q=${encodeURIComponent(value)}&lang=ko-KR&region=KR&quotesCount=6&newsCount=0`
          );
          const data = await res.json();
          const quotes = (data?.quotes ?? []).filter((q) => q.quoteType === "EQUITY");
          setSuggestions(quotes.map((q) => {
            const sym = q.symbol;
            let ticker = sym, market = "US";
            if (sym.endsWith(".KS")) { ticker = sym.replace(".KS", ""); market = "KOSPI"; }
            else if (sym.endsWith(".KQ")) { ticker = sym.replace(".KQ", ""); market = "KOSDAQ"; }
            return { symbol: sym, name: q.shortname || q.longname || sym, ticker, market };
          }));
        } catch { setSuggestions([]); }
      }, 300);
    }
  }

  function handleSelectSuggestion(s) {
    setForm((prev) => ({ ...prev, name: s.name, ticker: s.ticker, market: s.market }));
    setSuggestions([]);
    setShowSuggestions(false);
  }

  return (
    <div className="min-h-screen bg-slate-100 p-4 md:p-8">
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
          </div>
        </div>

        {/* 메인 콘텐츠 */}
        <div className="flex-1 min-w-0 space-y-6">

        {/* 헤더 */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl md:text-3xl font-bold text-slate-800">포트폴리오 대시보드</h1>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${isSupabaseConfigured ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                {isSupabaseConfigured ? "● Supabase 연결됨" : "● 로컬 모드"}
              </span>
            </div>
            <p className="text-slate-500 text-sm mt-1">
              {lastUpdated
                ? `마지막 업데이트: ${lastUpdated.toLocaleTimeString("ko-KR")}`
                : isFetching ? "시세 조회 중..." : "내 주식 포트폴리오 현황"}
              {fetchError && <span className="text-red-400 ml-2">{fetchError}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { fetchCurrentPrices([...stocks]); fetchIndices(); }}
              disabled={isFetching}
              className="flex items-center gap-1.5 bg-slate-200 hover:bg-slate-300 disabled:opacity-50 text-slate-700 font-semibold px-4 py-2 rounded-xl shadow transition"
            >
              <span className={isFetching ? "animate-spin inline-block" : ""}>↻</span>
              새로고침
            </button>
            <button
              onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); setErrors({}); setSubmitError(null); }}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-4 py-2 rounded-xl shadow transition"
            >
              <span className="text-lg leading-none">+</span> 종목 추가
            </button>
          </div>
        </div>

        

        {/* 요약 카드 */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <SummaryCard label="총 종목 수" value={stocks.length + "개"} color="text-slate-700" />
          <SummaryCard label="총 원금" value={formatKRW(totalCost)} color="text-slate-700" />
          <SummaryCard label="총 평가금액" value={formatKRW(totalEval)} color="text-slate-700" />
          <SummaryCard
            label="총 손익"
            value={formatKRW(totalPL)}
            color={totalPL >= 0 ? "text-red-500" : "text-blue-500"}
            sub={formatPercent(totalReturn)}
            subColor={totalReturn >= 0 ? "text-red-400" : "text-blue-400"}
          />
          <SummaryCard
            label="총 수익률"
            value={formatPercent(totalReturn)}
            color={totalReturn >= 0 ? "text-red-500" : "text-blue-500"}
          />
        </div>

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

        {/* 종목 추가/수정 폼 */}
        {showForm && (
          <div className="bg-white rounded-2xl shadow p-5">
            <h2 className="text-base font-semibold text-slate-700 mb-4">
              {editingId !== null ? "종목 수정" : "종목 추가"}
            </h2>
            <form onSubmit={handleSubmit} noValidate>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                <FormField label="종목명" error={errors.name}>
                  <div className="relative">
                    <input
                      type="text"
                      value={form.name}
                      onChange={(e) => handleChange("name", e.target.value)}
                      onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                      placeholder="삼성전자"
                      className={inputClass(errors.name)}
                      autoComplete="off"
                    />
                    {showSuggestions && suggestions.length > 0 && (
                      <ul className="absolute z-20 w-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-52 overflow-y-auto">
                        {suggestions.map((s) => (
                          <li
                            key={s.symbol}
                            onMouseDown={() => handleSelectSuggestion(s)}
                            className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-indigo-50 text-sm"
                          >
                            <span className="font-medium text-slate-800 truncate">{s.name}</span>
                            <span className="ml-2 text-xs text-slate-400 shrink-0">{s.ticker} · {s.market}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </FormField>
                <FormField label="티커" error={errors.ticker}>
                  <input
                    type="text"
                    value={form.ticker}
                    onChange={(e) => handleChange("ticker", e.target.value)}
                    placeholder="005930"
                    className={inputClass(errors.ticker)}
                  />
                </FormField>
                <FormField label="시장">
                  <select
                    value={form.market}
                    onChange={(e) => handleChange("market", e.target.value)}
                    className={inputClass(false)}
                  >
                    <option value="KOSPI">KOSPI</option>
                    <option value="KOSDAQ">KOSDAQ</option>
                    <option value="US">미국 (NYSE/NASDAQ)</option>
                  </select>
                </FormField>
                <FormField label="수량 (주)" error={errors.quantity}>
                  <input
                    type="number"
                    value={form.quantity}
                    onChange={(e) => handleChange("quantity", e.target.value)}
                    placeholder="100"
                    min="1"
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
                <FormField label="현재가 (원)" error={errors.currentPrice}>
                  <input
                    type="number"
                    value={form.currentPrice}
                    onChange={(e) => handleChange("currentPrice", e.target.value)}
                    placeholder="72000"
                    min="1"
                    className={inputClass(errors.currentPrice)}
                  />
                </FormField>
              </div>
              {submitError && (
                <p className="mt-4 text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{submitError}</p>
              )}
              <div className="flex gap-3 mt-4">
                <button
                  type="submit"
                  className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-6 py-2 rounded-xl transition"
                >
                  {editingId !== null ? "수정 완료" : "추가"}
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="bg-slate-200 hover:bg-slate-300 text-slate-700 font-semibold px-6 py-2 rounded-xl transition"
                >
                  취소
                </button>
              </div>
            </form>
          </div>
        )}

        {/* 종목 테이블 */}
        <div className="bg-white rounded-2xl shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-4 py-3 font-semibold text-slate-600">종목</th>
                  <th className="text-right px-4 py-3 font-semibold text-slate-600">수량</th>
                  <th className="text-right px-4 py-3 font-semibold text-slate-600">평균단가</th>
                  <th className="text-right px-4 py-3 font-semibold text-slate-600">현재가</th>
                  <th className="text-right px-4 py-3 font-semibold text-slate-600">평가금액</th>
                  <th className="text-right px-4 py-3 font-semibold text-slate-600">손익</th>
                  <th className="text-right px-4 py-3 font-semibold text-slate-600">수익률</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={8} className="text-center py-12 text-slate-400">
                      데이터 불러오는 중...
                    </td>
                  </tr>
                ) : enriched.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-12 text-slate-400">
                      종목을 추가해보세요
                    </td>
                  </tr>
                ) : (
                  enriched.map((s, i) => (
                    <tr
                      key={s.id}
                      className="border-b border-slate-100 hover:bg-slate-50 transition"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: COLORS[i % COLORS.length] }}
                          />
                          <div>
                            <div className="font-semibold text-slate-800">{s.name}</div>
                            <div className="text-xs text-slate-400">{s.ticker}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-700">{s.quantity.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{s.avgPrice.toLocaleString()}원</td>
                      <td className="px-4 py-3 text-right text-slate-700">{s.currentPrice.toLocaleString()}원</td>
                      <td className="px-4 py-3 text-right font-medium text-slate-800">{formatKRW(s.evalAmount)}</td>
                      <td className={`px-4 py-3 text-right font-medium ${s.profitLoss >= 0 ? "text-red-500" : "text-blue-500"}`}>
                        {s.profitLoss >= 0 ? "+" : ""}{s.profitLoss.toLocaleString()}원
                      </td>
                      <td className={`px-4 py-3 text-right font-semibold ${s.returnRate >= 0 ? "text-red-500" : "text-blue-500"}`}>
                        {formatPercent(s.returnRate)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 justify-end">
                          <button
                            onClick={() => handleEdit(s)}
                            className="text-xs text-indigo-600 hover:text-indigo-800 font-medium px-2 py-1 rounded hover:bg-indigo-50 transition"
                          >
                            수정
                          </button>
                          <button
                            onClick={() => handleDelete(s.id)}
                            className="text-xs text-red-500 hover:text-red-700 font-medium px-2 py-1 rounded hover:bg-red-50 transition"
                          >
                            삭제
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {enriched.length > 0 && (
                <tfoot>
                  <tr className="bg-slate-50 border-t-2 border-slate-200 font-semibold">
                    <td className="px-4 py-3 text-slate-700" colSpan={4}>합계</td>
                    <td className="px-4 py-3 text-right text-slate-800">{formatKRW(totalEval)}</td>
                    <td className={`px-4 py-3 text-right ${totalPL >= 0 ? "text-red-500" : "text-blue-500"}`}>
                      {totalPL >= 0 ? "+" : ""}{totalPL.toLocaleString()}원
                    </td>
                    <td className={`px-4 py-3 text-right ${totalReturn >= 0 ? "text-red-500" : "text-blue-500"}`}>
                      {formatPercent(totalReturn)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>

        <p className="text-center text-xs text-slate-400 pb-4">
          * 현재가는 Yahoo finance에서 자동으로 불러온 값을 기준으로 계산됩니다.
        </p>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color, sub, subColor }) {
  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
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
