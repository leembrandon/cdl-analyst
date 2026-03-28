import { useState, useEffect, useMemo, useCallback } from "react"; 
import { Analytics } from "@vercel/analytics/react";

const CURRENT_EVENT_ID = 102;

async function mySupaFetch(table, query) {
  var url = "/api/supabase?table=" + encodeURIComponent(table) + "&query=" + encodeURIComponent(query || "select=*");
  var res = await fetch(url);
  if (!res.ok) throw new Error("Supabase fetch failed (" + res.status + ")");
  return res.json();
}

// ─── DATA FETCHING ───────────────────────────────────────────
// Views return joined data with names — no manual lookups needed.

async function fetchPlayers() {
  // Leaderboard is the one denormalized table — has gamertag, team_name, etc.
  return mySupaFetch("leaderboard", "select=*");
}

async function fetchTeams() {
  // team_stats_view joins team_stats + teams (gives team_name, team_abbr, team_color)
  return mySupaFetch("team_stats_view", "select=*");
}

async function fetchMatches() {
  // match_view joins matches + teams + events (gives team names, event names)
   return mySupaFetch("match_view", "select=*&status=neq.completed&event_is_cdl=eq.true&order=scheduled_at.asc");
}

async function fetchResults() {
  // All completed CDL matches — most recent first
  return mySupaFetch("match_view", "select=*&status=eq.completed&event_is_cdl=eq.true&order=scheduled_at.desc");
}

async function fetchSeriesMaps(matchId) {
  // Map-by-map breakdown for a completed series
  return mySupaFetch("series_map_view", "select=*&match_id=eq." + matchId + "&order=map_number.asc");
}

async function fetchMatchPlayerStats(matchId) {
  // Per-player series totals for a specific match
  return mySupaFetch("match_stats_view", "select=*&match_id=eq." + matchId);
}

async function fetchMatchMapStats(matchId) {
  // Per-player per-map stats for a specific match
  return mySupaFetch("map_stats_view", "select=*&match_id=eq." + matchId + "&order=map_number.asc");
}

async function fetchRosters() {
  // roster_view joins rosters + players + teams + roles
  var rows = await mySupaFetch("roster_view", "select=*");
  // Group into team objects for buildAnalysis
  var teamMap = {};
  rows.forEach(function(r) {
    if (!teamMap[r.team_id]) {
      teamMap[r.team_id] = {
        id: r.team_id,
        name: r.team_name,
        name_short: r.team_abbr,
        color_hex: r.team_color,
        players: []
      };
    }
    teamMap[r.team_id].players.push({
      id: r.player_id,
      name: r.gamertag,
      role: r.role_name,
      retired: false
    });
  });
  return Object.values(teamMap);
}

async function fetchStandings(eventId) {
  // standings_view joins standings + teams + events
  var filter = eventId ? "event_id=eq." + eventId : "event_id=is.null";
  return mySupaFetch("standings_view", "select=*&season_id=eq.2026&" + filter + "&order=rank.asc");
}

async function fetchPlayerMatchStats(playerId) {
  // Fetch per-series stats from match_stats_view (for Maps 1-3 Kills + Series K/D)
  return mySupaFetch("match_stats_view", "select=*&player_id=eq." + playerId + "&event_is_cdl=eq.true&order=scheduled_at.desc&limit=30");
}

async function fetchPlayerMapStats(playerId) {
  // Fetch per-map stats from map_stats_view (for Map 1/2/3 individual lines)
  return mySupaFetch("map_stats_view", "select=*&player_id=eq." + playerId + "&event_is_cdl=eq.true&order=scheduled_at.desc,map_number.asc&limit=150");
}

// ─── HELPERS ─────────────────────────────────────────────────

var s = function(obj, key, def) { if (def === undefined) def = 0; return (obj && obj[key] != null) ? obj[key] : def; };

