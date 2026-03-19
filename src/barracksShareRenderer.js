/**
 * barracksShareRenderer.js
 *
 * Pure Canvas-API card renderer for Barracks share images.
 * Every pixel is drawn with ctx.fillRect / fillText — no DOM
 * serialisation, no foreignObject, no html2canvas.
 *
 * EXPORTS
 * ──────
 *  • renderCompareCard(data)  → Promise<Canvas>   (player vs player)
 *  • renderPlayerCard(data)   → Promise<Canvas>   (single player stat card)
 *  • renderTeamCard(data)     → Promise<Canvas>   (team overview)
 *  • renderMatchupCard(data)  → Promise<Canvas>   (upcoming match preview)
 *  • shareCanvas(canvas, filename, shareUrl?)  — trigger download / native share
 */

/* ─── constants ─── */
const SCALE = 2;
const CARD_W = 420;
const PAD = 20;
const CONTENT_W = CARD_W - PAD * 2;
const BG = "#0d0d1a";
const CARD_BG = "#111128";
const CARD_BORDER = "rgba(255,255,255,0.08)";
const ACCENT = "#e94560";
const WHITE = "#ffffff";
const DIM = "#888888";
const FAINT = "#555555";
const MUTED = "#444444";
const GREEN = "#52b788";
const RED = "#ff6b6b";
const YELLOW = "#ffd166";
const BRAND_DIM = "#333333";

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/* role colors — matches the app */
const ROLE_COLORS = { AR: "#53a8b6", SMG: "#e94560", Flex: "#ffd166" };

/* ─── low-level drawing primitives ─── */

function createCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w * SCALE;
  c.height = h * SCALE;
  const ctx = c.getContext("2d");
  ctx.scale(SCALE, SCALE);
  return { canvas: c, ctx };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fillRoundRect(ctx, x, y, w, h, r, color) {
  ctx.fillStyle = color;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
}

function strokeRoundRect(ctx, x, y, w, h, r, color, lineWidth = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  roundRect(ctx, x, y, w, h, r);
  ctx.stroke();
}

function drawText(ctx, text, x, y, { font = `14px ${FONT}`, color = WHITE, align = "left", maxWidth } = {}) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  if (maxWidth) {
    let t = String(text);
    while (ctx.measureText(t).width > maxWidth && t.length > 1) t = t.slice(0, -1);
    if (t !== String(text)) t += "…";
    ctx.fillText(t, x, y);
  } else {
    ctx.fillText(String(text), x, y);
  }
}

function measureText(ctx, text, font) {
  ctx.font = font;
  return ctx.measureText(String(text)).width;
}

