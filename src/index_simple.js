// ============================================================
//  MAL Widget Backend — Cloudflare Worker
//  github.com/dreamstatemods/MAL-widget-backend
//
//  A real-time MyAnimeList data proxy combining MAL list
//  endpoints with the Jikan API for stats and favorites.
//
//  Built with Claude AI — anthropic.com
//  Licensed under MIT
// ============================================================

// Hybrid architecture: MAL list endpoints for recent activity, Jikan API for profile/stats/favorites.
// Jikan is used where MAL has no public JSON API (profile, statistics, favorites).
// MAL list endpoints are used for recent updates as Jikan only refreshes these ~once per day.

// ================= CONFIG =================
const CACHE_DURATION = 3600;
const FETCH_TIMEOUT  = 8000;

// ================= UPSTREAM URLS =================
const MAL_ANIME_LIST_URL = (username, offset = 0, status = 7) =>
  `https://myanimelist.net/animelist/${username}/load.json?offset=${offset}&status=${status}`;

const MAL_MANGA_LIST_URL = (username, offset = 0, status = 7) =>
  `https://myanimelist.net/mangalist/${username}/load.json?offset=${offset}&status=${status}`;

const JIKAN_FAV_URL     = username => `https://api.jikan.moe/v4/users/${username}/favorites`;
const JIKAN_STATS_URL   = username => `https://api.jikan.moe/v4/users/${username}/statistics`;
const JIKAN_PROFILE_URL = username => `https://api.jikan.moe/v4/users/${username}/full`;

// ================= BROWSER HEADERS =================
// MAL blocks headless requests. Spoofing browser headers is required for profile page scraping.
const BROWSER_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control":   "no-cache",
  "Pragma":          "no-cache"
};

// ================= REQUEST COALESCING =================
const pendingRequests = new Map();

// ================= ERROR TYPES =================
class RateLimitError extends Error {
  constructor(source, status) {
    super(`${source} rate limit or error (${status})`);
    this.name   = "RateLimitError";
    this.source = source;
    this.status = status;
  }
}