function utcToET(dt) {
  try {
    var d = new Date(dt);
    return d.toLocaleString("en-US", {timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
  } catch(e) { return dt; }
}

function timeUntil(dt) {
  var d = new Date(dt) - new Date();
  if (d < 0) return "LIVE";
  var h = Math.floor(d / 3600000);
  var m = Math.floor((d % 3600000) / 60000);
  if (h > 24) return Math.floor(h / 24) + "d " + (h % 24) + "h";
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
}

function kdColor(kd) {
  if (kd >= 1.05) return "#52b788";
  if (kd >= 1.0) return "#a3be8c";
  if (kd >= 0.95) return "#ffd166";
  return "#ff6b6b";
}

function winPct(wins, losses) {
  var total = (wins || 0) + (losses || 0);
  return total > 0 ? ((wins || 0) / total) * 100 : 0;
}

// ─── PICKS STORAGE ───────────────────────────────────────────

var PICKS_KEY = "barracks_picks";

function loadPicks() {
  try {
    var raw = localStorage.getItem(PICKS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch(e) { return {}; }
}

function savePicks(picks) {
  try { localStorage.setItem(PICKS_KEY, JSON.stringify(picks)); } catch(e) {}
}

function encodePicksParam(picks) {
  // Format: matchId.teamId.score|matchId.teamId.score|...
  var parts = [];
  Object.keys(picks).forEach(function(matchId) {
    var p = picks[matchId];
    if (p && p.teamId && p.score) {
      parts.push(matchId + "." + p.teamId + "." + p.score);
    }
  });
  return parts.join("|");
}

function decodePicksParam(param) {
  var picks = {};
  if (!param) return picks;
  param.split("|").forEach(function(part) {
    var segs = part.split(".");
    if (segs.length === 3) {
      picks[segs[0]] = {teamId: Number(segs[1]), score: segs[2]};
    }
  });
  return picks;
}

// ─── BUILD ANALYSIS ──────────────────────────────────────────
// Views give us names already, so this is much simpler than v1.

function buildAnalysis(players, teams, matches, rosters, seasonStandings, majorStandings, completedMatches) {
  var teamLookup = {}, teamPlayers = {}, playerTeam = {}, playerStats = {}, playerRoles = {};

  rosters.forEach(function(t) {
    teamLookup[t.id] = {name: t.name, short: t.name_short, color: t.color_hex || "#888"};
    var active = (t.players || []).filter(function(p) { return !p.retired; });
    teamPlayers[t.id] = active;
    active.forEach(function(p) {
      playerTeam[p.id] = {teamName: t.name, teamShort: t.name_short, teamId: t.id};
      playerRoles[p.id] = p.role || "";
    });
  });

  // Players from leaderboard already have team_name, team_abbr, role
  players.forEach(function(p) {
    var pid = p.player_id;
    var i = playerTeam[pid] || {};
    p.team_name = p.team_name || i.teamName || "";
    p.team_short = p.team_abbr || i.teamShort || "";
    p.team_id = p.team_id || i.teamId;
    p.role = p.role || playerRoles[pid] || "";
    // Map new column names to what UI components expect
    p.player_tag = p.gamertag;
    playerStats[pid] = p;
  });

  // Teams from team_stats_view already have team_name, team_abbr, team_color
  var teamStats = {};
  teams.forEach(function(t) {
    var tid = t.team_id;
    var i = teamLookup[tid] || {};
    t.team_name = t.team_name || i.name || ("Team " + tid);
    t.team_short = t.team_abbr || i.short || "";
    t.team_color = t.team_color || i.color || "#888";
    // Compute win percentages from W-L counts
    t.hp_win_pct = winPct(t.hp_wins, t.hp_losses);
    t.snd_win_pct = winPct(t.snd_wins, t.snd_losses);
    t.ovl_win_pct = winPct(t.ovl_wins, t.ovl_losses);
    teamStats[tid] = t;
  });

  var rosterStats = function(tid) {
    return (teamPlayers[tid] || []).map(function(p) { return playerStats[p.id]; }).filter(Boolean);
  };

  var standingsLookup = {}, majorStandingsLookup = {};
  (seasonStandings || []).forEach(function(st) { standingsLookup[st.team_id] = st; });
  (majorStandings || []).forEach(function(st) { majorStandingsLookup[st.team_id] = st; });

  // Power rankings
  var power = Object.values(teamStats).map(function(ts) {
    var tid = ts.team_id, kd = s(ts, "kd");
    var hpW = ts.hp_win_pct, sndW = ts.snd_win_pct, ovlW = ts.ovl_win_pct;
    var avgWin = (hpW + sndW + ovlW) / 3;
    var rs = rosterStats(tid);
    var star = rs.reduce(function(b, p) { return s(p, "kd") > s(b, "kd") ? p : b; }, rs[0] || {});
    var score = (kd * 25) + (avgWin * 0.3) + (s(ts, "hp_score_diff") * 0.08) + (s(ts, "snd_round_diff") * 1.5) + (s(ts, "ovl_score_diff") * 0.5);
    var st = standingsLookup[tid] || {};
    return {tid: tid, name: ts.team_name, short: ts.team_short, color: ts.team_color, score: score, kd: kd, avgWin: avgWin, hpW: hpW, sndW: sndW, ovlW: ovlW, star: (star && star.gamertag) || "", starKd: s(star, "kd"), matchWins: st.series_wins || 0, matchLosses: st.series_losses || 0, points: st.cdl_points || 0, standingRank: st.rank || 99};
  }).sort(function(a, b) { return b.score - a.score; });
  var powerLookup = {};
  power.forEach(function(p) { powerLookup[p.tid] = p; });

  // Top performers
  var allPs = Object.values(playerStats).filter(function(p) { return p.team_id; });
  var topKd = allPs.slice().sort(function(a, b) { return s(b, "kd") - s(a, "kd"); }).slice(0, 5);
  var topHpK = allPs.slice().sort(function(a, b) { return s(b, "hp_kills_per_10m") - s(a, "hp_kills_per_10m"); }).slice(0, 5);
  var topSndKpr = allPs.slice().sort(function(a, b) { return s(b, "snd_kills_per_round") - s(a, "snd_kills_per_round"); }).slice(0, 5);

  // Matchups — match_view gives us team names and event names directly
  var known = matches.filter(function(m) { return m.home_team_id && m.away_team_id; });
  var seen = {};
  var matchups = [];
  known.forEach(function(m) {
    var key = Math.min(m.home_team_id, m.away_team_id) + "-" + Math.max(m.home_team_id, m.away_team_id) + "-" + (m.event_id);
    if (seen[key]) return;
    seen[key] = true;
    var t1 = teamStats[m.home_team_id] || {}, t2 = teamStats[m.away_team_id] || {};
    var p1 = powerLookup[m.home_team_id] || {}, p2 = powerLookup[m.away_team_id] || {};
    var edge = Math.abs((p1.score || 0) - (p2.score || 0));
    var favored = (p1.score || 0) >= (p2.score || 0) ? (m.home_team_abbr || "?") : (m.away_team_abbr || "?");

    var t1Obj = {name: m.home_team_name || "", name_short: m.home_team_abbr || ""};
    var t2Obj = {name: m.away_team_name || "", name_short: m.away_team_abbr || ""};
    var evObj = {id: m.event_id, name: m.event_name || "", name_short: m.event_short_name || ""};

    matchups.push({id: m.id, datetime: m.scheduled_at, bestOf: m.best_of, t1: t1Obj, t2: t2Obj, event: evObj, round: m.round_name, t1Stats: t1, t2Stats: t2, t1Roster: rosterStats(m.home_team_id), t2Roster: rosterStats(m.away_team_id), p1: p1, p2: p2, edge: edge, favored: favored, home_team_id: m.home_team_id, away_team_id: m.away_team_id});
  });

  // Completed match results — match_view gives us team names and scores
  var results = (completedMatches || []).map(function(m) {
    if (!m.home_team_id || !m.away_team_id) return null;
    var winnerId = m.winner_id;
    var homeWon = winnerId === m.home_team_id;
    var awayWon = winnerId === m.away_team_id;
    return {
      id: m.id,
      datetime: m.scheduled_at,
      bestOf: m.best_of,
      homeScore: m.home_score || 0,
      awayScore: m.away_score || 0,
      winnerId: winnerId,
      homeWon: homeWon,
      awayWon: awayWon,
      home: {id: m.home_team_id, name: m.home_team_name || "", short: m.home_team_abbr || "", color: m.home_team_color || "#888", logo: m.home_team_logo},
      away: {id: m.away_team_id, name: m.away_team_name || "", short: m.away_team_abbr || "", color: m.away_team_color || "#888", logo: m.away_team_logo},
      event: {id: m.event_id, name: m.event_name || "", short: m.event_short_name || ""}
    };
  }).filter(Boolean);

  return {power: power, matchups: matchups, results: results, teamStats: teamStats, playerStats: allPs, rosterStats: rosterStats, topKd: topKd, topHpK: topHpK, topSndKpr: topSndKpr, teamLookup: teamLookup, teamPlayers: teamPlayers, powerLookup: powerLookup, standingsLookup: standingsLookup, majorStandingsLookup: majorStandingsLookup, seasonStandings: seasonStandings || [], majorStandings: majorStandings || []};
}

// ─── UI COMPONENTS ───────────────────────────────────────────

function Stat(props) {
  var label = props.label, value = props.value, fmt = props.fmt || "0.00", color = props.color;
  var d;
  if (typeof value === "number") {
    if (fmt === "pct") d = value.toFixed(1) + "%";
    else if (fmt === "int") d = Math.round(value);
    else if (fmt === "0.0") d = value.toFixed(1);
    else d = value.toFixed(2);
  } else { d = value; }
  return <div className="flex flex-col items-center"><span style={{fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.5px", opacity: 0.5}}>{label}</span><span className="font-bold" style={{color: color || "inherit", fontSize: "15px"}}>{d}</span></div>;
}

function KdBadge(props) {
  var kd = props.kd, size = props.size || "lg";
  var cls = size === "sm" ? "font-mono font-bold text-sm" : "font-mono font-bold text-lg";
  return <span className={cls} style={{color: kdColor(kd)}}>{kd.toFixed(2)}</span>;
}

function RoleBadge(props) {
  var role = props.role;
  if (!role) return null;
  var c = {AR: "#53a8b6", SMG: "#e94560", Flex: "#ffd166"};
  return <span className="text-xs px-1.5 py-0.5 rounded ml-1.5" style={{background: "rgba(255,255,255,0.08)", color: c[role] || "#888", fontSize: "10px"}}>{role}</span>;
}

function H2HRow(props) {
  var label = props.label, v1 = props.v1, v2 = props.v2, fmt = props.fmt || "0.00", higherBetter = props.higherBetter !== false;
  var f = function(v) { return fmt === "pct" ? v.toFixed(1) + "%" : fmt === "0.0" ? v.toFixed(1) : v.toFixed(2); };
  var c1 = higherBetter ? (v1 > v2 ? "#52b788" : v1 < v2 ? "#ff6b6b" : "#ffd166") : (v1 < v2 ? "#52b788" : v1 > v2 ? "#ff6b6b" : "#ffd166");
  var c2 = higherBetter ? (v2 > v1 ? "#52b788" : v2 < v1 ? "#ff6b6b" : "#ffd166") : (v2 < v1 ? "#52b788" : v2 > v1 ? "#ff6b6b" : "#ffd166");
  return <div className="grid grid-cols-3 items-center py-1.5" style={{borderBottom: "1px solid rgba(255,255,255,0.03)"}}><div className="text-right pr-3 font-semibold text-sm" style={{color: c1}}>{f(v1)}</div><div className="text-center text-xs uppercase tracking-wider opacity-40">{label}</div><div className="text-left pl-3 font-semibold text-sm" style={{color: c2}}>{f(v2)}</div></div>;
}

function PlayerRow(props) {
  var p = props.p;
  var matches = s(p, "matches_played");
  return <div className="py-2" style={{borderBottom: "1px solid rgba(255,255,255,0.03)"}}>
    <div className="flex items-center gap-1 mb-1.5"><span className="text-sm font-medium text-white">{p.gamertag || p.player_tag}</span><RoleBadge role={p.role} /><span className="text-xs px-1.5 py-0.5 rounded ml-1" style={{background: "rgba(255,255,255,0.05)", color: "#555", fontSize: "9px"}}>{matches} matches</span></div>
    <div className="grid grid-cols-4 gap-2 pl-1">
      <div><div style={{fontSize: "9px", color: "#555"}}>K/D</div><div className="text-sm font-bold" style={{color: kdColor(s(p, "kd"))}}>{s(p, "kd").toFixed(2)}</div></div>
      <div><div style={{fontSize: "9px", color: "#555"}}>HP K/10</div><div className="text-sm font-semibold">{s(p, "hp_kills_per_10m").toFixed(1)}</div></div>
      <div><div style={{fontSize: "9px", color: "#555"}}>SnD KPR</div><div className="text-sm font-semibold">{s(p, "snd_kills_per_round").toFixed(2)}</div></div>
      <div><div style={{fontSize: "9px", color: "#555"}}>OVL K/10</div><div className="text-sm font-semibold">{s(p, "ovl_kills_per_10m").toFixed(1)}</div></div>
    </div>
  </div>;
}

function TeamRosterBlock(props) {
  return <div><div className="flex items-center gap-2 mb-2 mt-1"><div className="w-1 h-4 rounded" style={{background: props.teamColor}} /><span className="text-xs font-bold text-white uppercase tracking-wider">{props.teamName}</span></div>{(props.roster || []).map(function(p) { return <PlayerRow key={p.player_id} p={p} />; })}</div>;
}

function WhosHot(props) {
  var [cat, setCat] = useState("kd");
  var list = cat === "kd" ? props.topKd : cat === "hp" ? props.topHpK : props.topSndKpr;
  var valFn = cat === "kd" ? function(p) { return s(p, "kd").toFixed(2); } : cat === "hp" ? function(p) { return s(p, "hp_kills_per_10m").toFixed(1); } : function(p) { return s(p, "snd_kills_per_round").toFixed(2); };
  var labelMap = {kd: "K/D", hp: "HP K/10m", snd: "SnD KPR"};
  return <div className="rounded-xl p-4 mb-6" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}}>
    <div className="flex items-center justify-between mb-3">
      <span className="text-sm font-bold text-white">Top performers</span>
      <div className="flex gap-1">{["kd", "hp", "snd"].map(function(c) { return <button key={c} onClick={function() { setCat(c); }} className="px-2 py-1 rounded text-xs font-semibold" style={{background: cat === c ? "rgba(233,69,96,0.2)" : "rgba(255,255,255,0.05)", color: cat === c ? "#e94560" : "#666"}}>{labelMap[c]}</button>; })}</div>
    </div>
    {list.map(function(p, i) { return <div key={p.player_id} className="flex items-center gap-3 py-1.5" style={{borderBottom: i < list.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none"}}>
      <span className="text-xs font-bold w-5" style={{color: i < 3 ? "#e94560" : "#555"}}>{i + 1}</span>
      <span className="text-sm font-medium text-white flex-1">{p.gamertag}</span>
      <span className="text-xs opacity-40">{p.team_abbr || p.team_short}</span>
      <span className="text-sm font-bold" style={{color: kdColor(cat === "kd" ? s(p, "kd") : 1.05)}}>{valFn(p)}</span>
    </div>; })}
  </div>;
}

function PowerRankings(props) {
  return <div className="space-y-2">{props.power.map(function(t, i) {
    return <div key={t.tid} className="p-3 rounded-lg" style={{background: i % 2 === 0 ? "rgba(255,255,255,0.03)" : "transparent"}}>
      <div className="flex items-center gap-3 mb-2">
        <div className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0" style={{background: i < 3 ? "#e94560" : i < 6 ? "#53a8b6" : "rgba(255,255,255,0.1)", color: i < 6 ? "#fff" : "#888"}}>{i + 1}</div>
        <div className="w-3 h-8 rounded-sm flex-shrink-0" style={{background: t.color}} />
        <div className="flex-1 min-w-0"><div className="font-bold text-white truncate">{t.name}</div><div className="text-xs opacity-50">{t.matchWins}-{t.matchLosses} · Star: {t.star} ({t.starKd.toFixed(2)})</div></div>
      </div>
      <div className="grid grid-cols-3 gap-2 pl-12">
        <Stat label="Power" value={t.score} fmt="0.0" color={i < 4 ? "#52b788" : "#c8c8d0"} />
        <Stat label="K/D" value={t.kd} />
        <Stat label="Win%" value={t.avgWin} fmt="pct" />
      </div>
    </div>;
  })}</div>;
}

function MatchCard(props) {
  var mu = props.mu, onTeamClick = props.onTeamClick;
  var [expanded, setExpanded] = useState(false);
  var t1S = (mu.t1 && mu.t1.name_short) || "?";
  var t2S = (mu.t2 && mu.t2.name_short) || "?";
  var cd = timeUntil(mu.datetime);
  return <div className="rounded-xl overflow-hidden" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}}>
    <div className="p-4 cursor-pointer" onClick={function() { setExpanded(!expanded); }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase tracking-wider opacity-40">{(mu.event && mu.event.name_short) || ""} · {((mu.round && mu.round) || "").trim()} · Bo{mu.bestOf}</span>
        <span className="text-xs px-2 py-0.5 rounded-full" style={{background: cd === "LIVE" ? "#e94560" : "rgba(255,255,255,0.08)", color: cd === "LIVE" ? "#fff" : "#888"}}>{cd === "LIVE" ? "LIVE" : cd}</span>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><div className="w-2 h-8 rounded" style={{background: (mu.t1Stats && mu.t1Stats.team_color) || "#888"}} /><span className="font-bold text-xl text-white">{t1S}</span></div>
        <div className="flex flex-col items-center"><span className="text-xs opacity-30">vs</span><span className="text-xs mt-0.5" style={{color: "#52b788"}}>{"\u25B8"} {mu.favored}</span></div>
        <div className="flex items-center gap-2"><span className="font-bold text-xl text-white">{t2S}</span><div className="w-2 h-8 rounded" style={{background: (mu.t2Stats && mu.t2Stats.team_color) || "#888"}} /></div>
      </div>
      <div className="flex justify-between mt-3 text-xs opacity-50"><span>{utcToET(mu.datetime)}</span><span>Edge: {mu.edge.toFixed(1)}</span><span>{expanded ? "\u25B2 collapse" : "\u25BC matchup details"}</span></div>
    </div>
    {expanded && <div>
      <div className="px-4 pb-3 pt-1" style={{borderTop: "1px solid rgba(255,255,255,0.05)"}}>
        <div className="text-xs uppercase tracking-wider opacity-40 mb-2">Team comparison</div>
        <div className="grid grid-cols-3 items-center pb-1 mb-1" style={{borderBottom: "1px solid rgba(255,255,255,0.06)"}}>
          <div className="text-right pr-3 text-xs font-bold cursor-pointer hover:underline" style={{color: (mu.t1Stats && mu.t1Stats.team_color) || "#888"}} onClick={function(e) { e.stopPropagation(); onTeamClick(mu.t1Stats && mu.t1Stats.team_id); }}>{t1S}</div>
          <div className="text-center text-xs opacity-30">vs</div>
          <div className="text-left pl-3 text-xs font-bold cursor-pointer hover:underline" style={{color: (mu.t2Stats && mu.t2Stats.team_color) || "#888"}} onClick={function(e) { e.stopPropagation(); onTeamClick(mu.t2Stats && mu.t2Stats.team_id); }}>{t2S}</div>
        </div>
        <H2HRow label="K/D" v1={s(mu.t1Stats, "kd")} v2={s(mu.t2Stats, "kd")} />
        <H2HRow label="HP Win%" v1={mu.t1Stats.hp_win_pct || 0} v2={mu.t2Stats.hp_win_pct || 0} fmt="pct" />
        <H2HRow label="SnD Win%" v1={mu.t1Stats.snd_win_pct || 0} v2={mu.t2Stats.snd_win_pct || 0} fmt="pct" />
        <H2HRow label="OVL Win%" v1={mu.t1Stats.ovl_win_pct || 0} v2={mu.t2Stats.ovl_win_pct || 0} fmt="pct" />
        <H2HRow label="HP Diff" v1={s(mu.t1Stats, "hp_score_diff")} v2={s(mu.t2Stats, "hp_score_diff")} fmt="0.0" />
        <H2HRow label="SnD Diff" v1={s(mu.t1Stats, "snd_round_diff")} v2={s(mu.t2Stats, "snd_round_diff")} fmt="0.0" />
      </div>
      <div className="px-4 pb-4 pt-1" style={{borderTop: "1px solid rgba(255,255,255,0.05)"}}>
        <div className="text-xs uppercase tracking-wider opacity-40 mb-3">Player stats</div>
        <TeamRosterBlock teamName={t1S} teamColor={mu.t1Stats && mu.t1Stats.team_color} roster={mu.t1Roster || []} />
        <div className="mt-3" />
        <TeamRosterBlock teamName={t2S} teamColor={mu.t2Stats && mu.t2Stats.team_color} roster={mu.t2Roster || []} />
      </div>
    </div>}
  </div>;
}

function ResultCard(props) {
  var r = props.result, onTeamClick = props.onTeamClick, analysis = props.analysis;
  var [expanded, setExpanded] = useState(false);
  var [maps, setMaps] = useState(null);
  var [seriesStats, setSeriesStats] = useState(null);
  var [mapPlayerStats, setMapPlayerStats] = useState(null);
  var [detailLoading, setDetailLoading] = useState(false);
  var [activeMap, setActiveMap] = useState(null);
  var [sharing, setSharing] = useState(false);

  var winnerShort = r.homeWon ? r.home.short : r.away.short;
  var winnerColor = r.homeWon ? r.home.color : r.away.color;

  // Build gamertag lookup from leaderboard + roster data
  var gamertagMap = useMemo(function() {
    var m = {};
    if (analysis && analysis.playerStats) {
      analysis.playerStats.forEach(function(p) {
        m[p.player_id] = p.gamertag || p.player_tag || ("Player " + p.player_id);
      });
    }
    if (analysis && analysis.teamPlayers) {
      Object.keys(analysis.teamPlayers).forEach(function(tid) {
        (analysis.teamPlayers[tid] || []).forEach(function(p) {
          if (p.id && p.name && !m[p.id]) m[p.id] = p.name;
        });
      });
    }
    return m;
  }, [analysis]);

  var handleExpand = function() {
    var next = !expanded;
    setExpanded(next);
    if (next && !seriesStats && !detailLoading) {
      setDetailLoading(true);
      Promise.all([
        fetchSeriesMaps(r.id),
        fetchMatchPlayerStats(r.id),
        fetchMatchMapStats(r.id)
      ]).then(function(res) {
        setMaps(res[0] || []);
        setSeriesStats(res[1] || []);
        setMapPlayerStats(res[2] || []);
      }).catch(function() {
        setMaps([]); setSeriesStats([]); setMapPlayerStats([]);
      }).finally(function() {
        setDetailLoading(false);
      });
    }
  };

  // Aggregate series stats by team
  var homeTeamSeries = null, awayTeamSeries = null;
  if (seriesStats && seriesStats.length > 0) {
    var hK = 0, hD = 0, hDmg = 0, hPlayers = [];
    var aK = 0, aD = 0, aDmg = 0, aPlayers = [];
    seriesStats.forEach(function(p) {
      var isHome = p.team_id === r.home.id;
      var kills = p.kills || 0, deaths = p.deaths || 0, damage = p.damage || 0;
      var pKd = deaths > 0 ? kills / deaths : kills;
      var obj = {player_id: p.player_id, kills: kills, deaths: deaths, damage: damage, kd: pKd, assists: p.assists || 0};
      if (isHome) { hK += kills; hD += deaths; hDmg += damage; hPlayers.push(obj); }
      else { aK += kills; aD += deaths; aDmg += damage; aPlayers.push(obj); }
    });
    hPlayers.sort(function(a, b) { return b.kills - a.kills; });
    aPlayers.sort(function(a, b) { return b.kills - a.kills; });
    homeTeamSeries = {kills: hK, deaths: hD, damage: hDmg, diff: hK - hD, kd: hD > 0 ? hK / hD : hK, players: hPlayers};
    awayTeamSeries = {kills: aK, deaths: aD, damage: aDmg, diff: aK - aD, kd: aD > 0 ? aK / aD : aK, players: aPlayers};
  }

  // Get per-map player stats for the active map
  var activeMapPlayers = null;
  if (activeMap !== null && mapPlayerStats) {
    var homeMp = [], awayMp = [];
    mapPlayerStats.forEach(function(p) {
      if (p.map_number !== activeMap) return;
      var kills = p.kills || 0, deaths = p.deaths || 0, damage = p.damage || 0;
      var pKd = deaths > 0 ? kills / deaths : kills;
      var obj = {player_id: p.player_id, kills: kills, deaths: deaths, damage: damage, kd: pKd, assists: p.assists || 0};
      if (p.team_id === r.home.id) homeMp.push(obj);
      else awayMp.push(obj);
    });
    homeMp.sort(function(a, b) { return b.kills - a.kills; });
    awayMp.sort(function(a, b) { return b.kills - a.kills; });
    activeMapPlayers = {home: homeMp, away: awayMp};
  }

  // Determine which player list to show — activeMap overrides series
  var showingMap = activeMap !== null && activeMapPlayers;
  var displayHome = showingMap ? activeMapPlayers.home : (homeTeamSeries ? homeTeamSeries.players : []);
  var displayAway = showingMap ? activeMapPlayers.away : (awayTeamSeries ? awayTeamSeries.players : []);

  // Player stat row renderer
  var renderPlayerRow = function(p, i, teamColor) {
    var diff = p.kills - p.deaths;
    return <div key={p.player_id} className="grid items-center py-1.5" style={{gridTemplateColumns: "1fr 40px 40px 50px 60px 40px", borderBottom: "1px solid rgba(255,255,255,0.02)", background: i % 2 === 0 ? "rgba(255,255,255,0.015)" : "transparent"}}>
      <span className="text-xs font-semibold truncate pr-1" style={{color: teamColor}}>{gamertagMap[p.player_id] || p.player_id}</span>
      <span className="text-xs text-center font-bold text-white tabular-nums">{p.kills}</span>
      <span className="text-xs text-center tabular-nums" style={{color: "#888"}}>{p.deaths}</span>
      <span className="text-xs text-center font-bold tabular-nums" style={{color: kdColor(p.kd)}}>{p.kd.toFixed(2)}</span>
      <span className="text-xs text-center tabular-nums" style={{color: "#888"}}>{Math.round(p.damage).toLocaleString()}</span>
      <span className="text-xs text-center font-bold tabular-nums" style={{color: diff >= 0 ? "#52b788" : "#ff6b6b"}}>{diff >= 0 ? "+" : ""}{diff}</span>
    </div>;
  };

  return <div className="rounded-xl overflow-hidden" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}}>
    {/* Collapsed — clean series score */}
    <div className="p-4 cursor-pointer" onClick={handleExpand}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase tracking-wider opacity-40">{r.event.short || r.event.name} · Bo{r.bestOf}</span>
        <span className="text-xs px-2 py-0.5 rounded-full" style={{background: "rgba(82,183,136,0.12)", color: "#52b788"}}>Final</span>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-8 rounded" style={{background: r.home.color}} />
          <span className="font-bold text-xl" style={{color: r.homeWon ? "#fff" : "#555"}}>{r.home.short}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-2xl font-black tabular-nums" style={{color: r.homeWon ? "#fff" : "#555"}}>{r.homeScore}</span>
          <span className="text-xs opacity-30">-</span>
          <span className="text-2xl font-black tabular-nums" style={{color: r.awayWon ? "#fff" : "#555"}}>{r.awayScore}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-bold text-xl" style={{color: r.awayWon ? "#fff" : "#555"}}>{r.away.short}</span>
          <div className="w-2 h-8 rounded" style={{background: r.away.color}} />
        </div>
      </div>
      <div className="flex justify-between mt-3 text-xs opacity-50">
        <span>{utcToET(r.datetime)}</span>
        <span style={{color: winnerColor}}>{winnerShort} wins</span>
        <span>{expanded ? "\u25B2 collapse" : "\u25BC details"}</span>
      </div>
    </div>

    {/* Expanded */}
    {expanded && <div className="px-4 pb-4 pt-1" style={{borderTop: "1px solid rgba(255,255,255,0.05)"}}>
      {detailLoading && <div className="py-6 text-center"><div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{borderColor: "#e94560", borderTopColor: "transparent"}} /><p className="text-xs mt-2" style={{color: "#555"}}>Loading stats...</p></div>}

      {homeTeamSeries && awayTeamSeries && <div>
        {/* Map scores row — always visible in expanded */}
        {maps && maps.length > 0 && <div className="rounded-lg overflow-hidden mb-3" style={{background: "rgba(255,255,255,0.02)"}}>
          {/* Header row */}
          <div className="grid items-center py-2 px-2" style={{gridTemplateColumns: "40px 1fr 1fr 48px 48px", background: "rgba(255,255,255,0.04)"}}>
            <span style={{fontSize: "9px", color: "#555"}}>MAP</span>
            <span style={{fontSize: "9px", color: "#555"}}>MODE</span>
            <span style={{fontSize: "9px", color: "#555"}}>MAP</span>
            <span style={{fontSize: "9px", color: r.home.color, textAlign: "center", fontWeight: 700}}>{r.home.short}</span>
            <span style={{fontSize: "9px", color: r.away.color, textAlign: "center", fontWeight: 700}}>{r.away.short}</span>
          </div>
          {maps.map(function(m) {
            var homeWonMap = m.winner_id === r.home.id;
            return <div key={m.map_number} className="grid items-center py-1.5 px-2" style={{gridTemplateColumns: "40px 1fr 1fr 48px 48px", borderBottom: "1px solid rgba(255,255,255,0.03)"}}>
              <span className="text-xs font-bold" style={{color: "#555"}}>{m.map_number}</span>
              <span className="text-xs font-semibold" style={{color: "#888"}}>{m.mode_short || m.mode_name}</span>
              <span className="text-xs" style={{color: "#666"}}>{m.map_name}</span>
              <span className="text-sm font-bold text-center tabular-nums" style={{color: homeWonMap ? "#52b788" : "#555"}}>{m.home_score}</span>
              <span className="text-sm font-bold text-center tabular-nums" style={{color: !homeWonMap ? "#52b788" : "#555"}}>{m.away_score}</span>
            </div>;
          })}
        </div>}

        {/* View toggle — Series (default) vs individual maps */}
        <div className="flex gap-1 mb-3 flex-wrap">
          <button onClick={function(e) { e.stopPropagation(); setActiveMap(null); }} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all" style={{
            background: activeMap === null ? "rgba(233,69,96,0.15)" : "rgba(255,255,255,0.04)",
            border: activeMap === null ? "1px solid rgba(233,69,96,0.3)" : "1px solid rgba(255,255,255,0.04)",
            color: activeMap === null ? "#e94560" : "#666"
          }}>Series</button>
          {maps && maps.map(function(m) {
            var isActive = activeMap === m.map_number;
            return <button key={m.map_number} onClick={function(e) { e.stopPropagation(); setActiveMap(m.map_number); }} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all" style={{
              background: isActive ? "rgba(233,69,96,0.15)" : "rgba(255,255,255,0.04)",
              border: isActive ? "1px solid rgba(233,69,96,0.3)" : "1px solid rgba(255,255,255,0.04)",
              color: isActive ? "#e94560" : "#666"
            }}>
              <span>Map {m.map_number}</span>
            </button>;
          })}
        </div>

        {/* Active map header when viewing a specific map */}
        {showingMap && maps && maps.filter(function(m) { return m.map_number === activeMap; }).map(function(m) {
          var homeWonMap = m.winner_id === r.home.id;
          return <div key={m.map_number} className="flex items-center justify-between px-2 py-2 mb-2 rounded-lg" style={{background: "rgba(255,255,255,0.03)"}}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold" style={{color: "#888"}}>{m.mode_name}</span>
              <span className="text-xs" style={{color: "#555"}}>{m.map_name}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold tabular-nums" style={{color: homeWonMap ? "#52b788" : "#555"}}>{m.home_score}</span>
              <span style={{fontSize: "9px", color: "#444"}}>-</span>
              <span className="text-sm font-bold tabular-nums" style={{color: !homeWonMap ? "#52b788" : "#555"}}>{m.away_score}</span>
            </div>
          </div>;
        })}

        {/* Player stats table */}
        <div className="rounded-lg overflow-hidden" style={{background: "rgba(255,255,255,0.02)"}}>
          {/* Column headers */}
          <div className="grid items-center py-1.5 px-2" style={{gridTemplateColumns: "1fr 40px 40px 50px 60px 40px", borderBottom: "1px solid rgba(255,255,255,0.06)"}}>
            <span style={{fontSize: "9px", color: "#555"}}>PLAYER</span>
            <span style={{fontSize: "9px", color: "#555", textAlign: "center"}}>K</span>
            <span style={{fontSize: "9px", color: "#555", textAlign: "center"}}>D</span>
            <span style={{fontSize: "9px", color: "#555", textAlign: "center"}}>K/D</span>
            <span style={{fontSize: "9px", color: "#555", textAlign: "center"}}>DMG</span>
            <span style={{fontSize: "9px", color: "#555", textAlign: "center"}}>+/-</span>
          </div>

          {/* Home team */}
          <div className="px-2">
            <div className="flex items-center gap-2 mt-2 mb-1"><div className="w-1 h-3 rounded" style={{background: r.home.color}} /><span className="text-xs font-bold uppercase tracking-wider" style={{color: r.home.color}}>{r.home.short}</span></div>
            {displayHome.map(function(p, i) { return renderPlayerRow(p, i, r.home.color); })}
          </div>

          {/* Away team */}
          <div className="px-2">
            <div className="flex items-center gap-2 mt-3 mb-1"><div className="w-1 h-3 rounded" style={{background: r.away.color}} /><span className="text-xs font-bold uppercase tracking-wider" style={{color: r.away.color}}>{r.away.short}</span></div>
            {displayAway.map(function(p, i) { return renderPlayerRow(p, i, r.away.color); })}
          </div>

          {/* Series team totals footer — only show in series view */}
          {!showingMap && <div style={{borderTop: "1px solid rgba(255,255,255,0.06)", marginTop: "8px"}}>
            <div className="grid items-center py-2 px-2" style={{gridTemplateColumns: "1fr 40px 40px 50px 60px 40px"}}>
              <span className="text-xs font-bold" style={{color: r.home.color}}>{r.home.short} total</span>
              <span className="text-xs text-center font-bold text-white tabular-nums">{homeTeamSeries.kills}</span>
              <span className="text-xs text-center tabular-nums" style={{color: "#888"}}>{homeTeamSeries.deaths}</span>
              <span className="text-xs text-center font-bold tabular-nums" style={{color: kdColor(homeTeamSeries.kd)}}>{homeTeamSeries.kd.toFixed(2)}</span>
              <span className="text-xs text-center tabular-nums" style={{color: "#888"}}>{Math.round(homeTeamSeries.damage).toLocaleString()}</span>
              <span className="text-xs text-center font-bold tabular-nums" style={{color: homeTeamSeries.diff >= 0 ? "#52b788" : "#ff6b6b"}}>{homeTeamSeries.diff >= 0 ? "+" : ""}{homeTeamSeries.diff}</span>
            </div>
            <div className="grid items-center py-2 px-2" style={{gridTemplateColumns: "1fr 40px 40px 50px 60px 40px", borderTop: "1px solid rgba(255,255,255,0.02)"}}>
              <span className="text-xs font-bold" style={{color: r.away.color}}>{r.away.short} total</span>
              <span className="text-xs text-center font-bold text-white tabular-nums">{awayTeamSeries.kills}</span>
              <span className="text-xs text-center tabular-nums" style={{color: "#888"}}>{awayTeamSeries.deaths}</span>
              <span className="text-xs text-center font-bold tabular-nums" style={{color: kdColor(awayTeamSeries.kd)}}>{awayTeamSeries.kd.toFixed(2)}</span>
              <span className="text-xs text-center tabular-nums" style={{color: "#888"}}>{Math.round(awayTeamSeries.damage).toLocaleString()}</span>
              <span className="text-xs text-center font-bold tabular-nums" style={{color: awayTeamSeries.diff >= 0 ? "#52b788" : "#ff6b6b"}}>{awayTeamSeries.diff >= 0 ? "+" : ""}{awayTeamSeries.diff}</span>
            </div>
          </div>}
        </div>
      </div>}

      {/* Footer — share + team links */}
      <div className="mt-3 pt-3" style={{borderTop: "1px solid rgba(255,255,255,0.04)"}}>
        <div className="flex justify-center gap-4 mb-3">
          <button onClick={function(e) { e.stopPropagation(); onTeamClick(r.home.id); }} className="text-xs font-semibold hover:underline" style={{color: r.home.color}}>{r.home.name} →</button>
          <button onClick={function(e) {
            e.stopPropagation();
            if (sharing || !homeTeamSeries) return;
            setSharing(true);
            var viewLabel = activeMap === null ? "Series" : "";
            if (activeMap !== null && maps) {
              maps.forEach(function(m) {
                if (m.map_number === activeMap) viewLabel = "Map " + m.map_number + " — " + (m.mode_name || "") + " — " + (m.map_name || "");
              });
            }
            var shareData = {
              home: {short: r.home.short, color: r.home.color, id: r.home.id},
              away: {short: r.away.short, color: r.away.color, id: r.away.id},
              homeScore: r.homeScore, awayScore: r.awayScore,
              homeWon: r.homeWon, awayWon: r.awayWon,
              datetime: r.datetime,
              eventName: r.event.short || r.event.name || "CDL 2026",
              maps: maps || [],
              homePlayers: displayHome.map(function(p) { return {name: gamertagMap[p.player_id] || p.player_id, kills: p.kills, deaths: p.deaths, damage: p.damage, kd: p.kd}; }),
              awayPlayers: displayAway.map(function(p) { return {name: gamertagMap[p.player_id] || p.player_id, kills: p.kills, deaths: p.deaths, damage: p.damage, kd: p.kd}; }),
              homeTeamTotals: activeMap === null ? homeTeamSeries : null,
              awayTeamTotals: activeMap === null ? awayTeamSeries : null,
              viewLabel: viewLabel
            };
            import("./shareRenderer.js").then(function(mod) {
              return mod.shareResultImage(shareData);
            }).catch(function(err) { console.error("Share error:", err); }).finally(function() { setSharing(false); });
          }} disabled={sharing || !homeTeamSeries} className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg transition-all" style={{
            background: sharing ? "rgba(233,69,96,0.2)" : "rgba(233,69,96,0.1)",
            color: sharing ? "#888" : "#e94560",
            border: "1px solid rgba(233,69,96,0.2)",
            opacity: !homeTeamSeries ? 0.3 : 1
          }}>
            {sharing ? <div className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin" style={{borderColor: "#e94560", borderTopColor: "transparent"}} /> : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>}
            <span>{sharing ? "..." : "Share"}</span>
          </button>
          <button onClick={function(e) { e.stopPropagation(); onTeamClick(r.away.id); }} className="text-xs font-semibold hover:underline" style={{color: r.away.color}}>{r.away.name} →</button>
        </div>
      </div>
    </div>}
  </div>;
}

