import { ImageResponse } from '@vercel/og';

// ─── COLORS ──────────────────────────────────────────────────
const BG = '#0d0d1a';
const SURFACE = '#111128';
const ACCENT = '#e94560';
const GREEN = '#52b788';
const RED = '#ff6b6b';
const YELLOW = '#ffd166';
const DIM = '#555555';
const MUTED = '#444444';
const WHITE = '#ffffff';

function kdColor(kd) {
  if (kd >= 1.05) return GREEN;
  if (kd >= 1.0) return '#a3be8c';
  if (kd >= 0.95) return YELLOW;
  return RED;
}

// ─── SUPABASE HELPERS ────────────────────────────────────────
const SUPA_URL = 'https://xtxlopuvadwwuzvytqgo.supabase.co/rest/v1';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0eGxvcHV2YWR3d3V6dnl0cWdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTk2MjEsImV4cCI6MjA4OTE3NTYyMX0.MP8SGkba0Ye-d-RSRgEmfE6A4KmFTH5fG9S9aJoSnRI';

async function supaFetch(table, query) {
  const url = SUPA_URL + '/' + table + '?' + (query || 'select=*');
  const res = await fetch(url, {
    headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY },
  });
  if (!res.ok) return [];
  return res.json();
}

async function findPlayer(name) {
  const rows = await supaFetch('leaderboard', 'select=*&gamertag=ilike.' + encodeURIComponent(name));
  return rows[0] || null;
}

// ─── LINE CHECK OG ──────────────────────────────────────────
function LineOG({ player, cat, direction, threshold }) {
  const kd = player.kd || 0;
  const label = {
    map1: 'Map 1 Kills', map2: 'Map 2 Kills', map3: 'Map 3 Kills',
    m13kills: 'Maps 1-3 Kills', serieskd: 'Series K/D',
  }[cat] || cat;
  const sub = {
    map1: 'Hardpoint', map2: 'Search & Destroy', map3: 'Overload',
    m13kills: 'First 3 maps', serieskd: 'Full series',
  }[cat] || '';

  return new ImageResponse(
    (
      <div style={{
        display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
        background: SURFACE, fontFamily: 'system-ui, sans-serif', padding: 0,
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 32px', background: 'rgba(233,69,96,0.08)',
        }}>
          <span style={{ fontSize: 16, fontWeight: 900, color: ACCENT, letterSpacing: 1 }}>BARRACKS</span>
          <span style={{ fontSize: 12, color: DIM }}>LINE CHECK · CDL 2026</span>
        </div>

        {/* Player info */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 32px',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 28, fontWeight: 900, color: WHITE }}>{player.gamertag}</span>
            <span style={{ fontSize: 13, color: DIM, marginTop: 4 }}>
              {player.role || ''}{player.role && player.team_abbr ? ' · ' : ''}{player.team_abbr || ''}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 24 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: DIM }}>K/D</span>
              <span style={{ fontSize: 22, fontWeight: 800, color: kdColor(kd) }}>{kd.toFixed(2)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: DIM }}>HP K/10</span>
              <span style={{ fontSize: 22, fontWeight: 800, color: '#aaa' }}>{(player.hp_kills_per_10m || 0).toFixed(1)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: DIM }}>SnD KPR</span>
              <span style={{ fontSize: 22, fontWeight: 800, color: '#aaa' }}>{(player.snd_kills_per_round || 0).toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Line info */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '24px 32px', background: 'rgba(82,183,136,0.06)',
          borderTop: '1px solid rgba(255,255,255,0.05)',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 22, fontWeight: 900, color: GREEN, textTransform: 'uppercase' }}>
              {direction} {threshold}
            </span>
            <span style={{ fontSize: 13, color: DIM, marginTop: 4 }}>{label}</span>
            {sub && <span style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{sub}</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: DIM }}>Check the line →</span>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '16px 32px', marginTop: 'auto',
        }}>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)' }}>thebarracks.vercel.app</span>
        </div>
      </div>
    ),
    { width: 600, height: 340 }
  );
}

