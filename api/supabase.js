export default async function handler(req, res) {
  // Only allow GET requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  var table = req.query.table;
  var query = req.query.query || "select=*";

  if (!table) {
    return res.status(400).json({ error: "Missing 'table' parameter" });
  }

  // Whitelist of allowed tables/views to prevent abuse
  var allowed = [
    "leaderboard",
    "team_stats_view",
    "match_view",
    "roster_view",
    "standings_view",
    "series_map_view",
    "match_stats_view",
    "map_stats_view",
    "teams",
    "events"
  ];

  if (allowed.indexOf(table) === -1) {
    return res.status(403).json({ error: "Table not allowed" });
  }

  var url = process.env.SUPABASE_URL + "/rest/v1/" + table + "?" + query;

  try {
    var response = await fetch(url, {
      headers: {
        "apikey": process.env.SUPABASE_KEY,
        "Authorization": "Bearer " + process.env.SUPABASE_KEY
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "Supabase returned " + response.status });
    }

    var data = await response.json();

    // Cache for 60 seconds to reduce Supabase calls
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Proxy fetch failed" });
  }
}
