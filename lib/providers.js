// AI 제공사 연결: 모델 목록 불러오기 + 스트리밍 대화(도구 호출 루프 포함)
// 외부 SDK 없이 fetch만 사용한다.
const { TOOL_DEFS } = require('./tools');

const PROVIDERS = {
  anthropic: {
    label: 'Claude', kind: 'anthropic', bases: ['https://api.anthropic.com/v1'],
    keyUrl: 'https://console.anthropic.com/settings/keys', search: 'native',
  },
  openai: {
    label: 'ChatGPT', kind: 'responses', bases: ['https://api.openai.com/v1'],
    keyUrl: 'https://platform.openai.com/api-keys', search: 'native',
  },
  gemini: {
    label: 'Gemini', kind: 'gemini', bases: ['https://generativelanguage.googleapis.com/v1beta'],
    keyUrl: 'https://aistudio.google.com/apikey', search: 'native',
  },
  xai: {
    label: 'Grok', kind: 'responses', bases: ['https://api.x.ai/v1'],
    keyUrl: 'https://console.x.ai', search: 'native',
  },
  qwen: {
    label: 'Qwen', kind: 'chat', native: 'qwen',
    bases: [
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    ],
    keyUrl: 'https://modelstudio.console.alibabacloud.com', search: 'native',
  },
  deepseek: {
    label: 'DeepSeek', kind: 'chat', native: null, bases: ['https://api.deepseek.com'],
    keyUrl: 'https://platform.deepseek.com/api_keys', search: 'external',
  },
  glm: {
    label: 'GLM', kind: 'chat', native: 'glm',
    bases: ['https://api.z.ai/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4'],
    keyUrl: 'https://z.ai/manage-apikey/apikey-list', search: 'native',
    fallbackModels: ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flash', 'glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash'],
    probeModel: 'glm-4.5-flash',
  },
  kimi: {
    label: 'Kimi', kind: 'chat', native: 'kimi',
    bases: ['https://api.moonshot.ai/v1', 'https://api.moonshot.cn/v1'],
    keyUrl: 'https://platform.moonshot.ai/console/api-keys', search: 'native',
  },
};

const SEARCH_PROVIDERS = {
  tavily: { label: 'Tavily', keyUrl: 'https://app.tavily.com' },
  brave: { label: 'Brave Search', keyUrl: 'https://api-dashboard.search.brave.com' },
};

// ---------- HTTP 유틸 ----------
class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}
async function toApiError(res) {
  let text = '';
  try { text = await res.text(); } catch {}
  let msg = text;
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0] && j[0].error : j.error;
    msg = (e && (e.message || (typeof e === 'string' ? e : JSON.stringify(e)))) || j.message || j.msg || text;
  } catch {}
  return new ApiError(res.status, String(msg || '').slice(0, 600));
}
async function* sse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const parse = (raw) => {
    let event = null;
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? { event, data: data.join('\n') } : null;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = buf.match(/\r?\n\r?\n/))) {
      const raw = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const ev = parse(raw);
      if (ev) yield ev;
    }
  }
  if (buf.trim()) {
    const ev = parse(buf);
    if (ev) yield ev;
  }
}
function json(s) { try { return JSON.parse(s); } catch { return null; } }

