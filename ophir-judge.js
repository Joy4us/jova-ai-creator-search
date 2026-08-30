/**
 * OPHIR · AI 初判 —— Cloudflare Pages Functions 版
 * 从 Netlify Functions 迁移而来，逻辑不变。
 *
 * 环境变量（在 Cloudflare Pages 项目 → Settings → Environment variables 里加）：
 *   GEMINI_API_KEY        Google AI Studio 的免费 key（默认走这条，推荐）
 *   TOKENROUTER_API_KEY   TokenRouter 的 sk-... （备用，可不配）
 */

const RATE = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 12;

const MAX_CREATORS = 12;
const TIMEOUT_MS = 45000;

const GEMINI_PREFERENCE = [/flash-lite/i, /flash/i, /pro/i];
let GEMINI_MODEL_CACHE = null;

const TR_BASE_URL = 'https://api.tokenrouter.com/v1';
const TR_MODELS = [
  'qwen/qwen3.8-max-free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
];

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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function str(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function sanitize(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_CREATORS).map(function (c, i) {
    return {
      i: i + 1,
      id: str(c.channelId, 40),
      name: str(c.title, 80),
      country: str(c.country, 4),
      subs: c.subscribers == null ? null : num(c.subscribers),
      avgViews: num(c.avgViews),
      videos: num(c.videoCount),
      ratio: c.viewToSubRatio == null ? null : Number(Number(c.viewToSubRatio).toFixed(4)),
      about: str(c.description, 140),
      hitTitle: str(c.hitVideo && c.hitVideo.title, 120),
      hitViews: num(c.hitVideo && c.hitVideo.views)
    };
  });
}

const SYSTEM_PROMPT = [
  '你是海外网红营销的售前分析助手，服务的是中国出海品牌。',
  '你的任务：基于给定的 YouTube 频道公开数据，对每位达人做第一轮筛选判断。',
  '',
  '严格纪律（违反即为错误输出）：',
  '1. 只能使用我给你的字段做判断。绝对不要编造粉丝数、报价、合作过的品牌、争议事件或任何我没给你的事实。',
  '2. 你无法得知：虚假粉丝比例、受众画像与重合度、真实报价、是否与竞品排他。这些一律不要下结论；',
  '   如果某位达人的判断取决于这些，就把它写进 risk 字段，标明"需人工核查"。',
  '3. 判断依据主要是：观看量粉丝比（avgViews/subs，反映粉丝是否真的在看）、',
  '   频道体量与更新量、简介与命中视频标题反映出的内容方向是否与品牌契合。',
  '4. 经验参考值（供你判断，不要原样复述）：观看量粉丝比低于 2% 通常偏冷，',
  '   10%~40% 属健康区间，超过 100% 多半靠平台推流而非粉丝基本盘，两头都值得人工看一眼。',
  '',
  '对每位达人输出一个判断：',
  '  verdict：fit（推荐）/ caution（谨慎）/ avoid（不推荐）',
  '  reason：不超过 40 个汉字，说明为什么，必须引用具体数字或内容方向',
  '  risk：不超过 30 个汉字，指出最需要人工去核实的那一件事；没有明显风险写"无明显风险"',
  '',
  '只返回 JSON，不要任何解释文字、不要 markdown 代码块。格式：',
  '{"results":[{"id":"频道id","verdict":"fit","reason":"...","risk":"..."}]}'
].join('\n');

