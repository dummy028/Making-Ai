#!/usr/bin/env node
// 초간단 커스텀 AI 캐릭터 채팅 — 로컬 서버 (의존성 없음, Node 18+)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const store = require('./lib/store');
const { buildSystem } = require('./lib/prompt');
const { execTool } = require('./lib/tools');
const providers = require('./lib/providers');
const { createZip, readZip } = require('./lib/zip');

const HOST = '127.0.0.1';
const START_PORT = Number(process.env.PORT) || 3939;
const PUBLIC = path.join(__dirname, 'public');
const HISTORY_MAX_MESSAGES = 60;
const HISTORY_MAX_CHARS = 40000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
};

store.ensureData();
let port = START_PORT;

// ---------- 유틸 ----------
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(data);
}
function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('요청이 너무 큽니다.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw Object.assign(new Error('잘못된 JSON'), { status: 400 }); }
}
function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}
function maskedKeys() {
  const keys = store.getKeys();
  const out = {};
  for (const [id, v] of Object.entries(keys)) {
    if (v && v.key) out[id] = { set: true, hint: `${v.key.slice(0, 4)}…${v.key.slice(-4)}`, base: v.base || null };
  }
  return out;
}
function parseModel(s) {
  const i = String(s || '').indexOf('::');
  return i > 0 ? { provider: s.slice(0, i), model: s.slice(i + 2) } : null;
}
function firstAvailableModel() {
  const keys = store.getKeys();
  const models = store.getModels();
  for (const id of Object.keys(providers.PROVIDERS)) {
    if (keys[id] && keys[id].key && models[id] && models[id].length) return `${id}::${models[id][0].id}`;
  }
  return '';
}
function state() {
  const settings = store.getSettings();
  return {
    settings,
    keys: maskedKeys(),
    models: store.getModels(),
    providers: Object.fromEntries(Object.entries(providers.PROVIDERS).map(([id, p]) => [id, { label: p.label, keyUrl: p.keyUrl, search: p.search }])),
    searchProviders: providers.SEARCH_PROVIDERS,
    personas: store.listPersonas(),
    projects: store.listProjects(),
    personaFields: require('./lib/defaults').PERSONA_FIELDS,
    dataDir: store.P.root,
    fallbackModel: firstAvailableModel(),
  };
}
function decodeB64(data) {
  const s = String(data || '').replace(/^data:[^,]*,/, '');
  return Buffer.from(s, 'base64');
}

// ---------- 채팅 (스트리밍) ----------
async function handleChat(req, res) {
  const body = await readJsonBody(req);
  const { project, chatId } = body;
  const chat = store.getChat(project, chatId);
  if (!chat) return send(res, 404, { error: '채팅을 찾을 수 없습니다.' });
  const settings = store.getSettings();

  if (body.regenerate) {
    while (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'assistant') chat.messages.pop();
  } else {
    const text = String(body.text || '').trim();
    if (!text) return send(res, 400, { error: '메시지가 비어 있습니다.' });
    chat.messages.push({ id: store.uid('m-'), role: 'user', text, ts: Date.now() });
    if (chat.title === '새 채팅' && chat.messages.filter((m) => m.role === 'user').length === 1) {
      chat.title = text.replace(/\s+/g, ' ').slice(0, 30) + (text.length > 30 ? '…' : '');
    }
  }
  if (!chat.messages.length) return send(res, 400, { error: '보낼 메시지가 없습니다.' });

  const modelId = chat.model || settings.defaultModel || firstAvailableModel();
  const pm = parseModel(modelId);
  const keyEntry = pm && store.getKeys()[pm.provider];
  const persona = store.getPersona(chat.personaId) || store.getPersona(settings.defaultPersona) || store.listPersonas()[0] || null;
  if (persona && chat.personaId !== persona.id) chat.personaId = persona.id;
  if (pm && chat.model !== modelId) chat.model = modelId;
  store.saveChat(project, chat);

  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const write = (ev) => { if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n'); };
  write({ t: 'start', chat: { id: chat.id, title: chat.title, model: chat.model, personaId: chat.personaId }, userMessage: body.regenerate ? null : chat.messages[chat.messages.length - 1] });

  if (!pm || !keyEntry || !keyEntry.key) {
    write({ t: 'error', error: 'API 키가 연결된 모델이 없습니다. 설정에서 API 키를 추가하고 모델을 선택하세요.' });
    return res.end();
  }

  // 최근 대화만 보냄 (토큰 절약)
  const hist = [];
  let chars = 0;
  for (let i = chat.messages.length - 1; i >= 0 && hist.length < HISTORY_MAX_MESSAGES; i--) {
    const m = chat.messages[i];
    if (!m.text) continue;
    chars += m.text.length;
    if (chars > HISTORY_MAX_CHARS && hist.length) break;
    hist.unshift({ role: m.role, text: m.text });
  }

  const msg = { id: store.uid('m-'), role: 'assistant', text: '', ts: Date.now(), personaId: persona && persona.id, model: modelId, tools: [], notices: [] };
  const ac = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) ac.abort(); });

  const emit = (ev) => {
    if (ev.t === 'delta') msg.text += ev.text;
    else if (ev.t === 'set') msg.text = ev.text;
    else if (ev.t === 'tool') msg.tools.push({ name: ev.name, info: ev.info });
    else if (ev.t === 'notice') msg.notices.push(ev.text);
    else if (ev.t === 'model') msg.servedModel = ev.model;
    write(ev);
  };

  try {
    await providers.runChat({
      provider: pm.provider,
      model: pm.model,
      key: keyEntry.key,
      base: keyEntry.base || providers.PROVIDERS[pm.provider].bases[0],
      system: buildSystem(persona, settings),
      history: hist,
      emit,
      exec: (name, args) => execTool(name, args, { emit, signal: ac.signal }),
      signal: ac.signal,
    });
  } catch (e) {
    if (!ac.signal.aborted) {
      console.error('[chat]', e.status || '', e.detail || e.message);
      write({ t: 'error', error: providers.friendlyError(e, pm.provider) });
    }
  }
  finished = true;
  if (!msg.tools.length) delete msg.tools;
  if (!msg.notices.length) delete msg.notices;
  if (msg.text.trim()) {
    if (ac.signal.aborted) msg.stopped = true;
    const fresh = store.getChat(project, chatId) || chat;
    // 스트리밍 중에 다른 곳에서 바뀐 내용(이름 변경 등)을 보존
    fresh.messages = chat.messages.concat([msg]);
    store.saveChat(project, fresh);
    write({ t: 'done', message: msg });
  } else {
    write({ t: 'done', message: null });
  }
  res.end();
}

