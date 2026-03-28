/**
 * shareRenderer.js
 * Pure Canvas API renderer for Barracks CDL share images.
 * No html2canvas dependency — draws everything pixel-by-pixel.
 *
 * Updated for v2 schema column names.
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

// --- Compare card stats definition (v2 column names) ---

function getCompareStats(p1, p2) {
  return [
    {section: "OVERALL", rows: [
      {label: "K/D", v1: s(p1, "kd"), v2: s(p2, "kd"), fmt: "2"},
      {label: "DMG/10m", v1: s(p1, "dmg_per_10m"), v2: s(p2, "dmg_per_10m"), fmt: "1"}
    ]},
    {section: "HARDPOINT", rows: [
      {label: "K/D", v1: s(p1, "hp_kd"), v2: s(p2, "hp_kd"), fmt: "2"},
      {label: "K/10", v1: s(p1, "hp_kills_per_10m"), v2: s(p2, "hp_kills_per_10m"), fmt: "1"},
      {label: "D/10", v1: s(p1, "hp_deaths_per_10m"), v2: s(p2, "hp_deaths_per_10m"), fmt: "1", lower: true},
      {label: "DMG/10", v1: s(p1, "hp_damage_per_10m"), v2: s(p2, "hp_damage_per_10m"), fmt: "1"},
      {label: "ENG/10", v1: s(p1, "hp_engagements_10m"), v2: s(p2, "hp_engagements_10m"), fmt: "1"}
    ]},
    {section: "SEARCH & DESTROY", rows: [
      {label: "K/D", v1: s(p1, "snd_kd"), v2: s(p2, "snd_kd"), fmt: "2"},
      {label: "KPR", v1: s(p1, "snd_kills_per_round"), v2: s(p2, "snd_kills_per_round"), fmt: "2"},
      {label: "DPR", v1: s(p1, "snd_deaths_per_round"), v2: s(p2, "snd_deaths_per_round"), fmt: "2", lower: true},
      {label: "FB%", v1: s(p1, "first_blood_pct") * 100, v2: s(p2, "first_blood_pct") * 100, fmt: "1"}
    ]},
    {section: "OVERLOAD", rows: [
      {label: "K/D", v1: s(p1, "ovl_kd"), v2: s(p2, "ovl_kd"), fmt: "2"},
      {label: "K/10", v1: s(p1, "ovl_kills_per_10m"), v2: s(p2, "ovl_kills_per_10m"), fmt: "1"},
      {label: "D/10", v1: s(p1, "ovl_deaths_per_10m"), v2: s(p2, "ovl_deaths_per_10m"), fmt: "1", lower: true},
      {label: "DMG/10", v1: s(p1, "ovl_damage_per_10m"), v2: s(p2, "ovl_damage_per_10m"), fmt: "1"},
      {label: "ENG/10", v1: s(p1, "ovl_engagements_10m"), v2: s(p2, "ovl_engagements_10m"), fmt: "1"}
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
  var headerH = 40;
  var playerH = 100;
  var colHeaderH = 36;
  var verdictH = 72;
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
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(0, headerH - 1, CARD_WIDTH, 1);
  y = headerH;

  // --- Player names + KD hero ---
  var mid = CARD_WIDTH / 2;

  // Use gamertag (v2) with fallback to player_tag (legacy)
  var name1 = p1.gamertag || p1.player_tag || "P1";
  var name2 = p2.gamertag || p2.player_tag || "P2";
  var short1 = p1.team_abbr || p1.team_short || "";
  var short2 = p2.team_abbr || p2.team_short || "";

  drawText(ctx, name1, mid - 20, y + 12, {size: 18, weight: "900", color: TEXT_WHITE, align: "right"});
  drawText(ctx, short1 + (p1.role ? " · " + p1.role : ""), mid - 20, y + 34, {size: 10, weight: "400", color: TEXT_DIM, align: "right"});

  drawText(ctx, "VS", mid, y + 16, {size: 11, weight: "800", color: ACCENT, align: "center"});

  drawText(ctx, name2, mid + 20, y + 12, {size: 18, weight: "900", color: TEXT_WHITE, align: "left"});
  drawText(ctx, short2 + (p2.role ? " · " + p2.role : ""), mid + 20, y + 34, {size: 10, weight: "400", color: TEXT_DIM, align: "left"});

  var kd1 = s(p1, "kd"), kd2 = s(p2, "kd");
  drawText(ctx, kd1.toFixed(2), mid - 20, y + 56, {size: 32, weight: "900", color: kdColor(kd1), align: "right"});
  drawText(ctx, "K/D", mid, y + 68, {size: 9, weight: "400", color: TEXT_MUTED, align: "center"});
  drawText(ctx, kd2.toFixed(2), mid + 20, y + 56, {size: 32, weight: "900", color: kdColor(kd2), align: "left"});

  y += playerH;

  // --- Column header ---
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(0, y, CARD_WIDTH, colHeaderH);
  drawText(ctx, name1, mid - 44, y + 11, {size: 11, weight: "700", color: ACCENT, align: "right"});
  drawText(ctx, "stat", mid, y + 12, {size: 10, weight: "400", color: "rgba(255,255,255,0.3)", align: "center"});
  drawText(ctx, name2, mid + 44, y + 11, {size: 11, weight: "700", color: ACCENT, align: "left"});
  y += colHeaderH;

  // --- Stat rows ---
  stats.forEach(function(group) {
    drawText(ctx, group.section, CARD_PADDING, y + 10, {size: 9, weight: "700", color: ACCENT});
    y += SECTION_H;

    group.rows.forEach(function(row) {
      var f1 = row.fmt === "1" ? row.v1.toFixed(1) : row.v1.toFixed(2);
      var f2 = row.fmt === "1" ? row.v2.toFixed(1) : row.v2.toFixed(2);
      var c1 = scoreColor(row.v1, row.v2, row.lower);
      var c2 = scoreColor(row.v2, row.v1, row.lower);

      ctx.fillStyle = "rgba(255,255,255,0.025)";
      ctx.fillRect(CARD_PADDING, y + ROW_H - 1, CARD_WIDTH - CARD_PADDING * 2, 1);

      drawText(ctx, f1, mid - 44, y + 7, {size: 13, weight: "700", color: c1, align: "right"});
      drawText(ctx, row.label, mid, y + 8, {size: 10, weight: "400", color: TEXT_DIM, align: "center"});
      drawText(ctx, f2, mid + 44, y + 7, {size: 13, weight: "700", color: c2, align: "left"});

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
    var winnerName = winner.gamertag || winner.player_tag || "?";
    drawText(ctx, "VERDICT", mid, y + 8, {size: 8, weight: "700", color: TEXT_DIM, align: "center"});
    drawText(ctx, winnerName, mid, y + 22, {size: 13, weight: "900", color: GREEN, align: "center"});
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
 */
