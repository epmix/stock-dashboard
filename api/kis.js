const BASE = "https://openapi.koreainvestment.com:9443";

let _token = "";
let _tokenAt = 0;
const TOKEN_TTL = 23 * 60 * 60 * 1000;

async function getToken(appKey, appSecret) {
  if (_token && Date.now() - _tokenAt < TOKEN_TTL) return _token;
  const r = await fetch(`${BASE}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: appKey, appsecret: appSecret }),
  });
  if (!r.ok) throw new Error(`KIS token ${r.status}`);
  const d = await r.json();
  if (!d.access_token) throw new Error(d.error_description ?? "no access_token");
  _token = d.access_token;
  _tokenAt = Date.now();
  return _token;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;

  if (!appKey || !appSecret) {
    return res.status(503).json({ error: "KIS_APP_KEY / KIS_APP_SECRET not configured" });
  }

  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  try {
    const token = await getToken(appKey, appSecret);
    const r = await fetch(
      `${BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${encodeURIComponent(ticker)}`,
      {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: "FHKST01010100",
          custtype: "P",
        },
      }
    );
    if (!r.ok) throw new Error(`KIS price ${r.status}`);
    const d = await r.json();
    const price = parseInt(d.output?.stck_prpr, 10);
    if (!price || price <= 0) throw new Error(d.msg1 ?? "invalid price");
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
    return res.status(200).json({ price });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
