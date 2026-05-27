const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://finance.naver.com/",
};

export default async function handler(req, res) {
  const { type, ticker, code, symbol, count = "22", query } = req.query;

  res.setHeader("Access-Control-Allow-Origin", "*");

  // 종목 검색 자동완성
  if (type === "search") {
    if (!query) return res.status(400).json({ error: "query required" });
    try {
      const r = await fetch(
        `https://ac.stock.naver.com/ac?q=${encodeURIComponent(query)}&target=stock,overseas_stock`,
        { headers: HEADERS }
      );
      const data = await r.json();
      res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
      return res.status(200).json(data);
    } catch (e) {
      return res.status(502).json({ error: "search failed", detail: e.message });
    }
  }

  let url;
  if (type === "stock") {
    url = `https://m.stock.naver.com/api/stock/${ticker}/basic`;
  } else if (type === "index") {
    url = `https://m.stock.naver.com/api/index/${code}/basic`;
  } else if (type === "chart") {
    url = `https://fchart.stock.naver.com/sise.nhn?symbol=${symbol}&timeframe=day&count=${count}&requestType=0`;
  } else {
    return res.status(400).json({ error: "invalid type" });
  }

  try {
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) return res.status(r.status).json({ error: `naver ${r.status}` });

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (type === "chart") {
      const xml = await r.text();
      // parse: <item data="DATE|OPEN|HIGH|LOW|CLOSE|VOLUME" />
      const closes = [...xml.matchAll(/<item data="[^|]+\|[^|]+\|[^|]+\|[^|]+\|([^|]+)\|[^"]*"/g)]
        .map((m) => parseFloat(m[1]));
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
      return res.status(200).json({ closes });
    }

    const data = await r.json();
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: "fetch failed", detail: e.message });
  }
}
