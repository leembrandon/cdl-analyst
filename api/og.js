import { ImageResponse } from '@vercel/og';

// ─── COLORS ──────────────────────────────────────────────────
var SURFACE = '#111128';
var ACCENT = '#e94560';
var GREEN = '#52b788';
var RED = '#ff6b6b';
var YELLOW = '#ffd166';
var DIM = '#555555';
var MUTED = '#444444';
var WHITE = '#ffffff';

function kdColor(kd) {
  if (kd >= 1.05) return GREEN;
  if (kd >= 1.0) return '#a3be8c';
  if (kd >= 0.95) return YELLOW;
  return RED;
}

// ─── SUPABASE ────────────────────────────────────────────────
var SUPA_URL = 'https://xtxlopuvadwwuzvytqgo.supabase.co/rest/v1';
var SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0eGxvcHV2YWR3d3V6dnl0cWdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTk2MjEsImV4cCI6MjA4OTE3NTYyMX0.MP8SGkba0Ye-d-RSRgEmfE6A4KmFTH5fG9S9aJoSnRI';

async function findPlayer(name) {
  var url = SUPA_URL + '/leaderboard?select=*&gamertag=ilike.' + encodeURIComponent(name);
  var res = await fetch(url, {
    headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY },
  });
  if (!res.ok) return null;
  var rows = await res.json();
  return rows[0] || null;
}

// ─── HELPER: h(tag, style, ...children) ─────────────────────
// Shorthand for React.createElement without needing JSX/React import.
// @vercel/og uses Satori which accepts this element format directly.
function h(type, props) {
  var children = Array.prototype.slice.call(arguments, 2);
  // Flatten children arrays
  var flat = [];
  children.forEach(function(c) {
    if (Array.isArray(c)) flat = flat.concat(c);
    else if (c != null && c !== false) flat.push(c);
  });
  return { type: type, props: Object.assign({}, props, { children: flat.length === 1 ? flat[0] : flat.length === 0 ? undefined : flat }), key: null };
}

// ─── LINE CHECK OG ──────────────────────────────────────────
function LineOG(player, cat, direction, threshold) {
  var kd = player.kd || 0;
  var catLabels = {
    map1: 'Map 1 Kills', map2: 'Map 2 Kills', map3: 'Map 3 Kills',
    m13kills: 'Maps 1-3 Kills', serieskd: 'Series K/D',
  };
  var catSubs = {
    map1: 'Hardpoint', map2: 'Search & Destroy', map3: 'Overload',
    m13kills: 'First 3 maps', serieskd: 'Full series',
  };
  var label = catLabels[cat] || cat;
  var sub = catSubs[cat] || '';
  var roleText = (player.role || '') + (player.role && player.team_abbr ? ' · ' : '') + (player.team_abbr || '');

  var element = h('div', { style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: SURFACE, fontFamily: 'system-ui, sans-serif' } },
    // Header
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 32px', background: 'rgba(233,69,96,0.08)' } },
      h('span', { style: { fontSize: 16, fontWeight: 900, color: ACCENT, letterSpacing: 1 } }, 'BARRACKS'),
      h('span', { style: { fontSize: 12, color: DIM } }, 'LINE CHECK \u00B7 CDL 2026')
    ),
    // Player info
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 32px' } },
      h('div', { style: { display: 'flex', flexDirection: 'column' } },
        h('span', { style: { fontSize: 28, fontWeight: 900, color: WHITE } }, player.gamertag),
        h('span', { style: { fontSize: 13, color: DIM, marginTop: 4 } }, roleText)
      ),
      h('div', { style: { display: 'flex', gap: 24 } },
        h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center' } },
          h('span', { style: { fontSize: 10, color: DIM } }, 'K/D'),
          h('span', { style: { fontSize: 22, fontWeight: 800, color: kdColor(kd) } }, kd.toFixed(2))
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center' } },
          h('span', { style: { fontSize: 10, color: DIM } }, 'HP K/10'),
          h('span', { style: { fontSize: 22, fontWeight: 800, color: '#aaa' } }, (player.hp_kills_per_10m || 0).toFixed(1))
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center' } },
          h('span', { style: { fontSize: 10, color: DIM } }, 'SnD KPR'),
          h('span', { style: { fontSize: 22, fontWeight: 800, color: '#aaa' } }, (player.snd_kills_per_round || 0).toFixed(2))
        )
      )
    ),
    // Line info
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '24px 32px', background: 'rgba(82,183,136,0.06)', borderTop: '1px solid rgba(255,255,255,0.05)', borderBottom: '1px solid rgba(255,255,255,0.05)' } },
      h('div', { style: { display: 'flex', flexDirection: 'column' } },
        h('span', { style: { fontSize: 22, fontWeight: 900, color: GREEN, textTransform: 'uppercase' } }, direction + ' ' + threshold),
        h('span', { style: { fontSize: 13, color: DIM, marginTop: 4 } }, label),
        sub ? h('span', { style: { fontSize: 11, color: MUTED, marginTop: 2 } }, sub) : null
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center' } },
        h('span', { style: { fontSize: 14, fontWeight: 700, color: DIM } }, 'Check the line \u2192')
      )
    ),
    // Footer
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px 32px', marginTop: 'auto' } },
      h('span', { style: { fontSize: 11, color: 'rgba(255,255,255,0.25)' } }, 'thebarracks.vercel.app')
    )
  );

  return new ImageResponse(element, { width: 600, height: 340 });
}

