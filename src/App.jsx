import { useState, useEffect, useMemo, useCallback } from "react";

const ALL_MAP_IDS = [38,21,59,46,53,47,27,76,29,20,67,66,18,45,68,28,10,11,15,69,23,70,60,8,54,16,25,61,55,48,44,56,49,32,9,13,72,30,31,62,12,22,17,57,50,41,19,73,51,40,75,39,36,63,74,58,33,42,52,24,35,34,71,26,64,65,43,37];
const ROLE_MAP = { 1: "AR", 2: "SMG", 3: "Flex" };
const SUPABASE_BASE = "https://dfpiiufxcciujugzjvgx.supabase.co/rest/v1/standings";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmcGlpdWZ4Y2NpdWp1Z3pqdmd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ2ODk0MDMsImV4cCI6MjA2MDI2NTQwM30.36VuOTvrxtmR3nb-u3nnVYWzMBn9YP1bQFvUYF5T1OE";
const STANDINGS_FIELDS = "select=*,team_logo_darkmode:team_id(logo_darkmode),team_logo_lightmode:team_id(logo_lightmode),team_name:team_id(name),team_name_short:team_id(name_short),event_name:event_id(name)";

async function proxyFetch(url) {
  const res = await fetch("/api/proxy?url=" + encodeURIComponent(url));
  if (!res.ok) throw new Error("Fetch failed (" + res.status + ")");
  return res.json();
}
async function fetchPlayers() {
  var p = {"0":{"json":{"eventType":[],"mapId":ALL_MAP_IDS,"modeId":[1,2,3,4,5],"eventId":[],"teamId":[],"onlyCDLStats":true,"onlyChallengersStats":false,"seasonId":2026,"startAt":null,"endAt":null,"aggregateMatchStats":true},"meta":{"values":{"startAt":["undefined"],"endAt":["undefined"]}}}};
  var d = await proxyFetch("https://www.breakingpoint.gg/api/trpc/playerStats.getAggregatedOrderedPlayerStats?batch=1&input=" + encodeURIComponent(JSON.stringify(p)));
  return (d && d[0] && d[0].result && d[0].result.data && d[0].result.data.json) || [];
}
async function fetchTeams() {
  var p = {"0":{"json":{"eventType":[],"mapId":ALL_MAP_IDS,"modeId":[1,2,3,4,5],"eventId":[],"teamId":[],"onlyCDLStats":true,"onlyChallengersStats":false,"seasonId":2026,"startAt":null,"endAt":null},"meta":{"values":{"startAt":["undefined"],"endAt":["undefined"]}}}};
  var d = await proxyFetch("https://www.breakingpoint.gg/api/trpc/teamStats.getAggregatedOrderedTeamStats?batch=1&input=" + encodeURIComponent(JSON.stringify(p)));
  return (d && d[0] && d[0].result && d[0].result.data && d[0].result.data.json) || [];
}
async function fetchMatches() {
  var p = {"0":{"json":{"seeOnlyCDL":true}},"1":{"json":{"seeOnlyCDL":true}}};
  var d = await proxyFetch("https://www.breakingpoint.gg/api/trpc/matches.fetchLiveMatches,matches.fetchUpcomingMatches?batch=1&input=" + encodeURIComponent(JSON.stringify(p)));
  var live = (d && d[0] && d[0].result && d[0].result.data && d[0].result.data.json) || [];
  var upcoming = (d && d[1] && d[1].result && d[1].result.data && d[1].result.data.json) || [];
  return live.concat(upcoming);
}
async function fetchRosters() {
  var d = await proxyFetch("https://www.breakingpoint.gg/_next/data/qc5mt7EbU7bkvD8K_eB00/en/cdl/teams-and-players.json");
  return (d && d.pageProps && d.pageProps.teams) || [];
}
async function fetchStandings(eventId) {
  var filter = eventId ? "event_id=eq." + eventId : "event_id=is.null";
  return proxyFetch(SUPABASE_BASE + "?" + STANDINGS_FIELDS + "&season_id=eq.2026&" + filter + "&order=rank.asc&apikey=" + SUPABASE_KEY);
}

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

