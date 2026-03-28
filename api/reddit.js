// /api/reddit.js — Vercel serverless function
// Proxies Reddit's public JSON API to avoid CORS issues.
// No API key needed — uses Reddit's public .json endpoints.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600"); // 5min CDN cache

  var sort = req.query.sort || "hot";
  var limit = Math.min(parseInt(req.query.limit) || 25, 50);

  var url = "https://www.reddit.com/r/CoDCompetitive/" + sort + ".json?limit=" + limit + "&raw_json=1";

  try {
    var response = await fetch(url, {
      headers: {
        "User-Agent": "Barracks/1.0 (CDL Stats App)"
      }
    });

    if (!response.ok) {
      return res.status(200).json({ posts: [] });
    }

    var json = await response.json();
    var posts = (json.data && json.data.children || []).map(function(c) {
      var d = c.data;
      if (!d || d.stickied) return null;
      return {
        id: d.id,
        title: d.title || "",
        author: d.author || "",
        score: d.score || 0,
        numComments: d.num_comments || 0,
        url: "https://reddit.com" + d.permalink,
        created: d.created_utc || 0,
        flair: d.link_flair_text || "",
        thumbnail: (d.thumbnail && d.thumbnail.indexOf("http") === 0) ? d.thumbnail : null,
        isLink: d.is_self === false,
        domain: d.domain || "",
        selftext: (d.selftext || "").slice(0, 200)
      };
    }).filter(Boolean);

    return res.status(200).json({ posts: posts });
  } catch (err) {
    console.error("Reddit proxy error:", err);
    return res.status(200).json({ posts: [] });
  }
}