// ─── COMPARE OG ──────────────────────────────────────────────
function CompareOG(p1, p2) {
  var kd1 = p1.kd || 0;
  var kd2 = p2.kd || 0;

  var element = h('div', { style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: SURFACE, fontFamily: 'system-ui, sans-serif' } },
    // Header
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 32px', background: 'rgba(233,69,96,0.08)' } },
      h('span', { style: { fontSize: 16, fontWeight: 900, color: ACCENT, letterSpacing: 1 } }, 'BARRACKS'),
      h('span', { style: { fontSize: 12, color: DIM } }, 'PLAYER COMPARE \u00B7 CDL 2026')
    ),
    // Players
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '28px 32px', flex: 1 } },
      // P1
      h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start' } },
        h('span', { style: { fontSize: 24, fontWeight: 900, color: WHITE } }, p1.gamertag),
        h('span', { style: { fontSize: 12, color: DIM, marginTop: 4 } }, (p1.team_abbr || '') + (p1.role ? ' \u00B7 ' + p1.role : '')),
        h('span', { style: { fontSize: 42, fontWeight: 900, color: kdColor(kd1), marginTop: 12 } }, kd1.toFixed(2)),
        h('span', { style: { fontSize: 10, color: DIM } }, 'K/D')
      ),
      // VS
      h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 16px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 22, background: 'rgba(233,69,96,0.15)' } },
          h('span', { style: { fontSize: 14, fontWeight: 900, color: ACCENT } }, 'VS')
        )
      ),
      // P2
      h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' } },
        h('span', { style: { fontSize: 24, fontWeight: 900, color: WHITE } }, p2.gamertag),
        h('span', { style: { fontSize: 12, color: DIM, marginTop: 4 } }, (p2.team_abbr || '') + (p2.role ? ' \u00B7 ' + p2.role : '')),
        h('span', { style: { fontSize: 42, fontWeight: 900, color: kdColor(kd2), marginTop: 12 } }, kd2.toFixed(2)),
        h('span', { style: { fontSize: 10, color: DIM } }, 'K/D')
      )
    ),
    // Footer
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px 32px', borderTop: '1px solid rgba(255,255,255,0.05)' } },
      h('span', { style: { fontSize: 11, color: 'rgba(255,255,255,0.25)' } }, 'thebarracks.vercel.app')
    )
  );

  return new ImageResponse(element, { width: 600, height: 340 });
}

// ─── DEFAULT OG ──────────────────────────────────────────────
function DefaultOG() {
  var element = h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: SURFACE, fontFamily: 'system-ui, sans-serif' } },
    h('span', { style: { fontSize: 48, fontWeight: 900, color: ACCENT, letterSpacing: 2 } }, 'BARRACKS'),
    h('span', { style: { fontSize: 16, color: DIM, marginTop: 8 } }, 'CDL 2026 Stats \u00B7 Standings \u00B7 Line Checks'),
    h('span', { style: { fontSize: 12, color: MUTED, marginTop: 16 } }, 'thebarracks.vercel.app')
  );

  return new ImageResponse(element, { width: 600, height: 340 });
}

// ─── HANDLER ─────────────────────────────────────────────────
export default async function handler(req) {
  try {
    var url = new URL(req.url);
    var searchParams = url.searchParams;

    // Line check: ?line=Shotzzy,map1,over,22,10
    var lineParam = searchParams.get('line');
    if (lineParam) {
      var parts = lineParam.split(',');
      var playerName = decodeURIComponent(parts[0] || '').trim();
      var cat = parts[1] || 'map1';
      var direction = parts[2] || 'over';
      var threshold = parts[3] || '';
      var player = await findPlayer(playerName);
      if (player) {
        return LineOG(player, cat, direction, threshold);
      }
    }

    // Compare: ?compare=Player1,Player2
    var compareParam = searchParams.get('compare');
    if (compareParam) {
      var cparts = compareParam.split(',');
      if (cparts.length >= 2) {
        var p1 = await findPlayer(decodeURIComponent(cparts[0]).trim());
        var p2 = await findPlayer(decodeURIComponent(cparts[1]).trim());
        if (p1 && p2) {
          return CompareOG(p1, p2);
        }
      }
    }

    // Default
    return DefaultOG();
  } catch (e) {
    console.error('OG generation error:', e);
    return DefaultOG();
  }
}