const SYSTEM_PROMPT_EN = [
  'You are a pre-sales analyst for overseas influencer marketing, working for brands expanding out of China.',
  'Your task: based on the public YouTube channel data provided, make a first-pass screening judgment on each creator.',
  '',
  'Strict discipline (violating these is a wrong answer):',
  '1. Use only the fields I give you. Never invent subscriber counts, pricing, past brand deals, controversies,',
  '   or any fact I have not provided.',
  '2. You cannot know: fake-follower share, audience demographics or overlap, real rate cards, or competitor exclusivity.',
  '   Never draw conclusions on these. If a judgment would depend on them, put it in the risk field and mark it as needing human verification.',
  '3. Judge mainly on: view-to-subscriber ratio (avgViews/subs — whether the followers actually watch),',
  '   channel size and publishing cadence, and whether the description and matched video title suggest a content direction that fits the brand.',
  '4. Rules of thumb (for your judgment, do not quote them back): a ratio below 2% is usually cold,',
  '   10%-40% is a healthy band, above 100% usually means platform push rather than a real subscriber base — both extremes deserve a human look.',
  '',
  'For each creator output one judgment:',
  '  verdict: fit / caution / avoid',
  '  reason: at most 25 words, why, citing a specific number or content direction',
  '  risk: at most 18 words, the single thing that most needs human verification; write "No obvious risk" if none',
  '',
  'Return JSON only. No explanation, no markdown code fences. Format:',
  '{"results":[{"id":"channelId","verdict":"fit","reason":"...","risk":"..."}]}'
].join('\n');

