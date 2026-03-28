// /api/reddit.js — Vercel serverless function to proxy Reddit JSON API
// Returns rich post data including scores, comments, flairs, and images.

export default async function handler(req, res) {
  const ALLOWED_SUBS = ["CoDCompetitive", "CallOfDuty"];
  const ALLOWED_SORTS = ["hot", "new", "top", "rising"];

  const sub = req.query.sub || "CoDCompetitive";
  const sort = req.query.sort || "hot";
  const limit = Math.min(parseInt(req.query.limit) || 25, 50);

  if (!ALLOWED_SUBS.includes(sub)) {
    return res.status(400).json({ error: "Subreddit not allowed" });
  }
  if (!ALLOWED_SORTS.includes(sort)) {
    return res.status(400).json({ error: "Invalid sort" });
  }

  const url = `https://www.reddit.com/r/${sub}/${sort}.json?limit=${limit}&raw_json=1`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Barracks-CDL-App/1.0",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: "Reddit returned " + response.status });
    }

    const data = await response.json();
    const entries = (data.data?.children || []).map((child) => {
      const p = child.data;

      // Get the best available image URL
      let thumbnail = "";
      // 1. Try preview image (highest quality, already decoded with raw_json=1)
      const previewImg = p.preview?.images?.[0]?.source?.url || "";
      if (previewImg) {
        thumbnail = previewImg;
      }
      // 2. Fallback to thumbnail if it's a real URL
      else if (p.thumbnail && p.thumbnail.startsWith("http")) {
        thumbnail = p.thumbnail.replace(/&amp;/g, "&");
      }

      // Clean selftext preview
      let preview = (p.selftext || "").replace(/\n+/g, " ").trim();
      if (preview.length > 300) preview = preview.slice(0, 300) + "...";
      // Strip markdown formatting for cleaner preview
      preview = preview
        .replace(/#{1,6}\s/g, "")
        .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\|/g, " ")
        .replace(/-{3,}/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (preview.length < 10) preview = "";

      return {
        id: p.id,
        title: p.title,
        author: p.author,
        score: p.score,
        upvoteRatio: p.upvote_ratio,
        numComments: p.num_comments,
        url: p.url,
        permalink: "https://www.reddit.com" + p.permalink,
        preview,
        flair: p.link_flair_text || "",
        createdUtc: p.created_utc,
        isSelf: p.is_self,
        thumbnail,
        postHint: p.post_hint || "",
        isVideo: p.is_video || false,
        stickied: p.stickied || false,
      };
    });

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({ subreddit: sub, sort, entries });
  } catch (e) {
    console.error("Reddit proxy error:", e);
    res.status(500).json({ error: "Failed to fetch Reddit feed" });
  }
}