function authHeaders(provider, key) {
  if (provider === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  if (provider === 'gemini') return { 'x-goog-api-key': key };
  return { authorization: `Bearer ${key}` };
}

// ---------- 모델 목록 ----------
const MODEL_FILTERS = {
  openai: (id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(embed|tts|whisper|dall-e|moderation|audio|realtime|transcribe|image|search|instruct|computer-use|deep-research)/.test(id),
  xai: (id) => !/(image|imagine|video|embed)/.test(id),
  qwen: (id) => /(qwen|qwq)/i.test(id) && !/(embed|tts|asr|realtime|rerank|image|wanx|paraformer|ocr|livetranslate|-mt-|omni)/i.test(id),
  kimi: (id) => !/embed/.test(id),
  glm: (id) => /glm/i.test(id) && !/(embed|image|video|tts|asr|cogview|cogvideo)/i.test(id),
  gemini: (id) => !/(embedding|aqa|imagen|veo|tts|image|robotics|computer-use|lyria|native-audio|live)/.test(id),
};

async function listModels(provider, key, base) {
  const def = PROVIDERS[provider];
  const headers = authHeaders(provider, key);
  if (def.kind === 'gemini') {
    const out = [];
    let pageToken = '';
    do {
      const r = await fetch(`${base}/models?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers });
      if (!r.ok) throw await toApiError(r);
      const j = await r.json();
      for (const m of j.models || []) {
        const id = String(m.name || '').replace(/^models\//, '');
        if ((m.supportedGenerationMethods || []).includes('generateContent') && MODEL_FILTERS.gemini(id)) out.push({ id, name: m.displayName || id });
      }
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  }
  const url = provider === 'anthropic' ? `${base}/models?limit=1000` : `${base}/models`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw await toApiError(r);
  const j = await r.json();
  const list = (j.data || j.models || [])
    .map((m) => ({ id: m.id, name: m.display_name || m.id, created: m.created || (m.created_at ? Date.parse(m.created_at) / 1000 : 0) }))
    .filter((m) => m.id && (!MODEL_FILTERS[provider] || MODEL_FILTERS[provider](m.id)));
  if (provider !== 'anthropic') list.sort((a, b) => (b.created || 0) - (a.created || 0) || b.id.localeCompare(a.id, undefined, { numeric: true }));
  return list.map(({ id, name }) => ({ id, name }));
}

// 키 확인 + 지역(base URL) 자동 감지 + 모델 목록
async function connect(provider, key) {
  const def = PROVIDERS[provider];
  if (!def) throw new Error('알 수 없는 제공사');
  let lastErr = null;
  for (const base of def.bases) {
    try {
      const models = await listModels(provider, key, base);
      if (models.length || !def.fallbackModels) return { base, models };
    } catch (e) {
      lastErr = e;
      // 모델 목록 API가 없는 경우: 짧은 호출로 키 확인
      if (def.fallbackModels && e.status && e.status !== 401 && e.status !== 403) {
        try {
          const r = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { ...authHeaders(provider, key), 'content-type': 'application/json' },
            body: JSON.stringify({ model: def.probeModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
          });
          if (r.ok) return { base, models: def.fallbackModels.map((id) => ({ id, name: id })) };
          lastErr = await toApiError(r);
        } catch (e2) { lastErr = e2; }
      }
    }
  }
  if (def.fallbackModels && lastErr && lastErr.status && lastErr.status !== 401 && lastErr.status !== 403) {
    return { base: def.bases[0], models: def.fallbackModels.map((id) => ({ id, name: id })) };
  }
  throw lastErr || new Error('연결 실패');
}

// ---------- 공통: 텍스트 누적 ----------
function makeText(emit) {
  const t = { value: '', needBreak: false };
  t.add = (s) => {
    if (!s) return;
    if (t.needBreak && t.value && !/\n\s*$/.test(t.value)) s = '\n\n' + s;
    t.needBreak = false;
    t.value += s;
    emit({ t: 'delta', text: s });
  };
  t.brk = () => { t.needBreak = true; };
  t.cut = (len) => { t.value = t.value.slice(0, len); emit({ t: 'set', text: t.value }); };
  return t;
}

function normalizeHistory(history) {
  const out = [];
  for (const m of history) {
    const text = String(m.text || '').trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.text += '\n\n' + text;
    else out.push({ role: m.role, text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

const MAX_STEPS = 10;
const levelCache = new Map(); // `${provider}::${model}` -> 마지막으로 성공한 기능 단계

// 단계별로 기능을 줄여가며 시도 (내장 검색/도구를 지원하지 않는 모델 대응)
async function withLevels(cacheKey, levels, emitted, run) {
  let i = levelCache.has(cacheKey) ? levelCache.get(cacheKey) : 0;
  for (; i < levels.length; i++) {
    try {
      const r = await run(levels[i]);
      levelCache.set(cacheKey, i);
      return r;
    } catch (e) {
      const retryable = e instanceof ApiError && [400, 404, 422].includes(e.status) && !emitted() && i < levels.length - 1;
      if (!retryable) throw e;
    }
  }
}

// ---------- Anthropic (Claude) ----------
function claudeFeatures(model) {
  const m = model.toLowerCase();
  return {
    newSearch: /claude-(opus-4-[6-9]|opus-5|sonnet-4-[6-9]|sonnet-5|fable|mythos)/.test(m),
    effort: /claude-(opus-4-[5-9]|opus-5|sonnet-4-[6-9]|sonnet-5|fable|mythos)/.test(m),
    fallbacks: /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)(\b|-|$)/.test(m),
  };
}

async function runAnthropic(o) {
  const f = claudeFeatures(o.model);
  const levels = [
    { search: f.newSearch ? 'web_search_20260209' : 'web_search_20250305', extras: true },
    { search: 'web_search_20250305', extras: true },
    { search: 'web_search_20250305', extras: false },
    { search: null, extras: false },
  ];
  const text = makeText(o.emit);
  return withLevels(`anthropic::${o.model}`, levels, () => text.value.length > 0, async (lv) => {
    const tools = [];
    if (lv.search) tools.push({ type: lv.search, name: 'web_search', max_uses: 5 });
    for (const t of TOOL_DEFS) {
      if (lv.search && t.name === 'web_search') continue;
      tools.push({ name: t.name, description: t.description, input_schema: t.parameters });
    }
    const system = [{ type: 'text', text: o.system.stable, cache_control: { type: 'ephemeral' } }];
    const messages = o.history.map((m) => ({ role: m.role, content: m.text }));
    for (let step = 0; step < MAX_STEPS; step++) {
      const body = { model: o.model, max_tokens: 32000, system, messages, tools, stream: true };
      const headers = { ...authHeaders('anthropic', o.key), 'content-type': 'application/json' };
      if (lv.extras) body.cache_control = { type: 'ephemeral' }; // 대화 기록까지 자동 캐시
      if (lv.extras && f.effort) body.output_config = { effort: 'low' };
      if (lv.extras && f.fallbacks) {
        body.fallbacks = 'default';
        headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      }
      const res = await fetch(`${o.base}/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal: o.signal });
      if (!res.ok) throw await toApiError(res);

      const stepStart = text.value.length;
      const blocks = [];
      let stop = null;
      for await (const ev of sse(res)) {
        const d = json(ev.data);
        if (!d) continue;
        if (d.type === 'message_start') {
          const served = d.message && d.message.model;
          if (served && served !== o.model) o.emit({ t: 'model', model: served });
        } else if (d.type === 'content_block_start') {
          const b = JSON.parse(JSON.stringify(d.content_block));
          blocks[d.index] = b;
          if (b.type === 'tool_use' || b.type === 'server_tool_use') b._json = '';
          if (b.type === 'fallback') text.cut(stepStart); // 거절된 부분 응답은 버리고 대체 모델 응답으로 이어감
          if (b.type === 'text') { b.text = b.text || ''; if (b.text) text.add(b.text); }
          else if (b.type !== 'thinking' && b.type !== 'redacted_thinking') text.brk();
        } else if (d.type === 'content_block_delta') {
          const b = blocks[d.index];
          const dl = d.delta || {};
          if (!b) continue;
          if (dl.type === 'text_delta') { b.text += dl.text; text.add(dl.text); }
          else if (dl.type === 'input_json_delta') b._json += dl.partial_json || '';
          else if (dl.type === 'thinking_delta') b.thinking = (b.thinking || '') + dl.thinking;
          else if (dl.type === 'signature_delta') b.signature = dl.signature;
          else if (dl.type === 'citations_delta') (b.citations = b.citations || []).push(dl.citation);
        } else if (d.type === 'content_block_stop') {
          const b = blocks[d.index];
          if (b && b._json !== undefined) {
            b.input = b._json ? json(b._json) || {} : b.input || {};
            delete b._json;
            if (b.type === 'server_tool_use' && b.name === 'web_search') o.emit({ t: 'tool', name: 'web_search', info: b.input.query || '' });
          }
        } else if (d.type === 'message_delta') {
          if (d.delta && d.delta.stop_reason) stop = d.delta.stop_reason;
        } else if (d.type === 'error') {
          throw new ApiError(500, (d.error && d.error.message) || '스트림 오류');
        }
      }

      let content = blocks.filter(Boolean);
      // 대체 모델로 넘어간 경우: 경계 이전의 thinking/tool_use 등은 되돌려 보내지 않는다
      const fb = content.map((b) => b.type).lastIndexOf('fallback');
      if (fb >= 0) {
        const pairedIds = new Set(content.filter((b) => /_tool_result$/.test(b.type)).map((b) => b.tool_use_id));
        content = content.filter((b, i) => {
          if (i >= fb) return true;
          if (b.type === 'text') return true;
          if (b.type === 'server_tool_use') return pairedIds.has(b.id);
          if (/_tool_result$/.test(b.type)) return true;
          return false;
        });
      }

      if (stop === 'refusal') {
        o.emit({ t: 'notice', text: '모델이 이 요청에 대한 응답을 거부했습니다.' });
        break;
      }
      if (stop === 'pause_turn') {
        messages.push({ role: 'assistant', content });
        continue;
      }
      if (stop === 'tool_use') {
        const calls = content.filter((b) => b.type === 'tool_use');
        const results = [];
        for (const c of calls) {
          const out = await o.exec(c.name, c.input);
          results.push({ type: 'tool_result', tool_use_id: c.id, content: out });
        }
        messages.push({ role: 'assistant', content }, { role: 'user', content: results });
        text.brk();
        continue;
      }
      if (stop === 'max_tokens') o.emit({ t: 'notice', text: '최대 길이에 도달해 답변이 잘렸습니다.' });
      break;
    }
    return text.value;
  });
}

