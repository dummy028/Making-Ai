// AI가 호출할 수 있는 도구: Rule 폴더 읽기/쓰기 + (내장 검색이 없는 모델용) 외부 웹 검색
const store = require('./store');

const TOOL_DEFS = [
  {
    name: 'rules_list',
    description: 'Rule 폴더(지침 instructions/, 기억 memory/, 스킬 skills/)의 md 파일 목록을 본다.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'rules_read',
    description: 'Rule 폴더 안의 md 파일 하나를 읽는다. 스킬을 쓰기 전에 SKILL.md를 읽을 때도 사용.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Rule 폴더 기준 상대 경로. 예: skills/규칙-관리/SKILL.md' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'rules_write',
    description: 'Rule 폴더 안에 md 파일을 만들거나 전체 내용을 덮어쓴다. 기존 파일을 고칠 땐 먼저 rules_read로 읽고 합친 내용을 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Rule 폴더 기준 상대 경로(.md). 예: instructions/호칭.md, memory/기억.md' },
        content: { type: 'string', description: '파일 전체 내용' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'web_search',
    description: '웹을 검색한다. 모르는 것, 최신 정보, 전문 지식, 밈·은어 같은 커뮤니티 지식이 필요할 때 반드시 사용.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '검색어' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function webSearch(query, signal) {
  const keys = store.getKeys();
  let results = [];
  let engine = '';
  if (keys.tavily && keys.tavily.key) {
    engine = 'Tavily';
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keys.tavily.key}` },
      body: JSON.stringify({ query, max_results: 6, search_depth: 'basic' }),
      signal,
    });
    if (!r.ok) throw new Error(`Tavily 검색 실패 (${r.status})`);
    const j = await r.json();
    results = (j.results || []).map((x) => ({ title: x.title, url: x.url, text: x.content }));
  } else if (keys.brave && keys.brave.key) {
    engine = 'Brave';
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6`, {
      headers: { accept: 'application/json', 'x-subscription-token': keys.brave.key },
      signal,
    });
    if (!r.ok) throw new Error(`Brave 검색 실패 (${r.status})`);
    const j = await r.json();
    results = ((j.web && j.web.results) || []).map((x) => ({ title: stripHtml(x.title), url: x.url, text: stripHtml(x.description) }));
  } else {
    // 키 없이 쓰는 대체 수단 (DuckDuckGo HTML). 불안정할 수 있음.
    engine = 'DuckDuckGo';
    const r = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (compatible; MakingAI/1.0)' },
      body: `q=${encodeURIComponent(query)}&kl=kr-kr`,
      signal,
    });
    if (!r.ok) throw new Error(`검색 실패 (${r.status})`);
    const html = await r.text();
    const blocks = html.split(/class="result__body"|class="result results_links/).slice(1);
    for (const b of blocks) {
      const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      let url = a[1].replace(/&amp;/g, '&');
      const u = url.match(/[?&]uddg=([^&]+)/);
      if (u) url = decodeURIComponent(u[1]);
      const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      results.push({ title: stripHtml(a[2]), url, text: stripHtml(sn ? sn[1] : '') });
      if (results.length >= 6) break;
    }
  }
  if (!results.length) return `"${query}" 검색 결과가 없습니다. (${engine})`;
  return (
    `"${query}" 검색 결과 (${engine}):\n\n` +
    results.map((x, i) => `[${i + 1}] ${x.title}\n${x.url}\n${String(x.text || '').slice(0, 1200)}`).join('\n\n')
  );
}

// 도구 실행. 항상 문자열을 돌려준다 (에러도 문자열로 모델에게 전달)
async function execTool(name, args, { emit, signal }) {
  args = args || {};
  try {
    switch (name) {
      case 'rules_list': {
        const files = store.listRules();
        return files.length ? files.join('\n') : '(비어 있음)';
      }
      case 'rules_read': {
        emit({ t: 'tool', name: 'rules_read', info: args.path });
        return store.readRule(args.path);
      }
      case 'rules_write': {
        const rel = store.writeRule(args.path, args.content);
        emit({ t: 'tool', name: 'rules_write', info: rel });
        return `저장 완료: ${rel}`;
      }
      case 'web_search': {
        emit({ t: 'tool', name: 'web_search', info: args.query });
        return await webSearch(String(args.query || ''), signal);
      }
      default:
        return `알 수 없는 도구: ${name}`;
    }
  } catch (e) {
    if (signal && signal.aborted) throw e;
    return `오류: ${e.message}`;
  }
}

module.exports = { TOOL_DEFS, execTool, webSearch };
