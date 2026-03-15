export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }
  // Only allow requests to approved domains
  const allowed = [
    "https://www.breakingpoint.gg/",
    "https://dfpiiufxcciujugzjvgx.supabase.co/",
  ];
  if (!allowed.some(domain => url.startsWith(domain))) {
    return res.status(403).json({ error: "Domain not allowed" });
  }
  try {
    const headers = {
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Referer": "https://www.breakingpoint.gg/",
      "Origin": "https://www.breakingpoint.gg",
    };
    // Supabase requires the apikey header
    if (url.includes("supabase.co")) {
      const urlObj = new URL(url);
      const apikey = urlObj.searchParams.get("apikey");
      if (apikey) {
        headers["apikey"] = apikey;
      }
    }
    const response = await fetch(url, { headers });
    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream error: ${response.status}` });
    }
    const data = await response.json();
    // Cache for 5 minutes
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
