import { useState, useEffect, useMemo, useCallback } from "react"; 

const CURRENT_EVENT_ID = 102;

// Data fetched through /api/supabase proxy — credentials stay server-side
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
  // Filter to CDL matches only
  return mySupaFetch("match_view", "select=*&status=neq.completed&event_is_cdl=eq.true&order=scheduled_at.asc");
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
  return mySupaFetch("match_stats_view", "select=*&player_id=eq." + playerId + "&order=scheduled_at.desc&limit=30");
}

async function fetchPlayerMapStats(playerId) {
  // Fetch per-map stats from map_stats_view (for Map 1/2/3 individual lines)
  return mySupaFetch("map_stats_view", "select=*&player_id=eq." + playerId + "&order=scheduled_at.desc,map_number.asc&limit=150");
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

// ─── PACE HELPERS ────────────────────────────────────────────
// Derive team pace per mode by averaging roster player stats from the leaderboard.
// Returns { hp: avgKillsPer10, snd: avgKPR, ovl: avgKillsPer10, hpEng: avgEng10 }

function computeTeamPace(rosterPlayerStats) {
  if (!rosterPlayerStats || rosterPlayerStats.length === 0) return null;
  var hp = 0, snd = 0, ovl = 0, hpEng = 0, n = rosterPlayerStats.length;
  rosterPlayerStats.forEach(function(p) {
    hp += s(p, "hp_kills_per_10m");
    snd += s(p, "snd_kills_per_round");
    ovl += s(p, "ovl_kills_per_10m");
    hpEng += s(p, "hp_engagements_10m");
  });
  return { hp: hp / n, snd: snd / n, ovl: ovl / n, hpEng: hpEng / n };
}

function computeLeagueAvgPace(allTeamPaces) {
  if (!allTeamPaces || allTeamPaces.length === 0) return { hp: 22, snd: 0.7, ovl: 22, hpEng: 40 };
  var hp = 0, snd = 0, ovl = 0, hpEng = 0, n = allTeamPaces.length;
  allTeamPaces.forEach(function(p) {
    hp += p.hp; snd += p.snd; ovl += p.ovl; hpEng += p.hpEng;
  });
  return { hp: hp / n, snd: snd / n, ovl: ovl / n, hpEng: hpEng / n };
}

// Matchup pace factor: how much faster/slower this matchup plays relative to league avg.
// Returns a multiplier per mode — e.g. 1.08 means 8% more kills expected.
// Formula: average both teams' pace, divide by league avg.
function computeMatchupPaceFactor(playerTeamPace, oppTeamPace, leagueAvg) {
  if (!playerTeamPace || !oppTeamPace || !leagueAvg) return null;
  var matchupAvg = function(key) { return (playerTeamPace[key] + oppTeamPace[key]) / 2; };
  var factor = function(key) { return leagueAvg[key] > 0 ? matchupAvg(key) / leagueAvg[key] : 1; };
  return {
    hp: factor("hp"),
    snd: factor("snd"),
    ovl: factor("ovl"),
    hpEng: factor("hpEng"),
    // Raw matchup averages for display
    raw: { hp: matchupAvg("hp"), snd: matchupAvg("snd"), ovl: matchupAvg("ovl"), hpEng: matchupAvg("hpEng") }
  };
}

function paceLabel(factor) {
  if (factor >= 1.08) return { text: "High pace", color: "#52b788", icon: "\u26A1" };
  if (factor >= 1.03) return { text: "Above avg", color: "#a3be8c", icon: "\u25B2" };
  if (factor >= 0.97) return { text: "Average", color: "#ffd166", icon: "\u25CF" };
  if (factor >= 0.92) return { text: "Below avg", color: "#e9965a", icon: "\u25BC" };
  return { text: "Low pace", color: "#ff6b6b", icon: "\u25BC" };
}

// Apply pace factor to a player's average to get a matchup-adjusted projection
function paceAdjustedProjection(playerAvg, paceFactor) {
  return playerAvg * paceFactor;
}

// ─── BUILD ANALYSIS ──────────────────────────────────────────
// Views give us names already, so this is much simpler than v1.

function buildAnalysis(players, teams, matches, rosters, seasonStandings, majorStandings) {
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

  // ─── PACE DATA ───────────────────────────────────────────
  // Compute per-team pace from roster player stats
  var teamPaces = {};
  Object.keys(teamStats).forEach(function(tid) {
    var rs = rosterStats(Number(tid));
    var pace = computeTeamPace(rs);
    if (pace) teamPaces[tid] = pace;
  });
  var leagueAvgPace = computeLeagueAvgPace(Object.values(teamPaces));

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

    matchups.push({id: m.id, datetime: m.scheduled_at, bestOf: m.best_of, t1: t1Obj, t2: t2Obj, event: evObj, round: m.round_name, t1Stats: t1, t2Stats: t2, t1Roster: rosterStats(m.home_team_id), t2Roster: rosterStats(m.away_team_id), p1: p1, p2: p2, edge: edge, favored: favored});
  });

  return {power: power, matchups: matchups, teamStats: teamStats, playerStats: allPs, rosterStats: rosterStats, topKd: topKd, topHpK: topHpK, topSndKpr: topSndKpr, teamLookup: teamLookup, teamPlayers: teamPlayers, powerLookup: powerLookup, standingsLookup: standingsLookup, majorStandingsLookup: majorStandingsLookup, seasonStandings: seasonStandings || [], majorStandings: majorStandings || [], teamPaces: teamPaces, leagueAvgPace: leagueAvgPace};
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
        <input type="text" value={q1} onChange={function(e) { setQ1(e.target.value); setP1(null); setShow1(true); }} onFocus={function() { setShow1(true); }} onBlur={function() { setTimeout(function() { setShow1(false); }, 300); }} placeholder="Player 1..." className="w-full p-2.5 sm:p-3 rounded-lg text-white placeholder-gray-500 outline-none" style={{background: "rgba(255,255,255,0.06)", border: p1 ? "1px solid rgba(82,183,136,0.4)" : "1px solid rgba(255,255,255,0.1)", fontSize: "15px"}} />
        {show1 && r1.length > 0 && !p1 && <div className="absolute z-10 w-full mt-1 rounded-lg overflow-hidden" style={{background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 12px 32px rgba(0,0,0,0.5)"}}>
          {r1.map(function(p) { return <div key={p.player_id} className="flex items-center gap-2 p-3 cursor-pointer hover:bg-white/5 active:bg-white/10" onMouseDown={function(e) { handleItem(e, pick1, p); }} onTouchEnd={function(e) { handleItem(e, pick1, p); }}>
            <span className="text-white font-medium text-sm">{p.gamertag}</span><RoleBadge role={p.role} /><span className="text-xs opacity-40 ml-auto">{p.team_abbr || p.team_short}</span>
          </div>; })}
        </div>}
      </div>
      <div className="flex items-center justify-center pt-2"><div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0" style={{background: "rgba(233,69,96,0.15)", color: "#e94560", fontSize: "10px"}}>VS</div></div>
      <div className="relative flex-1">
        <input type="text" value={q2} onChange={function(e) { setQ2(e.target.value); setP2(null); setShow2(true); }} onFocus={function() { setShow2(true); }} onBlur={function() { setTimeout(function() { setShow2(false); }, 300); }} placeholder="Player 2..." className="w-full p-2.5 sm:p-3 rounded-lg text-white placeholder-gray-500 outline-none" style={{background: "rgba(255,255,255,0.06)", border: p2 ? "1px solid rgba(82,183,136,0.4)" : "1px solid rgba(255,255,255,0.1)", fontSize: "15px"}} />
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
  {key: "map1", label: "Map 1 Kills", sub: "Hardpoint", mode: MODE_HP, field: "kills", source: "map", paceMode: "hp"},
  {key: "map2", label: "Map 2 Kills", sub: "Search & Destroy", mode: MODE_SND, field: "kills", source: "map", paceMode: "snd"},
  {key: "map3", label: "Map 3 Kills", sub: "Overload", mode: MODE_OVL, field: "kills", source: "map", paceMode: "ovl"},
  {key: "m13kills", label: "Maps 1-3 Kills", sub: "First 3 maps only", mode: null, field: "kills", source: "combo", paceMode: "combo"},
  {key: "serieskd", label: "Series K/D", sub: "Full series", mode: null, field: "kd", source: "series", paceMode: null},
];

// ─── MATCHUP PACE CONTEXT PANEL ─────────────────────────────

function MatchupPaceContext(props) {
  var player = props.player;
  var analysis = props.analysis;
  var activeCat = props.activeCat;
  var avg = props.avg; // player's historical average for this line
  var threshold = props.threshold;
  var direction = props.direction;
  var [selectedOpp, setSelectedOpp] = useState(null);
  var [showPicker, setShowPicker] = useState(false);

  var playerTeamId = player.team_id;
  var playerPace = analysis.teamPaces[playerTeamId];
  var leagueAvg = analysis.leagueAvgPace;

  // Find upcoming opponents for this player's team
  var upcomingOpps = useMemo(function() {
    return analysis.matchups.filter(function(mu) {
      return (mu.t1Stats && mu.t1Stats.team_id === playerTeamId) || (mu.t2Stats && mu.t2Stats.team_id === playerTeamId);
    }).map(function(mu) {
      var isHome = mu.t1Stats && mu.t1Stats.team_id === playerTeamId;
      var oppStats = isHome ? mu.t2Stats : mu.t1Stats;
      var oppName = isHome ? mu.t2 : mu.t1;
      return {
        teamId: oppStats ? oppStats.team_id : null,
        name: oppName ? oppName.name : "",
        abbr: oppName ? oppName.name_short : "?",
        color: oppStats ? oppStats.team_color : "#888",
        datetime: mu.datetime,
        event: mu.event
      };
    }).filter(function(o) { return o.teamId; });
  }, [analysis.matchups, playerTeamId]);

  // All CDL teams as fallback picker (excluding player's own team)
  var allTeams = useMemo(function() {
    return Object.values(analysis.teamStats).filter(function(t) { return t.team_id !== playerTeamId; }).map(function(t) {
      return { teamId: t.team_id, name: t.team_name, abbr: t.team_abbr || t.team_short, color: t.team_color };
    }).sort(function(a, b) { return a.name.localeCompare(b.name); });
  }, [analysis.teamStats, playerTeamId]);

  if (!playerPace || !activeCat.paceMode) return null;

  var oppPace = selectedOpp ? analysis.teamPaces[selectedOpp.teamId] : null;
  var paceFactor = oppPace ? computeMatchupPaceFactor(playerPace, oppPace, leagueAvg) : null;

  // Get the relevant pace factor for this line category
  var relevantFactor = null;
  var relevantLabel = "";
  if (paceFactor) {
    if (activeCat.paceMode === "hp") { relevantFactor = paceFactor.hp; relevantLabel = "HP pace"; }
    else if (activeCat.paceMode === "snd") { relevantFactor = paceFactor.snd; relevantLabel = "SnD pace"; }
    else if (activeCat.paceMode === "ovl") { relevantFactor = paceFactor.ovl; relevantLabel = "OVL pace"; }
    else if (activeCat.paceMode === "combo") {
      // Weighted combo: HP and OVL are timed modes with more kills, SnD is round-based
      // Use a rough weighted average: HP 40%, OVL 40%, SnD 20%
      relevantFactor = (paceFactor.hp * 0.4) + (paceFactor.ovl * 0.4) + (paceFactor.snd * 0.2);
      relevantLabel = "Combined pace";
    }
  }

  var paceInfo = relevantFactor ? paceLabel(relevantFactor) : null;
  var projectedAvg = relevantFactor && avg > 0 ? paceAdjustedProjection(avg, relevantFactor) : null;
  var isKd = activeCat.field === "kd";
  var threshNum = Number(threshold);
  var hasThreshold = threshold !== "" && !isNaN(threshNum);

  // Compute pace-adjusted hit likelihood
  var paceVerdict = null;
  if (projectedAvg && hasThreshold) {
    var diff = projectedAvg - threshNum;
    var pctDiff = threshNum > 0 ? (diff / threshNum) * 100 : 0;
    if (direction === "over") {
      if (pctDiff > 8) paceVerdict = { text: "Pace strongly favors OVER", color: "#52b788", icon: "\u2705" };
      else if (pctDiff > 2) paceVerdict = { text: "Pace leans OVER", color: "#a3be8c", icon: "\u25B2" };
      else if (pctDiff > -2) paceVerdict = { text: "Coin flip territory", color: "#ffd166", icon: "\u26A0" };
      else if (pctDiff > -8) paceVerdict = { text: "Pace leans UNDER", color: "#e9965a", icon: "\u25BC" };
      else paceVerdict = { text: "Pace strongly favors UNDER", color: "#ff6b6b", icon: "\u274C" };
    } else {
      // Under direction — invert
      if (pctDiff < -8) paceVerdict = { text: "Pace strongly favors UNDER", color: "#52b788", icon: "\u2705" };
      else if (pctDiff < -2) paceVerdict = { text: "Pace leans UNDER", color: "#a3be8c", icon: "\u25B2" };
      else if (pctDiff < 2) paceVerdict = { text: "Coin flip territory", color: "#ffd166", icon: "\u26A0" };
      else if (pctDiff < 8) paceVerdict = { text: "Pace leans OVER", color: "#e9965a", icon: "\u25BC" };
      else paceVerdict = { text: "Pace strongly favors OVER", color: "#ff6b6b", icon: "\u274C" };
    }
  }

  return <div className="rounded-xl overflow-hidden mb-3" onClick={function(e) { e.stopPropagation(); }} style={{background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)"}}>
    {/* Header */}
    <div className="px-3 py-2 flex items-center justify-between" style={{background: "rgba(83,168,182,0.08)", borderBottom: "1px solid rgba(255,255,255,0.04)"}}>
      <div className="flex items-center gap-2">
        <span style={{fontSize: "12px"}}>&#x1F3AF;</span>
        <span className="text-xs font-bold uppercase tracking-wider" style={{color: "#53a8b6"}}>Matchup pace</span>
      </div>
      <span style={{fontSize: "9px", color: "#555", letterSpacing: "0.5px"}}>BASED ON TEAM ENGAGEMENT RATES</span>
    </div>

    <div className="p-3">
      {/* Opponent selector */}
      <div className="mb-3">
        <div style={{fontSize: "10px", color: "#555", textTransform: "uppercase", marginBottom: "6px"}}>Select opponent</div>

        {/* Quick picks from upcoming schedule */}
        {upcomingOpps.length > 0 && <div className="flex flex-wrap gap-1.5 mb-2">
          {upcomingOpps.map(function(opp, i) {
            var isSelected = selectedOpp && selectedOpp.teamId === opp.teamId;
            return <button type="button" key={opp.teamId + "-" + i} onClick={function(e) { e.stopPropagation(); e.preventDefault(); setSelectedOpp(opp); setShowPicker(false); }} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all" style={{
              background: isSelected ? "rgba(83,168,182,0.2)" : "rgba(255,255,255,0.04)",
              border: isSelected ? "1px solid rgba(83,168,182,0.4)" : "1px solid rgba(255,255,255,0.06)",
              color: isSelected ? "#53a8b6" : "#888"
            }}>
              <div className="w-1.5 h-4 rounded" style={{background: opp.color}} />
              <span>{opp.abbr}</span>
              <span style={{fontSize: "9px", color: "#555", fontWeight: 400}}>{timeUntil(opp.datetime)}</span>
            </button>;
          })}
          <button type="button" onClick={function(e) { e.stopPropagation(); e.preventDefault(); setShowPicker(!showPicker); }} className="px-2 py-1.5 rounded-lg text-xs font-semibold" style={{background: "rgba(255,255,255,0.04)", color: "#555", border: "1px solid rgba(255,255,255,0.06)"}}>
            {showPicker ? "\u2715" : "+"} {showPicker ? "Close" : "Other"}
          </button>
        </div>}

        {/* Full team picker (shown if no upcoming or "Other" clicked) */}
        {(showPicker || upcomingOpps.length === 0) && <div className="flex flex-wrap gap-1.5">
          {allTeams.map(function(t) {
            var isSelected = selectedOpp && selectedOpp.teamId === t.teamId;
            return <button type="button" key={t.teamId} onClick={function(e) { e.stopPropagation(); e.preventDefault(); setSelectedOpp(t); setShowPicker(false); }} className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold transition-all" style={{
              background: isSelected ? "rgba(83,168,182,0.2)" : "rgba(255,255,255,0.03)",
              border: isSelected ? "1px solid rgba(83,168,182,0.3)" : "1px solid rgba(255,255,255,0.04)",
              color: isSelected ? "#53a8b6" : "#666"
            }}>
              <div className="w-1 h-3 rounded" style={{background: t.color}} />
              {t.abbr}
            </button>;
          })}
        </div>}
      </div>

      {/* Pace analysis (shown when opponent selected) */}
      {selectedOpp && relevantFactor && <div>
        {/* Pace meter bar */}
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <span style={{fontSize: "10px", color: "#555"}}>{relevantLabel}</span>
            <span className="text-xs font-bold" style={{color: paceInfo.color}}>{paceInfo.icon} {paceInfo.text}</span>
          </div>
          <div className="relative h-2 rounded-full overflow-hidden" style={{background: "rgba(255,255,255,0.06)"}}>
            {/* Background gradient: red(slow) -> yellow(avg) -> green(fast) */}
            <div className="absolute inset-0 rounded-full" style={{background: "linear-gradient(to right, #ff6b6b, #ffd166 40%, #ffd166 60%, #52b788)"}} />
            {/* Indicator needle */}
            <div className="absolute top-0 h-full" style={{
              left: Math.max(0, Math.min(100, ((relevantFactor - 0.85) / 0.3) * 100)) + "%",
              width: "3px",
              background: "#fff",
              borderRadius: "2px",
              boxShadow: "0 0 6px rgba(255,255,255,0.5)",
              transform: "translateX(-50%)"
            }} />
          </div>
          <div className="flex justify-between mt-1" style={{fontSize: "9px", color: "#444"}}>
            <span>Slow</span>
            <span>Avg</span>
            <span>Fast</span>
          </div>
        </div>

        {/* Factor details */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div className="rounded-lg p-2 text-center" style={{background: "rgba(255,255,255,0.03)"}}>
            <div style={{fontSize: "9px", color: "#555", textTransform: "uppercase"}}>Pace factor</div>
            <div className="text-sm font-bold" style={{color: paceInfo.color}}>{(relevantFactor * 100).toFixed(1)}%</div>
          </div>
          <div className="rounded-lg p-2 text-center" style={{background: "rgba(255,255,255,0.03)"}}>
            <div style={{fontSize: "9px", color: "#555", textTransform: "uppercase"}}>Player avg</div>
            <div className="text-sm font-bold text-white">{isKd ? avg.toFixed(2) : avg.toFixed(1)}</div>
          </div>
          <div className="rounded-lg p-2 text-center" style={{background: "rgba(255,255,255,0.03)"}}>
            <div style={{fontSize: "9px", color: "#555", textTransform: "uppercase"}}>Adj. proj.</div>
            <div className="text-sm font-bold" style={{color: projectedAvg ? (projectedAvg > avg ? "#52b788" : projectedAvg < avg ? "#ff6b6b" : "#ffd166") : "#888"}}>
              {projectedAvg ? (isKd ? projectedAvg.toFixed(2) : projectedAvg.toFixed(1)) : "-"}
            </div>
          </div>
        </div>

        {/* Verdict vs line */}
        {paceVerdict && hasThreshold && <div className="rounded-lg p-3" style={{
          background: paceVerdict.color === "#52b788" ? "rgba(82,183,136,0.08)" : paceVerdict.color === "#ff6b6b" ? "rgba(255,107,107,0.08)" : "rgba(255,209,102,0.08)",
          border: "1px solid " + paceVerdict.color + "22"
        }}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-bold" style={{color: paceVerdict.color}}>{paceVerdict.icon} {paceVerdict.text}</div>
              <div style={{fontSize: "10px", color: "#555", marginTop: "2px"}}>
                Proj. {isKd ? projectedAvg.toFixed(2) : projectedAvg.toFixed(1)} vs line {isKd ? threshNum.toFixed(2) : threshNum} ({direction})
              </div>
            </div>
            <div className="text-right">
              <div className="text-lg font-black" style={{color: paceVerdict.color}}>
                {projectedAvg > threshNum ? "+" : ""}{isKd ? (projectedAvg - threshNum).toFixed(2) : (projectedAvg - threshNum).toFixed(1)}
              </div>
              <div style={{fontSize: "9px", color: "#555"}}>vs line</div>
            </div>
          </div>
        </div>}

        {/* Explanation */}
        <div className="mt-2" style={{fontSize: "10px", color: "#444", lineHeight: "1.4"}}>
          {relevantFactor >= 1.03 ?
            "Both teams play at a faster pace than average — expect more engagements and higher kill totals in this matchup." :
            relevantFactor <= 0.97 ?
            "This matchup trends slower than league average — fewer engagements and lower kill totals likely." :
            "This matchup plays near league-average pace — no major adjustment expected."
          }
        </div>
      </div>}

      {!selectedOpp && <div className="text-center py-3" style={{color: "#555", fontSize: "12px"}}>
        Pick an opponent to see pace-adjusted projections
      </div>}
    </div>
  </div>;
}