function TeamPage(props) {
  var tid = props.tid, analysis = props.analysis, onBack = props.onBack;
  var ts = analysis.teamStats[tid] || {};
  var standing = analysis.standingsLookup[tid] || {};
  var major = analysis.majorStandingsLookup[tid] || {};
  var roster = analysis.rosterStats(tid);
  var teamMatches = analysis.matchups.filter(function(mu) { return (mu.t1Stats && mu.t1Stats.team_id === tid) || (mu.t2Stats && mu.t2Stats.team_id === tid); });
  var mW = standing.series_wins || 0, mL = standing.series_losses || 0, gW = standing.map_wins || 0, gL = standing.map_losses || 0;
  var mmW = major.series_wins || 0, mmL = major.series_losses || 0, mgW = major.map_wins || 0, mgL = major.map_losses || 0;

  return <div>
    <button onClick={onBack} className="text-sm mb-4 hover:underline" style={{color: "#e94560"}}>{"\u2190"} back to standings</button>
    <div className="flex items-center gap-4 mb-5 pb-5" style={{borderBottom: "1px solid rgba(255,255,255,0.06)"}}>
      <div className="w-1.5 h-12 rounded" style={{background: ts.team_color}} />
      <div className="flex-1">
        <h2 className="text-2xl font-black text-white">{ts.team_name}</h2>
        <p className="text-sm opacity-50">{mW}-{mL} season · {standing.cdl_points || 0} CDL points</p>
      </div>
      <div className="text-center"><div className="text-2xl font-black" style={{color: "#e94560"}}>#{standing.rank || "-"}</div><div style={{fontSize: "10px", color: "#555", textTransform: "uppercase"}}>Standing</div></div>
    </div>
    <div className="grid grid-cols-2 gap-3 mb-5">
      <div className="rounded-lg p-3" style={{background: "rgba(255,255,255,0.04)"}}>
        <div style={{fontSize: "10px", color: "#555", textTransform: "uppercase", marginBottom: "4px"}}>Major</div>
        <div className="text-xl font-bold text-white">{mmW}-{mmL}</div>
        <div style={{fontSize: "11px", color: "#555"}}>{mgW}-{mgL} maps · {major.cdl_points || 0} pts</div>
      </div>
      <div className="rounded-lg p-3" style={{background: "rgba(255,255,255,0.04)"}}>
        <div style={{fontSize: "10px", color: "#555", textTransform: "uppercase", marginBottom: "4px"}}>Season</div>
        <div className="text-xl font-bold text-white">{mW}-{mL}</div>
        <div style={{fontSize: "11px", color: "#555"}}>{gW}-{gL} maps · {standing.cdl_points || 0} pts</div>
      </div>
    </div>
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
      <div className="rounded-lg p-3 text-center" style={{background: "rgba(255,255,255,0.04)"}}><div style={{fontSize: "10px", color: "#555", textTransform: "uppercase"}}>K/D</div><div className="text-xl font-bold" style={{color: kdColor(s(ts, "kd"))}}>{s(ts, "kd").toFixed(2)}</div></div>
      <div className="rounded-lg p-3 text-center" style={{background: "rgba(255,255,255,0.04)"}}><div style={{fontSize: "10px", color: "#555", textTransform: "uppercase"}}>Win rate</div><div className="text-xl font-bold" style={{color: (mW / (mW + mL || 1)) > 0.5 ? "#52b788" : "#ff6b6b"}}>{((mW / (mW + mL || 1)) * 100).toFixed(1)}%</div></div>
      <div className="rounded-lg p-3 text-center" style={{background: "rgba(255,255,255,0.04)"}}><div style={{fontSize: "10px", color: "#555", textTransform: "uppercase"}}>HP diff</div><div className="text-xl font-bold" style={{color: s(ts, "hp_score_diff") > 0 ? "#52b788" : "#ff6b6b"}}>{s(ts, "hp_score_diff") > 0 ? "+" : ""}{s(ts, "hp_score_diff").toFixed(1)}</div></div>
      <div className="rounded-lg p-3 text-center" style={{background: "rgba(255,255,255,0.04)"}}><div style={{fontSize: "10px", color: "#555", textTransform: "uppercase"}}>CDL points</div><div className="text-xl font-bold text-white">{standing.cdl_points || 0}</div></div>
    </div>
    <div className="mb-5">
      <div className="text-xs uppercase tracking-wider opacity-40 mb-3">Performance by mode</div>
      <div className="rounded-lg overflow-hidden" style={{background: "rgba(255,255,255,0.02)"}}>
        <div className="grid grid-cols-4 gap-2 px-3 py-2" style={{borderBottom: "1px solid rgba(255,255,255,0.06)"}}><div style={{fontSize: "10px", color: "#555"}}>MODE</div><div style={{fontSize: "10px", color: "#555", textAlign: "center"}}>WIN%</div><div style={{fontSize: "10px", color: "#555", textAlign: "center"}}>K/D</div><div style={{fontSize: "10px", color: "#555", textAlign: "center"}}>DIFF</div></div>
        {[["Hardpoint", "hp", "hp_score_diff"], ["SnD", "snd", "snd_round_diff"], ["Overload", "ovl", "ovl_score_diff"]].map(function(arr) {
          var label = arr[0], mode = arr[1], diffKey = arr[2];
          var w = ts[mode + "_win_pct"] || 0, kd = s(ts, mode + "_kd"), diff = s(ts, diffKey);
          return <div key={mode} className="grid grid-cols-4 gap-2 px-3 py-2" style={{borderBottom: "1px solid rgba(255,255,255,0.03)"}}>
            <div className="text-sm font-semibold" style={{color: "#888"}}>{label}</div>
            <div className="text-sm text-center" style={{color: w > 50 ? "#52b788" : w < 45 ? "#ff6b6b" : "#ffd166"}}>{w.toFixed(1)}%</div>
            <div className="text-sm text-center" style={{color: kdColor(kd)}}>{kd.toFixed(2)}</div>
            <div className="text-sm text-center" style={{color: diff > 0 ? "#52b788" : "#ff6b6b"}}>{diff > 0 ? "+" : ""}{diff.toFixed(1)}</div>
          </div>;
        })}
      </div>
    </div>
    <div className="mb-5"><div className="text-xs uppercase tracking-wider opacity-40 mb-3">Roster</div>{roster.map(function(p) { return <PlayerRow key={p.player_id} p={p} />; })}{roster.length === 0 && <p className="text-sm opacity-40">No player stats available</p>}</div>
    <div><div className="text-xs uppercase tracking-wider opacity-40 mb-3">Upcoming schedule</div>
      {teamMatches.length === 0 && <p className="text-sm opacity-40">No upcoming matches</p>}
      {teamMatches.map(function(mu) {
        var isT1 = mu.t1Stats && mu.t1Stats.team_id === tid;
        var oppName = isT1 ? (mu.t2 && mu.t2.name_short) : (mu.t1 && mu.t1.name_short);
        var oppColor = isT1 ? (mu.t2Stats && mu.t2Stats.team_color) : (mu.t1Stats && mu.t1Stats.team_color);
        return <div key={mu.id} className="flex items-center justify-between p-3 rounded-lg mb-2" style={{background: "rgba(255,255,255,0.02)"}}>
          <div className="flex items-center gap-3"><div className="w-1 h-5 rounded" style={{background: oppColor || "#888"}} /><div><div className="text-sm font-semibold text-white">vs {oppName}</div><div style={{fontSize: "11px", color: "#555"}}>{(mu.event && mu.event.name_short) || ""} · Bo{mu.bestOf}</div></div></div>
          <div className="text-right"><div style={{fontSize: "12px", color: "#888"}}>{utcToET(mu.datetime)}</div><div className="text-xs px-2 py-0.5 rounded-full mt-1 inline-block" style={{background: "rgba(255,255,255,0.06)", color: "#888", fontSize: "10px"}}>{timeUntil(mu.datetime)}</div></div>
        </div>;
      })}
    </div>
  </div>;
}

function TeamsGrid(props) {
  var analysis = props.analysis, onTeamClick = props.onTeamClick;
  var ordered = analysis.majorStandings.slice().sort(function(a, b) { return (a.rank || 99) - (b.rank || 99); });
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
    {ordered.map(function(major, i) {
      var tid = major.team_id;
      var ts = analysis.teamStats[tid] || {};
      var season = analysis.standingsLookup[tid] || {};
      var color = ts.team_color || major.team_color || "#888";
      var fullName = ts.team_name || major.team_name || "?";
      var kd = s(ts, "kd");
      var hpDiff = s(ts, "hp_score_diff");
      var avgWin = ((ts.hp_win_pct || 0) + (ts.snd_win_pct || 0) + (ts.ovl_win_pct || 0)) / 3;

      return <div key={tid} className="rounded-xl p-4 cursor-pointer hover:border-white/20 transition-all" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}} onClick={function() { onTeamClick(tid); }}>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-1 h-6 rounded" style={{background: color}} />
          <span className="font-bold text-white text-sm flex-1 truncate">{fullName}</span>
          <span className="text-sm font-bold" style={{color: i < 3 ? "#e94560" : i < 6 ? "#53a8b6" : "#555"}}>#{major.rank}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="rounded-lg p-2" style={{background: "rgba(255,255,255,0.04)"}}>
            <div style={{fontSize: "9px", color: "#555", textTransform: "uppercase"}}>Major</div>
            <div className="text-sm font-bold text-white">{major.series_wins}-{major.series_losses}</div>
            <div style={{fontSize: "10px", color: "#555"}}>{major.map_wins}-{major.map_losses} maps · {major.cdl_points || 0} pts</div>
          </div>
          <div className="rounded-lg p-2" style={{background: "rgba(255,255,255,0.04)"}}>
            <div style={{fontSize: "9px", color: "#555", textTransform: "uppercase"}}>Season</div>
            <div className="text-sm font-bold text-white">{season.series_wins || 0}-{season.series_losses || 0}</div>
            <div style={{fontSize: "10px", color: "#555"}}>{season.map_wins || 0}-{season.map_losses || 0} maps · {season.cdl_points || 0} pts</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center"><div style={{fontSize: "9px", color: "#555"}}>K/D</div><div className="text-sm font-bold" style={{color: kdColor(kd)}}>{kd.toFixed(2)}</div></div>
          <div className="text-center"><div style={{fontSize: "9px", color: "#555"}}>Win%</div><div className="text-sm font-bold" style={{color: avgWin > 50 ? "#52b788" : "#ff6b6b"}}>{avgWin.toFixed(1)}%</div></div>
          <div className="text-center"><div style={{fontSize: "9px", color: "#555"}}>HP +/-</div><div className="text-sm font-bold" style={{color: hpDiff > 0 ? "#52b788" : "#ff6b6b"}}>{hpDiff > 0 ? "+" : ""}{hpDiff.toFixed(1)}</div></div>
        </div>
      </div>;
    })}
  </div>;
}