function buildUserPrompt(brand, query, creators, lang) {
  const isEN = lang === 'en';
  const lines = [];
  lines.push(isEN ? ('Brand / product: ' + (brand || '(not provided — judge fit on content direction and data quality alone)'))
                 : ('品牌/产品：' + (brand || '（未提供，请仅按内容方向与数据质量判断契合度）')));
  lines.push((isEN ? 'Category keyword searched: ' : '搜索的品类关键词：') + query);
  lines.push('');
  lines.push(isEN ? ('Candidate creators (' + creators.length + '):') : ('候选达人（' + creators.length + ' 位）：'));
  creators.forEach(function (c) {
    lines.push(
      [
        '#' + c.i,
        'id=' + c.id,
        '频道=' + c.name,
        '国家=' + (c.country || '未公开'),
        '订阅=' + (c.subs == null ? '未公开' : c.subs),
        '平均单片播放=' + c.avgViews,
        '观看量粉丝比=' + (c.ratio == null ? '无法计算' : (c.ratio * 100).toFixed(1) + '%'),
        '视频数=' + c.videos,
        '简介=' + (c.about || '无'),
        '命中视频=' + (c.hitTitle || '无') + '（' + c.hitViews + ' 播放）'
      ].join(' | ')
    );
  });
  lines.push('');
  lines.push(isEN ? 'Output a judgment for every creator above. Keep the results array in the same order and echo each id verbatim.'
                  : '请对以上每一位输出判断，results 数组顺序与上面一致，id 必须原样回填。');
  return lines.join('\n');
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

function withTimeout(fn) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  return Promise.resolve(fn(ctrl.signal)).finally(function () { clearTimeout(timer); });
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

async function callGemini(key, brand, query, creators, lang) {
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
        systemInstruction: { parts: [{ text: lang === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: buildUserPrompt(brand, query, creators, lang) }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 2048,
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
  return { provider: 'gemini', model: model, content: text, usage: data.usageMetadata || null };
}

async function callTokenRouter(key, brand, query, creators, lang) {
  const messages = [
    { role: 'system', content: lang === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(brand, query, creators, lang) }
  ];
  let lastErr = null;
  for (const model of TR_MODELS) {
    try {
      const res = await withTimeout(function (signal) {
        return fetch(TR_BASE_URL + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          signal,
          body: JSON.stringify({ model: model, messages: messages, temperature: 0.2, max_tokens: 2000 })
        });
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        const err = new Error((data.error && (data.error.message || data.error.code)) || ('HTTP ' + res.status));
        err.status = res.status;
        throw err;
      }
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return { provider: 'tokenrouter', model: model, content: content, usage: data.usage || null };
    } catch (e) {
      lastErr = e;
      if (e.status === 401 || e.status === 403) throw e;
    }
  }
  throw lastErr || new Error('TokenRouter 免费模型均不可用');
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const geminiKey = env.GEMINI_API_KEY;
  const trKey = env.TOKENROUTER_API_KEY;
  if (!geminiKey && !trKey) {
    return json(503, {
      error: 'NO_KEY',
      message: 'AI 初判尚未配置：请在 Cloudflare Pages 环境变量中设置 GEMINI_API_KEY 后重新部署。搜索功能不受影响。'
    });
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (rateLimited(ip)) {
    return json(429, { error: 'RATE_LIMITED', message: 'AI 初判调用过于频繁，请 10 分钟后再试。' });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json(400, { error: 'BAD_JSON', message: '请求格式错误。' });
  }

  const creators = sanitize(payload.creators);
  if (!creators.length) {
    return json(400, { error: 'NO_CREATORS', message: '没有可判断的达人，请先搜索。' });
  }
  const brand = str(payload.brand, 60);
  const query = str(payload.query, 60);
  const lang = payload.lang === 'en' ? 'en' : 'zh';

  const chain = [];
  if (geminiKey) chain.push(function () { return callGemini(geminiKey, brand, query, creators, lang); });
  if (trKey) chain.push(function () { return callTokenRouter(trKey, brand, query, creators, lang); });

  let lastErr = null;
  for (const attempt of chain) {
    let out;
    try {
      out = await attempt();
    } catch (e) {
      lastErr = e;
      continue;
    }

    const parsed = parseModelJSON(out.content);
    const rows = parsed && Array.isArray(parsed.results) ? parsed.results : null;
    if (!rows) { lastErr = new Error('模型未返回可解析的 JSON'); continue; }

    const valid = new Set(['fit', 'caution', 'avoid']);
    const byId = {};
    rows.forEach(function (r, idx) {
      const id = str(r && r.id, 40) || (creators[idx] && creators[idx].id);
      if (!id) return;
      const v = String((r && r.verdict) || '').toLowerCase();
      byId[id] = {
        verdict: valid.has(v) ? v : 'caution',
        reason: str(r && r.reason, 60) || (lang === 'en' ? 'Not enough data to judge — worth a human look.' : '数据不足以判断，建议人工看一眼。'),
        risk: str(r && r.risk, 45) || (lang === 'en' ? 'Needs human verification' : '需人工核查')
      };
    });
    if (!Object.keys(byId).length) { lastErr = new Error('模型返回内容为空'); continue; }

    return json(200, {
      provider: out.provider,
      model: out.model,
      brand: brand,
      judgedAt: new Date().toISOString(),
      usage: out.usage,
      disclaimer:
        lang === 'en'
          ? 'The above is AI’s preliminary judgment from public data, not a final conclusion. Fake followers, audience overlap, fair pricing and brand safety require human review and sign-off.'
          : '以上为 AI 基于公开数据的初步判断，非最终结论。虚假粉丝、受众重合度、报价公允性与品牌安全需人工复核后签字。',
      verdicts: byId
    });
  }

  const msg = lastErr ? String(lastErr.message) : '';
  const gst = (lastErr && lastErr.gstatus) || '';
  const st = (lastErr && lastErr.status) || 0;

  if (st === 401 || st === 403 || gst === 'PERMISSION_DENIED' ||
      /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg)) {
    return json(503, { error: 'KEY_INVALID', message: 'AI 初判配置异常：模型密钥无效或未启用。' });
  }
  if (st === 429 || gst === 'RESOURCE_EXHAUSTED' ||
      /quota|RESOURCE_EXHAUSTED|exhaust|rate limit|too many/i.test(msg)) {
    return json(429, { error: 'QUOTA', message: '模型免费额度已用尽或调用过快，请稍等一分钟再试。搜索结果不受影响。' });
  }
  return json(502, {
    error: 'MODEL_UNAVAILABLE',
    message: 'AI 初判暂时不可用，请稍后再试。搜索结果不受影响。',
    detail: msg.slice(0, 200)
  });
}