function CDLLineCheck(props) {
  var player = props.player;
  var analysis = props.analysis;
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
    // Filter map_stats_view by mode name, grab kills per map
    var filtered = mapLogs.filter(function(m) { return m.mode_name === activeCat.mode; });
    // Each row is one map occurrence — already sorted by date desc
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
    // Maps 1-3 Kills: sum kills from map_stats_view where map_number <= 3, grouped per match
    var onlyFirst3 = mapLogs.filter(function(m) { return m.map_number <= 3; });
    // Group by match_id and sum kills
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
    // Only include matches that had all 3 maps
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
    // Series-level: use match_stats_view (full series K/D)
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

  // Average
  var avg = 0;
  if (dataPoints.length > 0) {
    var sum = 0;
    dataPoints.forEach(function(d) { sum += d.value; });
    avg = sum / dataPoints.length;
  }

  var hitColor = hitPct >= 60 ? "#52b788" : hitPct >= 40 ? "#ffd166" : "#ff6b6b";

  return <div>
    {/* Category pills */}
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

      {/* Controls row */}
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

    {/* ─── MATCHUP PACE CONTEXT ─── */}
    {analysis && activeCat.paceMode && <MatchupPaceContext
      player={player}
      analysis={analysis}
      activeCat={activeCat}
      avg={avg}
      threshold={threshold}
      direction={direction}
    />}

    {/* Result card */}
    {hasThreshold && dataPoints.length > 0 && <div>
      <div className="rounded-xl p-4 mb-3" style={{
        background: hitPct >= 60 ? "rgba(82,183,136,0.06)" : hitPct >= 40 ? "rgba(255,209,102,0.06)" : "rgba(255,107,107,0.06)",
        border: "1px solid " + (hitPct >= 60 ? "rgba(82,183,136,0.15)" : hitPct >= 40 ? "rgba(255,209,102,0.15)" : "rgba(255,107,107,0.15)")
      }}>
        {/* Player header */}
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

        {/* Hit rate */}
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

        {/* Per-game bubbles */}
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

        {/* Footer */}
        <div className="flex items-center justify-between mt-2 pt-2" style={{borderTop: "1px solid rgba(255,255,255,0.04)"}}>
          <span style={{fontSize: "10px", color: "#333", fontWeight: 700}}>BARRACKS</span>
          <span style={{fontSize: "10px", color: "#444"}}>Avg: {isKd ? avg.toFixed(2) : avg.toFixed(1)} / {activeCat.source === "map" ? "map" : "series"}</span>
        </div>
      </div>

      {/* Share / Copy link */}
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

    {/* Game log table */}
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

  // Read ?line= URL parameter on mount
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
      <button onClick={function() { setSelectedPlayer(null); }} className="text-xs font-semibold mb-4 flex items-center gap-1" style={{color: "#e94560"}}>{"\u2190"} Pick different player</button>

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

      <CDLLineCheck player={selectedPlayer} analysis={analysis} initialParams={initialLineParams} />
    </div>}
  </div>;
}