function drawLine(ctx, x1, y1, x2, y2, color = "rgba(255,255,255,0.04)", width = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/* ─── helpers ─── */

function kdColor(kd) {
  if (kd >= 1.05) return GREEN;
  if (kd >= 1.0) return "#a3be8c";
  if (kd >= 0.95) return YELLOW;
  return RED;
}

function winColor(v1, v2, lower) {
  if (lower) return v1 < v2 ? GREEN : v1 > v2 ? "#666" : YELLOW;
  return v1 > v2 ? GREEN : v1 < v2 ? "#666" : YELLOW;
}

function fmtVal(v, fmt) {
  if (v == null) return "—";
  if (fmt === "pct") return (v * 100).toFixed(1) + "%";
  if (fmt === "0.0" || fmt === "1") return Number(v).toFixed(1);
  return Number(v).toFixed(2);
}

function safe(obj, key, def) {
  if (def === undefined) def = 0;
  return (obj && obj[key] != null) ? obj[key] : def;
}

/* ─── reusable card components ─── */

function drawBranding(ctx, y, shareUrl) {
  drawText(ctx, "BARRACKS", PAD, y, {
    font: `900 10px ${FONT}`, color: ACCENT,
  });
  drawText(ctx, "CDL 2026", PAD + measureText(ctx, "BARRACKS", `900 10px ${FONT}`) + 6, y + 1, {
    font: `400 8px ${FONT}`, color: MUTED,
  });
  if (shareUrl) {
    const display = shareUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
    drawText(ctx, display, CARD_W - PAD, y, {
      font: `400 9px ${FONT}`, color: MUTED, align: "right",
    });
  }
  return y + 16;
}

function drawRoleBadge(ctx, role, x, y) {
  if (!role) return x;
  const color = ROLE_COLORS[role] || DIM;
  const badgeFont = `600 9px ${FONT}`;
  const tw = measureText(ctx, role, badgeFont);
  const bw = tw + 8;
  fillRoundRect(ctx, x, y, bw, 14, 3, "rgba(255,255,255,0.08)");
  drawText(ctx, role, x + 4, y + 3, { font: badgeFont, color });
  return x + bw + 4;
}

function drawSectionLabel(ctx, text, x, y) {
  drawText(ctx, text.toUpperCase(), x, y, {
    font: `700 8px ${FONT}`, color: ACCENT, letterSpacing: "1.5px",
  });
  return y + 14;
}

/**
 * Draw a stat grid of boxes.
 * boxes: [{ label, value, color? }]
 */
function drawStatGrid(ctx, x, y, w, cols, boxes, gap = 6) {
  const boxW = (w - gap * (cols - 1)) / cols;
  const boxH = 42;
  const r = 8;

  boxes.forEach((b, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const bx = x + col * (boxW + gap);
    const by = y + row * (boxH + gap);

    fillRoundRect(ctx, bx, by, boxW, boxH, r, "rgba(255,255,255,0.03)");
    drawText(ctx, b.label, bx + boxW / 2, by + 7, {
      font: `600 9px ${FONT}`, color: FAINT, align: "center",
    });
    drawText(ctx, b.value ?? "—", bx + boxW / 2, by + 21, {
      font: `700 13px ${FONT}`, color: b.color || WHITE, align: "center",
    });
  });

  const rows = Math.ceil(boxes.length / cols);
  return y + rows * (boxH + gap) - gap;
}


/* ═══════════════════════════════════════════════════════════════════
   COMPARE CARD — player vs player
   ═══════════════════════════════════════════════════════════════════ */
/**
 * data: {
 *   p1: { tag, teamShort, role, kd, stats },
 *   p2: { tag, teamShort, role, kd, stats },
 *   sections: [{ title, rows: [{ label, v1, v2, fmt?, lower? }] }],
 *   p1Wins, p2Wins, totalCats,
 *   shareUrl?: string,
 * }
 */
export async function renderCompareCard(data) {
  const totalRows = data.sections.reduce((n, sec) => n + sec.rows.length, 0);
  const totalSections = data.sections.length;

  let h = PAD;
  h += 6;                              // branding header bar
  h += 20;                             // branding content
  h += 8;                              // gap
  h += 54;                             // player names + roles
  h += 48;                             // K/D hero
  h += 6;                              // gap
  h += totalSections * 14;             // section labels
  h += totalRows * 24;                 // stat rows
  h += 8;                              // gap
  h += 40;                             // verdict bar + text
  h += 10;                             // gap
  h += 16;                             // footer url
  h += PAD;

  const { canvas, ctx } = createCanvas(CARD_W, h);

  // background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CARD_W, h);
  fillRoundRect(ctx, 0, 0, CARD_W, h, 14, CARD_BG);
  strokeRoundRect(ctx, 0, 0, CARD_W, h, 14, CARD_BORDER);

  const mid = CARD_W / 2;
  let cy = PAD;

  // ── branding header bar ──
  fillRoundRect(ctx, 0, 0, CARD_W, cy + 26, 14, "rgba(233,69,96,0.08)");
  // clip corners at top only — just overdraw the bottom corners
  ctx.fillStyle = CARD_BG;
  ctx.fillRect(0, cy + 12, CARD_W, 14);
  drawLine(ctx, 0, cy + 26, CARD_W, cy + 26, "rgba(255,255,255,0.05)");

  drawText(ctx, "BARRACKS", PAD, cy + 6, {
    font: `900 10px ${FONT}`, color: ACCENT,
  });
  drawText(ctx, "CDL 2026", CARD_W - PAD, cy + 7, {
    font: `400 8px ${FONT}`, color: MUTED, align: "right",
  });
  cy += 26 + 8;

  // ── player names ──
  // P1 left side
  drawText(ctx, data.p1.tag, mid - 18, cy, {
    font: `900 15px ${FONT}`, color: WHITE, align: "right", maxWidth: mid - 40,
  });
  let p1SubX = mid - 18 - measureText(ctx, data.p1.tag, `900 15px ${FONT}`);
  // sub line — team + role
  const p1Sub = data.p1.teamShort || "";
  drawText(ctx, p1Sub, mid - 18, cy + 20, {
    font: `400 9px ${FONT}`, color: FAINT, align: "right",
  });
  if (data.p1.role) {
    const subW = measureText(ctx, p1Sub, `400 9px ${FONT}`);
    drawRoleBadge(ctx, data.p1.role, mid - 18 - subW - 4 - (measureText(ctx, data.p1.role, `600 9px ${FONT}`) + 8), cy + 18);
  }

  // VS
  drawText(ctx, "VS", mid, cy + 6, { font: `900 9px ${FONT}`, color: ACCENT, align: "center" });

  // P2 right side
  drawText(ctx, data.p2.tag, mid + 18, cy, {
    font: `900 15px ${FONT}`, color: WHITE, maxWidth: mid - 40,
  });
  drawText(ctx, data.p2.teamShort || "", mid + 18, cy + 20, {
    font: `400 9px ${FONT}`, color: FAINT,
  });
  if (data.p2.role) {
    const subW2 = measureText(ctx, data.p2.teamShort || "", `400 9px ${FONT}`);
    drawRoleBadge(ctx, data.p2.role, mid + 18 + subW2 + 4, cy + 18);
  }

  cy += 54;

  // ── K/D hero numbers ──
  drawText(ctx, safe(data.p1, "kd").toFixed(2), mid - 18, cy, {
    font: `900 26px ${FONT}`, color: kdColor(safe(data.p1, "kd")), align: "right",
  });
  drawText(ctx, "K/D", mid, cy + 10, {
    font: `400 7px ${FONT}`, color: MUTED, align: "center",
  });
  drawText(ctx, safe(data.p2, "kd").toFixed(2), mid + 18, cy, {
    font: `900 26px ${FONT}`, color: kdColor(safe(data.p2, "kd")),
  });
  cy += 48;

  // ── stat sections ──
  data.sections.forEach((section) => {
    cy = drawSectionLabel(ctx, section.title, PAD, cy);

    section.rows.forEach((row) => {
      const v1 = Number(row.v1 || 0);
      const v2 = Number(row.v2 || 0);
      const lower = row.lower || false;
      const c1 = winColor(v1, v2, lower);
      const c2 = winColor(v2, v1, lower);
      const fmt = row.fmt || "2";
      const fv = (v) => fmt === "1" ? Number(v).toFixed(1) : fmt === "pct" ? Number(v).toFixed(1) + "%" : Number(v).toFixed(2);

      drawText(ctx, fv(v1), mid - 30, cy + 3, { font: `700 12px ${FONT}`, color: c1, align: "right" });
      drawText(ctx, row.label, mid, cy + 4, { font: `600 9px ${FONT}`, color: FAINT, align: "center" });
      drawText(ctx, fv(v2), mid + 30, cy + 3, { font: `700 12px ${FONT}`, color: c2 });
      drawLine(ctx, PAD, cy + 22, CARD_W - PAD, cy + 22, "rgba(255,255,255,0.025)");
      cy += 24;
    });
    cy += 2; // small gap between sections
  });

  cy += 4;

  // ── verdict bar ──
  const p1W = data.p1Wins || 0;
  const p2W = data.p2Wins || 0;
  const total = data.totalCats || (p1W + p2W) || 1;
  const ties = total - p1W - p2W;

  // colored bar
  const barY = cy;
  const barH = 3;
  fillRoundRect(ctx, PAD, barY, CONTENT_W, barH, 2, "rgba(255,255,255,0.06)");
  const w1 = (p1W / total) * CONTENT_W;
  const wT = (ties / total) * CONTENT_W;
  if (w1 > 0) fillRoundRect(ctx, PAD, barY, w1, barH, 2, p1W >= p2W ? GREEN : RED);
  if (wT > 0) ctx.fillStyle = YELLOW, ctx.fillRect(PAD + w1, barY, wT, barH);
  const w2 = CONTENT_W - w1 - wT;
  if (w2 > 0) fillRoundRect(ctx, PAD + w1 + wT, barY, w2, barH, 2, p2W >= p1W ? GREEN : RED);

  cy += barH + 6;

  // win counts + verdict
  const verdictY = cy;
  drawText(ctx, String(p1W), PAD + 2, verdictY, {
    font: `900 18px ${FONT}`, color: p1W >= p2W ? GREEN : RED,
  });
  drawText(ctx, "wins", PAD + 2 + measureText(ctx, String(p1W), `900 18px ${FONT}`) + 3, verdictY + 5, {
    font: `400 9px ${FONT}`, color: FAINT,
  });

  const winner = p1W > p2W ? data.p1 : p2W > p1W ? data.p2 : null;
  if (winner) {
    drawText(ctx, "VERDICT", mid, verdictY - 1, { font: `400 7px ${FONT}`, color: FAINT, align: "center" });
    drawText(ctx, winner.tag, mid, verdictY + 9, { font: `900 11px ${FONT}`, color: GREEN, align: "center" });
  } else {
    drawText(ctx, "TIED", mid, verdictY + 4, { font: `700 10px ${FONT}`, color: YELLOW, align: "center" });
  }

  const p2WStr = String(p2W);
  drawText(ctx, "wins", CARD_W - PAD - 2 - measureText(ctx, p2WStr, `900 18px ${FONT}`) - 3 - measureText(ctx, "wins", `400 9px ${FONT}`), verdictY + 5, {
    font: `400 9px ${FONT}`, color: FAINT,
  });
  drawText(ctx, p2WStr, CARD_W - PAD - 2, verdictY, {
    font: `900 18px ${FONT}`, color: p2W >= p1W ? GREEN : RED, align: "right",
  });

  cy += 30 + 10;

  // ── footer ──
  drawText(ctx, "thebarracks.vercel.app", mid, cy, {
    font: `400 8px ${FONT}`, color: MUTED, align: "center",
  });

  return canvas;
}


/* ═══════════════════════════════════════════════════════════════════
   PLAYER CARD — single player stat overview
   ═══════════════════════════════════════════════════════════════════ */
/**
 * data: {
 *   tag, teamShort, teamName, role,
 *   kd, matchesPlayed,
 *   overallStats:  [{ label, value, color? }],   // K/D, DMG/min, FB%
 *   hpStats:       [{ label, value, color? }],   // HP K/D, K/10, D/10, DMG/10, ENG/10
 *   sndStats:      [{ label, value, color? }],   // SnD K/D, KPR, DPR, FB%
 *   ovlStats:      [{ label, value, color? }],   // OVL K/D, K/10, D/10, DMG/10, ENG/10
 *   teamColor?: string,
 *   shareUrl?: string,
 * }
 */
export async function renderPlayerCard(data) {
  const overallCols = Math.min((data.overallStats || []).length, 3);
  const overallRows = Math.ceil((data.overallStats || []).length / overallCols);
  const hpCols = Math.min((data.hpStats || []).length, 5);
  const hpRows = Math.ceil((data.hpStats || []).length / hpCols);
  const sndCols = Math.min((data.sndStats || []).length, 4);
  const sndRows = Math.ceil((data.sndStats || []).length / sndCols);
  const ovlCols = Math.min((data.ovlStats || []).length, 5);
  const ovlRows = Math.ceil((data.ovlStats || []).length / ovlCols);

  let h = PAD;
  h += 50;                                  // header (name, team, role)
  h += 4;                                   // gap
  h += 14 + overallRows * 48;              // overall section
  h += 8;
  h += 14 + hpRows * 48;                   // hardpoint section
  h += 8;
  h += 14 + sndRows * 48;                  // snd section
  h += 8;
  h += 14 + ovlRows * 48;                  // overload section
  h += 10;
  h += 14;                                  // matches played
  h += 16;                                  // branding
  h += PAD;

  const { canvas, ctx } = createCanvas(CARD_W, h);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CARD_W, h);
  fillRoundRect(ctx, 0, 0, CARD_W, h, 14, CARD_BG);
  strokeRoundRect(ctx, 0, 0, CARD_W, h, 14, CARD_BORDER);

  let cy = PAD;

  // ── header ──
  // team color bar
  if (data.teamColor) {
    fillRoundRect(ctx, PAD, cy, 4, 36, 2, data.teamColor);
  }
  const tx = PAD + (data.teamColor ? 12 : 0);
  drawText(ctx, data.tag, tx, cy, {
    font: `900 20px ${FONT}`, color: WHITE, maxWidth: CARD_W - tx - PAD - 60,
  });
  // K/D badge on right
  drawText(ctx, safe(data, "kd").toFixed(2), CARD_W - PAD, cy + 2, {
    font: `900 22px ${FONT}`, color: kdColor(safe(data, "kd")), align: "right",
  });
  drawText(ctx, "K/D", CARD_W - PAD, cy + 26, {
    font: `400 9px ${FONT}`, color: FAINT, align: "right",
  });

  // team + role
  let subX = tx;
  drawText(ctx, data.teamShort || data.teamName || "", subX, cy + 26, {
    font: `400 11px ${FONT}`, color: FAINT,
  });
  subX += measureText(ctx, data.teamShort || data.teamName || "", `400 11px ${FONT}`) + 6;
  subX = drawRoleBadge(ctx, data.role, subX, cy + 24);

  cy += 50 + 4;

  // ── sections ──
  const sections = [
    { label: "Overall", stats: data.overallStats, cols: overallCols },
    { label: "Hardpoint", stats: data.hpStats, cols: hpCols },
    { label: "Search & Destroy", stats: data.sndStats, cols: sndCols },
    { label: "Overload", stats: data.ovlStats, cols: ovlCols },
  ];

  sections.forEach((sec) => {
    if (!sec.stats || !sec.stats.length) return;
    cy = drawSectionLabel(ctx, sec.label, PAD, cy);
    cy = drawStatGrid(ctx, PAD, cy, CONTENT_W, sec.cols, sec.stats) + 8;
  });

  cy += 2;

  // ── footer ──
  if (data.matchesPlayed != null) {
    drawText(ctx, `${data.matchesPlayed} matches played`, PAD, cy, {
      font: `400 10px ${FONT}`, color: FAINT,
    });
    cy += 14;
  }
  drawBranding(ctx, cy, data.shareUrl);

  return canvas;
}


