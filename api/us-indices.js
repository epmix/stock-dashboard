const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let _cookie = "";
let _crumb = "";
let _sessionAt = 0;
const SESSION_TTL = 45 * 60 * 1000;

async function getSession() {
  if (_crumb && Date.now() - _sessionAt < SESSION_TTL) return { cookie: _cookie, crumb: _crumb };
  const r1 = await fetch("https://finance.yahoo.com", {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
  });
  const cookies = [];
  r1.headers.forEach((v, k) => {
    if (k.toLowerCase() === "set-cookie") cookies.push(v.split(";")[0]);
  });
  _cookie = cookies.join("; ");
  const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: _cookie },
  });
  const crumb = (await r2.text()).trim();
  if (crumb && crumb.length < 30 && !crumb.startsWith("<")) {
    _crumb = crumb;
    _sessionAt = Date.now();
  }
  return { cookie: _cookie, crumb: _crumb };
}

async function fromStooq(stooqSym) {
  const r = await fetch(
    `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=json`,
    { headers: { "User-Agent": UA } }
  );
  const d = await r.json();
  const s = d.symbols?.[0];
  if (!s) return null;
  const change = s.close - s.open;
  const changePct = (change / s.open) * 100;
  return { price: s.close, change, changePct, closes: [] };
}

const SYMBOLS = [
  { key: "IXIC", yahoo: "%5EIXIC", stooq: "^ndq" },
  { key: "SPX",  yahoo: "%5EGSPC", stooq: "^spx" },
];

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const result = {};

  try {
    const { cookie, crumb } = await getSession();
    await Promise.all(
      SYMBOLS.map(async ({ key, yahoo, stooq }) => {
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahoo}?interval=1d&range=1mo${crumb ? `&crumb=${crumb}` : ""}`;
          const r = await fetch(url, {
            headers: {
              "User-Agent": UA,
              Cookie: cookie,
              Accept: "application/json",
              Referer: "https://finance.yahoo.com/",
            },
          });
          if (!r.ok) throw new Error(`yahoo ${r.status}`);
          const d = await r.json();
          const chartResult = d.chart?.result?.[0];
          if (!chartResult) throw new Error("no result");
          const price = chartResult.meta.regularMarketPrice;
          const prevClose = chartResult.meta.chartPreviousClose;
          const change = price - prevClose;
          const changePct = (change / prevClose) * 100;
          const closes = (chartResult.indicators?.quote?.[0]?.close ?? []).filter((v) => v != null);
          result[key] = { price, change, changePct, closes };
        } catch {
          result[key] = await fromStooq(stooq);
        }
      })
    );
  } catch {
    await Promise.all(
      SYMBOLS.map(async ({ key, stooq }) => {
        result[key] = await fromStooq(stooq);
      })
    );
  }

  res.status(200).json(result);
}