function buildAnalysis(players, teams, matches, rosters, seasonStandings, majorStandings) {
  var teamLookup = {}, teamPlayers = {}, playerTeam = {}, playerStats = {}, playerRoles = {};
  rosters.forEach(function(t) {
    teamLookup[t.id] = {name: t.name, short: t.name_short, color: t.color_hex || "#888"};
    var active = (t.players || []).filter(function(p) { return !p.retired; });
    teamPlayers[t.id] = active;
    active.forEach(function(p) {
      playerTeam[p.id] = {teamName: t.name, teamShort: t.name_short, teamId: t.id};
      playerRoles[p.id] = ROLE_MAP[p.position_id] || "";
    });
  });
  players.forEach(function(p) {
    var i = playerTeam[p.player_id] || {};
    p.team_name = i.teamName || "";
    p.team_short = i.teamShort || "";
    p.team_id = i.teamId;
    p.role = playerRoles[p.player_id] || "";
    playerStats[p.player_id] = p;
  });
  var teamStats = {};
  teams.forEach(function(t) {
    var i = teamLookup[t.team_id] || {};
    t.team_name = i.name || ("Team " + t.team_id);
    t.team_short = i.short || "";
    t.team_color = i.color || "#888";
    teamStats[t.team_id] = t;
  });
  var rosterStats = function(tid) {
    return (teamPlayers[tid] || []).map(function(p) { return playerStats[p.id]; }).filter(Boolean);
  };

  var standingsLookup = {}, majorStandingsLookup = {};
  (seasonStandings || []).forEach(function(st) { standingsLookup[st.team_id] = st; });
  (majorStandings || []).forEach(function(st) { majorStandingsLookup[st.team_id] = st; });

  var power = Object.values(teamStats).map(function(ts) {
    var tid = ts.team_id, kd = s(ts, "kd");
    var hpW = s(ts, "hp_map_win_percentage"), sndW = s(ts, "snd_map_win_percentage"), ovlW = s(ts, "ovl_map_win_percentage");
    var avgWin = (hpW + sndW + ovlW) / 3;
    var rs = rosterStats(tid);
    var avgBp = rs.length ? rs.reduce(function(a, p) { return a + s(p, "bp_rating"); }, 0) / rs.length : 0;
    var star = rs.reduce(function(b, p) { return s(p, "kd") > s(b, "kd") ? p : b; }, rs[0] || {});
    var score = (kd * 25) + (avgWin * 0.3) + (avgBp * 15) + (s(ts, "hp_average_differential") * 0.08) + (s(ts, "snd_average_differential") * 1.5) + (s(ts, "ovl_average_differential") * 0.5);
    var st = standingsLookup[tid] || {};
    return {tid: tid, name: ts.team_name, short: ts.team_short, color: ts.team_color, score: score, kd: kd, avgWin: avgWin, hpW: hpW, sndW: sndW, ovlW: ovlW, avgBp: avgBp, star: (star && star.player_tag) || "", starKd: s(star, "kd"), matchWins: st.match_wins || 0, matchLosses: st.match_losses || 0, points: st.points || 0, standingRank: st.rank || 99};
  }).sort(function(a, b) { return b.score - a.score; });
  var powerLookup = {};
  power.forEach(function(p) { powerLookup[p.tid] = p; });

  var teamMapCounts = {};
  Object.keys(teamStats).forEach(function(tid) {
    var rs = rosterStats(Number(tid));
    if (!rs.length) { teamMapCounts[tid] = {hp: 1, snd: 1, ovl: 1}; return; }
    teamMapCounts[tid] = {
      hp: Math.max(1, Math.round(rs.reduce(function(a, p) { return a + s(p, "hp_game_count"); }, 0) / rs.length)),
      snd: Math.max(1, Math.round(rs.reduce(function(a, p) { return a + s(p, "snd_game_count"); }, 0) / rs.length)),
      ovl: Math.max(1, Math.round(rs.reduce(function(a, p) { return a + s(p, "ovl_game_count"); }, 0) / rs.length))
    };
  });
  var perMapRate = function(tid, f, m) { return s(teamStats[tid], f) / ((teamMapCounts[tid] && teamMapCounts[tid][m]) || 1); };
  var tids = Object.keys(teamStats).map(Number);
  var lgAvg = function(f, m) { var r = tids.map(function(t) { return perMapRate(t, f, m); }); return r.reduce(function(a, b) { return a + b; }, 0) / r.length || 1; };
  var lgHpDpm = lgAvg("hp_deaths", "hp"), lgSndDpm = lgAvg("snd_deaths", "snd"), lgOvlDpm = lgAvg("ovl_deaths", "ovl");
  var lgHpKpm = lgAvg("hp_kills", "hp"), lgSndKpm = lgAvg("snd_kills", "snd"), lgOvlKpm = lgAvg("ovl_kills", "ovl");
  var clamp = function(v) { return Math.min(1.15, Math.max(0.85, v)); };
  var oppKF = function(o, m) { var f = {hp: "hp_deaths", snd: "snd_deaths", ovl: "ovl_deaths"}[m]; var l = {hp: lgHpDpm, snd: lgSndDpm, ovl: lgOvlDpm}[m]; return clamp(l > 0 ? perMapRate(o, f, m) / l : 1); };
  var oppDF = function(o, m) { var f = {hp: "hp_kills", snd: "snd_kills", ovl: "ovl_kills"}[m]; var l = {hp: lgHpKpm, snd: lgSndKpm, ovl: lgOvlKpm}[m]; return clamp(l > 0 ? perMapRate(o, f, m) / l : 1); };

  var allPs = Object.values(playerStats).filter(function(p) { return p.team_id; });
  var topKd = allPs.slice().sort(function(a, b) { return s(b, "kd") - s(a, "kd"); }).slice(0, 5);
  var topHpK = allPs.slice().sort(function(a, b) { return s(b, "hp_k_10m") - s(a, "hp_k_10m"); }).slice(0, 5);
  var topSndKpr = allPs.slice().sort(function(a, b) { return s(b, "snd_kpr") - s(a, "snd_kpr"); }).slice(0, 5);

  var known = matches.filter(function(m) { return m.team_1_id && m.team_2_id; });
  var seen = {};
  var matchups = [];
  known.forEach(function(m) {
    var key = Math.min(m.team_1_id, m.team_2_id) + "-" + Math.max(m.team_1_id, m.team_2_id) + "-" + (m.events && m.events.id);
    if (seen[key]) return;
    seen[key] = true;
    var t1 = teamStats[m.team_1_id] || {}, t2 = teamStats[m.team_2_id] || {};
    var p1 = powerLookup[m.team_1_id] || {}, p2 = powerLookup[m.team_2_id] || {};
    var edge = Math.abs((p1.score || 0) - (p2.score || 0));
    var favored = (p1.score || 0) >= (p2.score || 0) ? (m.team1 && m.team1.name_short) : (m.team2 && m.team2.name_short);

    var projections = [];
    [[m.team_1_id, m.team1, m.team_2_id], [m.team_2_id, m.team2, m.team_1_id]].forEach(function(arr) {
      var tid = arr[0], tI = arr[1], oT = arr[2];
      var rs = rosterStats(tid);
      var hKf = oppKF(oT, "hp"), hDf = oppDF(oT, "hp"), sKf = oppKF(oT, "snd"), sDf = oppDF(oT, "snd"), oKf = oppKF(oT, "ovl"), oDf = oppDF(oT, "ovl");
      var sR = s(teamStats[tid], "snd_rounds") || 10;
      rs.forEach(function(p) {
        var hM = s(p, "hp_game_count") > 0 ? s(p, "hp_gametime") / s(p, "hp_game_count") : 10;
        var oM = s(p, "ovl_game_count") > 0 ? s(p, "ovl_gametime") / s(p, "ovl_game_count") : 10;
        var hK = +(s(p, "hp_k_10m") * (hM / 10) * hKf).toFixed(1);
        var hD = +(s(p, "hp_d_10m") * (hM / 10) * hDf).toFixed(1);
        var sK = +(s(p, "snd_kpr") * sR * sKf).toFixed(1);
        var sD = +(s(p, "snd_dpr") * sR * sDf).toFixed(1);
        var oK = +(s(p, "ovl_k_10m") * (oM / 10) * oKf).toFixed(1);
        var oD = +(s(p, "ovl_d_10m") * (oM / 10) * oDf).toFixed(1);
        var tK = +(hK + sK + oK).toFixed(1);
        var tD = +(hD + sD + oD).toFixed(1);
        var kd = tD > 0 ? +(tK / tD).toFixed(2) : 0;
        projections.push({team: (tI && tI.name_short) || "?", tag: p.player_tag, hpK: hK, hpD: hD, sndK: sK, sndD: sD, ovlK: oK, ovlD: oD, totalK: tK, totalD: tD, seriesKd: kd, killAdj: +((hKf + sKf + oKf) / 3).toFixed(2), deathAdj: +((hDf + sDf + oDf) / 3).toFixed(2)});
      });
    });

    matchups.push({id: m.id, datetime: m.datetime, bestOf: m.best_of, t1: m.team1, t2: m.team2, event: m.events, round: m.round, t1Stats: t1, t2Stats: t2, t1Roster: rosterStats(m.team_1_id), t2Roster: rosterStats(m.team_2_id), p1: p1, p2: p2, edge: edge, favored: favored, projections: projections});
  });

  return {power: power, matchups: matchups, teamStats: teamStats, playerStats: allPs, rosterStats: rosterStats, topKd: topKd, topHpK: topHpK, topSndKpr: topSndKpr, teamLookup: teamLookup, teamPlayers: teamPlayers, powerLookup: powerLookup, standingsLookup: standingsLookup, majorStandingsLookup: majorStandingsLookup, seasonStandings: seasonStandings || [], majorStandings: majorStandings || []};
}

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
  var maps = Math.round((s(p, "hp_game_count") + s(p, "snd_game_count") + s(p, "ovl_game_count")) / 3);
  return <div className="py-2" style={{borderBottom: "1px solid rgba(255,255,255,0.03)"}}>
    <div className="flex items-center gap-1 mb-1.5"><span className="text-sm font-medium text-white">{p.player_tag}</span><RoleBadge role={p.role} /><span className="text-xs px-1.5 py-0.5 rounded ml-1" style={{background: "rgba(255,255,255,0.05)", color: "#555", fontSize: "9px"}}>{maps} maps</span></div>
    <div className="grid grid-cols-4 gap-2 pl-1">
      <div><div style={{fontSize: "9px", color: "#555"}}>K/D</div><div className="text-sm font-bold" style={{color: kdColor(s(p, "kd"))}}>{s(p, "kd").toFixed(2)}</div></div>
      <div><div style={{fontSize: "9px", color: "#555"}}>HP K/10</div><div className="text-sm font-semibold">{s(p, "hp_k_10m").toFixed(1)}</div></div>
      <div><div style={{fontSize: "9px", color: "#555"}}>SnD KPR</div><div className="text-sm font-semibold">{s(p, "snd_kpr").toFixed(2)}</div></div>
      <div><div style={{fontSize: "9px", color: "#555"}}>OVL K/10</div><div className="text-sm font-semibold">{s(p, "ovl_k_10m").toFixed(1)}</div></div>
    </div>
  </div>;
}

