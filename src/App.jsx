import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { renderCompareCard, renderPlayerCard, renderTeamCard, renderMatchupCard, shareCanvas } from "./barracksShareRenderer.js";

const ALL_MAP_IDS = [38,21,59,46,53,47,27,76,29,20,67,66,18,45,68,28,10,11,15,69,23,70,60,8,54,16,25,61,55,48,44,56,49,32,9,13,72,30,31,62,12,22,17,57,50,41,19,73,51,40,75,39,36,63,74,58,33,42,52,24,35,34,71,26,64,65,43,37];
const ROLE_MAP = { 1: "AR", 2: "SMG", 3: "Flex" };
const CURRENT_EVENT_ID = 102;

// Your Supabase (data synced by Python script)
const MY_SUPABASE_API = "https://xtxlopuvadwwuzvytqgo.supabase.co/rest/v1";
const MY_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0eGxvcHV2YWR3d3V6dnl0cWdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTk2MjEsImV4cCI6MjA4OTE3NTYyMX0.MP8SGkba0Ye-d-RSRgEmfE6A4KmFTH5fG9S9aJoSnRI";

async function mySupaFetch(table, query) {
  var url = MY_SUPABASE_API + "/" + table + "?" + (query || "select=*");
  var res = await fetch(url, {headers: {"apikey": MY_SUPABASE_KEY, "Authorization": "Bearer " + MY_SUPABASE_KEY}});
  if (!res.ok) throw new Error("Supabase fetch failed (" + res.status + ")");
  return res.json();
}

