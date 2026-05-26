const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 모듈 수준에서 세션 캐싱 (cold start 간 재사용)
let _cookie = "";
let _crumb = "";
let _sessionAt = 0;
const SESSION_TTL = 45 * 60 * 1000; // 45분

async function getSession() {
  if (_crumb && Date.now() - _sessionAt < SESSION_TTL) return { cookie: _cookie, crumb: _crumb };

  // 1) Yahoo Finance 홈 접근 → 세션 쿠키 획득
  const r1 = await fetch("https://finance.yahoo.com", {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
  });

  const cookies = [];
  r1.headers.forEach((v, k) => {
    if (k.toLowerCase() === "set-cookie") cookies.push(v.split(";")[0]);
  });
  _cookie = cookies.join("; ");

  // 2) crumb 획득
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

export default async function handler(req, res) {
  const parts = Array.isArray(req.query.path) ? req.query.path : [req.query.path];
  const { path: _, ...params } = req.query;

  try {
    const { cookie, crumb } = await getSession();
    if (crumb) params.crumb = crumb;

    const qs = new URLSearchParams(params).toString();
    const url = `https://query1.finance.yahoo.com/${parts.join("/")}${qs ? "?" + qs : ""}`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
        Referer: "https://finance.yahoo.com/",
        Cookie: cookie,
      },
    });

    if (!response.ok) {
      // crumb 만료 시 세션 초기화 후 1회 재시도
      if (response.status === 401 || response.status === 403) {
        _crumb = "";
        _sessionAt = 0;
      }
      res.status(response.status).json({ error: `Yahoo ${response.status}` });
      return;
    }

    const data = await response.json();
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: "fetch failed", detail: e.message });
  }
}