function TeamRosterBlock(props) {
  return <div><div className="flex items-center gap-2 mb-2 mt-1"><div className="w-1 h-4 rounded" style={{background: props.teamColor}} /><span className="text-xs font-bold text-white uppercase tracking-wider">{props.teamName}</span></div>{(props.roster || []).map(function(p) { return <PlayerRow key={p.player_id} p={p} />; })}</div>;
}

function WhosHot(props) {
  var [cat, setCat] = useState("kd");
  var list = cat === "kd" ? props.topKd : cat === "hp" ? props.topHpK : props.topSndKpr;
  var valFn = cat === "kd" ? function(p) { return s(p, "kd").toFixed(2); } : cat === "hp" ? function(p) { return s(p, "hp_k_10m").toFixed(1); } : function(p) { return s(p, "snd_kpr").toFixed(2); };
  var labelMap = {kd: "K/D", hp: "HP K/10m", snd: "SnD KPR"};
  return <div className="rounded-xl p-4 mb-6" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}}>
    <div className="flex items-center justify-between mb-3">
      <span className="text-sm font-bold text-white">Top performers</span>
      <div className="flex gap-1">{["kd", "hp", "snd"].map(function(c) { return <button key={c} onClick={function() { setCat(c); }} className="px-2 py-1 rounded text-xs font-semibold" style={{background: cat === c ? "rgba(233,69,96,0.2)" : "rgba(255,255,255,0.05)", color: cat === c ? "#e94560" : "#666"}}>{labelMap[c]}</button>; })}</div>
    </div>
    {list.map(function(p, i) { return <div key={p.player_id} className="flex items-center gap-3 py-1.5" style={{borderBottom: i < list.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none"}}>
      <span className="text-xs font-bold w-5" style={{color: i < 3 ? "#e94560" : "#555"}}>{i + 1}</span>
      <span className="text-sm font-medium text-white flex-1">{p.player_tag}</span>
      <span className="text-xs opacity-40">{p.team_short}</span>
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
      <div className="grid grid-cols-4 gap-2 pl-12">
        <Stat label="Power" value={t.score} fmt="0.0" color={i < 4 ? "#52b788" : "#c8c8d0"} />
        <Stat label="K/D" value={t.kd} />
        <Stat label="Win%" value={t.avgWin} fmt="pct" />
        <Stat label="BP Rtg" value={t.avgBp} />
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
        <span className="text-xs uppercase tracking-wider opacity-40">{(mu.event && mu.event.name_short) || ""} · {((mu.round && mu.round.name_short) || "").trim()} · Bo{mu.bestOf}</span>
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
        <H2HRow label="HP Win%" v1={s(mu.t1Stats, "hp_map_win_percentage")} v2={s(mu.t2Stats, "hp_map_win_percentage")} fmt="pct" />
        <H2HRow label="SnD Win%" v1={s(mu.t1Stats, "snd_map_win_percentage")} v2={s(mu.t2Stats, "snd_map_win_percentage")} fmt="pct" />
        <H2HRow label="OVL Win%" v1={s(mu.t1Stats, "ovl_map_win_percentage")} v2={s(mu.t2Stats, "ovl_map_win_percentage")} fmt="pct" />
        <H2HRow label="HP Diff" v1={s(mu.t1Stats, "hp_average_differential")} v2={s(mu.t2Stats, "hp_average_differential")} fmt="0.0" />
        <H2HRow label="SnD Diff" v1={s(mu.t1Stats, "snd_average_differential")} v2={s(mu.t2Stats, "snd_average_differential")} fmt="0.0" />
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
  var mW = standing.match_wins || 0, mL = standing.match_losses || 0, gW = standing.game_wins || 0, gL = standing.game_losses || 0;
  var mmW = major.match_wins || 0, mmL = major.match_losses || 0, mgW = major.game_wins || 0, mgL = major.game_losses || 0;

  return <div>
    <button onClick={onBack} className="text-sm mb-4 hover:underline" style={{color: "#e94560"}}>{"\u2190"} back to standings</button>
    <div className="flex items-center gap-4 mb-5 pb-5" style={{borderBottom: "1px solid rgba(255,255,255,0.06)"}}>
      <div className="w-1.5 h-12 rounded" style={{background: ts.team_color}} />
      <div className="flex-1">
        <h2 className="text-2xl font-black text-white">{ts.team_name}</h2>
        <p className="text-sm opacity-50">{mW}-{mL} season · {standing.points || 0} CDL points</p>
      </div>
      <div className="text-center"><div className="text-2xl font-black" style={{color: "#e94560"}}>#{standing.rank || "-"}</div><div style={{fontSize: "10px", color: "#555", textTransform: "uppercase"}}>Standing</div></div>
    </div>
    <div className="grid grid-cols-2 gap-3 mb-5">
      <div className="rounded-lg p-3" style={{background: "rgba(255,255,255,0.04)"}}>
        <div style={{fontSize: "10px", color: "#555", textTransform: "uppercase", marginBottom: "4px"}}>Major 2</div>
        <div className="text-xl font-bold text-white">{mmW}-{mmL}</div>
        <div style={{fontSize: "11px", color: "#555"}}>{mgW}-{mgL} maps · {major.points || 0} pts</div>
      </div>
      <div className="rounded-lg p-3" style={{background: "rgba(255,255,255,0.04)"}}>
        <div style={{fontSize: "10px", color: "#555", textTransform: "uppercase", marginBottom: "4px"}}>Season</div>
        <div className="text-xl font-bold text-white">{mW}-{mL}</div>
        <div style={{fontSize: "11px", color: "#555"}}>{gW}-{gL} maps · {standing.points || 0} pts</div>
      </div>
    </div>
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
      <div className="rounded-lg p-3 text-center" style={{background: "rgba(255,255,255,0.04)"}}><div style={{fontSize: "10px", color: "#555", textTransform: "uppercase"}}>K/D</div><div className="text-xl font-bold" style={{color: kdColor(s(ts, "kd"))}}>{s(ts, "kd").toFixed(2)}</div></div>
      <div className="rounded-lg p-3 text-center" style={{background: "rgba(255,255,255,0.04)"}}><div style={{fontSize: "10px", color: "#555", textTransform: "uppercase"}}>Win rate</div><div className="text-xl font-bold" style={{color: (mW / (mW + mL || 1)) > 0.5 ? "#52b788" : "#ff6b6b"}}>{((mW / (mW + mL || 1)) * 100).toFixed(1)}%</div></div>
      <div className="rounded-lg p-3 text-center" style={{background: "rgba(255,255,255,0.04)"}}><div style={{fontSize: "10px", color: "#555", textTransform: "uppercase"}}>HP diff</div><div className="text-xl font-bold" style={{color: s(ts, "hp_average_differential") > 0 ? "#52b788" : "#ff6b6b"}}>{s(ts, "hp_average_differential") > 0 ? "+" : ""}{s(ts, "hp_average_differential").toFixed(1)}</div></div>
      <div className="rounded-lg p-3 text-center" style={{background: "rgba(255,255,255,0.04)"}}><div style={{fontSize: "10px", color: "#555", textTransform: "uppercase"}}>CDL points</div><div className="text-xl font-bold text-white">{standing.points || 0}</div></div>
    </div>
    <div className="mb-5">
      <div className="text-xs uppercase tracking-wider opacity-40 mb-3">Performance by mode</div>
      <div className="rounded-lg overflow-hidden" style={{background: "rgba(255,255,255,0.02)"}}>
        <div className="grid grid-cols-4 gap-2 px-3 py-2" style={{borderBottom: "1px solid rgba(255,255,255,0.06)"}}><div style={{fontSize: "10px", color: "#555"}}>MODE</div><div style={{fontSize: "10px", color: "#555", textAlign: "center"}}>WIN%</div><div style={{fontSize: "10px", color: "#555", textAlign: "center"}}>K/D</div><div style={{fontSize: "10px", color: "#555", textAlign: "center"}}>DIFF</div></div>
        {[["Hardpoint", "hp"], ["SnD", "snd"], ["Overload", "ovl"]].map(function(arr) {
          var label = arr[0], mode = arr[1];
          var w = s(ts, mode + "_map_win_percentage"), kd = s(ts, mode + "_kd"), diff = s(ts, mode + "_average_differential");
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
      var color = ts.team_color || "#888";
      var fullName = ts.team_name || (major.team_name && major.team_name.name) || "?";
      var kd = s(ts, "kd");
      var hpDiff = s(ts, "hp_average_differential");
      var avgWin = (s(ts, "hp_map_win_percentage") + s(ts, "snd_map_win_percentage") + s(ts, "ovl_map_win_percentage")) / 3;

      return <div key={tid} className="rounded-xl p-4 cursor-pointer hover:border-white/20 transition-all" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}} onClick={function() { onTeamClick(tid); }}>
        <div className="flex items-center gap-2 mb-3">
          <div className="w-1 h-6 rounded" style={{background: color}} />
          <span className="font-bold text-white text-sm flex-1 truncate">{fullName}</span>
          <span className="text-sm font-bold" style={{color: i < 3 ? "#e94560" : i < 6 ? "#53a8b6" : "#555"}}>#{major.rank}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="rounded-lg p-2" style={{background: "rgba(255,255,255,0.04)"}}>
            <div style={{fontSize: "9px", color: "#555", textTransform: "uppercase"}}>Major 2</div>
            <div className="text-sm font-bold text-white">{major.match_wins}-{major.match_losses}</div>
            <div style={{fontSize: "10px", color: "#555"}}>{major.game_wins}-{major.game_losses} maps · {major.points || 0} pts</div>
          </div>
          <div className="rounded-lg p-2" style={{background: "rgba(255,255,255,0.04)"}}>
            <div style={{fontSize: "9px", color: "#555", textTransform: "uppercase"}}>Season</div>
            <div className="text-sm font-bold text-white">{season.match_wins || 0}-{season.match_losses || 0}</div>
            <div style={{fontSize: "10px", color: "#555"}}>{season.game_wins || 0}-{season.game_losses || 0} maps · {season.points || 0} pts</div>
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
    return analysis.playerStats.filter(function(p) { return (p.player_tag && p.player_tag.toLowerCase().indexOf(q) !== -1) || (p.team_name && p.team_name.toLowerCase().indexOf(q) !== -1); }).slice(0, 12);
  }, [query, analysis]);

  return <div className="space-y-3">
    <input type="text" value={query} onChange={function(e) { setQuery(e.target.value); setSelected(null); }} placeholder="Search player or team..." className="w-full p-3 rounded-lg text-white placeholder-gray-500 outline-none" style={{background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)"}} />
    {results.length > 0 && !selected && <div className="space-y-1">{results.map(function(p) {
      return <div key={p.player_id} className="flex items-center gap-3 p-2 rounded-lg cursor-pointer hover:bg-white/5" onClick={function() { setSelected(p); }}>
        <span className="font-bold text-white">{p.player_tag}</span><RoleBadge role={p.role} /><span className="text-xs opacity-50">{p.team_short}</span><span className="ml-auto"><KdBadge kd={s(p, "kd")} size="sm" /></span>
      </div>;
    })}</div>}
    {selected && <div className="space-y-3">
      <div className="flex items-center justify-between"><div><div className="flex items-center gap-2"><h3 className="text-xl font-bold text-white">{selected.player_tag}</h3><RoleBadge role={selected.role} /></div><span className="text-sm opacity-50">{selected.team_name}</span></div><button onClick={function() { setSelected(null); }} className="text-xs opacity-50 hover:opacity-100">{"\u2715"} clear</button></div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 rounded-lg" style={{background: "rgba(255,255,255,0.03)"}}>
        <Stat label="Overall K/D" value={s(selected, "kd")} /><Stat label="HP K/D" value={s(selected, "hp_kd")} /><Stat label="SnD K/D" value={s(selected, "snd_kd")} /><Stat label="OVL K/D" value={s(selected, "ovl_kd")} />
        <Stat label="HP K/10m" value={s(selected, "hp_k_10m")} fmt="0.0" /><Stat label="SnD KPR" value={s(selected, "snd_kpr")} /><Stat label="OVL K/10m" value={s(selected, "ovl_k_10m")} fmt="0.0" />
      </div>
    </div>}
  </div>;
}

var TABS = ["Schedule", "Rankings", "Teams", "Search"];

export default function App() {
  var [tab, setTab] = useState("Schedule");
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
        var results = await Promise.all([fetchPlayers(), fetchTeams(), fetchMatches(), fetchRosters(), fetchStandings(null), fetchStandings(102)]);
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

  var majorName = (analysis.majorStandings && analysis.majorStandings[0] && analysis.majorStandings[0].event_name && analysis.majorStandings[0].event_name.name) || "Major 2";

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

      {tab === "Search" && <div><h2 className="text-lg font-bold text-white mb-4">Player lookup</h2><PlayerSearch analysis={analysis} /></div>}
    </div>
    <div className="text-center py-6 mt-8" style={{borderTop: "1px solid rgba(255,255,255,0.04)"}}><p style={{fontSize: "11px", color: "#444"}}>Data via <a href="https://www.breakingpoint.gg" target="_blank" rel="noopener" style={{color: "#666", textDecoration: "underline"}}>BreakingPoint.gg</a></p></div>
  </div>;
}