async function fetchPlayers() {
  return mySupaFetch("player_stats", "select=*");
}
async function fetchTeams() {
  return mySupaFetch("team_stats", "select=*");
}
async function fetchMatches() {
  return mySupaFetch("matches", "select=*&status=neq.completed&order=datetime.asc");
}
async function fetchRosters() {
  // Group roster rows back into the team structure buildAnalysis expects
  var rows = await mySupaFetch("rosters", "select=*&retired=eq.false");
  var teamMap = {};
  rows.forEach(function(r) {
    if (!teamMap[r.team_id]) {
      teamMap[r.team_id] = {
        id: r.team_id,
        name: r.team_name,
        name_short: r.team_name_short,
        color_hex: r.team_color,
        players: []
      };
    }
    teamMap[r.team_id].players.push({
      id: r.player_id,
      name: r.player_name,
      position_id: r.position_id,
      retired: false
    });
  });
  return Object.values(teamMap);
}
async function fetchStandings(eventId) {
  var filter = eventId ? "event_id=eq." + eventId : "event_id=is.null";
  return mySupaFetch("cdl_standings", "select=*&season_id=eq.2026&" + filter + "&order=rank.asc");
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
    var star = rs.reduce(function(b, p) { return s(p, "kd") > s(b, "kd") ? p : b; }, rs[0] || {});
    var score = (kd * 25) + (avgWin * 0.3) + (s(ts, "hp_average_differential") * 0.08) + (s(ts, "snd_average_differential") * 1.5) + (s(ts, "ovl_average_differential") * 0.5);
    var st = standingsLookup[tid] || {};
    return {tid: tid, name: ts.team_name, short: ts.team_short, color: ts.team_color, score: score, kd: kd, avgWin: avgWin, hpW: hpW, sndW: sndW, ovlW: ovlW, star: (star && star.player_tag) || "", starKd: s(star, "kd"), matchWins: st.match_wins || 0, matchLosses: st.match_losses || 0, points: st.points || 0, standingRank: st.rank || 99};
  }).sort(function(a, b) { return b.score - a.score; });
  var powerLookup = {};
  power.forEach(function(p) { powerLookup[p.tid] = p; });

  var allPs = Object.values(playerStats).filter(function(p) { return p.team_id; });
  var topKd = allPs.slice().sort(function(a, b) { return s(b, "kd") - s(a, "kd"); }).slice(0, 5);
  var topHpK = allPs.slice().sort(function(a, b) { return s(b, "hp_k_10m") - s(a, "hp_k_10m"); }).slice(0, 5);
  var topSndKpr = allPs.slice().sort(function(a, b) { return s(b, "snd_kpr") - s(a, "snd_kpr"); }).slice(0, 5);

  var known = matches.filter(function(m) { return m.team_1_id && m.team_2_id; });
  var seen = {};
  var matchups = [];
  known.forEach(function(m) {
    var key = Math.min(m.team_1_id, m.team_2_id) + "-" + Math.max(m.team_1_id, m.team_2_id) + "-" + (m.event_id);
    if (seen[key]) return;
    seen[key] = true;
    var t1 = teamStats[m.team_1_id] || {}, t2 = teamStats[m.team_2_id] || {};
    var p1 = powerLookup[m.team_1_id] || {}, p2 = powerLookup[m.team_2_id] || {};
    var edge = Math.abs((p1.score || 0) - (p2.score || 0));
    var favored = (p1.score || 0) >= (p2.score || 0) ? m.team_1_name_short : m.team_2_name_short;

    // Build objects matching the shape the rest of the app expects
    var t1Obj = {name: m.team_1_name, name_short: m.team_1_name_short};
    var t2Obj = {name: m.team_2_name, name_short: m.team_2_name_short};
    var evObj = {id: m.event_id, name: m.event_name, name_short: m.event_name_short};

    matchups.push({id: m.id, datetime: m.datetime, bestOf: m.best_of, t1: t1Obj, t2: t2Obj, event: evObj, round: m.round, t1Stats: t1, t2Stats: t2, t1Roster: rosterStats(m.team_1_id), t2Roster: rosterStats(m.team_2_id), p1: p1, p2: p2, edge: edge, favored: favored});
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
  var matches = s(p, "matches_played");
  return <div className="py-2" style={{borderBottom: "1px solid rgba(255,255,255,0.03)"}}>
    <div className="flex items-center gap-1 mb-1.5"><span className="text-sm font-medium text-white">{p.player_tag}</span><RoleBadge role={p.role} /><span className="text-xs px-1.5 py-0.5 rounded ml-1" style={{background: "rgba(255,255,255,0.05)", color: "#555", fontSize: "9px"}}>{matches} matches</span></div>
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
      var fullName = ts.team_name || major.team_name || "?";
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
    <input type="text" value={query} onChange={function(e) { setQuery(e.target.value); setSelected(null); }} placeholder="Search player or team..." className="w-full p-3 rounded-lg text-white placeholder-gray-500 outline-none" style={{background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", fontSize: "16px"}} />
    {results.length > 0 && !selected && <div className="space-y-1">{results.map(function(p) {
      return <div key={p.player_id} className="flex items-center gap-3 p-2 rounded-lg cursor-pointer hover:bg-white/5" onClick={function() { setSelected(p); }}>
        <span className="font-bold text-white">{p.player_tag}</span><RoleBadge role={p.role} /><span className="text-xs opacity-50">{p.team_short}</span><span className="ml-auto"><KdBadge kd={s(p, "kd")} size="sm" /></span>
      </div>;
    })}</div>}
    {selected && <div className="space-y-3">
      <div className="flex items-center justify-between"><div><div className="flex items-center gap-2"><h3 className="text-xl font-bold text-white">{selected.player_tag}</h3><RoleBadge role={selected.role} /></div><span className="text-sm opacity-50">{selected.team_name}</span></div><button onClick={function() { setSelected(null); }} className="text-xs opacity-50 hover:opacity-100">{"\u2715"} clear</button></div>
      <div className="rounded-lg p-3" style={{background: "rgba(255,255,255,0.03)"}}>
        <div className="grid grid-cols-3 gap-3 pb-3 mb-2" style={{borderBottom: "1px solid rgba(255,255,255,0.04)"}}>
          <Stat label="Overall K/D" value={s(selected, "kd")} /><Stat label="DMG/min" value={s(selected, "dmg_per_min")} fmt="0.0" /><Stat label="FB%" value={s(selected, "first_blood_percentage") * 100} fmt="0.0" />
        </div>
        <div style={{fontSize: "10px", fontWeight: 600, color: "#e94560", padding: "4px 0"}}>Hardpoint</div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pb-3 mb-2" style={{borderBottom: "1px solid rgba(255,255,255,0.04)"}}>
          <Stat label="HP K/D" value={s(selected, "hp_kd")} /><Stat label="K/10" value={s(selected, "hp_k_10m")} fmt="0.0" /><Stat label="D/10" value={s(selected, "hp_d_10m")} fmt="0.0" /><Stat label="DMG/10" value={s(selected, "hp_dmg_10m")} fmt="0.0" /><Stat label="ENG/10" value={s(selected, "hp_eng_10m")} fmt="0.0" />
        </div>
        <div style={{fontSize: "10px", fontWeight: 600, color: "#e94560", padding: "4px 0"}}>Search and Destroy</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pb-3 mb-2" style={{borderBottom: "1px solid rgba(255,255,255,0.04)"}}>
          <Stat label="SnD K/D" value={s(selected, "snd_kd")} /><Stat label="KPR" value={s(selected, "snd_kpr")} /><Stat label="DPR" value={s(selected, "snd_dpr")} /><Stat label="FB%" value={s(selected, "first_blood_percentage") * 100} fmt="0.0" />
        </div>
        <div style={{fontSize: "10px", fontWeight: 600, color: "#e94560", padding: "4px 0"}}>Overload</div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <Stat label="OVL K/D" value={s(selected, "ovl_kd")} /><Stat label="K/10" value={s(selected, "ovl_k_10m")} fmt="0.0" /><Stat label="D/10" value={s(selected, "ovl_d_10m")} fmt="0.0" /><Stat label="DMG/10" value={s(selected, "ovl_dmg_10m")} fmt="0.0" /><Stat label="ENG/10" value={s(selected, "ovl_eng_10m")} fmt="0.0" />
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
  var [shareMode, setShareMode] = useState("full");
  var [sharing, setSharing] = useState(false);
  var [linkCopied, setLinkCopied] = useState(false);
  var cardRef = useRef(null);

  useEffect(function() {
    if (!initialCompare || !analysis) return;
    var parts = initialCompare.split(",");
    if (parts.length !== 2) return;
    var name1 = decodeURIComponent(parts[0]).toLowerCase().trim();
    var name2 = decodeURIComponent(parts[1]).toLowerCase().trim();
    var found1 = analysis.playerStats.find(function(p) { return p.player_tag && p.player_tag.toLowerCase() === name1; });
    var found2 = analysis.playerStats.find(function(p) { return p.player_tag && p.player_tag.toLowerCase() === name2; });
    if (found1) { setP1(found1); setQ1(found1.player_tag); }
    if (found2) { setP2(found2); setQ2(found2.player_tag); }
    if (found1 && found2) { setShareMode("compact"); }
  }, [initialCompare, analysis]);

  var updateUrl = function(player1, player2) {
    if (player1 && player2) {
      var url = window.location.origin + window.location.pathname + "?compare=" + encodeURIComponent(player1.player_tag) + "," + encodeURIComponent(player2.player_tag);
      window.history.replaceState(null, "", url);
    } else {
      window.history.replaceState(null, "", window.location.pathname);
    }
  };

  var search = function(q) {
    if (q.length < 2) return [];
    var lower = q.toLowerCase();
    return analysis.playerStats.filter(function(p) {
      return (p.player_tag && p.player_tag.toLowerCase().indexOf(lower) !== -1) || (p.team_name && p.team_name.toLowerCase().indexOf(lower) !== -1);
    }).slice(0, 6);
  };

  var r1 = useMemo(function() { return search(q1); }, [q1, analysis]);
  var r2 = useMemo(function() { return search(q2); }, [q2, analysis]);

  var pick1 = function(p) { setP1(p); setQ1(p.player_tag); setShow1(false); if (document.activeElement) document.activeElement.blur(); updateUrl(p, p2); };
  var pick2 = function(p) { setP2(p); setQ2(p.player_tag); setShow2(false); if (document.activeElement) document.activeElement.blur(); updateUrl(p1, p); };

  var handleShareImage = function() {
    if (!p1 || !p2 || sharing) return;
    setSharing(true);
    var shareStats = [
      {title: "OVERALL", rows: [
        {label: "K/D", v1: s(p1,"kd"), v2: s(p2,"kd"), fmt: "2"},
        {label: "DMG/m", v1: s(p1,"dmg_per_min"), v2: s(p2,"dmg_per_min"), fmt: "1"}
      ]},
      {title: "HARDPOINT", rows: [
        {label: "K/D", v1: s(p1,"hp_kd"), v2: s(p2,"hp_kd"), fmt: "2"},
        {label: "K/10", v1: s(p1,"hp_k_10m"), v2: s(p2,"hp_k_10m"), fmt: "1"},
        {label: "ENG/10", v1: s(p1,"hp_eng_10m"), v2: s(p2,"hp_eng_10m"), fmt: "1"}
      ]},
      {title: "S&D", rows: [
        {label: "K/D", v1: s(p1,"snd_kd"), v2: s(p2,"snd_kd"), fmt: "2"},
        {label: "KPR", v1: s(p1,"snd_kpr"), v2: s(p2,"snd_kpr"), fmt: "2"},
        {label: "FB%", v1: s(p1,"first_blood_percentage")*100, v2: s(p2,"first_blood_percentage")*100, fmt: "1"}
      ]},
      {title: "OVERLOAD", rows: [
        {label: "K/D", v1: s(p1,"ovl_kd"), v2: s(p2,"ovl_kd"), fmt: "2"},
        {label: "K/10", v1: s(p1,"ovl_k_10m"), v2: s(p2,"ovl_k_10m"), fmt: "1"}
      ]}
    ];
    var sp1Wins = 0, sp2Wins = 0;
    shareStats.forEach(function(group) {
      group.rows.forEach(function(row) {
        if (row.v1 > row.v2) sp1Wins++;
        else if (row.v2 > row.v1) sp2Wins++;
      });
    });
    var totalCats = shareStats.reduce(function(n, g) { return n + g.rows.length; }, 0);
    renderCompareCard({
      p1: { tag: p1.player_tag, teamShort: p1.team_short, role: p1.role, kd: s(p1, "kd") },
      p2: { tag: p2.player_tag, teamShort: p2.team_short, role: p2.role, kd: s(p2, "kd") },
      sections: shareStats,
      p1Wins: sp1Wins,
      p2Wins: sp2Wins,
      totalCats: totalCats,
      shareUrl: "thebarracks.vercel.app"
    }).then(function(canvas) {
      return shareCanvas(canvas, "barracks-" + p1.player_tag + "-vs-" + p2.player_tag, "https://thebarracks.vercel.app?compare=" + encodeURIComponent(p1.player_tag) + "," + encodeURIComponent(p2.player_tag));
    }).catch(function(e) {
      console.error("Share render error:", e);
    }).finally(function() {
      setSharing(false);
    });
  };

  var handleCopyLink = function() {
    if (!p1 || !p2) return;
    var url = window.location.origin + window.location.pathname + "?compare=" + encodeURIComponent(p1.player_tag) + "," + encodeURIComponent(p2.player_tag);
    navigator.clipboard.writeText(url).then(function() {
      setLinkCopied(true);
      setTimeout(function() { setLinkCopied(false); }, 2000);
    }).catch(function() {
      prompt("Copy this link:", url);
    });
  };

  var search = function(q) {
    if (q.length < 2) return [];
    var lower = q.toLowerCase();
    return analysis.playerStats.filter(function(p) {
      return (p.player_tag && p.player_tag.toLowerCase().indexOf(lower) !== -1) || (p.team_name && p.team_name.toLowerCase().indexOf(lower) !== -1);
    }).slice(0, 6);
  };

  var r1 = useMemo(function() { return search(q1); }, [q1, analysis]);
  var r2 = useMemo(function() { return search(q2); }, [q2, analysis]);

  var pick1 = function(p) { setP1(p); setQ1(p.player_tag); setShow1(false); if (document.activeElement) document.activeElement.blur(); };
  var pick2 = function(p) { setP2(p); setQ2(p.player_tag); setShow2(false); if (document.activeElement) document.activeElement.blur(); };

  var stats = [
    {label: "K/D", k: "kd"},
    {label: "DMG/min", k: "dmg_per_min", fmt: "0.0"},
    {label: "HP K/D", k: "hp_kd"},
    {label: "HP K/10", k: "hp_k_10m", fmt: "0.0"},
    {label: "HP D/10", k: "hp_d_10m", fmt: "0.0", lower: true},
    {label: "HP DMG/10", k: "hp_dmg_10m", fmt: "0.0"},
    {label: "HP ENG/10", k: "hp_eng_10m", fmt: "0.0"},
    {label: "SnD K/D", k: "snd_kd"},
    {label: "SnD KPR", k: "snd_kpr"},
    {label: "SnD DPR", k: "snd_dpr", lower: true},
    {label: "SnD FB%", k: "first_blood_percentage", fmt: "pct", pctMul: true},
    {label: "OVL K/D", k: "ovl_kd"},
    {label: "OVL K/10", k: "ovl_k_10m", fmt: "0.0"},
    {label: "OVL D/10", k: "ovl_d_10m", fmt: "0.0", lower: true},
    {label: "OVL DMG/10", k: "ovl_dmg_10m", fmt: "0.0"},
    {label: "OVL ENG/10", k: "ovl_eng_10m", fmt: "0.0"}
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
  var winnerWins = winner === p1 ? p1Wins : p2Wins;
  var loserWins = winner === p1 ? p2Wins : p1Wins;

  return <div className="space-y-4">
    {/* Search inputs — horizontal on mobile with VS between */}
    <div className="flex gap-2 items-start">
      <div className="relative flex-1">
        <input type="text" value={q1} onChange={function(e) { setQ1(e.target.value); setP1(null); setShow1(true); }} onFocus={function() { setShow1(true); }} onBlur={function() { setTimeout(function() { setShow1(false); }, 300); }} placeholder="Player 1..." className="w-full p-2.5 sm:p-3 rounded-lg text-white placeholder-gray-500 outline-none" style={{background: "rgba(255,255,255,0.06)", border: p1 ? "1px solid rgba(82,183,136,0.4)" : "1px solid rgba(255,255,255,0.1)", fontSize: "15px"}} />
        {show1 && r1.length > 0 && !p1 && <div className="absolute z-10 w-full mt-1 rounded-lg overflow-hidden" style={{background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 12px 32px rgba(0,0,0,0.5)"}}>
          {r1.map(function(p) { return <div key={p.player_id} className="flex items-center gap-2 p-3 cursor-pointer hover:bg-white/5 active:bg-white/10" onMouseDown={function(e) { handleItem(e, pick1, p); }} onTouchEnd={function(e) { handleItem(e, pick1, p); }}>
            <span className="text-white font-medium text-sm">{p.player_tag}</span><RoleBadge role={p.role} /><span className="text-xs opacity-40 ml-auto">{p.team_short}</span>
          </div>; })}
        </div>}
      </div>
      <div className="flex items-center justify-center pt-2"><div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0" style={{background: "rgba(233,69,96,0.15)", color: "#e94560", fontSize: "10px"}}>VS</div></div>
      <div className="relative flex-1">
        <input type="text" value={q2} onChange={function(e) { setQ2(e.target.value); setP2(null); setShow2(true); }} onFocus={function() { setShow2(true); }} onBlur={function() { setTimeout(function() { setShow2(false); }, 300); }} placeholder="Player 2..." className="w-full p-2.5 sm:p-3 rounded-lg text-white placeholder-gray-500 outline-none" style={{background: "rgba(255,255,255,0.06)", border: p2 ? "1px solid rgba(82,183,136,0.4)" : "1px solid rgba(255,255,255,0.1)", fontSize: "15px"}} />
        {show2 && r2.length > 0 && !p2 && <div className="absolute z-10 w-full mt-1 rounded-lg overflow-hidden" style={{background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 12px 32px rgba(0,0,0,0.5)"}}>
          {r2.map(function(p) { return <div key={p.player_id} className="flex items-center gap-2 p-3 cursor-pointer hover:bg-white/5 active:bg-white/10" onMouseDown={function(e) { handleItem(e, pick2, p); }} onTouchEnd={function(e) { handleItem(e, pick2, p); }}>
            <span className="text-white font-medium text-sm">{p.player_tag}</span><RoleBadge role={p.role} /><span className="text-xs opacity-40 ml-auto">{p.team_short}</span>
          </div>; })}
        </div>}
      </div>
    </div>

    {/* View toggle + reset when both selected */}
    {p1 && p2 && <div className="flex items-center justify-between">
      <div className="flex gap-1">
        {["full", "compact"].map(function(m) {
          return <button key={m} onClick={function() { setShareMode(m); }} className="px-2.5 py-1 rounded-lg text-xs font-semibold" style={{background: shareMode === m ? "rgba(233,69,96,0.2)" : "rgba(255,255,255,0.05)", color: shareMode === m ? "#e94560" : "#666"}}>{m === "full" ? "Full breakdown" : "Share card"}</button>;
        })}
      </div>
      <button onClick={function() { setP1(null); setP2(null); setQ1(""); setQ2(""); updateUrl(null, null); }} className="text-xs px-2 py-1 rounded opacity-40 hover:opacity-80" style={{background: "rgba(255,255,255,0.05)"}}>Reset</button>
    </div>}

    {/* ===== SHARE CARD MODE — ultra-compact, fits one phone screen ===== */}
    {p1 && p2 && shareMode === "compact" && function() {
      var sc = function(v1, v2, lower) {
        if (lower) return v1 < v2 ? "#52b788" : v1 > v2 ? "#666" : "#ffd166";
        return v1 > v2 ? "#52b788" : v1 < v2 ? "#666" : "#ffd166";
      };
      var fv = function(v, fmt) { return fmt === "pct" ? v.toFixed(1) + "%" : fmt === "1" ? v.toFixed(1) : v.toFixed(2); };
      var StatCell = function(props) {
        return <div className="text-center" style={{padding: "3px 0"}}>
          <div style={{fontSize: "12px", fontWeight: 700, color: props.color, fontVariantNumeric: "tabular-nums"}}>{props.val}</div>
        </div>;
      };
      var shareStats = [
        {section: "OVERALL", rows: [
          {label: "K/D", v1: s(p1,"kd"), v2: s(p2,"kd"), fmt: "2"},
          {label: "DMG/m", v1: s(p1,"dmg_per_min"), v2: s(p2,"dmg_per_min"), fmt: "1"}
        ]},
        {section: "HARDPOINT", rows: [
          {label: "K/D", v1: s(p1,"hp_kd"), v2: s(p2,"hp_kd"), fmt: "2"},
          {label: "K/10", v1: s(p1,"hp_k_10m"), v2: s(p2,"hp_k_10m"), fmt: "1"},
          {label: "ENG/10", v1: s(p1,"hp_eng_10m"), v2: s(p2,"hp_eng_10m"), fmt: "1"}
        ]},
        {section: "S&D", rows: [
          {label: "K/D", v1: s(p1,"snd_kd"), v2: s(p2,"snd_kd"), fmt: "2"},
          {label: "KPR", v1: s(p1,"snd_kpr"), v2: s(p2,"snd_kpr"), fmt: "2"},
          {label: "FB%", v1: s(p1,"first_blood_percentage")*100, v2: s(p2,"first_blood_percentage")*100, fmt: "1"}
        ]},
        {section: "OVERLOAD", rows: [
          {label: "K/D", v1: s(p1,"ovl_kd"), v2: s(p2,"ovl_kd"), fmt: "2"},
          {label: "K/10", v1: s(p1,"ovl_k_10m"), v2: s(p2,"ovl_k_10m"), fmt: "1"}
        ]}
      ];
      var shareP1Wins = 0, shareP2Wins = 0;
      shareStats.forEach(function(group) {
        group.rows.forEach(function(row) {
          if (row.v1 > row.v2) shareP1Wins++;
          else if (row.v2 > row.v1) shareP2Wins++;
        });
      });
      var shareTotalCats = shareP1Wins + shareP2Wins + shareStats.reduce(function(n, g) { return n + g.rows.filter(function(r) { return r.v1 === r.v2; }).length; }, 0);
      var shareWinner = shareP1Wins > shareP2Wins ? p1 : shareP2Wins > shareP1Wins ? p2 : null;
      return <div id="compare-share-card" ref={cardRef} className="rounded-2xl overflow-hidden" style={{background: "#111128", border: "1px solid rgba(255,255,255,0.08)"}}>
        {/* Branding header — single tight line */}
        <div className="flex items-center justify-between px-3 py-1.5" style={{background: "rgba(233,69,96,0.08)", borderBottom: "1px solid rgba(255,255,255,0.05)"}}>
          <span style={{fontSize: "10px", fontWeight: 900, letterSpacing: "2px", color: "#e94560"}}>BARRACKS</span>
          <span style={{fontSize: "8px", color: "#444", letterSpacing: "0.5px"}}>CDL 2026</span>
        </div>

        {/* Player names + K/D hero — tight */}
        <div className="px-3 pt-2.5 pb-1">
          <div style={{display: "grid", gridTemplateColumns: "1fr 28px 1fr", alignItems: "center"}}>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1"><span style={{fontSize: "15px", fontWeight: 900, color: "#fff", lineHeight: 1.1}}>{p1.player_tag}</span></div>
              <div className="flex items-center justify-center" style={{gap: "3px", marginTop: "1px"}}><span style={{fontSize: "9px", color: "#555"}}>{p1.team_short}</span><RoleBadge role={p1.role} /></div>
            </div>
            <div className="text-center"><span style={{fontSize: "9px", fontWeight: 800, color: "#e94560"}}>VS</span></div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1"><span style={{fontSize: "15px", fontWeight: 900, color: "#fff", lineHeight: 1.1}}>{p2.player_tag}</span></div>
              <div className="flex items-center justify-center" style={{gap: "3px", marginTop: "1px"}}><span style={{fontSize: "9px", color: "#555"}}>{p2.team_short}</span><RoleBadge role={p2.role} /></div>
            </div>
          </div>
          {/* K/D hero numbers */}
          <div style={{display: "grid", gridTemplateColumns: "1fr 28px 1fr", alignItems: "center", marginTop: "4px"}}>
            <div className="text-center">
              <div style={{fontSize: "26px", fontWeight: 900, color: kdColor(s(p1,"kd")), lineHeight: 1}}>{s(p1,"kd").toFixed(2)}</div>
            </div>
            <div className="text-center"><span style={{fontSize: "7px", color: "#444", letterSpacing: "0.5px"}}>K/D</span></div>
            <div className="text-center">
              <div style={{fontSize: "26px", fontWeight: 900, color: kdColor(s(p2,"kd")), lineHeight: 1}}>{s(p2,"kd").toFixed(2)}</div>
            </div>
          </div>
        </div>

        {/* Stat table — dense 3-col grid: P1 val | stat label | P2 val */}
        <div className="px-3 pb-1">
          {shareStats.map(function(group) {
            return <div key={group.section}>
              <div style={{fontSize: "8px", fontWeight: 700, color: "#e94560", letterSpacing: "1.5px", padding: "5px 0 1px"}}>{group.section}</div>
              {group.rows.map(function(row) {
                var f = row.fmt === "1" ? row.v1.toFixed(1) : row.v1.toFixed(2);
                var f2 = row.fmt === "1" ? row.v2.toFixed(1) : row.v2.toFixed(2);
                var c1 = sc(row.v1, row.v2, row.lower);
                var c2 = sc(row.v2, row.v1, row.lower);
                return <div key={row.label} style={{display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", padding: "2px 0", borderBottom: "1px solid rgba(255,255,255,0.025)"}}>
                  <div style={{textAlign: "right", paddingRight: "8px"}}><span style={{fontSize: "12px", fontWeight: 700, color: c1, fontVariantNumeric: "tabular-nums"}}>{f}</span></div>
                  <div style={{fontSize: "9px", color: "#555", textTransform: "uppercase", letterSpacing: "0.3px", minWidth: "40px", textAlign: "center"}}>{row.label}</div>
                  <div style={{textAlign: "left", paddingLeft: "8px"}}><span style={{fontSize: "12px", fontWeight: 700, color: c2, fontVariantNumeric: "tabular-nums"}}>{f2}</span></div>
                </div>;
              })}
            </div>;
          })}
        </div>

        {/* Verdict — tight bar + result */}
        <div className="mx-3 mb-2.5 mt-1 rounded-lg overflow-hidden" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)"}}>
          <div className="flex" style={{height: "3px"}}>
            <div style={{width: (shareTotalCats > 0 ? (shareP1Wins / shareTotalCats * 100) : 50) + "%", background: shareP1Wins >= shareP2Wins ? "#52b788" : "#ff6b6b"}} />
            <div style={{width: (shareTotalCats > 0 ? ((shareTotalCats - shareP1Wins - shareP2Wins) / shareTotalCats * 100) : 0) + "%", background: "#ffd166"}} />
            <div style={{width: (shareTotalCats > 0 ? (shareP2Wins / shareTotalCats * 100) : 50) + "%", background: shareP2Wins >= shareP1Wins ? "#52b788" : "#ff6b6b"}} />
          </div>
          <div style={{display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", padding: "6px 10px"}}>
            <div className="text-left"><span style={{fontSize: "18px", fontWeight: 900, color: shareP1Wins >= shareP2Wins ? "#52b788" : "#ff6b6b"}}>{shareP1Wins}</span><span style={{fontSize: "9px", color: "#555", marginLeft: "3px"}}>wins</span></div>
            <div className="text-center">
              {shareWinner ? <div><div style={{fontSize: "7px", color: "#555", letterSpacing: "1px"}}>VERDICT</div><div style={{fontSize: "11px", fontWeight: 900, color: "#52b788"}}>{shareWinner.player_tag}</div></div> : <div style={{fontSize: "10px", color: "#ffd166", fontWeight: 700}}>TIED</div>}
            </div>
            <div className="text-right"><span style={{fontSize: "9px", color: "#555", marginRight: "3px"}}>wins</span><span style={{fontSize: "18px", fontWeight: 900, color: shareP2Wins >= shareP1Wins ? "#52b788" : "#ff6b6b"}}>{shareP2Wins}</span></div>
          </div>
        </div>

        {/* Footer */}
        <div className="text-center pb-2.5" style={{opacity: 0.35}}><span style={{fontSize: "8px", letterSpacing: "1px"}}>thebarracks.vercel.app</span></div>
      </div>;
    }()}

    {/* Share action buttons — only in compact mode */}
    {p1 && p2 && shareMode === "compact" && <div className="flex gap-2 mt-3">
      <button onClick={handleShareImage} disabled={sharing} className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold" style={{background: sharing ? "rgba(233,69,96,0.3)" : "#e94560", color: "#fff", opacity: sharing ? 0.7 : 1, transition: "opacity 0.2s"}}>
        {sharing ? <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{borderColor: "#fff", borderTopColor: "transparent"}} /> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>}
        <span>{sharing ? "Generating..." : "Share image"}</span>
      </button>
      <button onClick={handleCopyLink} className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold" style={{background: linkCopied ? "rgba(82,183,136,0.15)" : "rgba(255,255,255,0.06)", border: linkCopied ? "1px solid rgba(82,183,136,0.3)" : "1px solid rgba(255,255,255,0.1)", color: linkCopied ? "#52b788" : "#c8c8d0", transition: "all 0.2s"}}>
        {linkCopied ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>}
        <span>{linkCopied ? "Copied!" : "Copy link"}</span>
      </button>
    </div>}

    {/* ===== FULL BREAKDOWN MODE — original detailed view ===== */}
    {p1 && p2 && shareMode === "full" && <div>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="rounded-xl p-3 sm:p-4 text-center" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}}>
          <div className="flex items-center justify-center gap-1"><span className="text-base sm:text-lg font-bold text-white">{p1.player_tag}</span></div>
          <div className="flex items-center justify-center gap-1"><span className="text-xs opacity-40">{p1.team_name}</span><RoleBadge role={p1.role} /></div>
          <div className="text-2xl font-black mt-2" style={{color: kdColor(s(p1, "kd"))}}>{s(p1, "kd").toFixed(2)}</div>
          <div style={{fontSize: "10px", color: "#555"}}>Overall K/D</div>
        </div>
        <div className="rounded-xl p-3 sm:p-4 text-center" style={{background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)"}}>
          <div className="flex items-center justify-center gap-1"><span className="text-base sm:text-lg font-bold text-white">{p2.player_tag}</span></div>
          <div className="flex items-center justify-center gap-1"><span className="text-xs opacity-40">{p2.team_name}</span><RoleBadge role={p2.role} /></div>
          <div className="text-2xl font-black mt-2" style={{color: kdColor(s(p2, "kd"))}}>{s(p2, "kd").toFixed(2)}</div>
          <div style={{fontSize: "10px", color: "#555"}}>Overall K/D</div>
        </div>
      </div>

      <div className="rounded-xl overflow-hidden" style={{background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)"}}>
        <div className="grid items-center py-2 px-3" style={{gridTemplateColumns: "1fr auto 1fr", background: "rgba(255,255,255,0.04)"}}>
          <div className="text-right pr-2 text-xs font-bold" style={{color: "#e94560"}}>{p1.player_tag}</div>
          <div className="text-center text-xs opacity-30 px-1" style={{minWidth: "64px"}}>stat</div>
          <div className="text-left pl-2 text-xs font-bold" style={{color: "#e94560"}}>{p2.player_tag}</div>
        </div>

        <div style={{padding: "0 8px"}}>
          <div style={{fontSize: "9px", fontWeight: 700, color: "#e94560", padding: "8px 0 2px", letterSpacing: "1px"}}>OVERALL</div>
          <CompareRow label="K/D" v1={s(p1, "kd")} v2={s(p2, "kd")} />
          <CompareRow label="DMG/min" v1={s(p1, "dmg_per_min")} v2={s(p2, "dmg_per_min")} fmt="0.0" />

          <div style={{fontSize: "9px", fontWeight: 700, color: "#e94560", padding: "8px 0 2px", letterSpacing: "1px"}}>HARDPOINT</div>
          <CompareRow label="HP K/D" v1={s(p1, "hp_kd")} v2={s(p2, "hp_kd")} />
          <CompareRow label="K/10" v1={s(p1, "hp_k_10m")} v2={s(p2, "hp_k_10m")} fmt="0.0" />
          <CompareRow label="D/10" v1={s(p1, "hp_d_10m")} v2={s(p2, "hp_d_10m")} fmt="0.0" />
          <CompareRow label="DMG/10" v1={s(p1, "hp_dmg_10m")} v2={s(p2, "hp_dmg_10m")} fmt="0.0" />
          <CompareRow label="ENG/10" v1={s(p1, "hp_eng_10m")} v2={s(p2, "hp_eng_10m")} fmt="0.0" />

          <div style={{fontSize: "9px", fontWeight: 700, color: "#e94560", padding: "8px 0 2px", letterSpacing: "1px"}}>SEARCH & DESTROY</div>
          <CompareRow label="SnD K/D" v1={s(p1, "snd_kd")} v2={s(p2, "snd_kd")} />
          <CompareRow label="KPR" v1={s(p1, "snd_kpr")} v2={s(p2, "snd_kpr")} />
          <CompareRow label="DPR" v1={s(p1, "snd_dpr")} v2={s(p2, "snd_dpr")} />
          <CompareRow label="FB%" v1={s(p1, "first_blood_percentage") * 100} v2={s(p2, "first_blood_percentage") * 100} fmt="0.0" />

          <div style={{fontSize: "9px", fontWeight: 700, color: "#e94560", padding: "8px 0 2px", letterSpacing: "1px"}}>OVERLOAD</div>
          <CompareRow label="OVL K/D" v1={s(p1, "ovl_kd")} v2={s(p2, "ovl_kd")} />
          <CompareRow label="K/10" v1={s(p1, "ovl_k_10m")} v2={s(p2, "ovl_k_10m")} fmt="0.0" />
          <CompareRow label="D/10" v1={s(p1, "ovl_d_10m")} v2={s(p2, "ovl_d_10m")} fmt="0.0" />
          <CompareRow label="DMG/10" v1={s(p1, "ovl_dmg_10m")} v2={s(p2, "ovl_dmg_10m")} fmt="0.0" />
          <CompareRow label="ENG/10" v1={s(p1, "ovl_eng_10m")} v2={s(p2, "ovl_eng_10m")} fmt="0.0" />
        </div>

        {/* Win bar visual + verdict */}
        <div style={{borderTop: "1px solid rgba(255,255,255,0.06)"}}>
          <div className="flex" style={{height: "4px"}}>
            <div style={{width: (totalCats > 0 ? (p1Wins / totalCats * 100) : 50) + "%", background: p1Wins >= p2Wins ? "#52b788" : "#ff6b6b", transition: "width 0.5s"}} />
            <div style={{width: (totalCats > 0 ? ((totalCats - p1Wins - p2Wins) / totalCats * 100) : 0) + "%", background: "#ffd166"}} />
            <div style={{width: (totalCats > 0 ? (p2Wins / totalCats * 100) : 50) + "%", background: p2Wins >= p1Wins ? "#52b788" : "#ff6b6b", transition: "width 0.5s"}} />
          </div>
          <div className="grid grid-cols-3 items-center py-3 px-3" style={{background: "rgba(255,255,255,0.03)"}}>
            <div className="text-left"><div className="text-xl font-black" style={{color: p1Wins >= p2Wins ? "#52b788" : "#ff6b6b"}}>{p1Wins}</div><div style={{fontSize: "10px", color: "#555"}}>categories won</div></div>
            <div className="text-center">
              {winner ? <div><div style={{fontSize: "9px", color: "#555", letterSpacing: "0.5px"}}>VERDICT</div><div className="text-sm font-black" style={{color: "#52b788"}}>{winner.player_tag}</div></div> : <div style={{fontSize: "11px", color: "#ffd166", fontWeight: 700}}>TIED</div>}
            </div>
            <div className="text-right"><div className="text-xl font-black" style={{color: p2Wins >= p1Wins ? "#52b788" : "#ff6b6b"}}>{p2Wins}</div><div style={{fontSize: "10px", color: "#555"}}>categories won</div></div>
          </div>
        </div>
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
    {key: "hp_k_10m", label: "HP K/10"},
    {key: "hp_kd", label: "HP K/D"},
    {key: "hp_dmg_10m", label: "HP DMG/10"},
    {key: "hp_eng_10m", label: "HP ENG/10"},
    {key: "snd_kpr", label: "SnD KPR"},
    {key: "snd_kd", label: "SnD K/D"},
    {key: "first_blood_percentage", label: "FB%"},
    {key: "ovl_k_10m", label: "OVL K/10"},
    {key: "ovl_kd", label: "OVL K/D"},
    {key: "dmg_per_min", label: "DMG/min"}
  ];

  var contextStats = {
    kd: [{k: "hp_k_10m", label: "HP K/10", fmt: "0.0"}, {k: "snd_kpr", label: "SnD KPR", fmt: "0.00"}],
    hp_k_10m: [{k: "hp_kd", label: "HP K/D", fmt: "0.00"}, {k: "hp_dmg_10m", label: "HP DMG/10", fmt: "0.0"}],
    hp_kd: [{k: "hp_k_10m", label: "HP K/10", fmt: "0.0"}, {k: "hp_d_10m", label: "HP D/10", fmt: "0.0"}],
    hp_dmg_10m: [{k: "hp_kd", label: "HP K/D", fmt: "0.00"}, {k: "hp_eng_10m", label: "HP ENG/10", fmt: "0.0"}],
    hp_eng_10m: [{k: "hp_k_10m", label: "HP K/10", fmt: "0.0"}, {k: "hp_dmg_10m", label: "HP DMG/10", fmt: "0.0"}],
    snd_kpr: [{k: "snd_kd", label: "SnD K/D", fmt: "0.00"}, {k: "first_blood_percentage", label: "FB%", fmt: "pct"}],
    snd_kd: [{k: "snd_kpr", label: "SnD KPR", fmt: "0.00"}, {k: "snd_dpr", label: "SnD DPR", fmt: "0.00"}],
    first_blood_percentage: [{k: "snd_kpr", label: "SnD KPR", fmt: "0.00"}, {k: "snd_kd", label: "SnD K/D", fmt: "0.00"}],
    ovl_k_10m: [{k: "ovl_kd", label: "OVL K/D", fmt: "0.00"}, {k: "ovl_dmg_10m", label: "OVL DMG/10", fmt: "0.0"}],
    ovl_kd: [{k: "ovl_k_10m", label: "OVL K/10", fmt: "0.0"}, {k: "ovl_d_10m", label: "OVL D/10", fmt: "0.0"}],
    dmg_per_min: [{k: "kd", label: "K/D", fmt: "0.00"}, {k: "hp_k_10m", label: "HP K/10", fmt: "0.0"}]
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

  var mainFmt = sortBy === "first_blood_percentage" ? "pct" : (sortBy.indexOf("k_10m") !== -1 || sortBy.indexOf("d_10m") !== -1 || sortBy.indexOf("dmg_10m") !== -1 || sortBy.indexOf("eng_10m") !== -1 || sortBy === "dmg_per_min") ? "0.0" : "0.00";

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
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-white truncate">{p.player_tag}</span>
            <RoleBadge role={p.role} />
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span style={{fontSize: "11px", color: "#555"}}>{p.team_short}</span>
            <span style={{fontSize: "10px", color: "#444"}}>{matches} matches</span>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {ctx.map(function(c) {
            return <div key={c.k} className="text-center hidden sm:block">
              <div style={{fontSize: "9px", color: "#555"}}>{c.label}</div>
              <div style={{fontSize: "12px", fontWeight: 600, color: "#aaa"}}>{fmtVal(s(p, c.k), c.fmt)}</div>
            </div>;
          })}
          <div className="text-center" style={{minWidth: "48px"}}>
            <div style={{fontSize: "9px", color: "#555"}}>{sortLabel}</div>
            <div style={{fontSize: "16px", fontWeight: 700, color: mainColor}}>{fmtVal(mainVal, mainFmt)}</div>
          </div>
        </div>
      </div>;
    })}
  </div>;
}

var TABS = ["Schedule", "Rankings", "Teams", "Compare", "Players", "Search"];

export default function App() {
  var urlParams = useMemo(function() { try { return new URLSearchParams(window.location.search); } catch(e) { return new URLSearchParams(); } }, []);
  var compareParam = urlParams.get("compare");
  var [tab, setTab] = useState(compareParam ? "Compare" : "Schedule");
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

  var majorName = (analysis.majorStandings && analysis.majorStandings[0] && analysis.majorStandings[0].event_name) || "Major 2";

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

      {tab === "Search" && <div><h2 className="text-lg font-bold text-white mb-4">Player lookup</h2><PlayerSearch analysis={analysis} /></div>}
    </div>
    <div className="text-center py-6 mt-8" style={{borderTop: "1px solid rgba(255,255,255,0.04)"}}><p style={{fontSize: "11px", color: "#444"}}>Data via <a href="https://www.breakingpoint.gg" target="_blank" rel="noopener" style={{color: "#666", textDecoration: "underline"}}>BreakingPoint.gg</a></p></div>
  </div>;
}