/* ═══════════════════════════════════════════════════════════════════
   TEAM CARD — team overview with mode breakdown
   ═══════════════════════════════════════════════════════════════════ */
/**
 * data: {
 *   name, short, color,
 *   rank?, points?,
 *   record: { wins, losses },
 *   major: { wins, losses, gameWins, gameLosses, points },
 *   season: { wins, losses, gameWins, gameLosses, points },
 *   topStats:  [{ label, value, color? }],   // K/D, Win%, HP Diff, CDL Pts
 *   modes:     [{ label, winPct, kd, diff }], // HP, SnD, OVL
 *   roster:    [{ tag, role, kd }],
 *   shareUrl?: string,
 * }
 */
export async function renderTeamCard(data) {
  const rosterCount = (data.roster || []).length;

  let h = PAD;
  h += 50;                         // header
  h += 8;
  h += 48;                         // major/season boxes
  h += 8;
  h += 42;                         // top stat boxes (1 row)
  h += 10;
  h += 14;                         // mode label
  h += (data.modes || []).length * 28; // mode rows
  h += 10;
  h += 14;                         // roster label
  h += rosterCount * 22;           // roster rows
  h += 10;
  h += 16;                         // branding
  h += PAD;

  const { canvas, ctx } = createCanvas(CARD_W, h);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CARD_W, h);
  fillRoundRect(ctx, 0, 0, CARD_W, h, 14, CARD_BG);
  strokeRoundRect(ctx, 0, 0, CARD_W, h, 14, CARD_BORDER);

  let cy = PAD;

  // ── header ──
  if (data.color) fillRoundRect(ctx, PAD, cy, 5, 40, 2, data.color);
  const tx = PAD + (data.color ? 14 : 0);
  drawText(ctx, data.name, tx, cy, {
    font: `900 20px ${FONT}`, color: WHITE, maxWidth: CARD_W - tx - PAD - 60,
  });
  drawText(ctx, `${data.record.wins}-${data.record.losses} season · ${data.points || 0} pts`, tx, cy + 26, {
    font: `400 11px ${FONT}`, color: FAINT,
  });
  if (data.rank) {
    drawText(ctx, `#${data.rank}`, CARD_W - PAD, cy + 4, {
      font: `900 22px ${FONT}`, color: ACCENT, align: "right",
    });
  }
  cy += 50 + 8;

  // ── major / season boxes ──
  const boxW = (CONTENT_W - 6) / 2;
  const boxH = 48;

  [
    { label: "MAJOR 2", d: data.major },
    { label: "SEASON", d: data.season },
  ].forEach((item, i) => {
    const bx = PAD + i * (boxW + 6);
    fillRoundRect(ctx, bx, cy, boxW, boxH, 8, "rgba(255,255,255,0.04)");
    drawText(ctx, item.label, bx + 8, cy + 6, { font: `600 9px ${FONT}`, color: FAINT });
    drawText(ctx, `${item.d.wins}-${item.d.losses}`, bx + 8, cy + 18, { font: `700 14px ${FONT}`, color: WHITE });
    drawText(ctx, `${item.d.gameWins}-${item.d.gameLosses} maps · ${item.d.points || 0} pts`, bx + 8, cy + 34, {
      font: `400 9px ${FONT}`, color: FAINT,
    });
  });
  cy += boxH + 8;

  // ── top stats row ──
  if (data.topStats && data.topStats.length) {
    cy = drawStatGrid(ctx, PAD, cy, CONTENT_W, Math.min(data.topStats.length, 4), data.topStats) + 10;
  }

  // ── mode breakdown ──
  if (data.modes && data.modes.length) {
    cy = drawSectionLabel(ctx, "Mode breakdown", PAD, cy);

    // header row
    const colW = [CONTENT_W * 0.28, CONTENT_W * 0.24, CONTENT_W * 0.24, CONTENT_W * 0.24];
    const cols = ["", "WIN%", "K/D", "DIFF"];
    cols.forEach((label, i) => {
      const cx = PAD + colW.slice(0, i).reduce((a, b) => a + b, 0) + colW[i] / 2;
      drawText(ctx, label, cx, cy, { font: `600 8px ${FONT}`, color: FAINT, align: "center" });
    });
    cy += 16;

    data.modes.forEach((mode) => {
      const rowY = cy;
      drawText(ctx, mode.label, PAD + colW[0] / 2, rowY + 2, { font: `600 11px ${FONT}`, color: DIM, align: "center" });
      drawText(ctx, mode.winPct.toFixed(1) + "%", PAD + colW[0] + colW[1] / 2, rowY + 2, {
        font: `700 11px ${FONT}`, color: mode.winPct > 50 ? GREEN : mode.winPct < 45 ? RED : YELLOW, align: "center",
      });
      drawText(ctx, mode.kd.toFixed(2), PAD + colW[0] + colW[1] + colW[2] / 2, rowY + 2, {
        font: `700 11px ${FONT}`, color: kdColor(mode.kd), align: "center",
      });
      const diffStr = (mode.diff > 0 ? "+" : "") + mode.diff.toFixed(1);
      drawText(ctx, diffStr, PAD + colW[0] + colW[1] + colW[2] + colW[3] / 2, rowY + 2, {
        font: `700 11px ${FONT}`, color: mode.diff > 0 ? GREEN : RED, align: "center",
      });
      drawLine(ctx, PAD, rowY + 20, CARD_W - PAD, rowY + 20, "rgba(255,255,255,0.03)");
      cy += 28;
    });
    cy += 2;
  }

  // ── roster ──
  if (data.roster && data.roster.length) {
    cy = drawSectionLabel(ctx, "Roster", PAD, cy);
    data.roster.forEach((p) => {
      drawText(ctx, p.tag, PAD + 4, cy + 2, { font: `600 11px ${FONT}`, color: WHITE });
      let rx = PAD + 4 + measureText(ctx, p.tag, `600 11px ${FONT}`) + 4;
      rx = drawRoleBadge(ctx, p.role, rx, cy + 1);
      drawText(ctx, p.kd.toFixed(2), CARD_W - PAD, cy + 2, {
        font: `700 11px ${FONT}`, color: kdColor(p.kd), align: "right",
      });
      drawLine(ctx, PAD, cy + 18, CARD_W - PAD, cy + 18, "rgba(255,255,255,0.025)");
      cy += 22;
    });
    cy += 2;
  }

  cy += 6;
  drawBranding(ctx, cy, data.shareUrl);

  return canvas;
}


