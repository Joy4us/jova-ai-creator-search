/**
 * 易海 · 「搜网红」后端 —— Cloudflare Pages Functions 版
 * ---------------------------------------------------------------
 * 从 Netlify Functions 迁移而来，业务逻辑完全不变，只改了"入口写法"：
 *   Netlify:    exports.handler = async function(event) {...}
 *   Cloudflare: export async function onRequestGet(context) {...}
 *
 * 环境变量（在 Cloudflare Pages 项目 → Settings → Environment variables 里加）：
 *   YT_API_KEY   —— 跟以前 Netlify 上用的是同一把 Key，直接复制过来即可
 */

const API = 'https://www.googleapis.com/youtube/v3';

/* 轻量缓存 & 限流（进程内，实例回收即清空，够用不烧钱） */
const CACHE = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时
const CACHE_MAX = 300;

const RATE = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 分钟
const RATE_MAX = 25;

const REGIONS = new Set([
  'US', 'CA', 'MX', 'BR', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'PL',
  'SA', 'AE', 'TR', 'IL', 'JP', 'KR', 'SG', 'TH', 'VN', 'ID', 'MY',
  'PH', 'IN', 'AU', 'NZ'
]);

function json(statusCode, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=600'
    }, extraHeaders || {})
  });
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = RATE.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    RATE.set(ip, { start: now, n: 1 });
    return false;
  }
  rec.n += 1;
  return rec.n > RATE_MAX;
}

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL_MS) { CACHE.delete(key); return null; }
  return hit.v;
}

function cacheSet(key, value) {
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, { t: Date.now(), v: value });
}

async function yt(path, params, key) {
  const qs = new URLSearchParams(Object.assign({ key }, params));
  const res = await fetch(`${API}/${path}?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason =
      (data.error && data.error.errors && data.error.errors[0] && data.error.errors[0].reason) || '';
    const err = new Error((data.error && data.error.message) || `YouTube API ${res.status}`);
    err.reason = reason;
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const key = env.YT_API_KEY;
  if (!key) {
    return json(503, {
      error: 'NO_KEY',
      message: '搜索服务尚未配置：请在 Cloudflare Pages 环境变量中设置 YT_API_KEY 后重新部署。'
    });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
  const regionRaw = (url.searchParams.get('region') || '').toUpperCase();
  const region = REGIONS.has(regionRaw) ? regionRaw : '';

  if (q.length < 2) {
    return json(400, { error: 'BAD_QUERY', message: '请输入至少 2 个字符的品类或关键词。' });
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (rateLimited(ip)) {
    return json(429, {
      error: 'RATE_LIMITED',
      message: '查询过于频繁，请 10 分钟后再试（或联系我们获取完整名单）。'
    });
  }

  const cacheKey = `${q.toLowerCase()}|${region}`;
  const cached = cacheGet(cacheKey);
  if (cached) return json(200, Object.assign({}, cached, { cached: true }));

  try {
    const searchParams = {
      part: 'snippet',
      type: 'video',
      q,
      maxResults: '40',
      order: 'relevance',
      videoDuration: 'medium',
      relevanceLanguage: 'en'
    };
    if (region) searchParams.regionCode = region;

    const search = await yt('search', searchParams, key);
    const items = (search.items || []).filter(function (it) {
      return it.id && it.id.videoId && it.snippet && it.snippet.channelId;
    });

    if (!items.length) {
      return json(200, { query: q, region, fetchedAt: new Date().toISOString(), creators: [] });
    }

    const byChannel = new Map();
    for (const it of items) {
      const cid = it.snippet.channelId;
      if (byChannel.has(cid)) continue;
      byChannel.set(cid, {
        channelId: cid,
        videoId: it.id.videoId,
        videoTitle: it.snippet.title,
        publishedAt: it.snippet.publishedAt
      });
      if (byChannel.size >= 12) break;
    }

    const channelIds = Array.from(byChannel.keys());
    const videoIds = Array.from(byChannel.values()).map(function (v) { return v.videoId; });

    const [chRes, vdRes] = await Promise.all([
      yt('channels', { part: 'snippet,statistics', id: channelIds.join(',') }, key),
      yt('videos', { part: 'statistics', id: videoIds.join(',') }, key)
    ]);

    const videoStats = new Map();
    for (const v of (vdRes.items || [])) {
      videoStats.set(v.id, Number((v.statistics && v.statistics.viewCount) || 0));
    }

    const creators = (chRes.items || []).map(function (c) {
      const st = c.statistics || {};
      const sn = c.snippet || {};
      const subs = st.hiddenSubscriberCount ? null : Number(st.subscriberCount || 0);
      const views = Number(st.viewCount || 0);
      const vids = Number(st.videoCount || 0);
      const avgViews = vids > 0 ? Math.round(views / vids) : 0;
      const hit = byChannel.get(c.id) || {};
      const thumbs = sn.thumbnails || {};

      return {
        channelId: c.id,
        title: sn.title || '',
        handle: (sn.customUrl || '').replace(/^@?/, '@'),
        country: sn.country || '',
        publishedAt: sn.publishedAt || '',
        description: (sn.description || '').slice(0, 140),
        avatar: (thumbs.medium && thumbs.medium.url) || (thumbs.default && thumbs.default.url) || '',
        subscribers: subs,
        totalViews: views,
        videoCount: vids,
        avgViews: avgViews,
        viewToSubRatio: subs && subs > 0 ? Number((avgViews / subs).toFixed(4)) : null,
        hitVideo: hit.videoId
          ? {
              videoId: hit.videoId,
              title: hit.videoTitle,
              publishedAt: hit.publishedAt,
              views: videoStats.get(hit.videoId) || 0
            }
          : null
      };
    });

    const payload = {
      query: q,
      region,
      fetchedAt: new Date().toISOString(),
      source: 'YouTube Data API v3',
      creators
    };
    cacheSet(cacheKey, payload);
    return json(200, payload);
  } catch (e) {
    if (e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded') {
      return json(429, {
        error: 'QUOTA',
        message: '今日免费查询额度已用完（YouTube 官方接口每日限额），明天恢复。需要完整名单请直接联系我们。'
      });
    }
    if (e.reason === 'keyInvalid' || e.status === 403) {
      return json(503, {
        error: 'KEY_INVALID',
        message: '搜索服务配置异常：API Key 无效或未启用 YouTube Data API v3。'
      });
    }
    return json(502, { error: 'UPSTREAM', message: '暂时无法连接 YouTube 官方接口，请稍后再试。' });
  }
}