export function shareCompareImage(p1, p2, shareUrl) {
  return new Promise(function(resolve, reject) {
    try {
      var canvas = renderCompareImage(p1, p2);
      var name1 = p1.gamertag || p1.player_tag || "P1";
      var name2 = p2.gamertag || p2.player_tag || "P2";
      canvas.toBlob(function(blob) {
        if (!blob) {
          reject(new Error("Failed to generate image"));
          return;
        }
        var file = new File([blob], "barracks-compare.png", {type: "image/png"});
        if (navigator.share && navigator.canShare && navigator.canShare({files: [file]})) {
          navigator.share({
            files: [file],
            title: name1 + " vs " + name2 + " — Barracks CDL Stats",
            url: shareUrl || undefined
          }).then(resolve).catch(resolve);
        } else {
          var link = document.createElement("a");
          link.download = "barracks-" + name1 + "-vs-" + name2 + ".png";
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

// ─── LINE CHECK CARD ────────────────────────────────────────

/**
 * Render a CDL prop line check result as a Canvas image.
 *
 * data = {
 *   gamertag, role, teamAbbr, teamColor,
 *   seasonKd, seasonHpK10, seasonSndKpr,
 *   catLabel, catSub, direction, threshold, isKd,
 *   dataPoints: [{value, opp, oppColor, kills, deaths, won}],
 *   hits, total, hitPct, avg
 * }
 */
export function renderLineCard(data) {
  var pts = data.dataPoints || [];
  var maxBubbles = Math.min(pts.length, 20);
  var BUBBLE_SIZE = 28;
  var BUBBLE_GAP = 6;
  var bubblesPerRow = Math.floor((CARD_WIDTH - CARD_PADDING * 2 + BUBBLE_GAP) / (BUBBLE_SIZE + BUBBLE_GAP));
  var bubbleRows = Math.ceil(maxBubbles / bubblesPerRow);
  var bubblesH = bubbleRows * (BUBBLE_SIZE + 18) + 8;

  // Game log rows
  var LOG_ROW_H = 26;
  var logRows = Math.min(pts.length, 10);
  var logHeaderH = 24;
  var logH = logRows > 0 ? logHeaderH + (logRows * LOG_ROW_H) + 8 : 0;

  // Card sections
  var headerH = 40;
  var playerH = 68;
  var resultH = 80;
  var footerH = 36;
  var cardHeight = headerH + playerH + resultH + bubblesH + logH + footerH;

  var scale = 2;
  var canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH * scale;
  canvas.height = cardHeight * scale;
  var ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  // Background
  fillRoundedRect(ctx, 0, 0, CARD_WIDTH, cardHeight, 16, SURFACE_COLOR);

  var y = 0;
  var mid = CARD_WIDTH / 2;

  // --- Header ---
  fillRoundedRect(ctx, 0, 0, CARD_WIDTH, headerH, 0, "rgba(233,69,96,0.08)");
  drawText(ctx, "BARRACKS", CARD_PADDING, 12, {size: 12, weight: "900", color: ACCENT, align: "left"});
  drawText(ctx, "LINE CHECK", CARD_WIDTH - CARD_PADDING, 12, {size: 10, weight: "700", color: TEXT_DIM, align: "right"});
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(0, headerH - 1, CARD_WIDTH, 1);
  y = headerH;

  // --- Player info ---
  var teamColor = data.teamColor || "#888";

  // Team color accent bar
  fillRoundedRect(ctx, CARD_PADDING, y + 14, 4, 40, 2, teamColor);

  drawText(ctx, data.gamertag || "?", CARD_PADDING + 16, y + 12, {size: 20, weight: "900", color: TEXT_WHITE, align: "left"});

  var roleText = (data.role || "") + (data.role && data.teamAbbr ? " · " : "") + (data.teamAbbr || "");
  drawText(ctx, roleText, CARD_PADDING + 16, y + 36, {size: 11, weight: "400", color: TEXT_DIM, align: "left"});

  // Season stats on the right
  var statX = CARD_WIDTH - CARD_PADDING;
  drawText(ctx, "K/D", statX - 120, y + 12, {size: 9, weight: "400", color: TEXT_DIM, align: "center"});
  drawText(ctx, (data.seasonKd || 0).toFixed(2), statX - 120, y + 24, {size: 15, weight: "800", color: kdColor(data.seasonKd || 0), align: "center"});

  drawText(ctx, "HP K/10", statX - 60, y + 12, {size: 9, weight: "400", color: TEXT_DIM, align: "center"});
  drawText(ctx, (data.seasonHpK10 || 0).toFixed(1), statX - 60, y + 24, {size: 15, weight: "800", color: "#aaaaaa", align: "center"});

  drawText(ctx, "SnD KPR", statX, y + 12, {size: 9, weight: "400", color: TEXT_DIM, align: "center"});
  drawText(ctx, (data.seasonSndKpr || 0).toFixed(2), statX, y + 24, {size: 15, weight: "800", color: "#aaaaaa", align: "center"});

  y += playerH;

  // --- Divider ---
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(CARD_PADDING, y, CARD_WIDTH - CARD_PADDING * 2, 1);
  y += 1;

  // --- Result section ---
  var hitColor = data.hitPct >= 60 ? GREEN : data.hitPct >= 40 ? YELLOW : RED;
  var resultBg = data.hitPct >= 60 ? "rgba(82,183,136,0.06)" : data.hitPct >= 40 ? "rgba(255,209,102,0.06)" : "rgba(255,107,107,0.06)";

  ctx.fillStyle = resultBg;
  ctx.fillRect(0, y, CARD_WIDTH, resultH);

  // Direction + line label
  var dirLabel = (data.direction || "over").toUpperCase() + " " + (data.isKd ? Number(data.threshold).toFixed(2) : data.threshold);
  drawText(ctx, dirLabel, CARD_PADDING, y + 14, {size: 16, weight: "900", color: hitColor, align: "left"});
  drawText(ctx, data.catLabel || "", CARD_PADDING, y + 36, {size: 11, weight: "400", color: TEXT_DIM, align: "left"});
  if (data.catSub) {
    drawText(ctx, data.catSub, CARD_PADDING, y + 52, {size: 10, weight: "400", color: TEXT_MUTED, align: "left"});
  }

  // Hit count
  drawText(ctx, data.hits + "/" + data.total, CARD_WIDTH - CARD_PADDING, y + 10, {size: 36, weight: "900", color: hitColor, align: "right"});
  drawText(ctx, data.hitPct.toFixed(0) + "%", CARD_WIDTH - CARD_PADDING, y + 52, {size: 14, weight: "800", color: hitColor, align: "right"});

  y += resultH;

  // --- Bubbles ---
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(CARD_PADDING, y, CARD_WIDTH - CARD_PADDING * 2, 1);
  y += 8;

  for (var i = 0; i < maxBubbles; i++) {
    var p = pts[i];
    var row = Math.floor(i / bubblesPerRow);
    var col = i % bubblesPerRow;
    var bx = CARD_PADDING + col * (BUBBLE_SIZE + BUBBLE_GAP);
    var by = y + row * (BUBBLE_SIZE + 18);

    var val = p.value;
    var isHit = data.direction === "over" ? val >= data.threshold : val < data.threshold;
    var bubbleColor = isHit ? "rgba(82,183,136,0.25)" : "rgba(255,107,107,0.2)";
    var textColor = isHit ? GREEN : RED;

    // Bubble circle
    ctx.beginPath();
    ctx.arc(bx + BUBBLE_SIZE / 2, by + BUBBLE_SIZE / 2, BUBBLE_SIZE / 2, 0, Math.PI * 2);
    ctx.fillStyle = bubbleColor;
    ctx.fill();

    // Value text
    var display = data.isKd ? val.toFixed(1) : String(Math.round(val));
    drawText(ctx, display, bx + BUBBLE_SIZE / 2, by + BUBBLE_SIZE / 2 - 5, {size: 10, weight: "800", color: textColor, align: "center"});

    // Opponent label below
    drawText(ctx, p.opp || "?", bx + BUBBLE_SIZE / 2, by + BUBBLE_SIZE + 2, {size: 8, weight: "400", color: p.oppColor || TEXT_MUTED, align: "center"});
  }

  y += bubblesH;

  // --- Game log ---
  if (logRows > 0) {
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(CARD_PADDING, y, CARD_WIDTH - CARD_PADDING * 2, 1);
    y += 4;

    // Log header
    var colW = (CARD_WIDTH - CARD_PADDING * 2);
    var cols = [
      {label: "OPP", x: CARD_PADDING, align: "left"},
      {label: "K", x: CARD_PADDING + colW * 0.35, align: "center"},
      {label: "D", x: CARD_PADDING + colW * 0.48, align: "center"},
      {label: "K/D", x: CARD_PADDING + colW * 0.62, align: "center"},
      {label: "W/L", x: CARD_PADDING + colW * 0.78, align: "center"},
      {label: data.isKd ? "K/D" : "VAL", x: CARD_WIDTH - CARD_PADDING, align: "right"}
    ];

    cols.forEach(function(c) {
      drawText(ctx, c.label, c.x, y, {size: 8, weight: "700", color: TEXT_MUTED, align: c.align});
    });
    y += logHeaderH;

    for (var j = 0; j < logRows; j++) {
      var g = pts[j];
      var gkd = g.deaths > 0 ? (g.kills / g.deaths) : g.kills;
      var gVal = g.value;
      var gHit = data.direction === "over" ? gVal >= data.threshold : gVal < data.threshold;

      // Alternating row bg
      if (j % 2 === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.02)";
        ctx.fillRect(CARD_PADDING, y - 2, colW, LOG_ROW_H);
      }

      drawText(ctx, g.opp || "?", cols[0].x, y + 2, {size: 11, weight: "700", color: g.oppColor || "#888888", align: "left"});
      drawText(ctx, String(g.kills), cols[1].x, y + 2, {size: 11, weight: "700", color: TEXT_WHITE, align: "center"});
      drawText(ctx, String(g.deaths), cols[2].x, y + 2, {size: 11, weight: "400", color: "#aaaaaa", align: "center"});
      drawText(ctx, gkd.toFixed(2), cols[3].x, y + 2, {size: 11, weight: "700", color: kdColor(gkd), align: "center"});
      drawText(ctx, g.won ? "W" : "L", cols[4].x, y + 2, {size: 11, weight: "800", color: g.won ? GREEN : RED, align: "center"});

      // Highlighted value column
      var valDisplay = data.isKd ? gVal.toFixed(2) : String(Math.round(gVal));
      drawText(ctx, valDisplay, cols[5].x, y + 2, {size: 11, weight: "800", color: gHit ? GREEN : RED, align: "right"});

      y += LOG_ROW_H;
    }
    y += 4;
  }

  // --- Footer ---
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(0, y, CARD_WIDTH, 1);
  y += 1;

  drawText(ctx, "thebarracks.vercel.app", mid, y + 10, {size: 9, weight: "400", color: "rgba(255,255,255,0.25)", align: "center"});
  drawText(ctx, "Avg: " + (data.isKd ? data.avg.toFixed(2) : data.avg.toFixed(1)) + " / " + (data.catSub && data.catSub.indexOf("maps") !== -1 ? "map" : "series"), CARD_WIDTH - CARD_PADDING, y + 10, {size: 9, weight: "400", color: TEXT_MUTED, align: "right"});

  return canvas;
}

/**
 * Share or download a line check card image.
 */
export function shareLineCard(data, shareUrl) {
  return new Promise(function(resolve, reject) {
    try {
      var canvas = renderLineCard(data);
      var name = data.gamertag || "player";
      var filename = "barracks-" + name.replace(/\s+/g, "-") + "-" + (data.direction || "over") + "-" + (data.threshold || "") + "-" + (data.catLabel || "line").replace(/\s+/g, "-");

      canvas.toBlob(function(blob) {
        if (!blob) {
          reject(new Error("Failed to generate image"));
          return;
        }
        var file = new File([blob], filename + ".png", {type: "image/png"});
        if (navigator.share && navigator.canShare && navigator.canShare({files: [file]})) {
          navigator.share({
            files: [file],
            title: name + " " + (data.direction || "over") + " " + (data.threshold || "") + " " + (data.catLabel || "") + " — Barracks",
            url: shareUrl || undefined
          }).then(resolve).catch(resolve);
        } else {
          var link = document.createElement("a");
          link.download = filename + ".png";
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

// ─── PICKS SHARE CARD ───────────────────────────────────────

/**
 * Render a picks share image as a Canvas.
 *
 * picks = [{
 *   winnerAbbr, winnerColor, loserAbbr, loserColor,
 *   score, eventShort, datetime
 * }]
 */
export function renderPicksCard(picks, eventName) {
  var ROW_H = 56;
  var headerH = 40;
  var titleH = 64;
  var footerH = 40;
  var numPicks = picks.length;
  var cardHeight = headerH + titleH + (numPicks * ROW_H) + footerH;

  var scale = 2;
  var canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH * scale;
  canvas.height = cardHeight * scale;
  var ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  // Background
  fillRoundedRect(ctx, 0, 0, CARD_WIDTH, cardHeight, 16, SURFACE_COLOR);

  var y = 0;
  var mid = CARD_WIDTH / 2;

  // --- Header ---
  ctx.fillStyle = "rgba(233,69,96,0.08)";
  ctx.fillRect(0, 0, CARD_WIDTH, headerH);
  drawText(ctx, "BARRACKS", CARD_PADDING, 12, {size: 12, weight: "900", color: ACCENT, align: "left"});
  drawText(ctx, "CDL 2026", CARD_WIDTH - CARD_PADDING, 15, {size: 10, weight: "400", color: TEXT_MUTED, align: "right"});
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(0, headerH - 1, CARD_WIDTH, 1);
  y = headerH;

  // --- Title area — use event name ---
  var titleText = eventName || "PICKS";
  drawText(ctx, titleText.toUpperCase(), mid, y + 14, {size: 22, weight: "900", color: TEXT_WHITE, align: "center"});
  drawText(ctx, numPicks + " match" + (numPicks !== 1 ? "es" : "") + " predicted", mid, y + 42, {size: 11, weight: "400", color: TEXT_DIM, align: "center"});
  y += titleH;

  // --- Divider ---
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(CARD_PADDING, y, CARD_WIDTH - CARD_PADDING * 2, 1);
  y += 1;

  // --- Pick rows ---
  picks.forEach(function(pick, i) {
    var rowY = y + (i * ROW_H);
    var centerY = rowY + ROW_H / 2;

    // Alternating row bg
    if (i % 2 === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      ctx.fillRect(0, rowY, CARD_WIDTH, ROW_H);
    }

    // Row divider
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(CARD_PADDING, rowY + ROW_H - 1, CARD_WIDTH - CARD_PADDING * 2, 1);

    // Winner team color bar
    fillRoundedRect(ctx, CARD_PADDING, centerY - 12, 4, 24, 2, pick.winnerColor || "#888");

    // Winner name (bold, large)
    drawText(ctx, pick.winnerAbbr || "?", CARD_PADDING + 16, centerY - 12, {size: 18, weight: "900", color: TEXT_WHITE, align: "left"});

    // Score in the middle
    var scoreX = mid;
    // Score background pill
    var scoreText = pick.score || "?";
    fillRoundedRect(ctx, scoreX - 28, centerY - 12, 56, 24, 12, "rgba(82,183,136,0.15)");
    drawText(ctx, scoreText, scoreX, centerY - 5, {size: 14, weight: "900", color: GREEN, align: "center"});

    // Loser team
    drawText(ctx, pick.loserAbbr || "?", CARD_WIDTH - CARD_PADDING - 16, centerY - 12, {size: 18, weight: "700", color: "#666666", align: "right"});
    fillRoundedRect(ctx, CARD_WIDTH - CARD_PADDING - 4, centerY - 12, 4, 24, 2, pick.loserColor || "#888");

    // Event + date subtitle
    var subText = (pick.eventShort || "");
    if (pick.datetime) {
      try {
        var d = new Date(pick.datetime);
        subText += " · " + d.toLocaleDateString("en-US", {month: "short", day: "numeric"});
      } catch(e) {}
    }
    drawText(ctx, subText, CARD_PADDING + 16, centerY + 10, {size: 9, weight: "400", color: TEXT_MUTED, align: "left"});
  });

  y += numPicks * ROW_H;

  // --- Footer ---
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(0, y, CARD_WIDTH, 1);
  y += 1;

  drawText(ctx, "thebarracks.vercel.app", mid, y + 12, {size: 9, weight: "400", color: "rgba(255,255,255,0.25)", align: "center"});

  return canvas;
}

/**
 * Share or download a picks card image.
 */
export function sharePicksImage(picks, shareUrl, eventName) {
  return new Promise(function(resolve, reject) {
    try {
      var canvas = renderPicksCard(picks, eventName);
      var filename = "barracks-picks" + (eventName ? "-" + eventName.replace(/\s+/g, "-").toLowerCase() : "");
      canvas.toBlob(function(blob) {
        if (!blob) {
          reject(new Error("Failed to generate image"));
          return;
        }
        var file = new File([blob], filename + ".png", {type: "image/png"});
        var title = (eventName || "My CDL") + " Picks — Barracks";
        if (navigator.share && navigator.canShare && navigator.canShare({files: [file]})) {
          navigator.share({
            files: [file],
            title: title,
            url: shareUrl || undefined
          }).then(resolve).catch(resolve);
        } else {
          var link = document.createElement("a");
          link.download = filename + ".png";
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

// ─── RESULT CARD SHARE ──────────────────────────────────────

/**
 * Render a match result share image as a Canvas.
 *
 * data = {
 *   home: {short, color, id}, away: {short, color, id},
 *   homeScore, awayScore, homeWon, awayWon,
 *   eventName,
 *   maps: [{map_number, mode_short, mode_name, map_name, home_score, away_score, winner_id}],
 *   homePlayers: [{name, kills, deaths, damage, kd}],
 *   awayPlayers: [{name, kills, deaths, damage, kd}],
 *   homeTeamTotals: {kills, deaths, damage, diff, kd} | null,
 *   awayTeamTotals: {kills, deaths, damage, diff, kd} | null,
 *   viewLabel: "Series" or "Map 1 — Hardpoint — Rewind"
 * }
 */
export function renderResultCard(data) {
  var headerH = 40;
  var scoreH = 80;
  var mapRowH = 26;
  var mapHeaderH = 24;
  var mapsH = data.maps && data.maps.length > 0 ? mapHeaderH + (data.maps.length * mapRowH) + 12 : 0;
  var viewLabelH = data.viewLabel ? 32 : 0;
  var playerRowH = 28;
  var teamLabelH = 28;
  var homePlayers = data.homePlayers || [];
  var awayPlayers = data.awayPlayers || [];
  var playerHeaderH = 24;
  var totalRowH = data.homeTeamTotals ? 28 : 0;
  var playersH = playerHeaderH + teamLabelH + (homePlayers.length * playerRowH) + totalRowH + 12 + teamLabelH + (awayPlayers.length * playerRowH) + totalRowH + 8;
  var footerH = 36;
  var cardHeight = headerH + scoreH + mapsH + viewLabelH + playersH + footerH;

  var scale = 2;
  var canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH * scale;
  canvas.height = cardHeight * scale;
  var ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  fillRoundedRect(ctx, 0, 0, CARD_WIDTH, cardHeight, 16, SURFACE_COLOR);

  var y = 0;
  var mid = CARD_WIDTH / 2;
  var homeColor = data.home.color || "#888";
  var awayColor = data.away.color || "#888";

  // --- Header ---
  ctx.fillStyle = "rgba(233,69,96,0.08)";
  ctx.fillRect(0, 0, CARD_WIDTH, headerH);
  drawText(ctx, "BARRACKS", CARD_PADDING, 12, {size: 12, weight: "900", color: ACCENT, align: "left"});
  drawText(ctx, data.eventName || "CDL 2026", CARD_WIDTH - CARD_PADDING, 15, {size: 10, weight: "400", color: TEXT_MUTED, align: "right"});
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(0, headerH - 1, CARD_WIDTH, 1);
  y = headerH;

  // --- Series score ---
  fillRoundedRect(ctx, CARD_PADDING, y + 20, 4, 40, 2, homeColor);
  drawText(ctx, data.home.short || "?", CARD_PADDING + 16, y + 18, {size: 24, weight: "900", color: data.homeWon ? TEXT_WHITE : "#555555", align: "left"});

  // Date/time under home team name
  if (data.datetime) {
    try {
      var d = new Date(data.datetime);
      var dateStr = d.toLocaleString("en-US", {timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
      drawText(ctx, dateStr, CARD_PADDING + 16, y + 46, {size: 10, weight: "400", color: TEXT_DIM, align: "left"});
    } catch(e) {}
  }

  drawText(ctx, String(data.homeScore || 0), mid - 24, y + 14, {size: 36, weight: "900", color: data.homeWon ? TEXT_WHITE : "#555555", align: "right"});
  drawText(ctx, "-", mid, y + 20, {size: 24, weight: "400", color: "rgba(255,255,255,0.2)", align: "center"});
  drawText(ctx, String(data.awayScore || 0), mid + 24, y + 14, {size: 36, weight: "900", color: data.awayWon ? TEXT_WHITE : "#555555", align: "left"});

  drawText(ctx, data.away.short || "?", CARD_WIDTH - CARD_PADDING - 16, y + 18, {size: 24, weight: "900", color: data.awayWon ? TEXT_WHITE : "#555555", align: "right"});
  fillRoundedRect(ctx, CARD_WIDTH - CARD_PADDING - 4, y + 20, 4, 40, 2, awayColor);

  drawText(ctx, "FINAL", mid, y + 62, {size: 9, weight: "700", color: GREEN, align: "center"});

  y += scoreH;

  // --- Map scores table ---
  if (data.maps && data.maps.length > 0) {
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(CARD_PADDING, y, CARD_WIDTH - CARD_PADDING * 2, 1);
    y += 4;

    drawText(ctx, "#", CARD_PADDING + 4, y + 4, {size: 9, weight: "700", color: TEXT_MUTED, align: "left"});
    drawText(ctx, "MODE", CARD_PADDING + 32, y + 4, {size: 9, weight: "700", color: TEXT_MUTED, align: "left"});
    drawText(ctx, "MAP", mid, y + 4, {size: 9, weight: "700", color: TEXT_MUTED, align: "left"});
    drawText(ctx, data.home.short, CARD_WIDTH - CARD_PADDING - 60, y + 4, {size: 9, weight: "700", color: homeColor, align: "center"});
    drawText(ctx, data.away.short, CARD_WIDTH - CARD_PADDING - 10, y + 4, {size: 9, weight: "700", color: awayColor, align: "center"});
    y += mapHeaderH;

    data.maps.forEach(function(m, i) {
      if (i % 2 === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.02)";
        ctx.fillRect(CARD_PADDING, y - 2, CARD_WIDTH - CARD_PADDING * 2, mapRowH);
      }
      var homeWonMap = m.winner_id === data.home.id;
      drawText(ctx, String(m.map_number), CARD_PADDING + 8, y + 4, {size: 11, weight: "700", color: TEXT_DIM, align: "left"});
      drawText(ctx, m.mode_short || "", CARD_PADDING + 32, y + 4, {size: 11, weight: "600", color: "#888888", align: "left"});
      drawText(ctx, m.map_name || "", mid, y + 4, {size: 11, weight: "400", color: "#666666", align: "left"});
      drawText(ctx, String(m.home_score), CARD_WIDTH - CARD_PADDING - 60, y + 4, {size: 12, weight: "700", color: homeWonMap ? GREEN : "#555555", align: "center"});
      drawText(ctx, String(m.away_score), CARD_WIDTH - CARD_PADDING - 10, y + 4, {size: 12, weight: "700", color: !homeWonMap ? GREEN : "#555555", align: "center"});
      y += mapRowH;
    });
    y += 8;
  }

  // --- View label (Series / Map X) ---
  if (data.viewLabel) {
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(CARD_PADDING, y, CARD_WIDTH - CARD_PADDING * 2, 1);
    y += 2;
    drawText(ctx, data.viewLabel.toUpperCase(), CARD_PADDING, y + 8, {size: 9, weight: "700", color: ACCENT, align: "left"});
    y += viewLabelH;
  }

  // --- Player stats columns ---
  var colPlayer = CARD_PADDING + 4;
  var colK = CARD_WIDTH - CARD_PADDING - 200;
  var colD = CARD_WIDTH - CARD_PADDING - 156;
  var colKD = CARD_WIDTH - CARD_PADDING - 108;
  var colDmg = CARD_WIDTH - CARD_PADDING - 52;
  var colDiff = CARD_WIDTH - CARD_PADDING - 4;

  drawText(ctx, "PLAYER", colPlayer, y + 4, {size: 9, weight: "700", color: TEXT_MUTED, align: "left"});
  drawText(ctx, "K", colK, y + 4, {size: 9, weight: "700", color: TEXT_MUTED, align: "center"});
  drawText(ctx, "D", colD, y + 4, {size: 9, weight: "700", color: TEXT_MUTED, align: "center"});
  drawText(ctx, "K/D", colKD, y + 4, {size: 9, weight: "700", color: TEXT_MUTED, align: "center"});
  drawText(ctx, "DMG", colDmg, y + 4, {size: 9, weight: "700", color: TEXT_MUTED, align: "center"});
  drawText(ctx, "+/-", colDiff, y + 4, {size: 9, weight: "700", color: TEXT_MUTED, align: "right"});
  y += playerHeaderH;

  // Helper to render one team block
  var renderTeamBlock = function(players, teamShort, teamColor, totals) {
    fillRoundedRect(ctx, CARD_PADDING + 4, y + 6, 3, 14, 1, teamColor);
    drawText(ctx, teamShort, CARD_PADDING + 14, y + 6, {size: 10, weight: "800", color: teamColor, align: "left"});
    y += teamLabelH;

    players.forEach(function(p, i) {
      if (i % 2 === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.015)";
        ctx.fillRect(CARD_PADDING, y - 2, CARD_WIDTH - CARD_PADDING * 2, playerRowH);
      }
      var diff = p.kills - p.deaths;
      drawText(ctx, p.name || "?", colPlayer, y + 4, {size: 11, weight: "600", color: teamColor, align: "left"});
      drawText(ctx, String(p.kills), colK, y + 4, {size: 11, weight: "700", color: TEXT_WHITE, align: "center"});
      drawText(ctx, String(p.deaths), colD, y + 4, {size: 11, weight: "400", color: "#888888", align: "center"});
      drawText(ctx, p.kd.toFixed(2), colKD, y + 4, {size: 11, weight: "700", color: kdColor(p.kd), align: "center"});
      drawText(ctx, Math.round(p.damage).toLocaleString(), colDmg, y + 4, {size: 11, weight: "400", color: "#888888", align: "center"});
      drawText(ctx, (diff >= 0 ? "+" : "") + diff, colDiff, y + 4, {size: 11, weight: "700", color: diff >= 0 ? GREEN : RED, align: "right"});
      y += playerRowH;
    });

    if (totals) {
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(CARD_PADDING, y - 2, CARD_WIDTH - CARD_PADDING * 2, totalRowH);
      var tDiff = totals.diff || 0;
      drawText(ctx, "TOTAL", colPlayer, y + 4, {size: 10, weight: "700", color: teamColor, align: "left"});
      drawText(ctx, String(totals.kills), colK, y + 4, {size: 11, weight: "700", color: TEXT_WHITE, align: "center"});
      drawText(ctx, String(totals.deaths), colD, y + 4, {size: 11, weight: "400", color: "#888888", align: "center"});
      drawText(ctx, totals.kd.toFixed(2), colKD, y + 4, {size: 11, weight: "700", color: kdColor(totals.kd), align: "center"});
      drawText(ctx, Math.round(totals.damage).toLocaleString(), colDmg, y + 4, {size: 11, weight: "400", color: "#888888", align: "center"});
      drawText(ctx, (tDiff >= 0 ? "+" : "") + tDiff, colDiff, y + 4, {size: 11, weight: "700", color: tDiff >= 0 ? GREEN : RED, align: "right"});
      y += totalRowH;
    }
  };

  renderTeamBlock(homePlayers, data.home.short, homeColor, data.homeTeamTotals);
  y += 12;
  renderTeamBlock(awayPlayers, data.away.short, awayColor, data.awayTeamTotals);
  y += 8;

  // --- Footer ---
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(0, y, CARD_WIDTH, 1);
  y += 1;
  drawText(ctx, "thebarracks.vercel.app", mid, y + 10, {size: 9, weight: "400", color: "rgba(255,255,255,0.25)", align: "center"});

  return canvas;
}

/**
 * Share or download a result card image.
 */
export function shareResultImage(data, shareUrl) {
  return new Promise(function(resolve, reject) {
    try {
      var canvas = renderResultCard(data);
      var filename = "barracks-" + (data.home.short || "home") + "-vs-" + (data.away.short || "away");

      canvas.toBlob(function(blob) {
        if (!blob) {
          reject(new Error("Failed to generate image"));
          return;
        }
        var file = new File([blob], filename + ".png", {type: "image/png"});
        var title = (data.home.short || "?") + " vs " + (data.away.short || "?") + " — Barracks CDL Results";
        if (navigator.share && navigator.canShare && navigator.canShare({files: [file]})) {
          navigator.share({
            files: [file],
            title: title,
            url: shareUrl || undefined
          }).then(resolve).catch(resolve);
        } else {
          var link = document.createElement("a");
          link.download = filename + ".png";
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