// ---------- OpenAI / xAI (Responses API) ----------
async function runResponses(o) {
  const isReasoning = /^(o\d|gpt-5)/.test(o.model);
  const levels = [
    { native: true, extras: true },
    { native: true, extras: false },
    { native: false, extras: false },
    { native: false, tools: false },
  ];
  const text = makeText(o.emit);
  return withLevels(`${o.provider}::${o.model}`, levels, () => text.value.length > 0, async (lv) => {
    const tools = [];
    if (lv.tools !== false) {
      if (lv.native) tools.push({ type: 'web_search' });
      for (const t of TOOL_DEFS) {
        if (lv.native && t.name === 'web_search') continue;
        tools.push({ type: 'function', name: t.name, description: t.description, parameters: t.parameters });
      }
    }
    let input = [
      { role: 'system', content: o.system.stable },
      ...o.history.map((m) => ({ role: m.role, content: m.text })),
    ];
    let prev = null;
    for (let step = 0; step < MAX_STEPS; step++) {
      const body = { model: o.model, input, stream: true };
      if (tools.length) body.tools = tools;
      if (prev) body.previous_response_id = prev;
      if (lv.extras && isReasoning && o.provider === 'openai') body.reasoning = { effort: 'low' };
      const res = await fetch(`${o.base}/responses`, {
        method: 'POST',
        headers: { ...authHeaders(o.provider, o.key), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: o.signal,
      });
      if (!res.ok) throw await toApiError(res);
      const items = [];
      let response = null;
      for await (const ev of sse(res)) {
        const d = json(ev.data);
        if (!d) continue;
        const type = d.type || ev.event;
        if (type === 'response.output_text.delta') text.add(d.delta);
        else if (type === 'response.output_item.added') {
          if (d.item && d.item.type !== 'message' && d.item.type !== 'reasoning') text.brk();
        } else if (type === 'response.output_item.done') {
          items.push(d.item);
          if (d.item.type === 'web_search_call') {
            const a = d.item.action || {};
            o.emit({ t: 'tool', name: 'web_search', info: a.query || (a.queries && a.queries[0]) || '' });
          }
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          response = d.response;
          if (type === 'response.incomplete') o.emit({ t: 'notice', text: '응답이 중간에 끊겼습니다.' });
        } else if (type === 'response.failed') {
          throw new ApiError(500, (d.response && d.response.error && d.response.error.message) || '응답 실패');
        } else if (type === 'error') {
          throw new ApiError(d.code === 'invalid_request_error' ? 400 : 500, d.message || (d.error && d.error.message) || '스트림 오류');
        }
      }
      const calls = items.filter((i) => i && i.type === 'function_call');
      if (!calls.length) break;
      if (!response || !response.id) break;
      const outs = [];
      for (const c of calls) {
        const out = await o.exec(c.name, json(c.arguments) || {});
        outs.push({ type: 'function_call_output', call_id: c.call_id, output: out });
      }
      prev = response.id;
      input = outs;
      text.brk();
    }
    return text.value;
  });
}

// ---------- Gemini ----------
const GEMINI_SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map((category) => ({ category, threshold: 'BLOCK_NONE' }));

async function runGemini(o) {
  // google_search와 함수 호출을 같이 못 쓰는 모델이 있어 단계적으로 시도
  const levels = [
    { native: true, fns: true },
    { native: true, fns: false },
    { native: false, fns: true },
    { native: false, fns: false },
  ];
  const text = makeText(o.emit);
  return withLevels(`gemini::${o.model}`, levels, () => text.value.length > 0, async (lv) => {
    const tools = [];
    if (lv.native) tools.push({ google_search: {} });
    if (lv.fns) {
      tools.push({
        functionDeclarations: TOOL_DEFS.filter((t) => !(lv.native && t.name === 'web_search')).map((t) => {
          const { additionalProperties, ...params } = t.parameters;
          return Object.keys(params.properties).length
            ? { name: t.name, description: t.description, parameters: params }
            : { name: t.name, description: t.description };
        }),
      });
    }
    const contents = o.history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] }));
    const seenQueries = new Set();
    for (let step = 0; step < MAX_STEPS; step++) {
      const body = {
        systemInstruction: { parts: [{ text: o.system.stable }] },
        contents,
        safetySettings: GEMINI_SAFETY,
      };
      if (tools.length) body.tools = tools;
      const res = await fetch(`${o.base}/models/${encodeURIComponent(o.model)}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { ...authHeaders('gemini', o.key), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: o.signal,
      });
      if (!res.ok) throw await toApiError(res);
      const parts = [];
      let finish = null;
      for await (const ev of sse(res)) {
        const d = json(ev.data);
        if (!d) continue;
        if (d.error) throw new ApiError(d.error.code || 500, d.error.message);
        if (d.promptFeedback && d.promptFeedback.blockReason) {
          o.emit({ t: 'notice', text: `요청이 차단되었습니다 (${d.promptFeedback.blockReason}).` });
        }
        const c = d.candidates && d.candidates[0];
        if (!c) continue;
        for (const p of (c.content && c.content.parts) || []) {
          parts.push(p);
          if (p.text && !p.thought) text.add(p.text);
          if (p.functionCall) text.brk();
        }
        const g = c.groundingMetadata;
        if (g && g.webSearchQueries) {
          for (const q of g.webSearchQueries) {
            if (!seenQueries.has(q)) { seenQueries.add(q); o.emit({ t: 'tool', name: 'web_search', info: q }); }
          }
        }
        if (c.finishReason) finish = c.finishReason;
      }
      const calls = parts.filter((p) => p.functionCall);
      if (calls.length) {
        contents.push({ role: 'model', parts });
        const responses = [];
        for (const p of calls) {
          const out = await o.exec(p.functionCall.name, p.functionCall.args || {});
          const fr = { name: p.functionCall.name, response: { result: out } };
          if (p.functionCall.id) fr.id = p.functionCall.id;
          responses.push({ functionResponse: fr });
        }
        contents.push({ role: 'user', parts: responses });
        text.brk();
        continue;
      }
      if (finish && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(finish)) {
        o.emit({ t: 'notice', text: finish === 'MAX_TOKENS' ? '최대 길이에 도달해 답변이 잘렸습니다.' : `응답이 중단되었습니다 (${finish}).` });
      }
      break;
    }
    return text.value;
  });
}

// ---------- OpenAI 호환 Chat Completions (Qwen, DeepSeek, GLM, Kimi) ----------
async function runChatCompletions(o) {
  const def = PROVIDERS[o.provider];
  const levels = [];
  if (def.native) levels.push({ native: true, fns: true });
  levels.push({ native: false, fns: true }, { native: false, fns: false });
  const text = makeText(o.emit);
  return withLevels(`${o.provider}::${o.model}`, levels, () => text.value.length > 0, async (lv) => {
    const messages = [
      { role: 'system', content: o.system.stable },
      ...o.history.map((m) => ({ role: m.role, content: m.text })),
    ];
    for (let step = 0; step < MAX_STEPS; step++) {
      const body = { model: o.model, messages, stream: true };
      const tools = [];
      if (lv.native) {
        if (def.native === 'qwen') body.enable_search = true;
        if (def.native === 'glm') tools.push({ type: 'web_search', web_search: { enable: true, search_result: false } });
        if (def.native === 'kimi') tools.push({ type: 'builtin_function', function: { name: '$web_search' } });
      }
      if (lv.fns) {
        for (const t of TOOL_DEFS) {
          if (lv.native && t.name === 'web_search') continue;
          tools.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } });
        }
      }
      if (tools.length) body.tools = tools;
      const res = await fetch(`${o.base}/chat/completions`, {
        method: 'POST',
        headers: { ...authHeaders(o.provider, o.key), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: o.signal,
      });
      if (!res.ok) throw await toApiError(res);
      let content = '';
      let reasoning = '';
      const calls = [];
      let finish = null;
      let glmSearched = false;
      for await (const ev of sse(res)) {
        if (ev.data === '[DONE]') break;
        const d = json(ev.data);
        if (!d) continue;
        if (d.error) throw new ApiError(400, d.error.message || JSON.stringify(d.error));
        if (d.web_search && !glmSearched) { glmSearched = true; o.emit({ t: 'tool', name: 'web_search', info: '' }); }
        const ch = d.choices && d.choices[0];
        if (!ch) continue;
        const dl = ch.delta || {};
        if (dl.content) { content += dl.content; text.add(dl.content); }
        if (dl.reasoning_content) reasoning += dl.reasoning_content;
        for (const tc of dl.tool_calls || []) {
          const i = tc.index ?? calls.length;
          const c = (calls[i] = calls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) c.id = tc.id;
          if (tc.type) c.type = tc.type;
          if (tc.function) {
            if (tc.function.name) c.function.name += tc.function.name;
            if (tc.function.arguments) c.function.arguments += tc.function.arguments;
          }
        }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
      const real = calls.filter(Boolean);
      if (real.length) {
        const am = { role: 'assistant', content: content || '', tool_calls: real };
        if (reasoning) am.reasoning_content = reasoning;
        messages.push(am);
        for (const c of real) {
          let out;
          if (c.function.name === '$web_search') {
            // Kimi 내장 검색: 인자를 그대로 돌려주면 서버가 검색을 수행한다
            o.emit({ t: 'tool', name: 'web_search', info: (json(c.function.arguments) || {}).query || '' });
            out = c.function.arguments;
          } else {
            out = await o.exec(c.function.name, json(c.function.arguments) || {});
          }
          messages.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: out });
        }
        text.brk();
        continue;
      }
      if (finish === 'length') o.emit({ t: 'notice', text: '최대 길이에 도달해 답변이 잘렸습니다.' });
      if (finish === 'sensitive' || finish === 'content_filter') o.emit({ t: 'notice', text: '제공사 필터에 의해 응답이 중단되었습니다.' });
      break;
    }
    return text.value;
  });
}

// ---------- 진입점 ----------
async function runChat(o) {
  const def = PROVIDERS[o.provider];
  if (!def) throw new Error(`알 수 없는 제공사: ${o.provider}`);
  o.history = normalizeHistory(o.history);
  if (!o.history.length) throw new Error('보낼 메시지가 없습니다.');
  // 현재 시각 같은 매번 바뀌는 정보는 시스템 프롬프트가 아닌 마지막 사용자 메시지 끝에 붙인다
  // (시스템 프롬프트와 이전 대화가 그대로 유지되어 제공사의 프롬프트 캐시가 잘 맞는다)
  const last = o.history[o.history.length - 1];
  if (o.system.dynamic && last.role === 'user') last.text += `\n\n(앱 정보 · ${o.system.dynamic})`;
  if (def.kind === 'anthropic') return runAnthropic(o);
  if (def.kind === 'responses') return runResponses(o);
  if (def.kind === 'gemini') return runGemini(o);
  return runChatCompletions(o);
}

function friendlyError(e, provider) {
  const name = (PROVIDERS[provider] && PROVIDERS[provider].label) || provider || '';
  const s = e && e.status;
  const d = (e && (e.detail || e.message)) || '';
  if (s === 401 || s === 403) return `${name} API 키가 올바르지 않거나 권한이 없습니다. (${d})`;
  if (s === 402) return `${name} 계정의 잔액/결제를 확인해주세요. (${d})`;
  if (s === 429) return `${name} 요청 한도 초과 또는 잔액 부족입니다. 잠시 후 다시 시도하세요. (${d})`;
  if (s === 404) return `모델을 찾을 수 없습니다. 모델 목록을 새로고침해보세요. (${d})`;
  if (s >= 500) return `${name} 서버 오류입니다. 잠시 후 다시 시도하세요. (${d})`;
  if (e && e.cause && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(String(e.cause.code))) return '인터넷 연결을 확인해주세요.';
  return d || '알 수 없는 오류';
}

module.exports = { PROVIDERS, SEARCH_PROVIDERS, connect, listModels, runChat, friendlyError, ApiError };