/* ═══════════════════════════════════════════════════════════════════
   MATCHUP CARD — upcoming match preview
   ═══════════════════════════════════════════════════════════════════ */
/**
 * data: {
 *   t1: { name, short, color },
 *   t2: { name, short, color },
 *   event: string,
 *   datetime: string,
 *   bestOf: number,
 *   favored: string,
 *   edge: number,
 *   stats: [{ label, v1, v2, fmt?, higherBetter? }],
 *   t1Roster: [{ tag, role, kd }],
 *   t2Roster: [{ tag, role, kd }],
 *   shareUrl?: string,
 * }
 */
export async function renderMatchupCard(data) {
  const statRows = (data.stats || []).length;
  const t1R = (data.t1Roster || []).length;
  const t2R = (data.t2Roster || []).length;

  let h = PAD;
  h += 52;                             // team header (names + vs)
  h += 24;                             // event info
  h += 6;
  h += 14 + statRows * 24;            // team comparison
  h += 10;
  h += 14 + Math.max(t1R, t2R) * 20;  // rosters side by side
  h += 10;
  h += 16;                             // branding
  h += PAD;

  const { canvas, ctx } = createCanvas(CARD_W, h);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CARD_W, h);
  fillRoundRect(ctx, 0, 0, CARD_W, h, 14, CARD_BG);
  strokeRoundRect(ctx, 0, 0, CARD_W, h, 14, CARD_BORDER);

  const mid = CARD_W / 2;
  let cy = PAD;

  // ── team matchup header ──
  // T1 left
  if (data.t1.color) fillRoundRect(ctx, PAD, cy + 6, 4, 30, 2, data.t1.color);
  drawText(ctx, data.t1.short, PAD + 12, cy, {
    font: `900 24px ${FONT}`, color: WHITE,
  });

  // VS
  drawText(ctx, "vs", mid, cy + 8, { font: `400 12px ${FONT}`, color: FAINT, align: "center" });
  drawText(ctx, `▸ ${data.favored}`, mid, cy + 26, { font: `600 10px ${FONT}`, color: GREEN, align: "center" });

  // T2 right
  if (data.t2.color) fillRoundRect(ctx, CARD_W - PAD - 4, cy + 6, 4, 30, 2, data.t2.color);
  drawText(ctx, data.t2.short, CARD_W - PAD - 12, cy, {
    font: `900 24px ${FONT}`, color: WHITE, align: "right",
  });

  cy += 52;

  // event info
  drawText(ctx, `${data.event} · Bo${data.bestOf} · Edge: ${data.edge.toFixed(1)}`, mid, cy, {
    font: `400 10px ${FONT}`, color: FAINT, align: "center",
  });
  drawText(ctx, data.datetime, mid, cy + 12, {
    font: `400 10px ${FONT}`, color: MUTED, align: "center",
  });
  cy += 24 + 6;

  // ── team stat comparison ──
  cy = drawSectionLabel(ctx, "Team comparison", PAD, cy);
  (data.stats || []).forEach((st) => {
    const v1 = Number(st.v1 || 0);
    const v2 = Number(st.v2 || 0);
    const hb = st.higherBetter !== false;
    const c1 = hb ? (v1 > v2 ? GREEN : v1 < v2 ? RED : YELLOW) : (v1 < v2 ? GREEN : v1 > v2 ? RED : YELLOW);
    const c2 = hb ? (v2 > v1 ? GREEN : v2 < v1 ? RED : YELLOW) : (v2 < v1 ? GREEN : v2 > v1 ? RED : YELLOW);
    const fv = (v) => st.fmt === "pct" ? Number(v).toFixed(1) + "%" : st.fmt === "0.0" ? Number(v).toFixed(1) : Number(v).toFixed(2);

    drawText(ctx, fv(v1), mid - 30, cy + 3, { font: `700 12px ${FONT}`, color: c1, align: "right" });
    drawText(ctx, st.label, mid, cy + 4, { font: `600 9px ${FONT}`, color: FAINT, align: "center" });
    drawText(ctx, fv(v2), mid + 30, cy + 3, { font: `700 12px ${FONT}`, color: c2 });
    drawLine(ctx, PAD, cy + 22, CARD_W - PAD, cy + 22, "rgba(255,255,255,0.025)");
    cy += 24;
  });
  cy += 4;

  // ── rosters side by side ──
  cy = drawSectionLabel(ctx, "Rosters", PAD, cy);

  // T1 header + T2 header
  drawText(ctx, data.t1.short, PAD + 4, cy, { font: `700 10px ${FONT}`, color: data.t1.color || DIM });
  drawText(ctx, data.t2.short, mid + 10, cy, { font: `700 10px ${FONT}`, color: data.t2.color || DIM });
  cy += 16;

  const maxR = Math.max(t1R, t2R);
  for (let i = 0; i < maxR; i++) {
    const p1 = (data.t1Roster || [])[i];
    const p2 = (data.t2Roster || [])[i];
    if (p1) {
      drawText(ctx, p1.tag, PAD + 4, cy + 1, { font: `500 10px ${FONT}`, color: WHITE, maxWidth: mid - PAD - 50 });
      drawText(ctx, p1.kd.toFixed(2), mid - 10, cy + 1, {
        font: `700 10px ${FONT}`, color: kdColor(p1.kd), align: "right",
      });
    }
    if (p2) {
      drawText(ctx, p2.tag, mid + 10, cy + 1, { font: `500 10px ${FONT}`, color: WHITE, maxWidth: mid - PAD - 50 });
      drawText(ctx, p2.kd.toFixed(2), CARD_W - PAD - 4, cy + 1, {
        font: `700 10px ${FONT}`, color: kdColor(p2.kd), align: "right",
      });
    }
    cy += 20;
  }

  cy += 6;
  drawBranding(ctx, cy, data.shareUrl);

  return canvas;
}


/* ═══════════════════════════════════════════════════════════════════
   SHARE / DOWNLOAD
   ═══════════════════════════════════════════════════════════════════ */
/**
 * Trigger native share or fallback download.
 * @param {HTMLCanvasElement} canvas
 * @param {string} filename  — without extension
 * @param {string} [shareUrl] — optional URL to include with native share
 * @returns {Promise<void>}
 */
export function shareCanvas(canvas, filename, shareUrl) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) { resolve(); return; }
      const file = new File([blob], filename + ".png", { type: "image/png" });

      if (navigator.share && navigator.canShare) {
        const shareData = { files: [file], title: filename };
        if (shareUrl) shareData.url = shareUrl;
        if (navigator.canShare(shareData)) {
          navigator.share(shareData).catch(() => {}).finally(resolve);
          return;
        }
        if (shareUrl) {
          navigator.share({ title: filename, url: shareUrl }).catch(() => {}).finally(resolve);
          return;
        }
      }

      // fallback: download
      const link = document.createElement("a");
      link.download = filename + ".png";
      link.href = canvas.toDataURL("image/png");
      link.click();
      resolve();
    }, "image/png");
  });
}