// ---------- 라우터 ----------
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const m = req.method;
  const seg = p.split('/').filter(Boolean).map(decodeURIComponent);

  // 정적 파일
  if (!p.startsWith('/api/') && !p.startsWith('/files/')) {
    const file = path.join(PUBLIC, p === '/' ? 'index.html' : path.normalize(p).replace(/^([\\/])+/, ''));
    if (!store.isInside(PUBLIC, file)) return send(res, 403, 'forbidden');
    return serveFile(res, file);
  }

  // 데이터 파일 (이미지)
  if (seg[0] === 'files') {
    if (seg[1] === 'personas' && seg[3] === 'images' && seg[4]) {
      const f = store.personaImagePath(seg[2], seg[4]);
      return f ? serveFile(res, f) : send(res, 404, 'not found');
    }
    if (seg[1] === 'assets' && seg[2]) return serveFile(res, path.join(store.P.assets, path.basename(seg[2])));
    return send(res, 404, 'not found');
  }

  const api = seg.slice(1);
  const [a0, a1, a2, a3, a4] = api;

  if (a0 === 'state' && m === 'GET') return send(res, 200, state());

  // 설정
  if (a0 === 'settings' && m === 'PUT') {
    const body = await readJsonBody(req);
    const allowed = ['theme', 'accent', 'userName', 'defaultModel', 'defaultPersona'];
    const patch = {};
    for (const k of allowed) if (k in body) patch[k] = body[k];
    return send(res, 200, store.setSettings(patch));
  }
  if (a0 === 'background') {
    const cur = store.getSettings().background;
    if (cur) fs.rmSync(path.join(store.P.assets, path.basename(cur)), { force: true });
    if (m === 'DELETE') return send(res, 200, store.setSettings({ background: '' }));
    if (m === 'POST') {
      const body = await readJsonBody(req);
      const ext = (path.extname(body.filename || '') || '.png').toLowerCase();
      if (!/^\.(png|jpe?g|gif|webp|avif|bmp)$/.test(ext)) return send(res, 400, { error: '이미지 파일만 가능합니다.' });
      const name = `background-${Date.now().toString(36)}${ext}`;
      fs.writeFileSync(path.join(store.P.assets, name), decodeB64(body.data));
      return send(res, 200, store.setSettings({ background: name }));
    }
  }

  // API 키
  if (a0 === 'keys') {
    if (m === 'POST') {
      const { provider, key } = await readJsonBody(req);
      const k = String(key || '').trim();
      if (!k) return send(res, 400, { error: '키를 입력하세요.' });
      if (providers.SEARCH_PROVIDERS[provider]) {
        store.setKey(provider, { key: k });
        return send(res, 200, state());
      }
      if (!providers.PROVIDERS[provider]) return send(res, 400, { error: '알 수 없는 제공사' });
      try {
        const { base, models } = await providers.connect(provider, k);
        store.setKey(provider, { key: k, base });
        store.setModels(provider, models);
        const s = store.getSettings();
        if (!parseModel(s.defaultModel) && models[0]) store.setSettings({ defaultModel: `${provider}::${models[0].id}` });
        return send(res, 200, state());
      } catch (e) {
        return send(res, 400, { error: providers.friendlyError(e, provider) });
      }
    }
    if (m === 'DELETE' && a1) {
      store.setKey(a1, null);
      store.setModels(a1, null);
      const s = store.getSettings();
      const pm = parseModel(s.defaultModel);
      if (pm && pm.provider === a1) store.setSettings({ defaultModel: firstAvailableModel() });
      return send(res, 200, state());
    }
  }
  if (a0 === 'models' && a1 === 'refresh' && m === 'POST') {
    const keys = store.getKeys();
    const errors = [];
    for (const id of Object.keys(providers.PROVIDERS)) {
      if (!keys[id] || !keys[id].key) continue;
      try {
        const { base, models } = await providers.connect(id, keys[id].key);
        store.setKey(id, { ...keys[id], base });
        store.setModels(id, models);
      } catch (e) { errors.push(`${providers.PROVIDERS[id].label}: ${providers.friendlyError(e, id)}`); }
    }
    return send(res, 200, { ...state(), errors });
  }

  // 프로젝트
  if (a0 === 'projects') {
    if (m === 'GET') return send(res, 200, store.listProjects());
    if (m === 'POST') { const b = await readJsonBody(req); store.createProject(b.name); return send(res, 200, store.listProjects()); }
    if (m === 'PATCH' && a1) { const b = await readJsonBody(req); const name = store.renameProject(a1, b.name); return send(res, 200, { name, projects: store.listProjects() }); }
    if (m === 'DELETE' && a1) { store.deleteProject(a1); return send(res, 200, store.listProjects()); }
  }

  // 채팅
  if (a0 === 'chat' && m === 'POST') return handleChat(req, res);
  if (a0 === 'chats') {
    if (m === 'POST' && a1 && !a2) {
      const b = await readJsonBody(req);
      const s = store.getSettings();
      const chat = store.createChat(a1, { personaId: b.personaId || s.defaultPersona, model: b.model || s.defaultModel || firstAvailableModel() });
      return send(res, 200, chat);
    }
    if (m === 'GET' && a1 && a2) {
      const c = store.getChat(a1, a2);
      return c ? send(res, 200, c) : send(res, 404, { error: '채팅을 찾을 수 없습니다.' });
    }
    if (m === 'PATCH' && a1 && a2) {
      const b = await readJsonBody(req);
      if (b.moveTo && b.moveTo !== a1) { store.moveChat(a1, a2, b.moveTo); return send(res, 200, store.getChat(b.moveTo, a2)); }
      const c = store.getChat(a1, a2);
      if (!c) return send(res, 404, { error: '채팅을 찾을 수 없습니다.' });
      if (typeof b.title === 'string' && b.title.trim()) c.title = b.title.trim().slice(0, 80);
      if (typeof b.personaId === 'string') c.personaId = b.personaId;
      if (typeof b.model === 'string') c.model = b.model;
      return send(res, 200, store.saveChat(a1, c));
    }
    if (m === 'DELETE' && a1 && a2 && a3 === 'messages' && a4) {
      const c = store.getChat(a1, a2);
      if (!c) return send(res, 404, { error: '채팅을 찾을 수 없습니다.' });
      c.messages = c.messages.filter((x) => x.id !== a4);
      return send(res, 200, store.saveChat(a1, c));
    }
    if (m === 'DELETE' && a1 && a2) { store.deleteChat(a1, a2); return send(res, 200, { ok: true }); }
  }
  if (a0 === 'search' && m === 'GET') return send(res, 200, store.searchChats(url.searchParams.get('q')));

  // 페르소나
  if (a0 === 'personas') {
    if (m === 'GET' && !a1) return send(res, 200, store.listPersonas());
    if (m === 'POST' && !a1) {
      const b = await readJsonBody(req);
      if (!String(b.name || '').trim()) return send(res, 400, { error: '이름은 필수입니다.' });
      return send(res, 200, store.createPersona(b));
    }
    if (a1 && !store.getPersona(a1)) return send(res, 404, { error: '페르소나를 찾을 수 없습니다.' });
    if (m === 'PUT' && a1 && !a2) {
      const b = await readJsonBody(req);
      if (!String(b.name || '').trim()) return send(res, 400, { error: '이름은 필수입니다.' });
      return send(res, 200, store.savePersona(a1, b));
    }
    if (m === 'DELETE' && a1 && !a2) {
      if (store.listPersonas().length <= 1) return send(res, 400, { error: '마지막 페르소나는 삭제할 수 없습니다.' });
      store.deletePersona(a1);
      const s = store.getSettings();
      if (s.defaultPersona === a1) store.setSettings({ defaultPersona: (store.listPersonas()[0] || {}).id || '' });
      return send(res, 200, store.listPersonas());
    }
    if (m === 'POST' && a2 === 'duplicate') return send(res, 200, store.duplicatePersona(a1));
    if (a2 === 'images') {
      if (m === 'POST') {
        const b = await readJsonBody(req);
        return send(res, 200, store.saveImage(a1, String(b.filename || 'img.png'), decodeB64(b.data), b.desc));
      }
      if (m === 'PATCH' && a3) { const b = await readJsonBody(req); return send(res, 200, store.updateImage(a1, a3, b)); }
      if (m === 'DELETE' && a3) return send(res, 200, store.deleteImage(a1, a3));
    }
  }

  // Rule 폴더 편집
  if (a0 === 'rules') {
    if (m === 'GET' && !a1) return send(res, 200, store.listRules());
    if (a1 === 'file') {
      const rel = url.searchParams.get('path');
      if (m === 'GET') return send(res, 200, { path: rel, content: store.readRule(rel) });
      if (m === 'PUT') { const b = await readJsonBody(req); store.writeRule(b.path, b.content); return send(res, 200, store.listRules()); }
      if (m === 'DELETE') { store.deleteRule(rel); return send(res, 200, store.listRules()); }
    }
  }

  // 내보내기 / 가져오기
  if (a0 === 'export' && m === 'GET') {
    const includeKeys = url.searchParams.get('keys') === '1';
    const entries = store.allDataFiles({ includeKeys }).map((rel) => {
      const full = path.join(store.P.root, rel);
      return { name: `data/${rel}`, data: fs.readFileSync(full), mtime: fs.statSync(full).mtime };
    });
    const zip = createZip(entries);
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return send(res, 200, zip, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="making-ai-data-${stamp}.zip"` });
  }
  if (a0 === 'import' && m === 'POST') {
    const buf = await readBody(req, 1024 * 1024 * 1024);
    const entries = readZip(buf);
    // zip 안의 data/ 접두어 처리 (data/ 없이 압축한 경우도 허용)
    const hasPrefix = entries.every((e) => e.name.startsWith('data/'));
    const files = entries.map((e) => ({ rel: hasPrefix ? e.name.slice(5) : e.name, data: e.data }));
    if (!files.some((f) => f.rel === 'settings.json' || f.rel.startsWith('rules/') || f.rel.startsWith('personas/'))) {
      return send(res, 400, { error: '이 앱의 데이터 zip이 아닌 것 같습니다.' });
    }
    const tmp = path.join(path.dirname(store.P.root), 'data_import_tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const f of files) {
      const target = path.resolve(tmp, f.rel);
      if (!store.isInside(tmp, target)) continue; // zip slip 방지
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.data);
    }
    // 키가 없는 백업이면 현재 키 유지
    if (!fs.existsSync(path.join(tmp, 'keys.json')) && fs.existsSync(store.P.keys)) fs.copyFileSync(store.P.keys, path.join(tmp, 'keys.json'));
    const backup = path.join(path.dirname(store.P.root), `data_backup_${Date.now()}`);
    fs.renameSync(store.P.root, backup);
    fs.renameSync(tmp, store.P.root);
    store.ensureData();
    return send(res, 200, { ok: true, backup });
  }

  send(res, 404, { error: 'not found' });
}

// ---------- 서버 ----------
const server = http.createServer(async (req, res) => {
  // 로컬 전용: 다른 사이트에서의 요청(DNS 리바인딩/CSRF) 차단
  const host = String(req.headers.host || '');
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return send(res, 403, 'forbidden host');
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, 'forbidden origin');
  try {
    await route(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 400, { error: e.message || '오류' });
    else res.end();
  }
});

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < START_PORT + 20) {
    port++;
    server.listen(port, HOST);
  } else {
    console.error(e);
    process.exit(1);
  }
});
server.listen(port, HOST, () => {
  const url = `http://localhost:${port}`;
  console.log(`\n  Making AI 실행 중 → ${url}`);
  console.log(`  데이터 폴더: ${store.P.root}`);
  console.log('  종료하려면 이 창을 닫거나 Ctrl+C\n');
  openBrowser(url);
});
