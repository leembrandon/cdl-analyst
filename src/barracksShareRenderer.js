/**
 * shareRenderer.js
 * Pure Canvas API renderer for Barracks CDL share images.
 * No html2canvas dependency — draws everything pixel-by-pixel.
 */

var CARD_WIDTH = 720;
var CARD_PADDING = 32;
var BG_COLOR = "#0d0d1a";
var SURFACE_COLOR = "#111128";
var ACCENT = "#e94560";
var TEXT_WHITE = "#ffffff";
var TEXT_DIM = "#555555";
var TEXT_MUTED = "#444444";
var GREEN = "#52b788";
var RED = "#ff6b6b";
var YELLOW = "#ffd166";
var BORDER_COLOR = "rgba(255,255,255,0.06)";

function kdColor(kd) {
  if (kd >= 1.05) return GREEN;
  if (kd >= 1.0) return "#a3be8c";
  if (kd >= 0.95) return YELLOW;
  return RED;
}

function scoreColor(v1, v2, lower) {
  if (lower) return v1 < v2 ? GREEN : v1 > v2 ? "#666666" : YELLOW;
  return v1 > v2 ? GREEN : v1 < v2 ? "#666666" : YELLOW;
}

function fmtVal(v, fmt) {
  if (fmt === "pct") return v.toFixed(1) + "%";
  if (fmt === "1" || fmt === "0.0") return v.toFixed(1);
  return v.toFixed(2);
}

function s(obj, key, def) {
  if (def === undefined) def = 0;
  return (obj && obj[key] != null) ? obj[key] : def;
}

// --- Low-level drawing helpers ---

