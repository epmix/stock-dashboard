export default async function handler(req, res) {
  const parts = Array.isArray(req.query.path) ? req.query.path : [req.query.path];
  const { path: _, ...params } = req.query;
  const qs = new URLSearchParams(params).toString();
  const url = `https://query1.finance.yahoo.com/${parts.join("/")}${qs ? "?" + qs : ""}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Origin": "https://finance.yahoo.com",
        "Referer": "https://finance.yahoo.com/",
      },
    });

    if (!response.ok) {
      res.status(response.status).json({ error: `Yahoo Finance returned ${response.status}` });
      return;
    }

    const data = await response.json();
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: "Yahoo Finance fetch failed", detail: e.message });
  }
}