var TABS = ["Schedule", "Rankings", "Teams", "Compare", "Players", "Lines", "Search"];

export default function App() {
  var urlParams = useMemo(function() { try { return new URLSearchParams(window.location.search); } catch(e) { return new URLSearchParams(); } }, []);
  var compareParam = urlParams.get("compare");
  var lineParam = urlParams.get("line");
  var [tab, setTab] = useState(compareParam ? "Compare" : lineParam ? "Lines" : "Schedule");
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
        var results = await Promise.all([fetchPlayers(), fetchTeams(), fetchMatches(), fetchRosters(), fetchStandings(null), fetchStandings(CURRENT_EVENT_ID)]);
        setAnalysis(buildAnalysis(results[0], results[1], results[2], results[3], results[4], results[5]));
      } catch(e) {
        console.error(e);
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="min-h-screen flex items-center justify-center" style={{background: "#0d0d1a"}}><div className="text-center space-y-3"><div className="w-10 h-10 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{borderColor: "#e94560", borderTopColor: "transparent"}} /><p className="text-sm" style={{color: "#888"}}>Loading CDL data...</p></div></div>;

  if (error) return <div className="min-h-screen flex items-center justify-center" style={{background: "#0d0d1a"}}><div className="text-center p-6 rounded-xl max-w-md" style={{background: "rgba(233,69,96,0.1)", border: "1px solid rgba(233,69,96,0.3)"}}><p className="text-lg font-bold mb-2" style={{color: "#e94560"}}>Failed to load</p><p className="text-sm opacity-60">{error}</p><button onClick={function() { window.location.reload(); }} className="mt-4 px-4 py-2 rounded-lg text-sm font-bold" style={{background: "#e94560", color: "#fff"}}>Retry</button></div></div>;

  var majorName = (analysis.majorStandings && analysis.majorStandings[0] && analysis.majorStandings[0].event_name) || "Major";

  return <div className="min-h-screen" style={{background: "#0d0d1a", color: "#c8c8d0"}}>
    <div className="sticky top-0 z-50 backdrop-blur-xl" style={{background: "rgba(13,13,26,0.9)", borderBottom: "1px solid rgba(255,255,255,0.06)"}}>
      <div className="max-w-4xl mx-auto px-4 py-3">
        <div className="flex items-center justify-between mb-3"><div><h1 className="text-xl font-black tracking-tight" style={{color: "#e94560"}}>BARRACKS</h1><p className="text-xs opacity-30">CDL 2026</p></div><div className="text-right text-xs opacity-30">{analysis.power.length} teams · {analysis.matchups.length} matchups</div></div>
        <div className="flex gap-1 overflow-x-auto">{TABS.map(function(t) { return <button key={t} onClick={function() { setTab(t); if (t !== "Teams") setTeamPageId(null); }} className="px-3 sm:px-4 py-1.5 rounded-lg text-sm font-bold transition-all whitespace-nowrap" style={{background: tab === t ? "#e94560" : "transparent", color: tab === t ? "#fff" : "#666"}}>{t}</button>; })}</div>
      </div>
    </div>
    <div className="max-w-4xl mx-auto px-4 py-6">
      {tab === "Schedule" && <div className="space-y-3">
        <WhosHot topKd={analysis.topKd} topHpK={analysis.topHpK} topSndKpr={analysis.topSndKpr} />
        <h2 className="text-lg font-bold text-white mb-4">Upcoming matches</h2>
        {analysis.matchups.map(function(mu) { return <MatchCard key={mu.id} mu={mu} onTeamClick={openTeam} />; })}
        {analysis.matchups.length === 0 && <p className="opacity-40">No upcoming matches with known teams</p>}
      </div>}
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
      {tab === "Search" && <div><h2 className="text-lg font-bold text-white mb-4">Player lookup</h2><PlayerSearch analysis={analysis} /></div>}
    </div>
    <div className="text-center py-6 mt-8" style={{borderTop: "1px solid rgba(255,255,255,0.04)"}}><p style={{fontSize: "11px", color: "#444"}}>BARRACKS · CDL 2026</p></div>
  </div>;
}