function PlayerSearch(props) {
  var analysis = props.analysis;
  var [query, setQuery] = useState("");
  var [selected, setSelected] = useState(null);
  var results = useMemo(function() {
    if (query.length < 2) return [];
    var q = query.toLowerCase();
    return analysis.playerStats.filter(function(p) { return (p.gamertag && p.gamertag.toLowerCase().indexOf(q) !== -1) || (p.team_name && p.team_name.toLowerCase().indexOf(q) !== -1); }).slice(0, 12);
  }, [query, analysis]);

  return <div className="space-y-3">
    <input type="text" value={query} onChange={function(e) { setQuery(e.target.value); setSelected(null); }} placeholder="Search player or team..." className="w-full p-3 rounded-lg text-white placeholder-gray-500 outline-none" style={{background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", fontSize: "16px"}} />
    {results.length > 0 && !selected && <div className="space-y-1">{results.map(function(p) {
      return <div key={p.player_id} className="flex items-center gap-3 p-2 rounded-lg cursor-pointer hover:bg-white/5" onClick={function() { setSelected(p); }}>
        <span className="font-bold text-white">{p.gamertag}</span><RoleBadge role={p.role} /><span className="text-xs opacity-50">{p.team_abbr || p.team_short}</span><span className="ml-auto"><KdBadge kd={s(p, "kd")} size="sm" /></span>
      </div>;
    })}</div>}
    {selected && <div className="space-y-3">
      <div className="flex items-center justify-between"><div><div className="flex items-center gap-2"><h3 className="text-xl font-bold text-white">{selected.gamertag}</h3><RoleBadge role={selected.role} /></div><span className="text-sm opacity-50">{selected.team_name}</span></div><button onClick={function() { setSelected(null); }} className="text-xs opacity-50 hover:opacity-100">{"\u2715"} clear</button></div>
      <div className="rounded-lg p-3" style={{background: "rgba(255,255,255,0.03)"}}>
        <div className="grid grid-cols-3 gap-3 pb-3 mb-2" style={{borderBottom: "1px solid rgba(255,255,255,0.04)"}}>
          <Stat label="Overall K/D" value={s(selected, "kd")} /><Stat label="DMG/10m" value={s(selected, "dmg_per_10m")} fmt="0.0" /><Stat label="FB%" value={s(selected, "first_blood_pct") * 100} fmt="0.0" />
        </div>
        <div style={{fontSize: "10px", fontWeight: 600, color: "#e94560", padding: "4px 0"}}>Hardpoint</div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pb-3 mb-2" style={{borderBottom: "1px solid rgba(255,255,255,0.04)"}}>
          <Stat label="HP K/D" value={s(selected, "hp_kd")} /><Stat label="K/10" value={s(selected, "hp_kills_per_10m")} fmt="0.0" /><Stat label="D/10" value={s(selected, "hp_deaths_per_10m")} fmt="0.0" /><Stat label="DMG/10" value={s(selected, "hp_damage_per_10m")} fmt="0.0" /><Stat label="ENG/10" value={s(selected, "hp_engagements_10m")} fmt="0.0" />
        </div>
        <div style={{fontSize: "10px", fontWeight: 600, color: "#e94560", padding: "4px 0"}}>Search and Destroy</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pb-3 mb-2" style={{borderBottom: "1px solid rgba(255,255,255,0.04)"}}>
          <Stat label="SnD K/D" value={s(selected, "snd_kd")} /><Stat label="KPR" value={s(selected, "snd_kills_per_round")} /><Stat label="DPR" value={s(selected, "snd_deaths_per_round")} /><Stat label="FB%" value={s(selected, "first_blood_pct") * 100} fmt="0.0" />
        </div>
        <div style={{fontSize: "10px", fontWeight: 600, color: "#e94560", padding: "4px 0"}}>Overload</div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <Stat label="OVL K/D" value={s(selected, "ovl_kd")} /><Stat label="K/10" value={s(selected, "ovl_kills_per_10m")} fmt="0.0" /><Stat label="D/10" value={s(selected, "ovl_deaths_per_10m")} fmt="0.0" /><Stat label="DMG/10" value={s(selected, "ovl_damage_per_10m")} fmt="0.0" /><Stat label="ENG/10" value={s(selected, "ovl_engagements_10m")} fmt="0.0" />
        </div>
      </div>
    </div>}
  </div>;
}

function CompareRow(props) {
  var label = props.label, v1 = props.v1, v2 = props.v2, fmt = props.fmt || "0.00";
  var f = function(v) { return fmt === "pct" ? v.toFixed(1) + "%" : fmt === "0.0" ? v.toFixed(1) : v.toFixed(2); };
  var w1 = v1 > v2, w2 = v2 > v1, tie = v1 === v2;
  var c1 = w1 ? "#52b788" : tie ? "#ffd166" : "#666";
  var c2 = w2 ? "#52b788" : tie ? "#ffd166" : "#666";
  return <div className="grid items-center py-1.5" style={{gridTemplateColumns: "1fr auto 1fr", borderBottom: "1px solid rgba(255,255,255,0.03)"}}>
    <div className="text-right pr-3"><span className="text-sm font-bold tabular-nums" style={{color: c1}}>{f(v1)}</span></div>
    <div className="text-center px-1" style={{fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.5px", color: "#555", minWidth: "64px"}}>{label}</div>
    <div className="text-left pl-3"><span className="text-sm font-bold tabular-nums" style={{color: c2}}>{f(v2)}</span></div>
  </div>;
}

function PlayerCompare(props) {
  var analysis = props.analysis;
  var initialCompare = props.initialCompare;
  var [q1, setQ1] = useState("");
  var [q2, setQ2] = useState("");
  var [p1, setP1] = useState(null);
  var [p2, setP2] = useState(null);
  var [show1, setShow1] = useState(false);
  var [show2, setShow2] = useState(false);
  var [sharing, setSharing] = useState(false);
  var [linkCopied, setLinkCopied] = useState(false);

  useEffect(function() {
    if (!initialCompare || !analysis) return;
    var parts = initialCompare.split(",");
    if (parts.length !== 2) return;
    var name1 = decodeURIComponent(parts[0]).toLowerCase().trim();
    var name2 = decodeURIComponent(parts[1]).toLowerCase().trim();
    var found1 = analysis.playerStats.find(function(p) { return p.gamertag && p.gamertag.toLowerCase() === name1; });
    var found2 = analysis.playerStats.find(function(p) { return p.gamertag && p.gamertag.toLowerCase() === name2; });
    if (found1) { setP1(found1); setQ1(found1.gamertag); }
    if (found2) { setP2(found2); setQ2(found2.gamertag); }
  }, [initialCompare, analysis]);

  var updateUrl = function(player1, player2) {
    if (player1 && player2) {
      var url = window.location.origin + window.location.pathname + "?compare=" + encodeURIComponent(player1.gamertag) + "," + encodeURIComponent(player2.gamertag);
      window.history.replaceState(null, "", url);
    } else {
      window.history.replaceState(null, "", window.location.pathname);
    }
  };

  var search = function(q) {
    if (q.length < 2) return [];
    var lower = q.toLowerCase();
    return analysis.playerStats.filter(function(p) {
      return (p.gamertag && p.gamertag.toLowerCase().indexOf(lower) !== -1) || (p.team_name && p.team_name.toLowerCase().indexOf(lower) !== -1);
    }).slice(0, 6);
  };

  var r1 = useMemo(function() { return search(q1); }, [q1, analysis]);
  var r2 = useMemo(function() { return search(q2); }, [q2, analysis]);

  var pick1 = function(p) { setP1(p); setQ1(p.gamertag); setShow1(false); if (document.activeElement) document.activeElement.blur(); updateUrl(p, p2); };
  var pick2 = function(p) { setP2(p); setQ2(p.gamertag); setShow2(false); if (document.activeElement) document.activeElement.blur(); updateUrl(p1, p); };

  var handleShareImage = function() {
    if (!p1 || !p2 || sharing) return;
    setSharing(true);
    var shareUrl = window.location.origin + window.location.pathname + "?compare=" + encodeURIComponent(p1.gamertag) + "," + encodeURIComponent(p2.gamertag);
    import("./shareRenderer.js").then(function(mod) {
      return mod.shareCompareImage(p1, p2, shareUrl);
    }).then(function() { setSharing(false); }).catch(function() { setSharing(false); });
  };

  var handleCopyLink = function() {
    if (!p1 || !p2) return;
    var url = window.location.origin + window.location.pathname + "?compare=" + encodeURIComponent(p1.gamertag) + "," + encodeURIComponent(p2.gamertag);
    navigator.clipboard.writeText(url).then(function() {
      setLinkCopied(true); setTimeout(function() { setLinkCopied(false); }, 2000);
    }).catch(function() { prompt("Copy this link:", url); });
  };

  var stats = [
    {label: "K/D", k: "kd"},
    {label: "DMG/10m", k: "dmg_per_10m", fmt: "0.0"},
    {label: "HP K/D", k: "hp_kd"},
    {label: "HP K/10", k: "hp_kills_per_10m", fmt: "0.0"},
    {label: "HP D/10", k: "hp_deaths_per_10m", fmt: "0.0", lower: true},
    {label: "HP DMG/10", k: "hp_damage_per_10m", fmt: "0.0"},
    {label: "HP ENG/10", k: "hp_engagements_10m", fmt: "0.0"},
    {label: "SnD K/D", k: "snd_kd"},
    {label: "SnD KPR", k: "snd_kills_per_round"},
    {label: "SnD DPR", k: "snd_deaths_per_round", lower: true},
    {label: "SnD FB%", k: "first_blood_pct", fmt: "pct", pctMul: true},
    {label: "OVL K/D", k: "ovl_kd"},
    {label: "OVL K/10", k: "ovl_kills_per_10m", fmt: "0.0"},
    {label: "OVL D/10", k: "ovl_deaths_per_10m", fmt: "0.0", lower: true},
    {label: "OVL DMG/10", k: "ovl_damage_per_10m", fmt: "0.0"},
    {label: "OVL ENG/10", k: "ovl_engagements_10m", fmt: "0.0"}
  ];

  var p1Wins = 0, p2Wins = 0;
  var counted = {};
  if (p1 && p2) {
    stats.forEach(function(st) {
      var key = st.k + (st.label || "");
      if (counted[key]) return;
      counted[key] = true;
      var v1 = s(p1, st.k), v2 = s(p2, st.k);
      if (st.lower) { if (v1 < v2) p1Wins++; else if (v2 < v1) p2Wins++; }
      else { if (v1 > v2) p1Wins++; else if (v2 > v1) p2Wins++; }
    });
  }
  var totalCats = Object.keys(counted).length;
  var handleItem = function(e, pickFn, p) { e.preventDefault(); e.stopPropagation(); pickFn(p); };
  var winner = p1 && p2 ? (p1Wins > p2Wins ? p1 : p2Wins > p1Wins ? p2 : null) : null;

  return <div className="space-y-4">
    <div className="flex gap-2 items-start">
      <div className="relative flex-1">
        <input type="text" value={q1} onChange={function(e) { setQ1(e.target.value); setP1(null); setShow1(true); }} onFocus={function() { setShow1(true); }} onBlur={function() { setTimeout(function() { setShow1(false); }, 300); }} placeholder="Player 1..." className="w-full p-2.5 sm:p-3 rounded-lg text-white placeholder-gray-500 outline-none" style={{background: "rgba(255,255,255,0.06)", border: p1 ? "1px solid rgba(82,183,136,0.4)" : "1px solid rgba(255,255,255,0.1)", fontSize: "16px"}} />
        {show1 && r1.length > 0 && !p1 && <div className="absolute z-10 w-full mt-1 rounded-lg overflow-hidden" style={{background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 12px 32px rgba(0,0,0,0.5)"}}>
          {r1.map(function(p) { return <div key={p.player_id} className="flex items-center gap-2 p-3 cursor-pointer hover:bg-white/5 active:bg-white/10" onMouseDown={function(e) { handleItem(e, pick1, p); }} onTouchEnd={function(e) { handleItem(e, pick1, p); }}>
            <span className="text-white font-medium text-sm">{p.gamertag}</span><RoleBadge role={p.role} /><span className="text-xs opacity-40 ml-auto">{p.team_abbr || p.team_short}</span>
          </div>; })}
        </div>}
      </div>
      <div className="flex items-center justify-center pt-2"><div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0" style={{background: "rgba(233,69,96,0.15)", color: "#e94560", fontSize: "10px"}}>VS</div></div>
      <div className="relative flex-1">
        <input type="text" value={q2} onChange={function(e) { setQ2(e.target.value); setP2(null); setShow2(true); }} onFocus={function() { setShow2(true); }} onBlur={function() { setTimeout(function() { setShow2(false); }, 300); }} placeholder="Player 2..." className="w-full p-2.5 sm:p-3 rounded-lg text-white placeholder-gray-500 outline-none" style={{background: "rgba(255,255,255,0.06)", border: p2 ? "1px solid rgba(82,183,136,0.4)" : "1px solid rgba(255,255,255,0.1)", fontSize: "16px"}} />
        {show2 && r2.length > 0 && !p2 && <div className="absolute z-10 w-full mt-1 rounded-lg overflow-hidden" style={{background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 12px 32px rgba(0,0,0,0.5)"}}>
          {r2.map(function(p) { return <div key={p.player_id} className="flex items-center gap-2 p-3 cursor-pointer hover:bg-white/5 active:bg-white/10" onMouseDown={function(e) { handleItem(e, pick2, p); }} onTouchEnd={function(e) { handleItem(e, pick2, p); }}>
            <span className="text-white font-medium text-sm">{p.gamertag}</span><RoleBadge role={p.role} /><span className="text-xs opacity-40 ml-auto">{p.team_abbr || p.team_short}</span>
          </div>; })}
        </div>}
      </div>
    </div>

    {p1 && p2 && <div className="flex items-center justify-end">
      <button onClick={function() { setP1(null); setP2(null); setQ1(""); setQ2(""); updateUrl(null, null); }} className="text-xs px-2 py-1 rounded opacity-40 hover:opacity-80" style={{background: "rgba(255,255,255,0.05)"}}>Reset</button>
    </div>}

    {p1 && p2 && <div>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="rounded-xl p-3 sm:p-4 text-center" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}}>
          <div className="flex items-center justify-center gap-1"><span className="text-base sm:text-lg font-bold text-white">{p1.gamertag}</span></div>
          <div className="flex items-center justify-center gap-1"><span className="text-xs opacity-40">{p1.team_name}</span><RoleBadge role={p1.role} /></div>
          <div className="text-2xl font-black mt-2" style={{color: kdColor(s(p1, "kd"))}}>{s(p1, "kd").toFixed(2)}</div>
          <div style={{fontSize: "10px", color: "#555"}}>Overall K/D</div>
        </div>
        <div className="rounded-xl p-3 sm:p-4 text-center" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}}>
          <div className="flex items-center justify-center gap-1"><span className="text-base sm:text-lg font-bold text-white">{p2.gamertag}</span></div>
          <div className="flex items-center justify-center gap-1"><span className="text-xs opacity-40">{p2.team_name}</span><RoleBadge role={p2.role} /></div>
          <div className="text-2xl font-black mt-2" style={{color: kdColor(s(p2, "kd"))}}>{s(p2, "kd").toFixed(2)}</div>
          <div style={{fontSize: "10px", color: "#555"}}>Overall K/D</div>
        </div>
      </div>

      <div className="rounded-xl overflow-hidden" style={{background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)"}}>
        <div className="grid items-center py-2 px-3" style={{gridTemplateColumns: "1fr auto 1fr", background: "rgba(255,255,255,0.04)"}}>
          <div className="text-right pr-2 text-xs font-bold" style={{color: "#e94560"}}>{p1.gamertag}</div>
          <div className="text-center text-xs opacity-30 px-1" style={{minWidth: "64px"}}>stat</div>
          <div className="text-left pl-2 text-xs font-bold" style={{color: "#e94560"}}>{p2.gamertag}</div>
        </div>
        <div style={{padding: "0 8px"}}>
          <div style={{fontSize: "9px", fontWeight: 700, color: "#e94560", padding: "8px 0 2px", letterSpacing: "1px"}}>OVERALL</div>
          <CompareRow label="K/D" v1={s(p1, "kd")} v2={s(p2, "kd")} />
          <CompareRow label="DMG/10m" v1={s(p1, "dmg_per_10m")} v2={s(p2, "dmg_per_10m")} fmt="0.0" />
          <div style={{fontSize: "9px", fontWeight: 700, color: "#e94560", padding: "8px 0 2px", letterSpacing: "1px"}}>HARDPOINT</div>
          <CompareRow label="HP K/D" v1={s(p1, "hp_kd")} v2={s(p2, "hp_kd")} />
          <CompareRow label="K/10" v1={s(p1, "hp_kills_per_10m")} v2={s(p2, "hp_kills_per_10m")} fmt="0.0" />
          <CompareRow label="D/10" v1={s(p1, "hp_deaths_per_10m")} v2={s(p2, "hp_deaths_per_10m")} fmt="0.0" />
          <CompareRow label="DMG/10" v1={s(p1, "hp_damage_per_10m")} v2={s(p2, "hp_damage_per_10m")} fmt="0.0" />
          <CompareRow label="ENG/10" v1={s(p1, "hp_engagements_10m")} v2={s(p2, "hp_engagements_10m")} fmt="0.0" />
          <div style={{fontSize: "9px", fontWeight: 700, color: "#e94560", padding: "8px 0 2px", letterSpacing: "1px"}}>SEARCH & DESTROY</div>
          <CompareRow label="SnD K/D" v1={s(p1, "snd_kd")} v2={s(p2, "snd_kd")} />
          <CompareRow label="KPR" v1={s(p1, "snd_kills_per_round")} v2={s(p2, "snd_kills_per_round")} />
          <CompareRow label="DPR" v1={s(p1, "snd_deaths_per_round")} v2={s(p2, "snd_deaths_per_round")} />
          <CompareRow label="FB%" v1={s(p1, "first_blood_pct") * 100} v2={s(p2, "first_blood_pct") * 100} fmt="0.0" />
          <div style={{fontSize: "9px", fontWeight: 700, color: "#e94560", padding: "8px 0 2px", letterSpacing: "1px"}}>OVERLOAD</div>
          <CompareRow label="OVL K/D" v1={s(p1, "ovl_kd")} v2={s(p2, "ovl_kd")} />
          <CompareRow label="K/10" v1={s(p1, "ovl_kills_per_10m")} v2={s(p2, "ovl_kills_per_10m")} fmt="0.0" />
          <CompareRow label="D/10" v1={s(p1, "ovl_deaths_per_10m")} v2={s(p2, "ovl_deaths_per_10m")} fmt="0.0" />
          <CompareRow label="DMG/10" v1={s(p1, "ovl_damage_per_10m")} v2={s(p2, "ovl_damage_per_10m")} fmt="0.0" />
          <CompareRow label="ENG/10" v1={s(p1, "ovl_engagements_10m")} v2={s(p2, "ovl_engagements_10m")} fmt="0.0" />
        </div>
        <div style={{borderTop: "1px solid rgba(255,255,255,0.06)"}}>
          <div className="flex" style={{height: "4px"}}>
            <div style={{width: (totalCats > 0 ? (p1Wins / totalCats * 100) : 50) + "%", background: p1Wins >= p2Wins ? "#52b788" : "#ff6b6b", transition: "width 0.5s"}} />
            <div style={{width: (totalCats > 0 ? ((totalCats - p1Wins - p2Wins) / totalCats * 100) : 0) + "%", background: "#ffd166"}} />
            <div style={{width: (totalCats > 0 ? (p2Wins / totalCats * 100) : 50) + "%", background: p2Wins >= p1Wins ? "#52b788" : "#ff6b6b", transition: "width 0.5s"}} />
          </div>
          <div className="grid grid-cols-3 items-center py-3 px-3" style={{background: "rgba(255,255,255,0.03)"}}>
            <div className="text-left"><div className="text-xl font-black" style={{color: p1Wins >= p2Wins ? "#52b788" : "#ff6b6b"}}>{p1Wins}</div><div style={{fontSize: "10px", color: "#555"}}>categories won</div></div>
            <div className="text-center">{winner ? <div><div style={{fontSize: "9px", color: "#555", letterSpacing: "0.5px"}}>VERDICT</div><div className="text-sm font-black" style={{color: "#52b788"}}>{winner.gamertag}</div></div> : <div style={{fontSize: "11px", color: "#ffd166", fontWeight: 700}}>TIED</div>}</div>
            <div className="text-right"><div className="text-xl font-black" style={{color: p2Wins >= p1Wins ? "#52b788" : "#ff6b6b"}}>{p2Wins}</div><div style={{fontSize: "10px", color: "#555"}}>categories won</div></div>
          </div>
        </div>
      </div>
      <div className="flex gap-2 mt-4">
        <button onClick={handleShareImage} disabled={sharing} className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold" style={{background: sharing ? "rgba(233,69,96,0.3)" : "#e94560", color: "#fff", opacity: sharing ? 0.7 : 1}}>
          {sharing ? <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{borderColor: "#fff", borderTopColor: "transparent"}} /> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>}
          <span>{sharing ? "Generating..." : "Share image"}</span>
        </button>
        <button onClick={handleCopyLink} className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold" style={{background: linkCopied ? "rgba(82,183,136,0.15)" : "rgba(255,255,255,0.06)", border: linkCopied ? "1px solid rgba(82,183,136,0.3)" : "1px solid rgba(255,255,255,0.1)", color: linkCopied ? "#52b788" : "#c8c8d0"}}>
          {linkCopied ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>}
          <span>{linkCopied ? "Copied!" : "Copy link"}</span>
        </button>
      </div>
    </div>}
    {(!p1 || !p2) && <div className="text-center py-8 opacity-30"><p className="text-sm">Select two players to compare their stats</p></div>}
  </div>;
}

function PlayerLeaderboard(props) {
  var analysis = props.analysis;
  var [sortBy, setSortBy] = useState("kd");
  var [roleFilter, setRoleFilter] = useState("All");

  var sortOptions = [
    {key: "kd", label: "K/D"},
    {key: "hp_kills_per_10m", label: "HP K/10"},
    {key: "hp_kd", label: "HP K/D"},
    {key: "hp_damage_per_10m", label: "HP DMG/10"},
    {key: "hp_engagements_10m", label: "HP ENG/10"},
    {key: "snd_kills_per_round", label: "SnD KPR"},
    {key: "snd_kd", label: "SnD K/D"},
    {key: "first_blood_pct", label: "FB%"},
    {key: "ovl_kills_per_10m", label: "OVL K/10"},
    {key: "ovl_kd", label: "OVL K/D"},
    {key: "dmg_per_10m", label: "DMG/10m"}
  ];

  var contextStats = {
    kd: [{k: "hp_kills_per_10m", label: "HP K/10", fmt: "0.0"}, {k: "snd_kills_per_round", label: "SnD KPR", fmt: "0.00"}],
    hp_kills_per_10m: [{k: "hp_kd", label: "HP K/D", fmt: "0.00"}, {k: "hp_damage_per_10m", label: "HP DMG/10", fmt: "0.0"}],
    hp_kd: [{k: "hp_kills_per_10m", label: "HP K/10", fmt: "0.0"}, {k: "hp_deaths_per_10m", label: "HP D/10", fmt: "0.0"}],
    hp_damage_per_10m: [{k: "hp_kd", label: "HP K/D", fmt: "0.00"}, {k: "hp_engagements_10m", label: "HP ENG/10", fmt: "0.0"}],
    hp_engagements_10m: [{k: "hp_kills_per_10m", label: "HP K/10", fmt: "0.0"}, {k: "hp_damage_per_10m", label: "HP DMG/10", fmt: "0.0"}],
    snd_kills_per_round: [{k: "snd_kd", label: "SnD K/D", fmt: "0.00"}, {k: "first_blood_pct", label: "FB%", fmt: "pct"}],
    snd_kd: [{k: "snd_kills_per_round", label: "SnD KPR", fmt: "0.00"}, {k: "snd_deaths_per_round", label: "SnD DPR", fmt: "0.00"}],
    first_blood_pct: [{k: "snd_kills_per_round", label: "SnD KPR", fmt: "0.00"}, {k: "snd_kd", label: "SnD K/D", fmt: "0.00"}],
    ovl_kills_per_10m: [{k: "ovl_kd", label: "OVL K/D", fmt: "0.00"}, {k: "ovl_damage_per_10m", label: "OVL DMG/10", fmt: "0.0"}],
    ovl_kd: [{k: "ovl_kills_per_10m", label: "OVL K/10", fmt: "0.0"}, {k: "ovl_deaths_per_10m", label: "OVL D/10", fmt: "0.0"}],
    dmg_per_10m: [{k: "kd", label: "K/D", fmt: "0.00"}, {k: "hp_kills_per_10m", label: "HP K/10", fmt: "0.0"}]
  };

  var filtered = analysis.playerStats.filter(function(p) {
    if (roleFilter === "All") return true;
    return p.role === roleFilter;
  });
  var sorted = filtered.slice().sort(function(a, b) { return s(b, sortBy) - s(a, sortBy); });

  var fmtVal = function(v, fmt) {
    if (fmt === "pct") return (v * 100).toFixed(1) + "%";
    if (fmt === "0.0") return v.toFixed(1);
    return v.toFixed(2);
  };

  var mainFmt = sortBy === "first_blood_pct" ? "pct" : (sortBy.indexOf("per_10m") !== -1 || sortBy.indexOf("per_round") !== -1 || sortBy === "dmg_per_10m") ? "0.0" : "0.00";
  var roles = ["All"];
  var roleSet = {};
  analysis.playerStats.forEach(function(p) { if (p.role && !roleSet[p.role]) { roleSet[p.role] = true; roles.push(p.role); } });
  var ctx = contextStats[sortBy] || contextStats.kd;
  var sortLabel = "";
  sortOptions.forEach(function(opt) { if (opt.key === sortBy) sortLabel = opt.label; });

  return <div>
    <div className="flex flex-wrap gap-1.5 mb-3">
      {sortOptions.map(function(opt) {
        return <button key={opt.key} onClick={function() { setSortBy(opt.key); }} className="px-2.5 py-1 rounded-lg text-xs font-semibold" style={{background: sortBy === opt.key ? "rgba(233,69,96,0.2)" : "rgba(255,255,255,0.05)", color: sortBy === opt.key ? "#e94560" : "#666"}}>{opt.label}</button>;
      })}
      <div style={{width: "1px", background: "rgba(255,255,255,0.08)", margin: "0 4px", alignSelf: "stretch"}} />
      {roles.map(function(r) {
        return <button key={r} onClick={function() { setRoleFilter(r); }} className="px-2.5 py-1 rounded-lg text-xs font-semibold" style={{background: roleFilter === r ? "rgba(83,168,182,0.2)" : "rgba(255,255,255,0.05)", color: roleFilter === r ? "#53a8b6" : "#666"}}>{r}</button>;
      })}
    </div>
    <div style={{fontSize: "11px", color: "#555", marginBottom: "10px"}}>{sorted.length} players · Sorted by {sortLabel}</div>
    {sorted.map(function(p, i) {
      var matches = s(p, "matches_played");
      var mainVal = s(p, sortBy);
      var mainColor = sortBy.indexOf("kd") !== -1 || sortBy === "kd" ? kdColor(mainVal) : mainVal > 0 ? "#52b788" : "#888";
      return <div key={p.player_id} className="flex items-center gap-2 py-2.5 px-2 rounded-lg" style={{background: i % 2 === 0 ? "rgba(255,255,255,0.025)" : "transparent", borderBottom: "1px solid rgba(255,255,255,0.02)"}}>
        <span className="text-xs font-bold flex-shrink-0" style={{width: "24px", textAlign: "center", color: i < 3 ? "#e94560" : "#555"}}>{i + 1}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5"><span className="text-sm font-semibold text-white truncate">{p.gamertag}</span><RoleBadge role={p.role} /></div>
          <div className="flex items-center gap-2 mt-0.5"><span style={{fontSize: "11px", color: "#555"}}>{p.team_abbr || p.team_short}</span><span style={{fontSize: "10px", color: "#444"}}>{matches} matches</span></div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {ctx.map(function(c) {
            return <div key={c.k} className="text-center hidden sm:block"><div style={{fontSize: "9px", color: "#555"}}>{c.label}</div><div style={{fontSize: "12px", fontWeight: 600, color: "#aaa"}}>{fmtVal(s(p, c.k), c.fmt)}</div></div>;
          })}
          <div className="text-center" style={{minWidth: "48px"}}><div style={{fontSize: "9px", color: "#555"}}>{sortLabel}</div><div style={{fontSize: "16px", fontWeight: 700, color: mainColor}}>{fmtVal(mainVal, mainFmt)}</div></div>
        </div>
      </div>;
    })}
  </div>;
}

// ─── LINES TAB (CDL PROP LINE CHECK) ────────────────────────
// Mode name constants — the view returns these from the modes table
var MODE_HP = "Hardpoint";
var MODE_SND = "Search and Destroy";
var MODE_OVL = "Overload";

// Line categories matching how books structure CDL props
var LINE_CATS = [
  {key: "map1", label: "Map 1 Kills", sub: "Hardpoint", mode: MODE_HP, field: "kills", source: "map"},
  {key: "map2", label: "Map 2 Kills", sub: "Search & Destroy", mode: MODE_SND, field: "kills", source: "map"},
  {key: "map3", label: "Map 3 Kills", sub: "Overload", mode: MODE_OVL, field: "kills", source: "map"},
  {key: "m13kills", label: "Maps 1-3 Kills", sub: "First 3 maps only", mode: null, field: "kills", source: "combo"},
  {key: "serieskd", label: "Series K/D", sub: "Full series", mode: null, field: "kd", source: "series"},
];

function CDLLineCheck(props) {
  var player = props.player;
  var init = props.initialParams || {};
  var [cat, setCat] = useState(init.cat || "map1");
  var [threshold, setThreshold] = useState(init.threshold || "");
  var [direction, setDirection] = useState(init.direction || "over");
  var [range, setRange] = useState(init.range || 10);
  var [loading, setLoading] = useState(true);
  var [mapLogs, setMapLogs] = useState([]);
  var [seriesLogs, setSeriesLogs] = useState([]);
  var [sharing, setSharing] = useState(false);
  var [linkCopied, setLinkCopied] = useState(false);

  useEffect(function() {
    (async function() {
      try {
        setLoading(true);
        var results = await Promise.all([
          fetchPlayerMapStats(player.player_id),
          fetchPlayerMatchStats(player.player_id)
        ]);
        setMapLogs(results[0] || []);
        setSeriesLogs(results[1] || []);
      } catch(e) { console.error(e); setMapLogs([]); setSeriesLogs([]); }
      finally { setLoading(false); }
    })();
  }, [player.player_id]);

  if (loading) return <div className="py-6 text-center"><div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{borderColor: "#52b788", borderTopColor: "transparent"}} /><p className="text-xs mt-2" style={{color: "#555"}}>Loading match history...</p></div>;

  var activeCat = null;
  LINE_CATS.forEach(function(c) { if (c.key === cat) activeCat = c; });
  if (!activeCat) activeCat = LINE_CATS[0];

  // Build the data points based on category
  var dataPoints = [];
  if (activeCat.source === "map") {
    var filtered = mapLogs.filter(function(m) { return m.mode_name === activeCat.mode; });
    dataPoints = filtered.slice(0, range).map(function(m) {
      return {
        value: Number(m[activeCat.field]) || 0,
        opp: m.opp_team_abbr || "?",
        oppColor: m.opp_team_color || "#888",
        date: m.scheduled_at,
        mapName: m.map_name || "",
        won: m.won_map,
        wonSeries: m.won_series,
        kills: m.kills || 0,
        deaths: m.deaths || 0,
        kd: m.deaths > 0 ? (m.kills / m.deaths) : m.kills
      };
    });
  } else if (activeCat.source === "combo") {
    var onlyFirst3 = mapLogs.filter(function(m) { return m.map_number <= 3; });
    var matchGroups = {};
    var matchOrder = [];
    onlyFirst3.forEach(function(m) {
      var mid = m.match_id;
      if (!matchGroups[mid]) {
        matchGroups[mid] = {kills: 0, deaths: 0, opp: m.opp_team_abbr || "?", oppColor: m.opp_team_color || "#888", date: m.scheduled_at, wonSeries: m.won_series, mapsInGroup: 0};
        matchOrder.push(mid);
      }
      matchGroups[mid].kills += (m.kills || 0);
      matchGroups[mid].deaths += (m.deaths || 0);
      matchGroups[mid].mapsInGroup += 1;
    });
    dataPoints = matchOrder.filter(function(mid) {
      return matchGroups[mid].mapsInGroup >= 3;
    }).slice(0, range).map(function(mid) {
      var g = matchGroups[mid];
      return {
        value: g.kills,
        opp: g.opp,
        oppColor: g.oppColor,
        date: g.date,
        mapName: "",
        won: g.wonSeries,
        wonSeries: g.wonSeries,
        kills: g.kills,
        deaths: g.deaths,
        kd: g.deaths > 0 ? (g.kills / g.deaths) : g.kills
      };
    });
  } else {
    var sliced = seriesLogs.slice(0, range);
    dataPoints = sliced.map(function(m) {
      var val;
      if (activeCat.field === "kd") {
        val = m.deaths > 0 ? (m.kills / m.deaths) : m.kills;
      } else {
        val = Number(m[activeCat.field]) || 0;
      }
      return {
        value: val,
        opp: m.opp_team_abbr || "?",
        oppColor: m.opp_team_color || "#888",
        date: m.scheduled_at,
        mapName: "",
        won: m.won_series,
        wonSeries: m.won_series,
        kills: m.kills || 0,
        deaths: m.deaths || 0,
        kd: m.deaths > 0 ? (m.kills / m.deaths) : m.kills
      };
    });
  }

  var threshNum = Number(threshold);
  var hasThreshold = threshold !== "" && !isNaN(threshNum);
  var isKd = activeCat.field === "kd";

  var hits = hasThreshold ? dataPoints.filter(function(d) {
    return direction === "over" ? d.value >= threshNum : d.value < threshNum;
  }) : [];
  var hitPct = hasThreshold && dataPoints.length > 0 ? (hits.length / dataPoints.length * 100) : 0;

  var avg = 0;
  if (dataPoints.length > 0) {
    var sum = 0;
    dataPoints.forEach(function(d) { sum += d.value; });
    avg = sum / dataPoints.length;
  }

  var hitColor = hitPct >= 60 ? "#52b788" : hitPct >= 40 ? "#ffd166" : "#ff6b6b";

  return <div>
    <div className="rounded-xl p-3 mb-3" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}}>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {LINE_CATS.map(function(c) {
          var isActive = cat === c.key;
          return <button key={c.key} onClick={function() { setCat(c.key); }} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all" style={{
            background: isActive ? "rgba(82,183,136,0.15)" : "rgba(255,255,255,0.04)",
            color: isActive ? "#52b788" : "#666"
          }}>
            <span>{c.label}</span>
          </button>;
        })}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex rounded-lg overflow-hidden" style={{border: "1px solid rgba(255,255,255,0.08)"}}>
          <button onClick={function() { setDirection("over"); }} className="px-3 py-2 text-xs font-bold transition-all" style={{background: direction === "over" ? "rgba(82,183,136,0.2)" : "transparent", color: direction === "over" ? "#52b788" : "#666"}}>Over</button>
          <button onClick={function() { setDirection("under"); }} className="px-3 py-2 text-xs font-bold transition-all" style={{background: direction === "under" ? "rgba(255,107,107,0.2)" : "transparent", color: direction === "under" ? "#ff6b6b" : "#666"}}>Under</button>
        </div>
        <input type="number" inputMode="decimal" step={isKd ? "0.01" : "1"} value={threshold} onChange={function(e) { setThreshold(e.target.value); }} placeholder={isKd ? "1.00" : "Line"} className="p-2 rounded-lg text-white text-sm text-center outline-none" style={{background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", width: "72px", fontSize: "16px"}} />
        <div className="flex rounded-lg overflow-hidden" style={{border: "1px solid rgba(255,255,255,0.08)"}}>
          {[5, 10, 15, 20].map(function(n) {
            return <button key={n} onClick={function() { setRange(n); }} className="px-2.5 py-2 text-xs font-bold transition-all" style={{background: range === n ? "rgba(233,69,96,0.15)" : "transparent", color: range === n ? "#e94560" : "#666"}}>L{n}</button>;
          })}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span style={{fontSize: "10px", color: "#444"}}>{dataPoints.length} {activeCat.source === "map" ? "maps" : "series"} found</span>
        {activeCat.sub && <span style={{fontSize: "10px", color: "#555", background: "rgba(255,255,255,0.04)", padding: "2px 6px", borderRadius: "4px"}}>{activeCat.sub}</span>}
      </div>
    </div>

    {hasThreshold && dataPoints.length > 0 && <div>
      <div className="rounded-xl p-4 mb-3" style={{
        background: hitPct >= 60 ? "rgba(82,183,136,0.06)" : hitPct >= 40 ? "rgba(255,209,102,0.06)" : "rgba(255,107,107,0.06)",
        border: "1px solid " + (hitPct >= 60 ? "rgba(82,183,136,0.15)" : hitPct >= 40 ? "rgba(255,209,102,0.15)" : "rgba(255,107,107,0.15)")
      }}>
        <div className="flex items-center gap-3 mb-3 pb-3" style={{borderBottom: "1px solid rgba(255,255,255,0.04)"}}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5"><span className="text-sm font-bold text-white truncate">{player.gamertag}</span><RoleBadge role={player.role} /></div>
            <span style={{fontSize: "11px", color: "#555"}}>{player.team_abbr || player.team_short}</span>
          </div>
          <div className="grid grid-cols-3 gap-3 flex-shrink-0">
            <div className="text-center"><div style={{fontSize: "9px", color: "#555"}}>K/D</div><div className="text-sm font-bold" style={{color: kdColor(s(player, "kd"))}}>{s(player, "kd").toFixed(2)}</div></div>
            <div className="text-center"><div style={{fontSize: "9px", color: "#555"}}>HP K/10</div><div className="text-sm font-bold" style={{color: "#aaa"}}>{s(player, "hp_kills_per_10m").toFixed(1)}</div></div>
            <div className="text-center"><div style={{fontSize: "9px", color: "#555"}}>SnD KPR</div><div className="text-sm font-bold" style={{color: "#aaa"}}>{s(player, "snd_kills_per_round").toFixed(2)}</div></div>
          </div>
        </div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-sm font-bold uppercase" style={{color: hitColor}}>{direction} {isKd ? threshNum.toFixed(2) : threshNum} {activeCat.label}</div>
            <div className="text-xs" style={{color: "#555"}}>Last {dataPoints.length} {activeCat.source === "map" ? "maps" : "series"}</div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-black" style={{color: hitColor}}>{hits.length}/{dataPoints.length}</div>
            <div className="text-sm font-bold" style={{color: hitColor}}>{hitPct.toFixed(0)}%</div>
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap mb-2">
          {dataPoints.map(function(d, i) {
            var hit = direction === "over" ? d.value >= threshNum : d.value < threshNum;
            var display = isKd ? d.value.toFixed(1) : d.value;
            return <div key={i} className="flex flex-col items-center">
              <div className="w-8 h-8 rounded-full flex items-center justify-center font-bold" style={{
                background: hit ? "rgba(82,183,136,0.2)" : "rgba(255,107,107,0.15)",
                color: hit ? "#52b788" : "#ff6b6b",
                fontSize: "10px"
              }}>{display}</div>
              <span style={{fontSize: "8px", color: d.oppColor || "#444", marginTop: "2px"}}>{d.opp}</span>
            </div>;
          })}
        </div>
        <div className="flex items-center justify-between mt-2 pt-2" style={{borderTop: "1px solid rgba(255,255,255,0.04)"}}>
          <span style={{fontSize: "10px", color: "#333", fontWeight: 700}}>BARRACKS</span>
          <span style={{fontSize: "10px", color: "#444"}}>Avg: {isKd ? avg.toFixed(2) : avg.toFixed(1)} / {activeCat.source === "map" ? "map" : "series"}</span>
        </div>
      </div>
      <div className="flex justify-center gap-2 mb-3">
        <button onClick={function() {
          if (sharing) return;
          setSharing(true);
          var lineParams = new URLSearchParams();
          lineParams.set("line", [player.gamertag || "", cat, direction, threshold, range].join(","));
          var shareUrl = window.location.origin + window.location.pathname + "?" + lineParams.toString();
          import("./shareRenderer.js").then(function(mod) {
            return mod.shareLineCard({
              gamertag: player.gamertag,
              role: player.role,
              teamAbbr: player.team_abbr || player.team_short || "",
              teamColor: player.team_color || "#888",
              seasonKd: s(player, "kd"),
              seasonHpK10: s(player, "hp_kills_per_10m"),
              seasonSndKpr: s(player, "snd_kills_per_round"),
              catLabel: activeCat.label,
              catSub: activeCat.sub || "",
              direction: direction,
              threshold: threshNum,
              isKd: isKd,
              dataPoints: dataPoints,
              hits: hits.length,
              total: dataPoints.length,
              hitPct: hitPct,
              avg: avg
            }, shareUrl);
          }).catch(function(e) { console.error("Share error:", e); }).finally(function() { setSharing(false); });
        }} disabled={sharing} className="px-4 py-2 rounded-xl text-xs font-bold transition-all" style={{background: sharing ? "rgba(233,69,96,0.2)" : "#e94560", color: "#fff", opacity: sharing ? 0.6 : 1}}>
          {sharing ? "Generating..." : "\uD83D\uDCE4 Share"}
        </button>
        <button onClick={function() {
          var params = new URLSearchParams();
          params.set("line", [player.gamertag || "", cat, direction, threshold, range].join(","));
          var url = window.location.origin + window.location.pathname + "?" + params.toString();
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function() { setLinkCopied(true); setTimeout(function() { setLinkCopied(false); }, 2000); }).catch(function() { prompt("Copy this link:", url); });
          } else {
            prompt("Copy this link:", url);
          }
        }} className="px-4 py-2 rounded-xl text-xs font-bold transition-all" style={{background: "rgba(255,255,255,0.06)", color: linkCopied ? "#52b788" : "#888"}}>
          {linkCopied ? "\u2713 Copied!" : "\uD83D\uDD17 Copy link"}
        </button>
      </div>
    </div>}

    {activeCat.source === "map" && dataPoints.length > 0 && (function() {
      // Group dataPoints by map name
      var mapGroups = {};
      var mapOrder = [];
      dataPoints.forEach(function(d) {
        var name = d.mapName || "Unknown";
        if (!mapGroups[name]) {
          mapGroups[name] = {maps: [], kills: 0, deaths: 0};
          mapOrder.push(name);
        }
        mapGroups[name].maps.push(d);
        mapGroups[name].kills += d.kills;
        mapGroups[name].deaths += d.deaths;
      });
      // Only show if more than one map name
      if (mapOrder.length <= 1) return null;
      // Compute per-map stats
      var mapStats = mapOrder.map(function(name) {
        var g = mapGroups[name];
        var count = g.maps.length;
        var avgVal = 0;
        g.maps.forEach(function(d) { avgVal += d.value; });
        avgVal = count > 0 ? avgVal / count : 0;
        var mapKd = g.deaths > 0 ? (g.kills / g.deaths) : g.kills;
        var hitCount = 0;
        if (hasThreshold) {
          g.maps.forEach(function(d) {
            if (direction === "over" ? d.value >= threshNum : d.value < threshNum) hitCount++;
          });
        }
        return {name: name, count: count, avg: avgVal, kd: mapKd, hitCount: hitCount, total: count};
      });
      // Sort by highest average first
      mapStats.sort(function(a, b) { return b.avg - a.avg; });
      return <div className="rounded-xl mb-3 overflow-hidden" style={{border: "1px solid rgba(255,255,255,0.06)"}}>
        <div className="px-3 py-2 flex items-center justify-between" style={{borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)"}}>
          <span className="text-xs font-bold uppercase tracking-wider" style={{color: "#888"}}>By map</span>
          <span style={{fontSize: "9px", color: "#444"}}>{mapOrder.length} maps played</span>
        </div>
        <div className="px-2 py-1.5 grid items-center" style={{
          gridTemplateColumns: hasThreshold ? "1fr 28px 46px 42px 52px" : "1fr 28px 46px 42px",
          fontSize: "9px", color: "#555", textTransform: "uppercase", letterSpacing: "0.5px", borderBottom: "1px solid rgba(255,255,255,0.04)"
        }}>
          <span>Map</span>
          <span className="text-center">#</span>
          <span className="text-center">Avg</span>
          <span className="text-center">K/D</span>
          {hasThreshold && <span className="text-center">Hit</span>}
        </div>
        {mapStats.map(function(ms, i) {
          var avgAbove = ms.avg >= avg;
          var hitPctMap = hasThreshold && ms.total > 0 ? (ms.hitCount / ms.total * 100) : 0;
          var hitMapColor = hitPctMap >= 60 ? "#52b788" : hitPctMap >= 40 ? "#ffd166" : "#ff6b6b";
          return <div key={ms.name} className="px-2 py-2 grid items-center" style={{
            gridTemplateColumns: hasThreshold ? "1fr 28px 46px 42px 52px" : "1fr 28px 46px 42px",
            borderBottom: "1px solid rgba(255,255,255,0.02)",
            background: i % 2 === 0 ? "rgba(255,255,255,0.015)" : "transparent"
          }}>
            <span className="text-xs font-semibold text-white truncate">{ms.name}</span>
            <span className="text-xs text-center tabular-nums" style={{color: "#666"}}>{ms.count}</span>
            <span className="text-xs text-center font-bold tabular-nums" style={{color: avgAbove ? "#52b788" : "#ff6b6b"}}>{isKd ? ms.avg.toFixed(2) : ms.avg.toFixed(1)}</span>
            <span className="text-xs text-center font-bold tabular-nums" style={{color: kdColor(ms.kd)}}>{ms.kd.toFixed(2)}</span>
            {hasThreshold && <span className="text-xs text-center font-bold tabular-nums" style={{color: hitMapColor}}>{ms.hitCount}/{ms.total}</span>}
          </div>;
        })}
        <div className="px-2 py-2 grid items-center" style={{
          gridTemplateColumns: hasThreshold ? "1fr 28px 46px 42px 52px" : "1fr 28px 46px 42px",
          borderTop: "1px solid rgba(255,255,255,0.06)",
          background: "rgba(255,255,255,0.02)"
        }}>
          <span className="text-xs font-bold uppercase" style={{color: "#555"}}>Overall</span>
          <span className="text-xs text-center tabular-nums" style={{color: "#555"}}>{dataPoints.length}</span>
          <span className="text-xs text-center font-bold tabular-nums" style={{color: "#888"}}>{isKd ? avg.toFixed(2) : avg.toFixed(1)}</span>
          <span className="text-xs text-center font-bold tabular-nums" style={{color: "#888"}}>{(function() { var tk = 0, td = 0; dataPoints.forEach(function(d) { tk += d.kills; td += d.deaths; }); return td > 0 ? (tk / td).toFixed(2) : "—"; })()}</span>
          {hasThreshold && <span className="text-xs text-center font-bold tabular-nums" style={{color: "#888"}}>{hits.length}/{dataPoints.length}</span>}
        </div>
      </div>;
    })()}

    {dataPoints.length > 0 && <div className="rounded-xl overflow-hidden" style={{border: "1px solid rgba(255,255,255,0.06)"}}>
      <div className="px-2 py-1.5 grid items-center" style={{
        gridTemplateColumns: activeCat.source === "map" ? "42px 1fr 36px 36px 42px 36px" : "42px 1fr 36px 36px 42px 36px",
        fontSize: "9px", color: "#555", textTransform: "uppercase", letterSpacing: "0.5px", borderBottom: "1px solid rgba(255,255,255,0.06)"
      }}>
        <span>OPP</span>
        <span>{activeCat.source === "map" ? "MAP" : "DATE"}</span>
        <span className="text-center">K</span>
        <span className="text-center">D</span>
        <span className="text-center">K/D</span>
        <span className="text-center">W/L</span>
      </div>
      {dataPoints.map(function(d, i) {
        return <div key={i} className="px-2 py-1.5 grid items-center" style={{
          gridTemplateColumns: "42px 1fr 36px 36px 42px 36px",
          borderBottom: "1px solid rgba(255,255,255,0.02)",
          background: i % 2 === 0 ? "rgba(255,255,255,0.015)" : "transparent"
        }}>
          <span className="text-xs font-bold truncate" style={{color: d.oppColor || "#888"}}>{d.opp}</span>
          <span style={{fontSize: "9px", color: "#444"}}>{d.mapName ? d.mapName : (d.date ? new Date(d.date).toLocaleDateString("en-US", {month: "short", day: "numeric"}) : "")}</span>
          <span className="text-xs text-center font-bold text-white tabular-nums">{d.kills}</span>
          <span className="text-xs text-center tabular-nums" style={{color: "#aaa"}}>{d.deaths}</span>
          <span className="text-xs text-center font-bold tabular-nums" style={{color: kdColor(d.kd)}}>{d.kd.toFixed(2)}</span>
          <span className="text-xs text-center font-bold" style={{color: (activeCat.source === "map" ? d.won : d.wonSeries) ? "#52b788" : "#ff6b6b"}}>{(activeCat.source === "map" ? d.won : d.wonSeries) ? "W" : "L"}</span>
        </div>;
      })}
    </div>}

    {dataPoints.length === 0 && <div className="text-center py-6 text-xs" style={{color: "#555"}}>No {activeCat.source === "map" ? activeCat.sub : "series"} data found for this player</div>}
  </div>;
}

