/**
 * JOY AI · 全网视频 TOP 30（按真实播放量排序）—— Cloudflare Pages Functions 版
 * 从 Netlify Functions 迁移而来，逻辑不变。
 *
 * 环境变量：YT_API_KEY（跟 yt-search.js 共用同一把官方 key）
 */

const API = 'https://www.googleapis.com/youtube/v3';

const CACHE = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时
const CACHE_MAX = 200;

const RATE = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 20;

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
      message: '视频排行服务尚未配置：请在 Cloudflare Pages 环境变量中设置 YT_API_KEY 后重新部署。'
    });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
  if (q.length < 2) {
    return json(400, { error: 'BAD_QUERY', message: '请输入至少 2 个字符的产品或关键词。' });
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (rateLimited(ip)) {
    return json(429, { error: 'RATE_LIMITED', message: '查询过于频繁，请 10 分钟后再试。' });
  }

  const cacheKey = `rank|${q.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return json(200, Object.assign({}, cached, { cached: true }));

  try {
    const search = await yt('search', {
      part: 'snippet',
      type: 'video',
      q,
      maxResults: '50',
      order: 'viewCount',
      relevanceLanguage: 'en'
    }, key);

    const items = (search.items || []).filter(function (it) {
      return it.id && it.id.videoId;
    });
    if (!items.length) {
      return json(200, { query: q, fetchedAt: new Date().toISOString(), videos: [] });
    }

    const videoIds = items.map(function (it) { return it.id.videoId; });

    const vd = await yt('videos', { part: 'snippet,statistics', id: videoIds.join(',') }, key);

    const videos = (vd.items || []).map(function (v) {
      const sn = v.snippet || {};
      const st = v.statistics || {};
      const thumbs = sn.thumbnails || {};
      return {
        videoId: v.id,
        title: sn.title || '',
        channelId: sn.channelId || '',
        channelTitle: sn.channelTitle || '',
        publishedAt: sn.publishedAt || '',
        thumbnail: (thumbs.medium && thumbs.medium.url) || (thumbs.default && thumbs.default.url) || '',
        views: Number(st.viewCount || 0),
        likes: Number(st.likeCount || 0),
        comments: Number(st.commentCount || 0),
        url: `https://www.youtube.com/watch?v=${v.id}`
      };
    });

    videos.sort(function (a, b) { return b.views - a.views; });
    const top30 = videos.slice(0, 30);

    const payload = {
      query: q,
      fetchedAt: new Date().toISOString(),
      source: 'YouTube Data API v3',
      videos: top30
    };
    cacheSet(cacheKey, payload);
    return json(200, payload);
  } catch (e) {
    if (e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded') {
      return json(429, {
        error: 'QUOTA',
        message: '今日免费查询额度已用完（YouTube 官方接口每日限额），明天恢复。'
      });
    }
    if (e.reason === 'keyInvalid' || e.status === 403) {
      return json(503, {
        error: 'KEY_INVALID',
        message: '视频排行服务配置异常：API Key 无效或未启用 YouTube Data API v3。'
      });
    }
    return json(502, { error: 'UPSTREAM', message: '暂时无法连接 YouTube 官方接口，请稍后再试。' });
  }
}
