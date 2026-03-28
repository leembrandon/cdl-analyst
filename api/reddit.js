// /api/reddit.js — Vercel serverless function to proxy Reddit RSS feeds
// Avoids CORS issues by fetching server-side and returning parsed JSON.

export default async function handler(req, res) {
  // Allowed subreddits — whitelist to prevent abuse
  const ALLOWED_SUBS = ["CoDCompetitive", "CallOfDuty"];
  const DEFAULT_SORT = "hot";
  const ALLOWED_SORTS = ["hot", "new", "top", "rising"];

  const sub = req.query.sub || "CoDCompetitive";
  const sort = req.query.sort || DEFAULT_SORT;
  const limit = Math.min(parseInt(req.query.limit) || 25, 50);

  if (!ALLOWED_SUBS.includes(sub)) {
    return res.status(400).json({ error: "Subreddit not allowed" });
  }
  if (!ALLOWED_SORTS.includes(sort)) {
    return res.status(400).json({ error: "Invalid sort" });
  }

  const url = `https://www.reddit.com/r/${sub}/${sort}.rss?limit=${limit}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Barracks-CDL-App/1.0",
        Accept: "application/rss+xml, application/xml, text/xml",
      },
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: "Reddit returned " + response.status });
    }

    const xml = await response.text();

    // Parse Atom feed (Reddit returns Atom, not RSS)
    const entries = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;

    while ((match = entryRegex.exec(xml)) !== null) {
      const entry = match[1];
      const get = (tag) => {
        const m = entry.match(
          new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`)
        );
        if (m) return m[1];
        const m2 = entry.match(
          new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)
        );
        return m2 ? m2[1] : "";
      };

      const getAttr = (tag, attr) => {
        const m = entry.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*/>`));
        if (m) return m[1];
        const m2 = entry.match(
          new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*>`)
        );
        return m2 ? m2[1] : "";
      };

      const title = get("title")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"');

      const content = get("content");
      const link = getAttr("link", "href");
      const updated = get("updated");
      const author = get("name");
      const id = get("id");
      const category = getAttr("category", "term");

      // Try to extract a thumbnail from the content HTML
      let thumbnail = "";
      // Decode HTML entities first so we can find real img tags
      const decodedContent = content
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"');
      const imgMatch = decodedContent.match(/<img[^>]+src="([^"]+)"/);
      if (imgMatch) {
        thumbnail = imgMatch[1];
      }

      // Extract a text preview from content — decode entities, strip all HTML, clean up
      let preview = decodedContent
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
      // Skip previews that are just "[link]" or "[comments]" or too short
      if (preview.length < 10 || /^\[link\]/.test(preview)) preview = "";
      preview = preview.slice(0, 300);

      entries.push({
        id,
        title,
        link,
        updated,
        author,
        category,
        thumbnail,
        preview,
      });
    }

    // Cache for 5 minutes
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({ subreddit: sub, sort, entries });
  } catch (e) {
    console.error("Reddit proxy error:", e);
    res.status(500).json({ error: "Failed to fetch Reddit feed" });
  }
}