// ================= MAIN HANDLER =================
export default {

  async fetch(request, env, ctx) {

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith("/purge"))       return handlePurge(request, env);
    if (url.pathname.startsWith("/debug-cache")) return handleDebugCache(request, env);

    if (url.pathname === "/health") {
      return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain", ...corsHeaders() } });
    }

    // Debug route — shows raw MAL profile HTML around "Last Manga Updates"
    // Usage: /debug-profile/:username
    if (url.pathname.startsWith("/debug-profile")) {
      const uname = url.pathname.split("/").filter(Boolean).pop();
      const r = await fetchWithTimeout(
        `https://myanimelist.net/profile/${uname}`,
        { cf: { cacheTtl: 0 }, headers: BROWSER_HEADERS }
      );
      const text = await r.text();
      const idx  = text.indexOf("Last Manga");
      const out  = idx === -1
        ? `NOT FOUND. Total HTML length: ${text.length}\nFirst 500 chars:\n${text.slice(0, 500)}`
        : `FOUND at index ${idx}:\n${text.slice(idx, idx + 3000)}`;
      return new Response(out, { headers: { "Content-Type": "text/plain", ...corsHeaders() } });
    }

    if (url.pathname === "/" || url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    let username = url.pathname.split("/").filter(Boolean).pop();
    if (!username) username = url.searchParams.get("username");
    if (!username) return jsonResponse({ error: "No username provided" }, 400);

    const version     = await getCacheVersion(env);
    const cache       = caches.default;
    const cacheKeyUrl = `https://mal-widget.internal/v${version}/user/${encodeURIComponent(username)}`;
    const cacheKey    = new Request(cacheKeyUrl, { method: "GET" });

    const cached = await cache.match(cacheKey);
    if (cached) {
      const hit = new Response(await cached.arrayBuffer(), cached);
      hit.headers.set("X-Cache", "HIT");
      return hit;
    }

    const coalesceKey = `user:${username}`;
    if (pendingRequests.has(coalesceKey)) return pendingRequests.get(coalesceKey);

    const promise = (async () => {
      try {

        const recentAnime = await getRecentAnimeFromMAL(username);

        let recentManga = await getRecentMangaFromMAL(username);
        if (!recentManga.length) {
          recentManga = await getRecentMangaFromProfile(username);
        }

        const statsData  = await fetchJsonWithHandling("JIKAN", JIKAN_STATS_URL(username), {});
        const animeStats = statsData.data?.anime || {};
        const mangaStats = statsData.data?.manga || {};

        const profileData = await fetchJsonWithHandling("JIKAN", JIKAN_PROFILE_URL(username), {});
        const profile = {
          mal_id:      profileData.data.mal_id,
          username:    profileData.data.username,
          url:         profileData.data.url,
          image:       profileData.data.images?.jpg?.image_url || null,
          joined:      profileData.data.joined,
          last_online: profileData.data.last_online,
          about:       profileData.data.about    || null,
          gender:      profileData.data.gender   || null,
          birthday:    profileData.data.birthday || null,
          location:    profileData.data.location || null
        };

        let animeFavorites = [];
        let mangaFavorites = [];
        try {
          const favData  = await fetchJsonWithHandling("JIKAN", JIKAN_FAV_URL(username), {});
          animeFavorites = (favData.data?.anime || []).slice(0, 10);
          mangaFavorites = (favData.data?.manga || []).slice(0, 10);
        } catch { /* non-fatal */ }

        const payload = {
          username,
          profile,
          statistics:    { anime: animeStats, manga: mangaStats },
          favorites:     { anime: animeFavorites, manga: mangaFavorites },
          recentUpdates: { anime: recentAnime, manga: recentManga },
          timestamp:     Date.now()
        };

        const response = jsonResponse(payload);
        response.headers.set("X-Cache", "MISS");
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;

      } catch (err) {
        if (err instanceof RateLimitError)
          return jsonResponse({ error: `${err.source} rate limit hit`, message: err.message }, 503);
        if (err.name === "AbortError")
          return jsonResponse({ error: "Upstream timeout" }, 504);
        return jsonResponse({ error: "Failed to fetch data", message: err.message }, 500);
      } finally {
        pendingRequests.delete(coalesceKey);
      }
    })();

    pendingRequests.set(coalesceKey, promise);
    return promise;
  }
};

// ================= RESPONSE HELPERS =================
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type":  "application/json",
      "Cache-Control": `public, max-age=${CACHE_DURATION}`,
      ...corsHeaders()
    }
  });
}

async function getCacheVersion(env) {
  const configured = env?.CACHE_VERSION;
  if (!configured) return "1";
  return String(configured).trim() || "1";
}

// ================= FETCH UTILITIES =================
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchJsonWithHandling(source, url, options) {
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) throw new RateLimitError(source, res.status);
    throw new Error(`${source} fetch failed (${res.status})`);
  }
  return res.json();
}

// ================= ANIME PARSERS =================
function parseTopThreeRecent(list) {
  if (!Array.isArray(list)) return [];

  return list
    .sort((a, b) => Number(b.updated_at) - Number(a.updated_at))
    .slice(0, 3)
    .map(entry => {
      const updatedIso = entry.updated_at > 0
        ? new Date(entry.updated_at * 1000).toISOString()
        : null;

      const episodes = entry.num_watched_episodes ?? entry.num_episodes_watched ?? entry.watched_episodes ?? 0;
      const total    = entry.anime_num_episodes || 0;

      return {
        mal_id:          entry.anime_id || null,
        title:           entry.anime_title || null,
        url:             entry.anime_id ? `https://myanimelist.net/anime/${entry.anime_id}` : null,
        image:           entry.anime_image_path || null,
        progress:        episodes,
        total_episodes:  total,
        score:           entry.score || 0,
        updated_at:      updatedIso,
        percentComplete: total > 0 ? Math.round((episodes / total) * 100) : 0
      };
    });
}

