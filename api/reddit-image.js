// /api/reddit-image.js — Vercel serverless function to proxy Reddit preview images
// Reddit's preview CDN blocks cross-origin requests, so we fetch server-side and pipe through.

export default async function handler(req, res) {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  // Only allow proxying Reddit image domains
  const allowed = [
    "preview.redd.it",
    "external-preview.redd.it",
    "i.redd.it",
    "a.thumbs.redditmedia.com",
    "b.thumbs.redditmedia.com",
    "styles.redditmedia.com",
  ];

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (!allowed.includes(parsed.hostname)) {
    return res.status(403).json({ error: "Domain not allowed" });
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Barracks-CDL-App/1.0",
        Accept: "image/*",
      },
    });

    if (!response.ok) {
      return res.status(response.status).end();
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await response.arrayBuffer());

    // Cache for 1 hour
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=7200");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", buffer.length);
    res.status(200).send(buffer);
  } catch (e) {
    console.error("Image proxy error:", e);
    res.status(500).end();
  }
}