// ─── COMPARE OG ──────────────────────────────────────────────
function CompareOG({ p1, p2 }) {
  const kd1 = p1.kd || 0, kd2 = p2.kd || 0;
  return new ImageResponse(
    (
      <div style={{
        display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
        background: SURFACE, fontFamily: 'system-ui, sans-serif',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 32px', background: 'rgba(233,69,96,0.08)',
        }}>
          <span style={{ fontSize: 16, fontWeight: 900, color: ACCENT, letterSpacing: 1 }}>BARRACKS</span>
          <span style={{ fontSize: 12, color: DIM }}>PLAYER COMPARE · CDL 2026</span>
        </div>

        {/* Players */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '28px 32px', flex: 1,
        }}>
          {/* P1 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <span style={{ fontSize: 24, fontWeight: 900, color: WHITE }}>{p1.gamertag}</span>
            <span style={{ fontSize: 12, color: DIM, marginTop: 4 }}>
              {p1.team_abbr || ''}{p1.role ? ' · ' + p1.role : ''}
            </span>
            <span style={{ fontSize: 42, fontWeight: 900, color: kdColor(kd1), marginTop: 12 }}>
              {kd1.toFixed(2)}
            </span>
            <span style={{ fontSize: 10, color: DIM }}>K/D</span>
          </div>

          {/* VS */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: '0 16px',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 44, height: 44, borderRadius: 22,
              background: 'rgba(233,69,96,0.15)',
            }}>
              <span style={{ fontSize: 14, fontWeight: 900, color: ACCENT }}>VS</span>
            </div>
          </div>

          {/* P2 */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            <span style={{ fontSize: 24, fontWeight: 900, color: WHITE }}>{p2.gamertag}</span>
            <span style={{ fontSize: 12, color: DIM, marginTop: 4 }}>
              {p2.team_abbr || ''}{p2.role ? ' · ' + p2.role : ''}
            </span>
            <span style={{ fontSize: 42, fontWeight: 900, color: kdColor(kd2), marginTop: 12 }}>
              {kd2.toFixed(2)}
            </span>
            <span style={{ fontSize: 10, color: DIM }}>K/D</span>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '16px 32px', borderTop: '1px solid rgba(255,255,255,0.05)',
        }}>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)' }}>thebarracks.vercel.app</span>
        </div>
      </div>
    ),
    { width: 600, height: 340 }
  );
}

// ─── DEFAULT OG ──────────────────────────────────────────────
function DefaultOG() {
  return new ImageResponse(
    (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        width: '100%', height: '100%', background: SURFACE, fontFamily: 'system-ui, sans-serif',
      }}>
        <span style={{ fontSize: 48, fontWeight: 900, color: ACCENT, letterSpacing: 2 }}>BARRACKS</span>
        <span style={{ fontSize: 16, color: DIM, marginTop: 8 }}>CDL 2026 Stats · Standings · Line Checks</span>
        <span style={{ fontSize: 12, color: MUTED, marginTop: 16 }}>thebarracks.vercel.app</span>
      </div>
    ),
    { width: 600, height: 340 }
  );
}

// ─── HANDLER ─────────────────────────────────────────────────
export default async function handler(req) {
  try {
    const { searchParams } = new URL(req.url);

    // Line check: ?line=Shotzzy,map1,over,22,10
    const lineParam = searchParams.get('line');
    if (lineParam) {
      const parts = lineParam.split(',');
      const playerName = decodeURIComponent(parts[0] || '').trim();
      const cat = parts[1] || 'map1';
      const direction = parts[2] || 'over';
      const threshold = parts[3] || '';
      const player = await findPlayer(playerName);
      if (player) {
        return LineOG({ player, cat, direction, threshold });
      }
    }

    // Compare: ?compare=Player1,Player2
    const compareParam = searchParams.get('compare');
    if (compareParam) {
      const parts = compareParam.split(',');
      if (parts.length >= 2) {
        const p1 = await findPlayer(decodeURIComponent(parts[0]).trim());
        const p2 = await findPlayer(decodeURIComponent(parts[1]).trim());
        if (p1 && p2) {
          return CompareOG({ p1, p2 });
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