async function getRecentAnimeFromMAL(username) {
  try {
    const res = await fetchWithTimeout(MAL_ANIME_LIST_URL(username, 0, 7), { cf: { cacheTtl: 0 } });
    if (!res.ok) return [];
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return [];
    const list = await res.json();
    return parseTopThreeRecent(list);
  } catch {
    return [];
  }
}

// ================= MANGA PARSERS =================

// Prefers updated_at (true last activity) over created_at (when entry was first added).
// If only created_at is available, returns empty to trigger the profile scraper instead.
function parseTopThreeRecentManga(list) {
  if (!Array.isArray(list)) return [];

  const hasUpdatedAt = list.some(e => e.updated_at != null);
  const sortField    = hasUpdatedAt ? "updated_at" : "created_at";

  return list
    .filter(e => e[sortField] != null)
    .sort((a, b) => Number(b[sortField]) - Number(a[sortField]))
    .slice(0, 3)
    .map(entry => {
      const ts         = entry[sortField] ?? 0;
      const updatedIso = ts > 0 ? new Date(ts * 1000).toISOString() : null;
      const chapters   = entry.num_read_chapters ?? entry.num_chapters_read ?? entry.read_chapters ?? 0;
      const total      = entry.manga_num_chapters || 0;

      return {
        mal_id:          entry.manga_id || null,
        title:           entry.manga_title ?? entry.manga_english ?? null,
        url:             entry.manga_id ? `https://myanimelist.net/manga/${entry.manga_id}` : null,
        image:           entry.manga_image_path || null,
        progress:        chapters,
        total_chapters:  total,
        score:           entry.score || 0,
        updated_at:      updatedIso,
        percentComplete: total > 0 ? Math.round((chapters / total) * 100) : 0,
        _sortedBy:       sortField
      };
    });
}

async function getRecentMangaFromMAL(username) {
  try {
    const res = await fetchWithTimeout(MAL_MANGA_LIST_URL(username, 0, 7), { cf: { cacheTtl: 0 } });
    if (!res.ok) return [];
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return [];
    const list   = await res.json();
    const result = parseTopThreeRecentManga(list);

    // created_at only = not reliable for recent activity, use profile scraper instead
    if (result.length && result[0]._sortedBy === "created_at") return [];

    return result.map(({ _sortedBy, ...rest }) => rest);
  } catch {
    return [];
  }
}