function CDLLinesTab(props) {
  var analysis = props.analysis;
  var [query, setQuery] = useState("");
  var [selectedPlayer, setSelectedPlayer] = useState(null);
  var [initialLineParams, setInitialLineParams] = useState(null);
  var [switchQuery, setSwitchQuery] = useState("");
  var [switchOpen, setSwitchOpen] = useState(false);

  useEffect(function() {
    try {
      var params = new URLSearchParams(window.location.search);
      var lineParam = params.get("line");
      if (!lineParam) return;
      var parts = lineParam.split(",");
      if (parts.length >= 3) {
        var playerName = decodeURIComponent(parts[0]).toLowerCase();
        var found = analysis.playerStats.find(function(p) { return p.gamertag && p.gamertag.toLowerCase() === playerName; });
        if (found) {
          setSelectedPlayer(found);
          setInitialLineParams({cat: parts[1] || "map1", direction: parts[2] || "over", threshold: parts[3] || "", range: parseInt(parts[4]) || 10});
        }
      }
    } catch(e) {}
  }, [analysis]);

  var results = useMemo(function() {
    if (query.length < 2) return [];
    var q = query.toLowerCase();
    return analysis.playerStats.filter(function(p) {
      return (p.gamertag && p.gamertag.toLowerCase().indexOf(q) !== -1) || (p.team_name && p.team_name.toLowerCase().indexOf(q) !== -1);
    }).sort(function(a, b) { return s(b, "kd") - s(a, "kd"); }).slice(0, 8);
  }, [query, analysis]);

  return <div>
    {!selectedPlayer ? <div>
      <div className="mb-4">
        <h2 className="text-lg font-bold text-white mb-1">Line check</h2>
        <p className="text-xs" style={{color: "#555"}}>Check how often a player hits over/under a kill or K/D line</p>
      </div>
      <input type="text" value={query} onChange={function(e) { setQuery(e.target.value); }} placeholder="Search player..." className="w-full p-3 rounded-xl text-white placeholder-gray-600 outline-none mb-3" style={{background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", fontSize: "16px"}} />

      {results.length > 0 && <div className="space-y-1">
        {results.map(function(p) {
          return <div key={p.player_id} className="flex items-center gap-3 p-3 rounded-xl cursor-pointer hover:bg-white/5 transition-colors" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.04)"}} onClick={function() { setSelectedPlayer(p); setQuery(""); }}>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-white truncate">{p.gamertag}</div>
              <div className="flex items-center gap-1.5"><RoleBadge role={p.role} /><span style={{fontSize: "11px", color: "#555"}}>{p.team_abbr || p.team_short}</span></div>
            </div>
            <div className="text-right flex-shrink-0">
              <div className="text-sm font-bold" style={{color: kdColor(s(p, "kd"))}}>{s(p, "kd").toFixed(2)}</div>
              <div style={{fontSize: "10px", color: "#555"}}>K/D</div>
            </div>
          </div>;
        })}
      </div>}

      {query.length < 2 && <div>
        <div className="text-xs font-bold uppercase tracking-wider mb-3" style={{color: "#555"}}>Top K/D players</div>
        <div className="space-y-1">
          {analysis.playerStats.slice().sort(function(a, b) { return s(b, "kd") - s(a, "kd"); }).slice(0, 12).map(function(p, i) {
            return <div key={p.player_id} className="flex items-center gap-3 p-2.5 rounded-xl cursor-pointer hover:bg-white/5 transition-colors" style={{background: i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent"}} onClick={function() { setSelectedPlayer(p); }}>
              <span className="text-xs font-bold w-5 text-center" style={{color: i < 3 ? "#e94560" : "#444"}}>{i + 1}</span>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-semibold text-white truncate block">{p.gamertag}</span>
                <div className="flex items-center gap-1"><RoleBadge role={p.role} /><span style={{fontSize: "10px", color: "#555"}}>{p.team_abbr || p.team_short}</span></div>
              </div>
              <div className="text-right">
                <div className="text-sm font-bold" style={{color: kdColor(s(p, "kd"))}}>{s(p, "kd").toFixed(2)}</div>
                <div style={{fontSize: "9px", color: "#555"}}>K/D</div>
              </div>
              <span className="text-xs font-bold px-2 py-1 rounded-lg" style={{background: "rgba(82,183,136,0.1)", color: "#52b788", fontSize: "10px"}}>Check line {"\u2192"}</span>
            </div>;
          })}
        </div>
      </div>}
    </div> : <div>
      <button onClick={function() { setSelectedPlayer(null); setSwitchQuery(""); setSwitchOpen(false); }} className="text-xs font-semibold mb-3 flex items-center gap-1" style={{color: "#e94560"}}>{"\u2190"} Back</button>

      <div className="relative mb-3">
        <div style={{position: "relative"}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none"}}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" value={switchQuery} onChange={function(e) { setSwitchQuery(e.target.value); setSwitchOpen(true); }} onFocus={function() { setSwitchOpen(true); }} onBlur={function() { setTimeout(function() { setSwitchOpen(false); }, 200); }} placeholder="Switch to another player..." className="w-full py-2.5 pr-3 rounded-xl text-white placeholder-gray-600 outline-none" style={{background: "rgba(255,255,255,0.04)", border: switchOpen && switchQuery.length >= 2 ? "1px solid rgba(233,69,96,0.3)" : "1px solid rgba(255,255,255,0.07)", fontSize: "16px", paddingLeft: "34px"}} />
        </div>
        {switchOpen && switchQuery.length >= 2 && <div className="absolute left-0 right-0 top-full mt-1 rounded-xl overflow-hidden z-50" style={{background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 8px 32px rgba(0,0,0,0.5)", maxHeight: "300px", overflowY: "auto"}}>
          {(function() {
            var sq = switchQuery.toLowerCase();
            var switchResults = analysis.playerStats.filter(function(p) {
              return (p.gamertag && p.gamertag.toLowerCase().indexOf(sq) !== -1) || (p.team_name && p.team_name.toLowerCase().indexOf(sq) !== -1);
            }).sort(function(a, b) { return s(b, "kd") - s(a, "kd"); }).slice(0, 8);
            if (switchResults.length === 0) return <div className="p-4 text-center text-xs" style={{color: "#555"}}>No players found</div>;
            return switchResults.map(function(p) {
              var isActive = p.player_id === selectedPlayer.player_id;
              return <div key={p.player_id} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-white/5 transition-colors" style={{background: isActive ? "rgba(233,69,96,0.08)" : "transparent", borderBottom: "1px solid rgba(255,255,255,0.03)"}} onClick={function() { setSelectedPlayer(p); setSwitchOpen(false); setSwitchQuery(""); setInitialLineParams(null); }}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5"><span className="text-sm font-semibold text-white truncate">{p.gamertag}</span>{isActive && <span style={{fontSize: "9px", color: "#e94560", fontWeight: 700}}>VIEWING</span>}</div>
                  <div className="flex items-center gap-1"><RoleBadge role={p.role} /><span style={{fontSize: "10px", color: "#555"}}>{p.team_abbr || ""}</span></div>
                </div>
                <div className="text-sm font-bold" style={{color: kdColor(s(p, "kd"))}}>{s(p, "kd").toFixed(2)}</div>
              </div>;
            });
          })()}
        </div>}
      </div>

      <div className="flex items-center gap-3 p-3 rounded-xl mb-4" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5"><span className="text-base font-bold text-white truncate">{selectedPlayer.gamertag}</span><RoleBadge role={selectedPlayer.role} /></div>
          <span className="text-xs" style={{color: "#888"}}>{selectedPlayer.team_name || selectedPlayer.team_abbr || ""}</span>
        </div>
        <div className="grid grid-cols-3 gap-3 flex-shrink-0">
          <div className="text-center"><div style={{fontSize: "9px", color: "#555"}}>K/D</div><div className="text-sm font-bold" style={{color: kdColor(s(selectedPlayer, "kd"))}}>{s(selectedPlayer, "kd").toFixed(2)}</div></div>
          <div className="text-center"><div style={{fontSize: "9px", color: "#555"}}>HP K/10</div><div className="text-sm font-bold" style={{color: "#aaa"}}>{s(selectedPlayer, "hp_kills_per_10m").toFixed(1)}</div></div>
          <div className="text-center"><div style={{fontSize: "9px", color: "#555"}}>Matches</div><div className="text-sm font-bold" style={{color: "#aaa"}}>{s(selectedPlayer, "matches_played")}</div></div>
        </div>
      </div>

      <CDLLineCheck key={selectedPlayer.player_id} player={selectedPlayer} initialParams={initialLineParams} />
    </div>}
  </div>;
}

// ─── SCHEDULE TAB ───────────────────────────────────────────

function ScheduleTab(props) {
  var analysis = props.analysis, openTeam = props.openTeam;
  var [view, setView] = useState("upcoming");
  var [selectedEventId, setSelectedEventId] = useState(null);

  // Extract unique events from completed results
  var resultEvents = useMemo(function() {
    var seen = {};
    var list = [];
    (analysis.results || []).forEach(function(r) {
      var ev = r.event;
      if (ev && ev.id && !seen[ev.id]) {
        seen[ev.id] = true;
        list.push({id: ev.id, name: ev.name || "", short: ev.short || ""});
      }
    });
    return list;
  }, [analysis.results]);

  // Default to the first event (most recent matches come first, so first event = current)
  var activeEventId = selectedEventId || (resultEvents.length > 0 ? resultEvents[0].id : null);

  // Filter results by selected event
  var filteredResults = activeEventId ? (analysis.results || []).filter(function(r) {
    return r.event && r.event.id === activeEventId;
  }) : (analysis.results || []);

  return <div className="space-y-3">
    <WhosHot topKd={analysis.topKd} topHpK={analysis.topHpK} topSndKpr={analysis.topSndKpr} />

    {/* Upcoming / Results toggle */}
    <div className="flex rounded-xl overflow-hidden" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}}>
      <button onClick={function() { setView("upcoming"); }} className="flex-1 py-2.5 text-sm font-bold transition-all" style={{
        background: view === "upcoming" ? "#e94560" : "transparent",
        color: view === "upcoming" ? "#fff" : "#555"
      }}>Upcoming</button>
      <button onClick={function() { setView("results"); }} className="flex-1 py-2.5 text-sm font-bold transition-all" style={{
        background: view === "results" ? "#e94560" : "transparent",
        color: view === "results" ? "#fff" : "#555"
      }}>Results</button>
    </div>

    {view === "upcoming" && <div className="space-y-3">
      {analysis.matchups.map(function(mu) { return <MatchCard key={mu.id} mu={mu} onTeamClick={openTeam} />; })}
      {analysis.matchups.length === 0 && <div className="text-center py-8 opacity-30"><p className="text-sm">No upcoming matches with known teams</p></div>}
    </div>}

    {view === "results" && <div className="space-y-3">
      {/* Event selector */}
      {resultEvents.length > 1 && <div className="flex flex-wrap gap-1.5">
        {resultEvents.map(function(ev) {
          var isActive = ev.id === activeEventId;
          return <button key={ev.id} onClick={function() { setSelectedEventId(ev.id); }} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all" style={{
            background: isActive ? "rgba(233,69,96,0.2)" : "rgba(255,255,255,0.04)",
            color: isActive ? "#e94560" : "#666",
            border: isActive ? "1px solid rgba(233,69,96,0.3)" : "1px solid rgba(255,255,255,0.06)"
          }}>{ev.short || ev.name}</button>;
        })}
      </div>}

      {filteredResults.map(function(r) { return <ResultCard key={r.id} result={r} onTeamClick={openTeam} analysis={analysis} />; })}
      {filteredResults.length === 0 && <div className="text-center py-8 opacity-30"><p className="text-sm">No completed matches for this event</p></div>}
    </div>}
  </div>;
}

// ─── PICKS TAB ───────────────────────────────────────────────

var SCORE_OPTIONS = ["3-0", "3-1", "3-2"];

function PickCard(props) {
  var mu = props.mu, pick = props.pick, onPick = props.onPick;
  var t1S = (mu.t1 && mu.t1.name_short) || "?";
  var t2S = (mu.t2 && mu.t2.name_short) || "?";
  var t1Color = (mu.t1Stats && mu.t1Stats.team_color) || "#888";
  var t2Color = (mu.t2Stats && mu.t2Stats.team_color) || "#888";
  var t1Id = mu.home_team_id;
  var t2Id = mu.away_team_id;
  var pickedTeam = pick ? pick.teamId : null;
  var pickedScore = pick ? pick.score : null;
  var isT1Picked = pickedTeam === t1Id;
  var isT2Picked = pickedTeam === t2Id;
  var hasPick = pickedTeam && pickedScore;

  var handleTeamPick = function(teamId) {
    if (pickedTeam === teamId) {
      // Deselect team — clear pick
      onPick(mu.id, null);
    } else {
      // Select team, keep score if already set
      onPick(mu.id, {teamId: teamId, score: pickedScore || null});
    }
  };

  var handleScorePick = function(score) {
    if (!pickedTeam) return;
    if (pickedScore === score) {
      // Deselect score
      onPick(mu.id, {teamId: pickedTeam, score: null});
    } else {
      onPick(mu.id, {teamId: pickedTeam, score: score});
    }
  };

  // Derive the losing team's map wins from the score
  var loserWins = "";
  if (hasPick) {
    var parts = pickedScore.split("-");
    loserWins = parts[1] || "0";
  }

  return <div className="rounded-xl overflow-hidden" style={{
    background: hasPick ? "rgba(82,183,136,0.04)" : "rgba(255,255,255,0.03)",
    border: hasPick ? "1px solid rgba(82,183,136,0.15)" : "1px solid rgba(255,255,255,0.06)",
    transition: "all 0.2s"
  }}>
    {/* Match info header */}
    <div className="px-4 pt-3 pb-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs uppercase tracking-wider opacity-40">{(mu.event && mu.event.name_short) || ""} · Bo{mu.bestOf}</span>
        <span className="text-xs opacity-40">{utcToET(mu.datetime)}</span>
      </div>
    </div>

    {/* Team selection */}
    <div className="px-4 pb-3">
      <div className="flex items-center gap-3">
        {/* Team 1 button */}
        <button onClick={function() { handleTeamPick(t1Id); }} className="flex-1 flex items-center gap-2 p-3 rounded-xl transition-all" style={{
          background: isT1Picked ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)",
          border: isT1Picked ? "2px solid " + t1Color : "2px solid rgba(255,255,255,0.06)",
          cursor: "pointer"
        }}>
          <div className="w-1.5 h-8 rounded-full flex-shrink-0" style={{background: t1Color}} />
          <span className="font-bold text-white text-lg">{t1S}</span>
          {isT1Picked && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#52b788" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="ml-auto flex-shrink-0"><polyline points="20 6 9 17 4 12"/></svg>}
        </button>

        <div className="flex-shrink-0">
          <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{background: "rgba(255,255,255,0.04)"}}>
            <span style={{fontSize: "10px", fontWeight: 800, color: "#555"}}>VS</span>
          </div>
        </div>

        {/* Team 2 button */}
        <button onClick={function() { handleTeamPick(t2Id); }} className="flex-1 flex items-center gap-2 p-3 rounded-xl transition-all" style={{
          background: isT2Picked ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)",
          border: isT2Picked ? "2px solid " + t2Color : "2px solid rgba(255,255,255,0.06)",
          cursor: "pointer"
        }}>
          {isT2Picked && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#52b788" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="20 6 9 17 4 12"/></svg>}
          <span className="font-bold text-white text-lg">{t2S}</span>
          <div className="w-1.5 h-8 rounded-full flex-shrink-0 ml-auto" style={{background: t2Color}} />
        </button>
      </div>

      {/* Score selection — only show when a team is picked */}
      {pickedTeam && <div className="mt-3">
        <div className="flex items-center gap-2">
          <span style={{fontSize: "10px", color: "#555", textTransform: "uppercase", letterSpacing: "0.5px"}}>Predicted score</span>
          <div className="flex gap-1.5 flex-1 justify-end">
            {SCORE_OPTIONS.map(function(score) {
              var isActive = pickedScore === score;
              var winnerAbbr = isT1Picked ? t1S : t2S;
              var loserAbbr = isT1Picked ? t2S : t1S;
              var parts = score.split("-");
              return <button key={score} onClick={function() { handleScorePick(score); }} className="px-3 py-2 rounded-lg text-xs font-bold transition-all" style={{
                background: isActive ? "rgba(82,183,136,0.2)" : "rgba(255,255,255,0.04)",
                border: isActive ? "1px solid rgba(82,183,136,0.3)" : "1px solid rgba(255,255,255,0.06)",
                color: isActive ? "#52b788" : "#666"
              }}>
                {score}
              </button>;
            })}
          </div>
        </div>
      </div>}

      {/* Pick summary */}
      {hasPick && <div className="mt-3 pt-3 flex items-center justify-between" style={{borderTop: "1px solid rgba(255,255,255,0.04)"}}>
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 rounded" style={{background: isT1Picked ? t1Color : t2Color}} />
          <span className="text-xs font-bold" style={{color: "#52b788"}}>
            {isT1Picked ? t1S : t2S} wins {pickedScore}
          </span>
        </div>
        <button onClick={function() { onPick(mu.id, null); }} className="text-xs px-2 py-1 rounded opacity-40 hover:opacity-80" style={{background: "rgba(255,255,255,0.05)"}}>Clear</button>
      </div>}
    </div>
  </div>;
}

function SharedPicksBanner(props) {
  var sharedPicks = props.sharedPicks, matchups = props.matchups, onAdopt = props.onAdopt, onDismiss = props.onDismiss;

  // Build a summary of shared picks
  var pickSummaries = [];
  Object.keys(sharedPicks).forEach(function(mid) {
    var p = sharedPicks[mid];
    if (!p || !p.teamId || !p.score) return;
    var mu = matchups.find(function(m) { return String(m.id) === String(mid); });
    if (!mu) return;
    var isT1 = p.teamId === mu.home_team_id;
    pickSummaries.push({
      winnerAbbr: isT1 ? (mu.t1 && mu.t1.name_short) : (mu.t2 && mu.t2.name_short),
      winnerColor: isT1 ? ((mu.t1Stats && mu.t1Stats.team_color) || "#888") : ((mu.t2Stats && mu.t2Stats.team_color) || "#888"),
      loserAbbr: isT1 ? (mu.t2 && mu.t2.name_short) : (mu.t1 && mu.t1.name_short),
      score: p.score
    });
  });

  if (pickSummaries.length === 0) return null;

  return <div className="rounded-xl mb-4 overflow-hidden" style={{background: "rgba(83,168,182,0.06)", border: "1px solid rgba(83,168,182,0.15)"}}>
    <div className="px-4 pt-3 pb-2">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#53a8b6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          <span className="text-sm font-bold" style={{color: "#53a8b6"}}>Someone shared their picks</span>
        </div>
        <button onClick={onDismiss} className="text-xs opacity-40 hover:opacity-80 px-2 py-1" style={{color: "#888"}}>{"\u2715"}</button>
      </div>
    </div>

    {/* Compact pick list */}
    <div className="px-4 pb-2">
      <div className="flex flex-wrap gap-2">
        {pickSummaries.map(function(ps, i) {
          return <div key={i} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg" style={{background: "rgba(255,255,255,0.04)"}}>
            <div className="w-1 h-4 rounded-full" style={{background: ps.winnerColor}} />
            <span className="text-xs font-bold text-white">{ps.winnerAbbr}</span>
            <span className="text-xs font-bold" style={{color: "#52b788"}}>{ps.score}</span>
            <span className="text-xs" style={{color: "#555"}}>{ps.loserAbbr}</span>
          </div>;
        })}
      </div>
    </div>

    {/* Action buttons */}
    <div className="px-4 pb-3 pt-2 flex gap-2" style={{borderTop: "1px solid rgba(83,168,182,0.1)"}}>
      <button onClick={onAdopt} className="flex-1 py-2 rounded-xl text-xs font-bold" style={{background: "rgba(83,168,182,0.15)", color: "#53a8b6", border: "1px solid rgba(83,168,182,0.2)"}}>Use as starting point</button>
      <button onClick={onDismiss} className="flex-1 py-2 rounded-xl text-xs font-bold" style={{background: "rgba(255,255,255,0.04)", color: "#888", border: "1px solid rgba(255,255,255,0.06)"}}>Start fresh</button>
    </div>
  </div>;
}

function PicksTab(props) {
  var analysis = props.analysis;

  // Separate shared picks from user's own picks
  var [sharedPicks] = useState(function() {
    try {
      var params = new URLSearchParams(window.location.search);
      var shared = params.get("picks");
      if (shared) return decodePicksParam(shared);
    } catch(e) {}
    return null;
  });
  var [showSharedBanner, setShowSharedBanner] = useState(!!sharedPicks);
  var [picks, setPicks] = useState(function() { return loadPicks(); });
  var [linkCopied, setLinkCopied] = useState(false);
  var [sharing, setSharing] = useState(false);
  var [selectedEventId, setSelectedEventId] = useState(null);

  var matchups = analysis.matchups;

  // Extract unique events from matchups
  var events = useMemo(function() {
    var seen = {};
    var list = [];
    matchups.forEach(function(mu) {
      var ev = mu.event;
      if (ev && ev.id && !seen[ev.id]) {
        seen[ev.id] = true;
        list.push({id: ev.id, name: ev.name || "", short: ev.name_short || ""});
      }
    });
    return list;
  }, [matchups]);

  // Default to the first event if not selected
  var activeEventId = selectedEventId || (events.length > 0 ? events[0].id : null);
  var activeEvent = events.find(function(e) { return e.id === activeEventId; }) || events[0] || null;
  var activeEventName = activeEvent ? (activeEvent.name || activeEvent.short || "Picks") : "Picks";
  var activeEventShort = activeEvent ? (activeEvent.short || activeEvent.name || "Picks") : "Picks";

  // Filter matchups by selected event
  var filteredMatchups = activeEventId ? matchups.filter(function(mu) {
    return mu.event && mu.event.id === activeEventId;
  }) : matchups;

  var handlePick = function(matchId, pick) {
    setPicks(function(prev) {
      var next = Object.assign({}, prev);
      if (!pick || (!pick.teamId)) {
        delete next[matchId];
      } else {
        next[matchId] = pick;
      }
      savePicks(next);
      return next;
    });
  };

  // Count picks only for the filtered matches
  var filteredMatchIds = {};
  filteredMatchups.forEach(function(mu) { filteredMatchIds[mu.id] = true; });
  var completedPicks = Object.keys(picks).filter(function(mid) {
    var p = picks[mid];
    return p && p.teamId && p.score && filteredMatchIds[mid];
  });
  var totalMatches = filteredMatchups.length;
  var pickedCount = completedPicks.length;

  var handleClearAll = function() {
    setPicks(function(prev) {
      var next = Object.assign({}, prev);
      filteredMatchups.forEach(function(mu) {
        delete next[mu.id];
      });
      savePicks(next);
      return next;
    });
  };

  var handleAdoptShared = function() {
    if (!sharedPicks) return;
    setPicks(function(prev) {
      var next = Object.assign({}, prev, sharedPicks);
      savePicks(next);
      return next;
    });
    setShowSharedBanner(false);
    window.history.replaceState(null, "", window.location.pathname);
  };

  var handleDismissShared = function() {
    setShowSharedBanner(false);
    window.history.replaceState(null, "", window.location.pathname);
  };

  var handleCopyLink = function() {
    var eventPicks = {};
    completedPicks.forEach(function(mid) { eventPicks[mid] = picks[mid]; });
    var encoded = encodePicksParam(eventPicks);
    if (!encoded) return;
    var url = window.location.origin + window.location.pathname + "?picks=" + encoded;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function() {
        setLinkCopied(true); setTimeout(function() { setLinkCopied(false); }, 2000);
      }).catch(function() { prompt("Copy this link:", url); });
    } else {
      prompt("Copy this link:", url);
    }
  };

  var handleShareImage = function() {
    if (sharing || pickedCount === 0) return;
    setSharing(true);
    var pickData = completedPicks.map(function(mid) {
      var p = picks[mid];
      var mu = filteredMatchups.find(function(m) { return String(m.id) === String(mid); });
      if (!mu) return null;
      var isT1 = p.teamId === mu.home_team_id;
      return {
        winnerAbbr: isT1 ? (mu.t1 && mu.t1.name_short) : (mu.t2 && mu.t2.name_short),
        winnerColor: isT1 ? ((mu.t1Stats && mu.t1Stats.team_color) || "#888") : ((mu.t2Stats && mu.t2Stats.team_color) || "#888"),
        loserAbbr: isT1 ? (mu.t2 && mu.t2.name_short) : (mu.t1 && mu.t1.name_short),
        loserColor: isT1 ? ((mu.t2Stats && mu.t2Stats.team_color) || "#888") : ((mu.t1Stats && mu.t1Stats.team_color) || "#888"),
        score: p.score,
        eventShort: (mu.event && mu.event.name_short) || "",
        datetime: mu.datetime
      };
    }).filter(Boolean);

    var eventPicks = {};
    completedPicks.forEach(function(mid) { eventPicks[mid] = picks[mid]; });
    var encoded = encodePicksParam(eventPicks);
    var shareUrl = window.location.origin + window.location.pathname + "?picks=" + encoded;

    import("./shareRenderer.js").then(function(mod) {
      return mod.sharePicksImage(pickData, shareUrl, activeEventName);
    }).then(function() { setSharing(false); }).catch(function(e) { console.error(e); setSharing(false); });
  };

  return <div>
    {/* Header with event name */}
    <div className="mb-4">
      <h2 className="text-lg font-bold text-white mb-1">{activeEventName}</h2>
      <p className="text-xs" style={{color: "#555"}}>Pick who you think wins each series and the score</p>
    </div>

    {/* Shared picks banner */}
    {showSharedBanner && sharedPicks && <SharedPicksBanner sharedPicks={sharedPicks} matchups={matchups} onAdopt={handleAdoptShared} onDismiss={handleDismissShared} />}

    {/* Event selector — only show if there are multiple events */}
    {events.length > 1 && <div className="flex flex-wrap gap-1.5 mb-4">
      {events.map(function(ev) {
        var isActive = ev.id === activeEventId;
        return <button key={ev.id} onClick={function() { setSelectedEventId(ev.id); }} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all" style={{
          background: isActive ? "rgba(233,69,96,0.2)" : "rgba(255,255,255,0.04)",
          color: isActive ? "#e94560" : "#666",
          border: isActive ? "1px solid rgba(233,69,96,0.3)" : "1px solid rgba(255,255,255,0.06)"
        }}>{ev.short || ev.name}</button>;
      })}
    </div>}

    {/* Summary card */}
    <div className="rounded-xl p-4 mb-4" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-2xl font-black text-white">{pickedCount}<span style={{fontSize: "14px", fontWeight: 400, color: "#555"}}>/{totalMatches}</span></div>
          <div style={{fontSize: "10px", color: "#555", textTransform: "uppercase"}}>Matches picked</div>
        </div>
        {/* Progress bar */}
        <div className="flex-1 mx-4">
          <div className="h-2 rounded-full overflow-hidden" style={{background: "rgba(255,255,255,0.06)"}}>
            <div className="h-full rounded-full transition-all" style={{
              width: (totalMatches > 0 ? (pickedCount / totalMatches * 100) : 0) + "%",
              background: pickedCount === totalMatches && totalMatches > 0 ? "#52b788" : "#e94560"
            }} />
          </div>
        </div>
        {pickedCount === totalMatches && totalMatches > 0 && <span className="text-xs font-bold px-2 py-1 rounded-lg" style={{background: "rgba(82,183,136,0.15)", color: "#52b788"}}>All in!</span>}
      </div>

      {/* Share buttons */}
      {pickedCount > 0 && <div className="flex gap-2">
        <button onClick={handleShareImage} disabled={sharing} className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold" style={{background: sharing ? "rgba(233,69,96,0.3)" : "#e94560", color: "#fff", opacity: sharing ? 0.7 : 1}}>
          {sharing ? <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{borderColor: "#fff", borderTopColor: "transparent"}} /> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>}
          <span>{sharing ? "Generating..." : "Share picks"}</span>
        </button>
        <button onClick={handleCopyLink} className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold" style={{background: linkCopied ? "rgba(82,183,136,0.15)" : "rgba(255,255,255,0.06)", border: linkCopied ? "1px solid rgba(82,183,136,0.3)" : "1px solid rgba(255,255,255,0.1)", color: linkCopied ? "#52b788" : "#c8c8d0"}}>
          {linkCopied ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>}
          <span>{linkCopied ? "Copied!" : "Copy link"}</span>
        </button>
      </div>}

      {/* Clear all */}
      {pickedCount > 0 && <div className="mt-3 pt-3 flex justify-end" style={{borderTop: "1px solid rgba(255,255,255,0.04)"}}>
        <button onClick={handleClearAll} className="text-xs px-3 py-1.5 rounded-lg font-semibold transition-all hover:opacity-100" style={{background: "rgba(255,107,107,0.08)", color: "#ff6b6b", border: "1px solid rgba(255,107,107,0.15)", opacity: 0.7}}>Clear all picks</button>
      </div>}
    </div>

    {/* Match pick cards */}
    <div className="space-y-3">
      {filteredMatchups.map(function(mu) {
        return <PickCard key={mu.id} mu={mu} pick={picks[mu.id] || null} onPick={handlePick} />;
      })}
      {filteredMatchups.length === 0 && <div className="text-center py-8 opacity-30"><p className="text-sm">No upcoming matches for this event</p></div>}
    </div>
  </div>;
}

