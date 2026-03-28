// /api/reddit.js — Vercel serverless function
// Proxies Reddit's public JSON API to avoid CORS issues.
// No API key needed — uses Reddit's public .json endpoints.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  var sort = req.query.sort || "hot";
  var limit = Math.min(parseInt(req.query.limit) || 25, 50);

  var url = "https://old.reddit.com/r/CoDCompetitive/" + sort + ".json?limit=" + limit + "&raw_json=1";

  try {
    var response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; BarracksCDL/2.0; +https://thebarracks.vercel.app)",
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      console.error("Reddit returned status:", response.status);
      return res.status(200).json({ posts: [], error: "Reddit returned " + response.status });
    }

    var text = await response.text();
    var json;
    try {
      json = JSON.parse(text);
    } catch (parseErr) {
      console.error("Reddit JSON parse error:", parseErr.message, "Body preview:", text.slice(0, 200));
      return res.status(200).json({ posts: [], error: "Invalid JSON from Reddit" });
    }

    if (!json.data || !json.data.children) {
      console.error("Unexpected Reddit response shape:", JSON.stringify(json).slice(0, 300));
      return res.status(200).json({ posts: [], error: "Unexpected response shape" });
    }

    var posts = [];
    for (var i = 0; i < json.data.children.length; i++) {
      var c = json.data.children[i];
      var d = c.data;
      if (!d) continue;
      if (d.stickied) continue;

      posts.push({
        id: d.id || "",
        title: d.title || "",
        author: d.author || "[deleted]",
        score: d.score || 0,
        numComments: d.num_comments || 0,
        url: d.permalink ? "https://reddit.com" + d.permalink : "",
        created: d.created_utc || 0,
        flair: d.link_flair_text || "",
        thumbnail: (d.thumbnail && d.thumbnail.startsWith("http")) ? d.thumbnail : null,
        isLink: d.is_self === false,
        domain: d.domain || "",
        selftext: (d.selftext || "").slice(0, 200)
      });
    }

    return res.status(200).json({ posts: posts });
  } catch (err) {
    console.error("Reddit proxy error:", err.message || err);
    return res.status(200).json({ posts: [], error: err.message || "Fetch failed" });
  }
}