// Fallback: scrapes "Last Manga Updates" from the public MAL profile page.
// Uses browser headers to avoid MAL's bot detection.
async function getRecentMangaFromProfile(username) {
  try {
    const res = await fetchWithTimeout(
      `https://myanimelist.net/profile/${username}`,
      { cf: { cacheTtl: 0 }, headers: BROWSER_HEADERS }
    );
    if (!res.ok) return [];

    const html   = await res.text();
    const marker = "Last Manga Updates";
    const start  = html.indexOf(marker);
    if (start === -1) return [];

    const slice     = html.slice(start, start + 25000);
    const entries   = [];
    // Exclude CDN image paths like /manga/3/image.jpg
    const linkRegex = /\/manga\/(\d+)\/(?![\w-]*\.\w{2,4}(?:[?#"<\s]|$))([^"<\s]*)/g;
    let match;

    while ((match = linkRegex.exec(slice)) !== null) {
      const mal_id = Number(match[1]);
      if (!mal_id || entries.some(e => e.mal_id === mal_id)) continue;

      const block = slice.slice(match.index, match.index + 2000);

      // Title is plain anchor text: <a href="/manga/ID/Slug">Title Here</a>
      const titleMatch =
        block.match(/\/manga\/\d+\/[^"]+">([^<]{2,200})<\/a>/) ||
        block.match(/(?:title|aria-label)="([^"]{2,200})"/)     ||
        block.match(/<strong[^>]*>([^<]{2,200})<\/strong>/);

      // MAL uses data-src (lazy loading) on profile images
      const imageMatch =
        block.match(/data-src="(https:\/\/cdn\.myanimelist\.net\/r\/[^"]+)"/) ||
        block.match(/src="(https:\/\/cdn\.myanimelist\.net\/r\/[^"]+)"/);

      const statusMatch   = block.match(/(Reading|Completed|On-Hold|Dropped|Plan to Read)/);
      const progressMatch = block.match(/<span[^>]*>(\d+)<\/span>\s*\/\s*(\d+|\?)/);

      // Matches "Today, 5:32 PM", "Yesterday, 11:00 AM", or "Feb 26, 5:32 PM"
      const timeMatch = block.match(
        /(Today|Yesterday|\w{3}\s+\d{1,2}(?:,\s*\d{4})?),\s*(\d{1,2}:\d{2}\s*[AP]M)/i
      );

      let updatedIso = null;
      if (timeMatch) {
        const label    = timeMatch[1].toLowerCase();
        const timePart = timeMatch[2];
        const now      = new Date();
        let baseDate;

        if (label === "today") {
          baseDate = now.toDateString();
        } else if (label === "yesterday") {
          const yesterday = new Date(now);
          yesterday.setDate(yesterday.getDate() - 1);
          baseDate = yesterday.toDateString();
        } else {
          baseDate = timeMatch[1].includes(",") && timeMatch[1].match(/\d{4}/)
            ? timeMatch[1]
            : `${timeMatch[1]}, ${now.getFullYear()}`;
        }

        const parsed = Date.parse(`${baseDate} ${timePart}`);
        if (!isNaN(parsed)) updatedIso = new Date(parsed).toISOString();
      }

      // Derive title from URL slug as absolute last resort
      const slugTitle = match[0].split("/").pop()?.replace(/_/g, " ") || null;

      // MAL graph bar max width is 190px — use as fallback % when total chapters unknown
      const graphMatch    = block.match(/graph-inner[^>]+style="width:(\d+)px"/);
      const graphPct      = graphMatch ? Math.round((Number(graphMatch[1]) / 190) * 100) : 0;

      const totalChapters = progressMatch && progressMatch[2] !== "?"
        ? Number(progressMatch[2])
        : 0;
      const pct = totalChapters > 0 && progressMatch
        ? Math.round((Number(progressMatch[1]) / totalChapters) * 100)
        : graphPct;

      entries.push({
        mal_id,
        title:           titleMatch    ? titleMatch[1]            : slugTitle,
        url:             `https://myanimelist.net/manga/${mal_id}`,
        image:           imageMatch    ? imageMatch[1]            : null,
        status:          statusMatch   ? statusMatch[1]           : null,
        progress:        progressMatch ? Number(progressMatch[1]) : null,
        total_chapters:  totalChapters,
        percentComplete: pct,
        updated_at:      updatedIso
      });

      if (entries.length >= 3) break;
    }

    return entries;

  } catch (err) {
    console.log("PROFILE SCRAPE ERROR:", err);
    return [];
  }
}

// ================= CACHE ROUTES =================
async function handlePurge(request, env) {
  const url     = new URL(request.url);
  const parts   = url.pathname.split("/").filter(Boolean);
  const cache   = caches.default;
  const version = await getCacheVersion(env);

  if (parts[1] === "all") {
    return jsonResponse({ message: "Global purge requires KV version bump" }, 200);
  }

  const username = parts[1];
  if (!username) return jsonResponse({ error: "No username provided" }, 400);

  const cacheKeyUrl = `https://mal-widget.internal/v${version}/user/${encodeURIComponent(username)}`;
  await cache.delete(new Request(cacheKeyUrl, { method: "GET" }));

  return jsonResponse({ message: "Purged cache for user", username, cache_version: version });
}

async function handleDebugCache(request, env) {
  const url      = new URL(request.url);
  const username = url.searchParams.get("username");
  if (!username) return jsonResponse({ error: "username query param required" }, 400);

  const version     = await getCacheVersion(env);
  const cacheKeyUrl = `https://mal-widget.internal/v${version}/user/${encodeURIComponent(username)}`;
  const cached      = await caches.default.match(new Request(cacheKeyUrl, { method: "GET" }));

  return jsonResponse({
    username,
    cache_version: version,
    cache_key:     cacheKeyUrl,
    cached:        !!cached
  });
}
