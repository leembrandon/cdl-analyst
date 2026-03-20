// middleware.js — Vercel Edge Middleware
// Intercepts requests to inject dynamic OG meta tags for social crawlers.
// Only modifies HTML responses when a crawler is detected AND a share param exists.

const BOT_UA = /bot|crawler|spider|preview|facebookexternalhit|Twitterbot|WhatsApp|Slack|Discord|Telegram|LinkedInBot|iMessageRichLink|Embedly|Quora|Pinterest|Googlebot|Bingbot|Yandex|Baiduspider/i;

export const config = {
  matcher: '/',
};

export default async function middleware(req) {
  const ua = req.headers.get('user-agent') || '';
  const url = new URL(req.url);

  // Only intercept if a crawler is requesting a share URL
  const lineParam = url.searchParams.get('line');
  const compareParam = url.searchParams.get('compare');
  const hasShareParam = lineParam || compareParam;

  if (!hasShareParam || !BOT_UA.test(ua)) {
    // Normal request — let it through unchanged
    return;
  }

  // Build OG meta values based on the URL params
  const origin = url.origin;
  let title = 'Barracks — CDL 2026 Stats';
  let description = 'CDL 2026 stats, standings, line checks, and player comparisons.';
  let ogImageUrl = origin + '/api/og';

  if (lineParam) {
    const parts = lineParam.split(',');
    const playerName = decodeURIComponent(parts[0] || '').trim();
    const cat = parts[1] || 'map1';
    const direction = parts[2] || 'over';
    const threshold = parts[3] || '';
    const catLabels = {
      map1: 'Map 1 Kills', map2: 'Map 2 Kills', map3: 'Map 3 Kills',
      m13kills: 'Maps 1-3 Kills', serieskd: 'Series K/D',
    };
    const catLabel = catLabels[cat] || cat;
    title = playerName + ' ' + direction + ' ' + threshold + ' ' + catLabel + ' — Barracks';
    description = 'Check ' + playerName + "'s CDL prop line: " + direction + ' ' + threshold + ' ' + catLabel;
    ogImageUrl = origin + '/api/og?line=' + encodeURIComponent(lineParam);
  }

  if (compareParam) {
    const parts = compareParam.split(',');
    const name1 = decodeURIComponent(parts[0] || '').trim();
    const name2 = decodeURIComponent(parts[1] || '').trim();
    title = name1 + ' vs ' + name2 + ' — Barracks CDL Stats';
    description = 'Head-to-head stat comparison: ' + name1 + ' vs ' + name2;
    ogImageUrl = origin + '/api/og?compare=' + encodeURIComponent(compareParam);
  }

  // Fetch the original HTML
  const response = await fetch(req.url, {
    headers: req.headers,
    redirect: 'follow',
  });
  let html = await response.text();

  // Replace existing OG tags (or inject before </head>)
  const metaBlock = [
    '<meta property="og:title" content="' + escapeAttr(title) + '" />',
    '<meta property="og:description" content="' + escapeAttr(description) + '" />',
    '<meta property="og:image" content="' + escapeAttr(ogImageUrl) + '" />',
    '<meta property="og:image:width" content="600" />',
    '<meta property="og:image:height" content="340" />',
    '<meta property="og:type" content="website" />',
    '<meta property="og:url" content="' + escapeAttr(url.toString()) + '" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    '<meta name="twitter:title" content="' + escapeAttr(title) + '" />',
    '<meta name="twitter:description" content="' + escapeAttr(description) + '" />',
    '<meta name="twitter:image" content="' + escapeAttr(ogImageUrl) + '" />',
  ].join('\n    ');

  // Strip any existing og/twitter meta tags to avoid duplicates
  html = html.replace(/<meta\s+(?:property="og:|name="twitter:)[^>]*>/gi, '');

  // Also update the <title> tag
  html = html.replace(/<title>[^<]*<\/title>/i, '<title>' + escapeHtml(title) + '</title>');

  // Inject our meta block before </head>
  html = html.replace('</head>', '    ' + metaBlock + '\n  </head>');

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=300',
    },
  });
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
