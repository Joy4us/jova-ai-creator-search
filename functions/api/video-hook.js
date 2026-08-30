/**
 * JOY AI · Hook 分析（单条视频）—— Cloudflare Pages Functions 版
 * 从 Netlify Functions 迁移而来，逻辑不变。
 *
 * 环境变量：GEMINI_API_KEY（Google AI Studio 的免费 key）
 * 没配置时返回 503，前端按"未配置"处理，不影响视频排行本身。
 */

const RATE = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 60;

const TIMEOUT_MS = 45000;

const GEMINI_PREFERENCE = [/flash-lite/i, /flash/i, /pro/i];
let GEMINI_MODEL_CACHE = null;

function json(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
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

function str(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function withTimeout(fn) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  return Promise.resolve(fn(ctrl.signal)).finally(function () { clearTimeout(timer); });
}

function parseModelJSON(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(s); } catch (e) { /* 继续尝试 */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* 放弃 */ }
  }
  return null;
}

async function pickGeminiModel(key) {
  if (GEMINI_MODEL_CACHE) return GEMINI_MODEL_CACHE;
  const res = await withTimeout(function (signal) {
    return fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key), { signal });
  });
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  const usable = (data.models || [])
    .filter(function (m) {
      return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0;
    })
    .map(function (m) { return String(m.name || '').replace(/^models\//, ''); })
    .filter(function (n) { return n && !/embed|aqa|imagen|veo|tts|native-audio|image/i.test(n); });

  for (const pat of GEMINI_PREFERENCE) {
    const hit = usable.find(function (n) { return pat.test(n); });
    if (hit) { GEMINI_MODEL_CACHE = hit; return hit; }
  }
  if (usable.length) { GEMINI_MODEL_CACHE = usable[0]; return usable[0]; }
  throw new Error('Gemini 账号下没有可用于生成的模型');
}

const SYS_ZH = [
  '你是短视频内容分析师，专门拆解视频的开场 Hook（前几秒抓住观众注意力的手法）。',
  '你会拿到一个 YouTube 视频链接，只需要看/听开头 8 秒。',
  '严格纪律：',
  '1. 只描述你在这 8 秒里实际看到、听到的画面与台词，不要编造没出现的内容。',
  '2. 如果视频无法访问（受限、已删除、地区限制等），如实说明，不要瞎猜内容。',
  '只返回 JSON，不要解释文字、不要 markdown 代码块，格式：',
  '{"hookType":"这段开场用的钩子类型，8个汉字以内，例如：数据震撼式 / 展示成果式 / 悬念提问式 / 反常识观点式",',
  '"hookText":"具体描述开头8秒看到/听到什么，60个汉字以内，可引用画外音原话"}'
].join('\n');

const SYS_EN = [
  'You are a short-form video analyst who breaks down opening "hooks" (the technique used in the first seconds to grab attention).',
  'You will be given a YouTube video link — only watch/listen to the first 8 seconds.',
  'Strict discipline:',
  '1. Only describe what you actually see/hear in those 8 seconds. Never invent content that is not there.',
  '2. If the video cannot be accessed (restricted, deleted, region-locked, etc.), say so honestly instead of guessing.',
  'Return JSON only, no explanation, no markdown fences, format:',
  '{"hookType":"the hook technique used, at most 4 words, e.g. Shocking-stat / Results-first / Curiosity-question / Contrarian-take",',
  '"hookText":"what you actually see/hear in the first 8 seconds, at most 30 words, quote the voiceover if useful"}'
].join('\n');

async function callGemini(key, videoUrl, lang) {
  const model = await pickGeminiModel(key);
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);

  const res = await withTimeout(function (signal) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: lang === 'en' ? SYS_EN : SYS_ZH }] },
        contents: [{
          role: 'user',
          parts: [
            {
              fileData: { fileUri: videoUrl },
              videoMetadata: { startOffset: '0s', endOffset: '8s' }
            },
            { text: lang === 'en' ? 'Analyze the opening hook of this video.' : '分析这条视频的开场 Hook。' }
          ]
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 512,
          responseMimeType: 'application/json'
        }
      })
    });
  });

  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || ('HTTP ' + res.status));
    err.status = res.status;
    err.gstatus = data.error && data.error.status;
    throw err;
  }
  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && cand.content.parts &&
    cand.content.parts.map(function (p) { return p.text || ''; }).join('');
  return { model: model, content: text };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const geminiKey = env.GEMINI_API_KEY;
  if (!geminiKey) {
    let lang0 = 'zh';
    try {
      const peek = await request.clone().json();
      lang0 = peek.lang === 'en' ? 'en' : 'zh';
    } catch (e) {}
    return json(503, {
      error: 'NO_KEY',
      message: lang0 === 'en'
        ? 'Hook analysis is not configured yet: set GEMINI_API_KEY in Cloudflare Pages environment variables and redeploy. Video ranking itself is unaffected.'
        : 'Hook 分析尚未配置：请在 Cloudflare Pages 环境变量中设置 GEMINI_API_KEY 后重新部署。视频排行本身不受影响。'
    });
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (rateLimited(ip)) {
    return json(429, { error: 'RATE_LIMITED', message: 'Hook 分析调用过于频繁，请稍后再试。' });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { error: 'BAD_JSON', message: '请求格式错误。' });
  }

  const videoId = str(payload.videoId, 20);
  if (!/^[\w-]{6,20}$/.test(videoId)) {
    return json(400, { error: 'BAD_VIDEO', message: '缺少有效的视频 ID。' });
  }
  const lang = payload.lang === 'en' ? 'en' : 'zh';
  const videoUrl = 'https://www.youtube.com/watch?v=' + videoId;

  try {
    const out = await callGemini(geminiKey, videoUrl, lang);
    const parsed = parseModelJSON(out.content);
    if (!parsed || !parsed.hookText) {
      return json(502, {
        error: 'MODEL_UNAVAILABLE',
        message: lang === 'en' ? 'Hook analysis failed for this video.' : 'Hook 分析失败，可能是视频被设为年龄限制或地区限制。'
      });
    }
    return json(200, {
      videoId: videoId,
      model: out.model,
      hookType: str(parsed.hookType, 30),
      hookText: str(parsed.hookText, 200)
    });
  } catch (e) {
    const msg = String(e.message || '');
    const gst = e.gstatus || '';
    const st = e.status || 0;

    if (st === 401 || st === 403 || gst === 'PERMISSION_DENIED' ||
        /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg)) {
      return json(503, { error: 'KEY_INVALID', message: 'Hook 分析配置异常：模型密钥无效或未启用。' });
    }
    if (st === 429 || gst === 'RESOURCE_EXHAUSTED' ||
        /quota|RESOURCE_EXHAUSTED|exhaust|rate limit|too many/i.test(msg)) {
      return json(429, { error: 'QUOTA', message: '模型免费额度已用尽或调用过快，请稍等再试。' });
    }
    return json(502, {
      error: 'MODEL_UNAVAILABLE',
      message: lang === 'en' ? 'Hook analysis failed for this video.' : 'Hook 分析失败，可能是视频被设为年龄限制或地区限制。',
      detail: msg.slice(0, 200)
    });
  }
}
