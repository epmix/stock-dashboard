export default async function handler(req, res) {
  const parts = Array.isArray(req.query.path) ? req.query.path : [req.query.path];
  const { path: _, ...params } = req.query;
  const qs = new URLSearchParams(params).toString();
  const url = `https://query1.finance.yahoo.com/${parts.join("/")}${qs ? "?" + qs : ""}`;

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible)" },
    });
    const data = await response.json();
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(response.status).json(data);
  } catch {
    res.status(502).json({ error: "Yahoo Finance fetch failed" });
  }
}