// ─── REDDIT FEED ────────────────────────────────────────────

var FEED_SUBS = [
  {id: "CoDCompetitive", label: "r/CoDCompetitive"},
  {id: "CallOfDuty", label: "r/CallOfDuty"}
];
var FEED_SORTS = [
  {id: "hot", label: "Hot"},
  {id: "new", label: "New"},
  {id: "top", label: "Top"},
  {id: "rising", label: "Rising"}
];

async function fetchRedditFeed(sub, sort) {
  var res = await fetch("/api/reddit?sub=" + encodeURIComponent(sub) + "&sort=" + encodeURIComponent(sort) + "&limit=25");
  if (!res.ok) throw new Error("Feed fetch failed (" + res.status + ")");
  return res.json();
}

function timeAgo(dateStr) {
  var d = new Date(dateStr);
  var now = new Date();
  var diff = Math.floor((now - d) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  if (diff < 604800) return Math.floor(diff / 86400) + "d ago";
  return d.toLocaleDateString("en-US", {month: "short", day: "numeric"});
}

function proxyThumb(url) {
  if (!url) return "";
  // Route Reddit preview images through our proxy to avoid CORS blocks
  try {
    var host = new URL(url).hostname;
    if (host.indexOf("redd.it") !== -1 || host.indexOf("redditmedia.com") !== -1) {
      return "/api/reddit-image?url=" + encodeURIComponent(url);
    }
  } catch(e) {}
  return url;
}

function FeedCard(props) {
  var post = props.post;
  var hasThumb = post.thumbnail && post.thumbnail.indexOf("http") === 0 && post.thumbnail.indexOf("reddit.com/awards") === -1;
  var [thumbFailed, setThumbFailed] = useState(false);
  var showThumb = hasThumb && !thumbFailed;

  return <a href={post.link} target="_blank" rel="noopener noreferrer" className="block rounded-xl p-4 transition-all" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}} onMouseEnter={function(e) { e.currentTarget.style.background = "rgba(233,69,96,0.06)"; e.currentTarget.style.borderColor = "rgba(233,69,96,0.2)"; }} onMouseLeave={function(e) { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"; }}>
    <div className="flex gap-3">
      {showThumb ? <div className="flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden" style={{background: "rgba(255,255,255,0.05)"}}>
        <img src={proxyThumb(post.thumbnail)} alt="" className="w-full h-full object-cover" onError={function() { setThumbFailed(true); }} />
      </div> : <div className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center" style={{background: "rgba(233,69,96,0.08)"}}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e94560" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </div>}
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-bold text-white leading-snug mb-1" style={{display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden"}}>{post.title}</h3>
        {post.preview && <p className="text-xs leading-relaxed mb-2" style={{color: "#777", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden"}}>{post.preview}</p>}
        <div className="flex items-center gap-2 flex-wrap">
          {post.category && <span className="text-xs font-semibold px-1.5 py-0.5 rounded" style={{background: "rgba(233,69,96,0.12)", color: "#e94560", fontSize: "10px"}}>{post.category}</span>}
          <span style={{fontSize: "10px", color: "#555"}}>u/{post.author}</span>
          <span style={{fontSize: "10px", color: "#444"}}>{timeAgo(post.updated)}</span>
        </div>
      </div>
      <div className="flex-shrink-0 self-center opacity-30">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </div>
    </div>
  </a>;
}

function FeedTab() {
  var [activeSub, setActiveSub] = useState("CoDCompetitive");
  var [activeSort, setActiveSort] = useState("hot");
  var [posts, setPosts] = useState([]);
  var [feedLoading, setFeedLoading] = useState(true);
  var [feedError, setFeedError] = useState(null);

  useEffect(function() {
    var cancelled = false;
    setFeedLoading(true);
    setFeedError(null);
    fetchRedditFeed(activeSub, activeSort).then(function(data) {
      if (!cancelled) {
        setPosts(data.entries || []);
        setFeedLoading(false);
      }
    }).catch(function(e) {
      if (!cancelled) {
        setFeedError(e.message);
        setFeedLoading(false);
      }
    });
    return function() { cancelled = true; };
  }, [activeSub, activeSort]);

  return <div>
    <div className="mb-4">
      <h2 className="text-lg font-bold text-white mb-1">Reddit feed</h2>
      <p className="text-xs" style={{color: "#555"}}>Latest CoD discussion from Reddit</p>
    </div>

    {/* Subreddit selector */}
    <div className="flex flex-wrap gap-1.5 mb-3">
      {FEED_SUBS.map(function(sub) {
        var isActive = sub.id === activeSub;
        return <button key={sub.id} onClick={function() { setActiveSub(sub.id); }} className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all" style={{
          background: isActive ? "rgba(233,69,96,0.2)" : "rgba(255,255,255,0.04)",
          color: isActive ? "#e94560" : "#666",
          border: isActive ? "1px solid rgba(233,69,96,0.3)" : "1px solid rgba(255,255,255,0.06)"
        }}>{sub.label}</button>;
      })}
    </div>

    {/* Sort selector */}
    <div className="flex gap-1 mb-4">
      {FEED_SORTS.map(function(sort) {
        var isActive = sort.id === activeSort;
        return <button key={sort.id} onClick={function() { setActiveSort(sort.id); }} className="px-2.5 py-1 rounded-md text-xs font-semibold transition-all" style={{
          background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
          color: isActive ? "#c8c8d0" : "#555"
        }}>{sort.label}</button>;
      })}
    </div>

    {/* Feed content */}
    {feedLoading && <div className="flex items-center justify-center py-12">
      <div className="text-center space-y-3">
        <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{borderColor: "#e94560", borderTopColor: "transparent"}} />
        <p className="text-xs" style={{color: "#555"}}>Loading posts...</p>
      </div>
    </div>}

    {feedError && <div className="rounded-xl p-4 text-center" style={{background: "rgba(233,69,96,0.08)", border: "1px solid rgba(233,69,96,0.2)"}}>
      <p className="text-sm font-bold mb-1" style={{color: "#e94560"}}>Failed to load feed</p>
      <p className="text-xs" style={{color: "#777"}}>{feedError}</p>
      <button onClick={function() { setActiveSort(activeSort); }} className="mt-3 px-3 py-1.5 rounded-lg text-xs font-bold" style={{background: "#e94560", color: "#fff"}}>Retry</button>
    </div>}

    {!feedLoading && !feedError && posts.length === 0 && <div className="text-center py-12 opacity-30">
      <p className="text-sm">No posts found</p>
    </div>}

    {!feedLoading && !feedError && posts.length > 0 && <div className="space-y-2">
      {posts.map(function(post, idx) {
        return <FeedCard key={post.id || idx} post={post} />;
      })}
      <div className="text-center pt-4 pb-2">
        <a href={"https://www.reddit.com/r/" + activeSub + "/" + activeSort} target="_blank" rel="noopener noreferrer" className="text-xs font-bold px-4 py-2 rounded-lg inline-block transition-all" style={{background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#888"}} onMouseEnter={function(e) { e.currentTarget.style.color = "#e94560"; }} onMouseLeave={function(e) { e.currentTarget.style.color = "#888"; }}>
          View more on Reddit &rarr;
        </a>
      </div>
    </div>}
  </div>;
}

// ─── MAIN APP ────────────────────────────────────────────────

var TABS = ["Schedule", "Picks", "Rankings", "Teams", "Compare", "Players", "Lines", "Feed", "Search"];

export default function App() {
  var urlParams = useMemo(function() { try { return new URLSearchParams(window.location.search); } catch(e) { return new URLSearchParams(); } }, []);
  var compareParam = urlParams.get("compare");
  var lineParam = urlParams.get("line");
  var picksParam = urlParams.get("picks");
  var [tab, setTab] = useState(compareParam ? "Compare" : lineParam ? "Lines" : picksParam ? "Picks" : "Schedule");
  var [loading, setLoading] = useState(true);
  var [error, setError] = useState(null);
  var [analysis, setAnalysis] = useState(null);
  var [teamPageId, setTeamPageId] = useState(null);

  var openTeam = function(tid) { setTeamPageId(tid); setTab("Teams"); };
  var closeTeam = function() { setTeamPageId(null); };

  useEffect(function() {
    (async function() {
      try {
        setLoading(true);
        setError(null);
        var results = await Promise.all([fetchPlayers(), fetchTeams(), fetchMatches(), fetchRosters(), fetchStandings(null), fetchStandings(CURRENT_EVENT_ID), fetchResults()]);
        setAnalysis(buildAnalysis(results[0], results[1], results[2], results[3], results[4], results[5], results[6]));
      } catch(e) {
        console.error(e);
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(function() {
  if (window.location.search.includes("notrack")) {
    localStorage.setItem("barracks_no_track", "true");
  }
}, []);

  if (loading) return <div className="min-h-screen flex items-center justify-center" style={{background: "#0d0d1a"}}><div className="text-center space-y-3"><div className="w-10 h-10 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{borderColor: "#e94560", borderTopColor: "transparent"}} /><p className="text-sm" style={{color: "#888"}}>Loading CDL data...</p></div></div>;

  if (error) return <div className="min-h-screen flex items-center justify-center" style={{background: "#0d0d1a"}}><div className="text-center p-6 rounded-xl max-w-md" style={{background: "rgba(233,69,96,0.1)", border: "1px solid rgba(233,69,96,0.3)"}}><p className="text-lg font-bold mb-2" style={{color: "#e94560"}}>Failed to load</p><p className="text-sm opacity-60">{error}</p><button onClick={function() { window.location.reload(); }} className="mt-4 px-4 py-2 rounded-lg text-sm font-bold" style={{background: "#e94560", color: "#fff"}}>Retry</button></div></div>;

  var majorName = (analysis.majorStandings && analysis.majorStandings[0] && analysis.majorStandings[0].event_name) || "Major";

  return <div className="min-h-screen" style={{background: "#0d0d1a", color: "#c8c8d0"}}>
    <Analytics beforeSend={function(event) {
  if (localStorage.getItem("barracks_no_track")) return null;
  return event;
}} />
    <div className="sticky top-0 z-50 backdrop-blur-xl" style={{background: "rgba(13,13,26,0.9)", borderBottom: "1px solid rgba(255,255,255,0.06)"}}>
      <div className="max-w-4xl mx-auto px-4 py-3">
        <div className="flex items-center justify-between mb-3"><div><h1 className="text-xl font-black tracking-tight" style={{color: "#e94560"}}>BARRACKS</h1><p className="text-xs opacity-30">CDL 2026</p></div><div className="text-right text-xs opacity-30">{analysis.power.length} teams · {analysis.matchups.length} matchups</div></div>
        <div className="flex gap-1 overflow-x-auto">{TABS.map(function(t) { return <button key={t} onClick={function() { setTab(t); if (t !== "Teams") setTeamPageId(null); }} className="px-3 sm:px-4 py-1.5 rounded-lg text-sm font-bold transition-all whitespace-nowrap" style={{background: tab === t ? "#e94560" : "transparent", color: tab === t ? "#fff" : "#666"}}>{t}</button>; })}</div>
      </div>
    </div>
    <div className="max-w-4xl mx-auto px-4 py-6">
      {tab === "Schedule" && <ScheduleTab analysis={analysis} openTeam={openTeam} />}
      {tab === "Picks" && <PicksTab analysis={analysis} />}
      {tab === "Rankings" && <div><h2 className="text-lg font-bold text-white mb-4">Power rankings</h2><PowerRankings power={analysis.power} /></div>}
      {tab === "Teams" && <div>
        {teamPageId ? <TeamPage tid={teamPageId} analysis={analysis} onBack={closeTeam} /> : <div>
          <h2 className="text-lg font-bold text-white mb-1">CDL standings</h2>
          <p className="text-xs opacity-40 mb-4">Ordered by {majorName} standings</p>
          <TeamsGrid analysis={analysis} onTeamClick={setTeamPageId} />
        </div>}
      </div>}
      {tab === "Compare" && <div><h2 className="text-lg font-bold text-white mb-4">Player comparison</h2><PlayerCompare analysis={analysis} initialCompare={compareParam} /></div>}
      {tab === "Players" && <div><h2 className="text-lg font-bold text-white mb-4">Player leaderboard</h2><PlayerLeaderboard analysis={analysis} /></div>}
      {tab === "Lines" && <div><CDLLinesTab analysis={analysis} /></div>}
      {tab === "Feed" && <FeedTab />}
      {tab === "Search" && <div><h2 className="text-lg font-bold text-white mb-4">Player lookup</h2><PlayerSearch analysis={analysis} /></div>}
    </div>
    <div className="text-center py-6 mt-8" style={{borderTop: "1px solid rgba(255,255,255,0.04)"}}><p style={{fontSize: "11px", color: "#444"}}>BARRACKS · CDL 2026</p></div>
  </div>;
}