function drawRoundedRect(ctx, x, y, w, h, r) {
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

function fillRoundedRect(ctx, x, y, w, h, r, color) {
  drawRoundedRect(ctx, x, y, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawText(ctx, text, x, y, opts) {
  var size = opts.size || 14;
  var weight = opts.weight || "400";
  var color = opts.color || TEXT_WHITE;
  var align = opts.align || "left";
  var font = opts.font || "system-ui, -apple-system, sans-serif";
  ctx.font = weight + " " + size + "px " + font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = opts.baseline || "top";
  ctx.fillText(text, x, y);
}

function measureText(ctx, text, size, weight) {
  ctx.font = (weight || "400") + " " + (size || 14) + "px system-ui, -apple-system, sans-serif";
  return ctx.measureText(text).width;
}

// --- Compare card stats definition ---

function getCompareStats(p1, p2) {
  return [
    {section: "OVERALL", rows: [
      {label: "K/D", v1: s(p1, "kd"), v2: s(p2, "kd"), fmt: "2"},
      {label: "DMG/min", v1: s(p1, "dmg_per_min"), v2: s(p2, "dmg_per_min"), fmt: "1"}
    ]},
    {section: "HARDPOINT", rows: [
      {label: "K/D", v1: s(p1, "hp_kd"), v2: s(p2, "hp_kd"), fmt: "2"},
      {label: "K/10", v1: s(p1, "hp_k_10m"), v2: s(p2, "hp_k_10m"), fmt: "1"},
      {label: "D/10", v1: s(p1, "hp_d_10m"), v2: s(p2, "hp_d_10m"), fmt: "1", lower: true},
      {label: "DMG/10", v1: s(p1, "hp_dmg_10m"), v2: s(p2, "hp_dmg_10m"), fmt: "1"},
      {label: "ENG/10", v1: s(p1, "hp_eng_10m"), v2: s(p2, "hp_eng_10m"), fmt: "1"}
    ]},
    {section: "SEARCH & DESTROY", rows: [
      {label: "K/D", v1: s(p1, "snd_kd"), v2: s(p2, "snd_kd"), fmt: "2"},
      {label: "KPR", v1: s(p1, "snd_kpr"), v2: s(p2, "snd_kpr"), fmt: "2"},
      {label: "DPR", v1: s(p1, "snd_dpr"), v2: s(p2, "snd_dpr"), fmt: "2", lower: true},
      {label: "FB%", v1: s(p1, "first_blood_percentage") * 100, v2: s(p2, "first_blood_percentage") * 100, fmt: "1"}
    ]},
    {section: "OVERLOAD", rows: [
      {label: "K/D", v1: s(p1, "ovl_kd"), v2: s(p2, "ovl_kd"), fmt: "2"},
      {label: "K/10", v1: s(p1, "ovl_k_10m"), v2: s(p2, "ovl_k_10m"), fmt: "1"},
      {label: "D/10", v1: s(p1, "ovl_d_10m"), v2: s(p2, "ovl_d_10m"), fmt: "1", lower: true},
      {label: "DMG/10", v1: s(p1, "ovl_dmg_10m"), v2: s(p2, "ovl_dmg_10m"), fmt: "1"},
      {label: "ENG/10", v1: s(p1, "ovl_eng_10m"), v2: s(p2, "ovl_eng_10m"), fmt: "1"}
    ]}
  ];
}

// --- Main render function ---

export function renderCompareImage(p1, p2) {
  var stats = getCompareStats(p1, p2);

  // Count wins
  var p1Wins = 0, p2Wins = 0, totalCats = 0;
  stats.forEach(function(group) {
    group.rows.forEach(function(row) {
      totalCats++;
      if (row.lower) {
        if (row.v1 < row.v2) p1Wins++;
        else if (row.v2 < row.v1) p2Wins++;
      } else {
        if (row.v1 > row.v2) p1Wins++;
        else if (row.v2 > row.v1) p2Wins++;
      }
    });
  });
  var winner = p1Wins > p2Wins ? p1 : p2Wins > p1Wins ? p2 : null;

  // --- Measure required height ---
  var ROW_H = 30;
  var SECTION_H = 32;
  var headerH = 40;        // branding bar
  var playerH = 100;       // player names + KD hero
  var colHeaderH = 36;     // stat column header
  var verdictH = 72;       // verdict bar + footer
  var footerH = 36;
  var totalRows = 0;
  var totalSections = stats.length;
  stats.forEach(function(g) { totalRows += g.rows.length; });
  var cardHeight = headerH + playerH + colHeaderH + (totalSections * SECTION_H) + (totalRows * ROW_H) + verdictH + footerH;

  // --- Create canvas ---
  var scale = 2;
  var canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH * scale;
  canvas.height = cardHeight * scale;
  var ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  // --- Background ---
  fillRoundedRect(ctx, 0, 0, CARD_WIDTH, cardHeight, 16, SURFACE_COLOR);

  var y = 0;

  // --- Branding header ---
  fillRoundedRect(ctx, 0, 0, CARD_WIDTH, headerH, 0, "rgba(233,69,96,0.08)");
  drawText(ctx, "BARRACKS", CARD_PADDING, 12, {size: 12, weight: "900", color: ACCENT, align: "left"});
  drawText(ctx, "CDL 2026", CARD_WIDTH - CARD_PADDING, 15, {size: 10, weight: "400", color: TEXT_MUTED, align: "right"});
  // divider
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(0, headerH - 1, CARD_WIDTH, 1);
  y = headerH;

  // --- Player names + KD hero ---
  var mid = CARD_WIDTH / 2;
  var colW = (CARD_WIDTH - 60) / 2;

  // Player 1
  drawText(ctx, p1.player_tag, mid - 20, y + 12, {size: 18, weight: "900", color: TEXT_WHITE, align: "right"});
  drawText(ctx, (p1.team_short || "") + (p1.role ? " · " + p1.role : ""), mid - 20, y + 34, {size: 10, weight: "400", color: TEXT_DIM, align: "right"});

  // VS
  drawText(ctx, "VS", mid, y + 16, {size: 11, weight: "800", color: ACCENT, align: "center"});

  // Player 2
  drawText(ctx, p2.player_tag, mid + 20, y + 12, {size: 18, weight: "900", color: TEXT_WHITE, align: "left"});
  drawText(ctx, (p2.team_short || "") + (p2.role ? " · " + p2.role : ""), mid + 20, y + 34, {size: 10, weight: "400", color: TEXT_DIM, align: "left"});

  // KD hero numbers
  var kd1 = s(p1, "kd"), kd2 = s(p2, "kd");
  drawText(ctx, kd1.toFixed(2), mid - 20, y + 56, {size: 32, weight: "900", color: kdColor(kd1), align: "right"});
  drawText(ctx, "K/D", mid, y + 68, {size: 9, weight: "400", color: TEXT_MUTED, align: "center"});
  drawText(ctx, kd2.toFixed(2), mid + 20, y + 56, {size: 32, weight: "900", color: kdColor(kd2), align: "left"});

  y += playerH;

  // --- Column header ---
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(0, y, CARD_WIDTH, colHeaderH);
  drawText(ctx, p1.player_tag, mid - 14, y + 11, {size: 11, weight: "700", color: ACCENT, align: "right"});
  drawText(ctx, "stat", mid, y + 12, {size: 10, weight: "400", color: "rgba(255,255,255,0.3)", align: "center"});
  drawText(ctx, p2.player_tag, mid + 14, y + 11, {size: 11, weight: "700", color: ACCENT, align: "left"});
  y += colHeaderH;

  // --- Stat rows ---
  stats.forEach(function(group) {
    // Section header
    drawText(ctx, group.section, CARD_PADDING, y + 10, {size: 9, weight: "700", color: ACCENT});
    y += SECTION_H;

    group.rows.forEach(function(row) {
      var f1 = row.fmt === "1" ? row.v1.toFixed(1) : row.v1.toFixed(2);
      var f2 = row.fmt === "1" ? row.v2.toFixed(1) : row.v2.toFixed(2);
      var c1 = scoreColor(row.v1, row.v2, row.lower);
      var c2 = scoreColor(row.v2, row.v1, row.lower);

      // subtle divider
      ctx.fillStyle = "rgba(255,255,255,0.025)";
      ctx.fillRect(CARD_PADDING, y + ROW_H - 1, CARD_WIDTH - CARD_PADDING * 2, 1);

      drawText(ctx, f1, mid - 14, y + 7, {size: 13, weight: "700", color: c1, align: "right"});
      drawText(ctx, row.label, mid, y + 8, {size: 10, weight: "400", color: TEXT_DIM, align: "center"});
      drawText(ctx, f2, mid + 14, y + 7, {size: 13, weight: "700", color: c2, align: "left"});

      y += ROW_H;
    });
  });

  // --- Win bar ---
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(0, y, CARD_WIDTH, 1);
  y += 1;

  var barY = y;
  var barH = 4;
  var barW = CARD_WIDTH;
  var p1Pct = totalCats > 0 ? (p1Wins / totalCats) : 0.5;
  var tiePct = totalCats > 0 ? ((totalCats - p1Wins - p2Wins) / totalCats) : 0;
  var p2Pct = totalCats > 0 ? (p2Wins / totalCats) : 0.5;

  ctx.fillStyle = p1Wins >= p2Wins ? GREEN : RED;
  ctx.fillRect(0, barY, barW * p1Pct, barH);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(barW * p1Pct, barY, barW * tiePct, barH);
  ctx.fillStyle = p2Wins >= p1Wins ? GREEN : RED;
  ctx.fillRect(barW * (p1Pct + tiePct), barY, barW * p2Pct, barH);

  y += barH;

  // --- Verdict area ---
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.fillRect(0, y, CARD_WIDTH, verdictH - barH);

  drawText(ctx, String(p1Wins), CARD_PADDING + 4, y + 10, {size: 22, weight: "900", color: p1Wins >= p2Wins ? GREEN : RED, align: "left"});
  drawText(ctx, "wins", CARD_PADDING + 34, y + 16, {size: 10, weight: "400", color: TEXT_DIM, align: "left"});

  if (winner) {
    drawText(ctx, "VERDICT", mid, y + 8, {size: 8, weight: "700", color: TEXT_DIM, align: "center"});
    drawText(ctx, winner.player_tag, mid, y + 22, {size: 13, weight: "900", color: GREEN, align: "center"});
  } else {
    drawText(ctx, "TIED", mid, y + 16, {size: 12, weight: "700", color: YELLOW, align: "center"});
  }

  drawText(ctx, "wins", CARD_WIDTH - CARD_PADDING - 34, y + 16, {size: 10, weight: "400", color: TEXT_DIM, align: "right"});
  drawText(ctx, String(p2Wins), CARD_WIDTH - CARD_PADDING - 4, y + 10, {size: 22, weight: "900", color: p2Wins >= p1Wins ? GREEN : RED, align: "right"});

  y += verdictH - barH;

  // --- Footer ---
  drawText(ctx, "thebarracks.vercel.app", mid, y + 10, {size: 9, weight: "400", color: "rgba(255,255,255,0.25)", align: "center"});

  return canvas;
}

/**
 * Generate a share image blob from the canvas and trigger share or download.
 * Returns a Promise that resolves when sharing/download is complete.
 */
export function shareCompareImage(p1, p2) {
  return new Promise(function(resolve, reject) {
    try {
      var canvas = renderCompareImage(p1, p2);
      canvas.toBlob(function(blob) {
        if (!blob) {
          reject(new Error("Failed to generate image"));
          return;
        }
        var file = new File([blob], "barracks-compare.png", {type: "image/png"});
        if (navigator.share && navigator.canShare && navigator.canShare({files: [file]})) {
          navigator.share({
            files: [file],
            title: (p1.player_tag || "P1") + " vs " + (p2.player_tag || "P2") + " — Barracks CDL Stats"
          }).then(resolve).catch(resolve); // resolve even if user cancels
        } else {
          // Fallback: download
          var link = document.createElement("a");
          link.download = "barracks-" + (p1.player_tag || "p1") + "-vs-" + (p2.player_tag || "p2") + ".png";
          link.href = canvas.toDataURL("image/png");
          link.click();
          resolve();
        }
      }, "image/png");
    } catch (e) {
      reject(e);
    }
  });
}
