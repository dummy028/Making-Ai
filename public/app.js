'use strict';
// ================= 유틸 =================
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) opt.body = body;
    else { opt.body = JSON.stringify(body); opt.headers['content-type'] = 'application/json'; }
  }
  const r = await fetch(url, opt);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || data || `HTTP ${r.status}`);
  return data;
}
const enc = encodeURIComponent;
function toast(msg, err) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  $('#toast').append(t);
  setTimeout(() => t.remove(), err ? 4500 : 2200);
}
function fail(e) { console.error(e); toast(e.message || String(e), true); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function inlineMd(s) {
  s = escapeHtml(s);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em class="act">$2</em>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/^#{1,6} (.+)$/gm, '<strong>$1</strong>');
  return s.replace(/\n/g, '<br>');
}
function md(src) {
  return String(src || '')
    .split('```')
    .map((p, i) => (i % 2 ? `<pre><code>${escapeHtml(p.replace(/^[\w+-]*\n/, ''))}</code></pre>` : inlineMd(p)))
    .join('');
}
function timeAgo(ts) {
  if (!ts) return '';
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return '방금';
  if (d < 3600) return `${Math.floor(d / 60)}분`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}일`;
  const t = new Date(ts);
  return `${t.getMonth() + 1}/${t.getDate()}`;
}
function fmtTime(ts) {
  const t = new Date(ts);
  return `${t.getFullYear()}.${t.getMonth() + 1}.${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}
function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
const ls = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ================= 상태 =================
const S = {
  st: null, // 서버 상태 (settings, keys, models, personas, projects, ...)
  project: null,
  chat: null,
  streaming: null,
  error: null,
  collapsed: ls.get('collapsed', {}),
  search: '',
  searchResults: [],
};

async function loadState() {
  S.st = await api('GET', '/api/state');
  applyTheme();
}
function hasLLM() { return Object.keys(S.st.keys).some((id) => S.st.providers[id]); }
function personaById(id) { return S.st.personas.find((p) => p.id === id) || null; }
function currentPersona() {
  return (S.chat && personaById(S.chat.personaId)) || personaById(S.st.settings.defaultPersona) || S.st.personas[0] || null;
}
function parseModel(s) { const i = String(s || '').indexOf('::'); return i > 0 ? { provider: s.slice(0, i), model: s.slice(i + 2) } : null; }
function currentModel() { return (S.chat && S.chat.model) || S.st.settings.defaultModel || S.st.fallbackModel || ''; }
function modelLabel(id) {
  const pm = parseModel(id);
  if (!pm) return { prov: '', name: '모델 선택' };
  const prov = (S.st.providers[pm.provider] || {}).label || pm.provider;
  const m = (S.st.models[pm.provider] || []).find((x) => x.id === pm.model);
  return { prov, name: (m && m.name) || pm.model };
}
function imgUrl(p, file) { return `/files/personas/${enc(p.id)}/images/${enc(file)}`; }
function pickImage(p, code) {
  if (!p || !p.images || !p.images.length) return null;
  const c = String(code || '').toLowerCase();
  return (c && p.images.find((i) => i.code.toLowerCase() === c)) || p.images.find((i) => i.code === 'default') || p.images[0];
}
function faceEl(p, code, cls = 'face') {
  const im = pickImage(p, code);
  if (im) {
    const src = imgUrl(p, im.file);
    return h('img', { class: cls, src, alt: im.code, title: im.desc || im.code, onclick: () => lightbox(src) });
  }
  return h('div', { class: cls + ' letter' }, ((p && p.name) || '?').slice(0, 1));
}
function lightbox(src) {
  const lb = h('div', { class: 'lightbox', onclick: () => lb.remove() }, h('img', { src }));
  document.body.append(lb);
}

// ================= 테마 =================
function contrastColor(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return '#fff';
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.6 ? '#111' : '#fff';
}
function applyTheme() {
  const s = S.st.settings;
  const root = document.documentElement;
  root.dataset.theme = s.theme === 'dark' ? 'dark' : 'light';
  root.style.setProperty('--accent', s.accent || '#6366f1');
  root.style.setProperty('--accent-fg', contrastColor(s.accent || '#6366f1'));
  const main = $('#main');
  if (s.background) {
    main.style.backgroundImage = `url("/files/assets/${enc(s.background)}")`;
    main.classList.add('has-bg');
  } else {
    main.style.backgroundImage = '';
    main.classList.remove('has-bg');
  }
}

// ================= 메뉴 / 모달 =================
let openMenuEl = null;
function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; } }
function popup(anchor, content, { align = 'left', width } = {}) {
  closeMenu();
  const m = h('div', { class: 'menu' }, content);
  if (width) m.style.width = width + 'px';
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth;
  let left = align === 'right' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = r.bottom + 6;
  if (top + m.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - m.offsetHeight - 6);
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  openMenuEl = m;
  setTimeout(() => {
    const close = (e) => { if (!m.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', close); } };
    document.addEventListener('mousedown', close);
  });
  return m;
}
function menu(anchor, items, opts) {
  return popup(
    anchor,
    items.map((it) =>
      it === '-' ? h('div', { class: 'menu-sep' })
        : h('button', { class: 'menu-item' + (it.danger ? ' danger' : '') + (it.active ? ' active' : ''), onclick: () => { closeMenu(); it.onClick(); } }, it.icon || null, it.label)
    ),
    opts
  );
}
function modal(title, body, { wide = false, foot = null, onClose } = {}) {
  const wrap = h('div', { class: 'modal-wrap' });
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = (e) => { if (e.key === 'Escape' && !openMenuEl && wrap === $('#modal-root').lastElementChild) close(); };
  document.addEventListener('keydown', onKey);
  const box = h('div', { class: 'modal' + (wide ? ' wide' : '') },
    h('div', { class: 'modal-head' }, h('h3', null, title), h('button', { class: 'icon-btn', title: '닫기', onclick: close }, '✕')),
    h('div', { class: 'modal-body', style: wide ? { padding: 0 } : null }, body),
    foot ? h('div', { class: 'modal-foot' }, foot) : null
  );
  wrap.append(box);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap._down = true; });
  wrap.addEventListener('click', (e) => { if (e.target === wrap && wrap._down) close(); wrap._down = false; });
  $('#modal-root').append(wrap);
  return { close, box };
}
function ask(title, value = '', { placeholder = '', okText = '확인' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'field', value, placeholder });
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) finish(input.value.trim()); });
    const m = modal(title, input, {
      foot: [h('button', { class: 'btn', onclick: () => finish(null) }, '취소'), h('button', { class: 'btn primary', onclick: () => finish(input.value.trim()) }, okText)],
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}
function confirmBox(text, { okText = '삭제', danger = true } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal('확인', h('div', null, text), {
      foot: [h('button', { class: 'btn', onclick: () => finish(false) }, '취소'), h('button', { class: 'btn ' + (danger ? 'primary' : 'primary'), style: danger ? { background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' } : null, onclick: () => finish(true) }, okText)],
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
  });
}

// ================= 사이드바 =================
function renderSidebar() {
  const nav = $('#project-list');
  nav.innerHTML = '';
  if (S.search) {
    if (!S.searchResults.length) nav.append(h('div', { class: 'empty-chats', style: { paddingLeft: '10px' } }, '검색 결과가 없습니다.'));
    for (const r of S.searchResults) {
      nav.append(
        h('div', { class: 'search-result', onclick: () => { openChat(r.project, r.id); closeSidebarMobile(); } },
          h('div', { class: 't' }, r.title),
          r.snippet ? h('div', { class: 's' }, r.snippet) : null,
          h('div', { class: 'p' }, r.project))
      );
    }
    return;
  }
  for (const p of S.st.projects) {
    const collapsed = !!S.collapsed[p.name];
    const head = h('div', { class: 'proj-head', onclick: (e) => {
      if (e.target.closest('.more')) return;
      S.collapsed[p.name] = !collapsed; ls.set('collapsed', S.collapsed); renderSidebar();
    } },
      h('span', { class: 'caret' }, '▼'), h('span', { class: 'name' }, p.name),
      h('button', { class: 'more', title: '프로젝트 메뉴', onclick: (e) => projectMenu(e.currentTarget, p) }, '⋯'));
    const chats = h('div', { class: 'proj-chats' });
    if (!p.chats.length) chats.append(h('div', { class: 'empty-chats' }, '채팅 없음'));
    for (const c of p.chats) {
      const active = S.chat && S.chat.id === c.id && S.project === p.name;
      chats.append(
        h('div', { class: 'chat-item' + (active ? ' active' : ''), onclick: (e) => { if (e.target.closest('.more')) return; openChat(p.name, c.id); closeSidebarMobile(); } },
          h('span', { class: 'title' }, c.title || '새 채팅'),
          h('span', { class: 'time' }, timeAgo(c.updated)),
          h('button', { class: 'more', title: '채팅 메뉴', onclick: (e) => chatMenu(e.currentTarget, p.name, c) }, '⋯'))
      );
    }
    nav.append(h('div', { class: 'proj' + (collapsed ? ' collapsed' : '') }, head, chats));
  }
  nav.append(h('button', { class: 'add-proj', onclick: newProject }, '＋ 새 프로젝트'));
}
async function refreshProjects() {
  S.st.projects = await api('GET', '/api/projects');
  renderSidebar();
}
async function newProject() {
  const name = await ask('새 프로젝트', '', { placeholder: '프로젝트 이름' });
  if (!name) return;
  try {
    S.st.projects = await api('POST', '/api/projects', { name });
    renderSidebar();
    await newChat(name);
  } catch (e) { fail(e); }
}
function projectMenu(anchor, p) {
  menu(anchor, [
    { label: '새 채팅', onClick: () => newChat(p.name) },
    { label: '이름 변경', onClick: async () => {
      const name = await ask('프로젝트 이름 변경', p.name);
      if (!name || name === p.name) return;
      try {
        const r = await api('PATCH', `/api/projects/${enc(p.name)}`, { name });
        if (S.project === p.name) { S.project = r.name; saveLast(); }
        S.st.projects = r.projects; renderSidebar();
      } catch (e) { fail(e); }
    } },
    '-',
    { label: '프로젝트 삭제', danger: true, onClick: async () => {
      if (!(await confirmBox(`'${p.name}' 프로젝트와 안의 채팅 ${p.chats.length}개를 모두 삭제할까요?`))) return;
      try {
        S.st.projects = await api('DELETE', `/api/projects/${enc(p.name)}`);
        if (S.project === p.name) { S.chat = null; S.project = null; openFirstOrNew(); }
        renderSidebar();
      } catch (e) { fail(e); }
    } },
  ]);
}
function chatMenu(anchor, project, c) {
  menu(anchor, [
    { label: '이름 변경', onClick: () => renameChat(project, c.id, c.title) },
    { label: '다른 프로젝트로 이동', onClick: async () => {
      const others = S.st.projects.filter((p) => p.name !== project);
      if (!others.length) return toast('다른 프로젝트가 없습니다.');
      menu(anchor, others.map((p) => ({ label: p.name, onClick: async () => {
        try {
          await api('PATCH', `/api/chats/${enc(project)}/${c.id}`, { moveTo: p.name });
          if (S.chat && S.chat.id === c.id) { S.project = p.name; saveLast(); }
          await refreshProjects();
        } catch (e) { fail(e); }
      } })));
    } },
    '-',
    { label: '삭제', danger: true, onClick: async () => {
      if (!(await confirmBox(`'${c.title}' 채팅을 삭제할까요?`))) return;
      try {
        await api('DELETE', `/api/chats/${enc(project)}/${c.id}`);
        if (S.chat && S.chat.id === c.id) { S.chat = null; await refreshProjects(); openFirstOrNew(); }
        else await refreshProjects();
      } catch (e) { fail(e); }
    } },
  ]);
}
async function renameChat(project, id, title) {
  const t = await ask('채팅 이름 변경', title);
  if (!t) return;
  try {
    const c = await api('PATCH', `/api/chats/${enc(project)}/${id}`, { title: t });
    if (S.chat && S.chat.id === id) { S.chat.title = c.title; renderTopbar(); }
    await refreshProjects();
  } catch (e) { fail(e); }
}
function closeSidebarMobile() { $('#app').classList.remove('side-open'); }

// ================= 채팅 열기 / 만들기 =================
function saveLast() { ls.set('last', S.chat ? { project: S.project, id: S.chat.id } : null); }
async function openChat(project, id) {
  if (S.streaming) return toast('응답이 끝난 뒤에 이동할 수 있어요.');
  try {
    S.chat = await api('GET', `/api/chats/${enc(project)}/${id}`);
    S.project = project;
    S.error = null;
    saveLast();
    renderAll();
    $('#input').focus();
  } catch (e) {
    S.chat = null;
    fail(e);
  }
}
async function newChat(project) {
  if (S.streaming) return;
  project = project || S.project || (S.st.projects[0] && S.st.projects[0].name) || '기본';
  // 현재 채팅이 비어 있으면 재사용
  if (S.chat && S.project === project && !S.chat.messages.length) { $('#input').focus(); return; }
  try {
    const persona = currentPersona();
    S.chat = await api('POST', `/api/chats/${enc(project)}`, { personaId: persona && persona.id, model: currentModel() });
    S.project = project;
    S.error = null;
    if (S.collapsed[project]) { delete S.collapsed[project]; ls.set('collapsed', S.collapsed); }
    saveLast();
    await refreshProjects();
    renderAll();
    $('#input').focus();
  } catch (e) { fail(e); }
}
function openFirstOrNew() {
  const last = ls.get('last', null);
  const exists = (proj, id) => S.st.projects.some((p) => p.name === proj && p.chats.some((c) => c.id === id));
  if (last && exists(last.project, last.id)) return openChat(last.project, last.id);
  for (const p of S.st.projects) if (p.chats[0]) return openChat(p.name, p.chats[0].id);
  return newChat();
}

// ================= 상단바 =================
function renderTopbar() {
  $('#chat-title').textContent = S.chat ? S.chat.title : '';
  const p = currentPersona();
  const pp = $('#persona-pick');
  pp.innerHTML = '';
  pp.append(p ? faceEl(p, 'default', 'mini-face') : '', h('span', { class: 'lbl' }, p ? p.name : '페르소나'), h('span', { class: 'prov' }, '▾'));
  const ml = modelLabel(currentModel());
  const mp = $('#model-pick');
  mp.innerHTML = '';
  mp.append(h('span', { class: 'prov' }, ml.prov), h('span', { class: 'lbl' }, ml.name), h('span', { class: 'prov' }, '▾'));
}
async function updateChat(patch) {
  if (!S.chat) return;
  Object.assign(S.chat, patch);
  renderTopbar();
  renderMessages();
  try { await api('PATCH', `/api/chats/${enc(S.project)}/${S.chat.id}`, patch); } catch (e) { fail(e); }
}
function personaMenu(anchor) {
  const cur = currentPersona();
  menu(anchor, [
    ...S.st.personas.map((p) => ({ icon: faceEl(p, 'default', 'mini-face'), label: p.name, active: cur && cur.id === p.id, onClick: () => updateChat({ personaId: p.id }) })),
    '-',
    { label: '페르소나 관리…', onClick: () => openPersonas(cur && cur.id) },
  ], { align: 'right' });
}
function modelMenu(anchor) {
  const cur = currentModel();
  const input = h('input', { class: 'field', placeholder: '모델 검색 또는 ID 직접 입력', autocomplete: 'off' });
  const list = h('div');
  const choose = (id) => { closeMenu(); updateChat({ model: id }); };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    list.innerHTML = '';
    let count = 0;
    for (const [pid, prov] of Object.entries(S.st.providers)) {
      if (!S.st.keys[pid]) continue;
      const ms = (S.st.models[pid] || []).filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q) || prov.label.toLowerCase().includes(q));
      if (!ms.length) continue;
      list.append(h('div', { class: 'menu-group' }, prov.label));
      for (const m of ms.slice(0, q ? 200 : 60)) {
        const id = `${pid}::${m.id}`;
        count++;
        list.append(h('button', { class: 'menu-item' + (id === cur ? ' active' : ''), onclick: () => choose(id) }, m.name || m.id, m.name && m.name !== m.id ? h('span', { class: 'sub' }, m.id) : null));
      }
    }
    if (q && /^[\w.:\/-]+$/.test(q)) {
      list.append(h('div', { class: 'menu-group' }, '직접 입력'));
      for (const [pid, prov] of Object.entries(S.st.providers)) {
        if (!S.st.keys[pid]) continue;
        list.append(h('button', { class: 'menu-item', onclick: () => choose(`${pid}::${input.value.trim()}`) }, `${prov.label} · ${input.value.trim()}`));
      }
    } else if (!count) list.append(h('div', { class: 'hint', style: { padding: '8px 10px' } }, '연결된 모델이 없습니다.'));
    list.append(h('div', { class: 'menu-sep' }), h('button', { class: 'menu-item', onclick: () => { closeMenu(); openSettings('keys'); } }, 'API 키 / 모델 관리…'));
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { const b = list.querySelector('.menu-item'); if (b) b.click(); }
  });
  draw();
  popup(anchor, [input, list], { align: 'right', width: 340 });
  setTimeout(() => input.focus(), 20);
}

// ================= 메시지 =================
function parseSegments(text, streaming) {
  if (streaming) text = text.replace(/\[(?:i(?:m(?:g(?::[^\]\n]*)?)?)?)?$/, '');
  const re = /\[img:\s*([^\]\s]+)\s*\]/gi;
  const segs = [];
  let last = 0;
  let code = null;
  let m;
  while ((m = re.exec(text))) {
    const chunk = text.slice(last, m.index);
    if (chunk.trim()) segs.push({ code, text: chunk.trim() });
    code = m[1];
    last = re.lastIndex;
  }
  const tail = text.slice(last);
  if (tail.trim() || streaming || !segs.length) segs.push({ code, text: tail.trim() });
  return segs;
}
const TOOL_LABEL = {
  web_search: (i) => `🔍 ${i ? `'${i}' ` : ''}검색함`,
  rules_read: (i) => `📖 ${i} 읽음`,
  rules_write: (i) => `📝 ${i} 저장함`,
};
function msgEl(msg, { streaming = false, isLast = false } = {}) {
  if (msg.role === 'user') {
    return h('div', { class: 'msg user' },
      h('div', { class: 'bubble', html: md(msg.text), title: fmtTime(msg.ts) }),
      streaming ? null : h('div', { class: 'actions' },
        h('button', { onclick: () => copyText(msg.text) }, '복사'),
        h('button', { onclick: () => editResend(msg) }, '수정'),
        h('button', { onclick: () => deleteMsg(msg) }, '삭제')));
  }
  const p = personaById(msg.personaId) || currentPersona();
  const wrap = h('div', { class: 'msg ai' });
  wrap.append(h('div', { class: 'who' }, p ? p.name : 'AI'));
  if (msg.tools && msg.tools.length) {
    const seen = new Set();
    const chips = h('div', { class: 'chips' });
    for (const t of msg.tools) {
      const key = t.name + t.info;
      if (seen.has(key) || !TOOL_LABEL[t.name]) continue;
      seen.add(key);
      chips.append(h('span', { class: 'chip' }, TOOL_LABEL[t.name](t.info)));
    }
    if (chips.childNodes.length) wrap.append(chips);
  }
  const segs = parseSegments(msg.text || '', streaming);
  segs.forEach((s, i) => {
    const typing = streaming && i === segs.length - 1 && !s.text;
    wrap.append(h('div', { class: 'seg' },
      faceEl(p, s.code),
      h('div', { class: 'bubble', html: typing ? '<span class="typing"><i></i><i></i><i></i></span>' : md(s.text) })));
  });
  for (const n of msg.notices || []) wrap.append(h('div', { class: 'notice' }, '⚠ ' + n));
  if (msg.stopped) wrap.append(h('div', { class: 'notice' }, '⏹ 중지됨'));
  if (!streaming) {
    const ml = modelLabel(msg.servedModel ? `${(parseModel(msg.model) || {}).provider}::${msg.servedModel}` : msg.model);
    wrap.append(h('div', { class: 'actions' },
      h('button', { onclick: () => copyText(stripTags(msg.text)) }, '복사'),
      isLast ? h('button', { onclick: () => send(null, true) }, '다시 생성') : null,
      h('button', { onclick: () => deleteMsg(msg) }, '삭제'),
      h('span', { class: 'meta', title: fmtTime(msg.ts) }, `${ml.prov} · ${ml.name}`)));
  }
  return wrap;
}
function stripTags(t) { return String(t || '').replace(/\[img:[^\]]*\]\s*/gi, ''); }
function copyText(t) {
  navigator.clipboard.writeText(t).then(() => toast('복사했어요'), () => toast('복사 실패', true));
}
async function deleteMsg(msg) {
  if (S.streaming) return;
  try {
    S.chat = await api('DELETE', `/api/chats/${enc(S.project)}/${S.chat.id}/messages/${msg.id}`);
    renderMessages();
  } catch (e) { fail(e); }
}
async function editResend(msg) {
  if (S.streaming) return;
  const idx = S.chat.messages.findIndex((m) => m.id === msg.id);
  const after = S.chat.messages.length - idx - 1;
  if (after > 0 && !(await confirmBox('이 메시지 이후의 대화가 지워지고 입력창으로 돌아갑니다. 계속할까요?', { okText: '수정' }))) return;
  try {
    for (const m of S.chat.messages.slice(idx).reverse()) {
      S.chat = await api('DELETE', `/api/chats/${enc(S.project)}/${S.chat.id}/messages/${m.id}`);
    }
    renderMessages();
    const input = $('#input');
    input.value = msg.text;
    autosize();
    input.focus();
  } catch (e) { fail(e); }
}

function renderMessages() {
  const box = $('#messages');
  const area = $('#chat-area');
  const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 120;
  box.innerHTML = '';
  if (!S.chat) return;
  const msgs = S.chat.messages;
  if (!msgs.length && !S.streaming) {
    const p = currentPersona();
    const big = p && pickImage(p, 'default');
    box.append(h('div', { class: 'empty-state' },
      big ? h('img', { class: 'big-face', src: imgUrl(p, big.file), onclick: () => lightbox(imgUrl(p, big.file)) }) : h('div', { class: 'big-face letter' }, p ? p.name.slice(0, 1) : '?'),
      h('h2', null, p ? p.name : '대화 시작'),
      h('p', null, p ? p.description || '' : '')));
  }
  const lastAi = [...msgs].reverse().find((m) => m.role === 'assistant');
  for (const m of msgs) box.append(msgEl(m, { isLast: !S.streaming && m === lastAi && msgs[msgs.length - 1] === m }));
  if (S.streaming) {
    S.streaming.el = msgEl(S.streaming.msg, { streaming: true });
    box.append(S.streaming.el);
  }
  if (S.error) {
    box.append(h('div', { class: 'err-box' }, S.error, h('div', null, h('button', { class: 'btn small', onclick: () => send(null, true) }, '다시 시도'))));
  }
  if (nearBottom || S.streaming) area.scrollTop = area.scrollHeight;
}
let rafPending = false;
function renderStreaming() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (!S.streaming) return;
    const area = $('#chat-area');
    const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 160;
    const el = msgEl(S.streaming.msg, { streaming: true });
    if (S.streaming.el && S.streaming.el.parentNode) S.streaming.el.replaceWith(el);
    else $('#messages').append(el);
    S.streaming.el = el;
    if (nearBottom) area.scrollTop = area.scrollHeight;
  });
}

// ================= 전송 =================
function setSending(on) {
  const b = $('#send');
  b.classList.toggle('stop', on);
  b.textContent = on ? '■' : '↑';
  b.title = on ? '중지' : '보내기 (Enter)';
}
async function send(textArg, regenerate = false) {
  if (S.streaming) return;
  const input = $('#input');
  const text = regenerate ? '' : (textArg ?? input.value).trim();
  if (!regenerate && !text) return;
  if (!S.chat) await newChat();
  if (!S.chat) return;
  if (!regenerate) { input.value = ''; autosize(); }

  S.error = null;
  if (regenerate) {
    while (S.chat.messages.length && S.chat.messages[S.chat.messages.length - 1].role === 'assistant') S.chat.messages.pop();
  } else {
    S.chat.messages.push({ id: 'tmp', role: 'user', text, ts: Date.now() });
  }
  const persona = currentPersona();
  const ac = new AbortController();
  S.streaming = { ac, msg: { role: 'assistant', text: '', tools: [], notices: [], personaId: persona && persona.id, model: currentModel() } };
  setSending(true);
  renderMessages();

  let finalMsg = null;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: S.project, chatId: S.chat.id, text, regenerate }),
      signal: ac.signal,
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        const sm = S.streaming && S.streaming.msg;
        if (!sm) continue;
        if (ev.t === 'start') {
          if (ev.userMessage) { const tmp = S.chat.messages.find((m) => m.id === 'tmp'); if (tmp) Object.assign(tmp, ev.userMessage); }
          if (ev.chat) {
            const titleChanged = S.chat.title !== ev.chat.title;
            Object.assign(S.chat, { title: ev.chat.title, model: ev.chat.model, personaId: ev.chat.personaId });
            renderTopbar();
            refreshProjects().catch(() => {});
            if (titleChanged) renderTopbar();
          }
        } else if (ev.t === 'delta') { sm.text += ev.text; renderStreaming(); }
        else if (ev.t === 'set') { sm.text = ev.text; renderStreaming(); }
        else if (ev.t === 'tool') { sm.tools.push({ name: ev.name, info: ev.info }); renderStreaming(); }
        else if (ev.t === 'notice') { sm.notices.push(ev.text); renderStreaming(); }
        else if (ev.t === 'model') { sm.servedModel = ev.model; }
        else if (ev.t === 'error') { S.error = ev.error; }
        else if (ev.t === 'done') { finalMsg = ev.message; }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') S.error = e.message;
  }
  const aborted = ac.signal.aborted;
  S.streaming = null;
  setSending(false);
  if (aborted) {
    // 서버가 부분 응답을 저장할 시간을 잠깐 준 뒤 다시 불러옴
    setTimeout(async () => {
      try { S.chat = await api('GET', `/api/chats/${enc(S.project)}/${S.chat.id}`); renderMessages(); } catch {}
      refreshProjects().catch(() => {});
    }, 400);
  } else {
    if (finalMsg) S.chat.messages.push(finalMsg);
    S.chat.messages = S.chat.messages.filter((m) => m.id !== 'tmp');
    refreshProjects().catch(() => {});
  }
  renderMessages();
}
function stop() { if (S.streaming) S.streaming.ac.abort(); }
function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 220) + 'px';
}

// ================= 페르소나 관리 =================
function openPersonas(selectId) {
  let sel = selectId || (currentPersona() || {}).id;
  let dirty = false;
  const listEl = h('div', { class: 'split-list' });
  const mainEl = h('div', { class: 'split-main' });
  const m = modal('페르소나', h('div', { class: 'split' }, listEl, mainEl), {
    wide: true,
    onClose: () => { renderTopbar(); renderMessages(); },
  });

  const drawList = () => {
    listEl.innerHTML = '';
    listEl.append(h('button', { class: 'btn primary block', style: { marginBottom: '6px' }, onclick: createNew }, '＋ 새 페르소나'));
    for (const p of S.st.personas) {
      listEl.append(h('button', { class: 'list-item' + (p.id === sel ? ' active' : ''), onclick: async () => {
        if (dirty && !(await confirmBox('저장하지 않은 변경 사항이 있어요. 버릴까요?', { okText: '버리기' }))) return;
        sel = p.id; dirty = false; drawList(); drawForm();
      } }, faceEl(p, 'default', 'mini-face'), h('div', { class: 'grow' }, h('div', null, p.name), h('div', { class: 'sub' }, `${p.age ? p.age + ' · ' : ''}이미지 ${p.images.length}개`))));
    }
  };
  const createNew = async () => {
    const name = await ask('새 페르소나', '', { placeholder: '이름' });
    if (!name) return;
    try {
      const p = await api('POST', '/api/personas', { name });
      S.st.personas = await api('GET', '/api/personas');
      sel = p.id; dirty = false; drawList(); drawForm();
    } catch (e) { fail(e); }
  };
  const reloadPersonas = async () => { S.st.personas = await api('GET', '/api/personas'); };

  const drawForm = () => {
    mainEl.innerHTML = '';
    const p = personaById(sel);
    if (!p) { mainEl.append(h('div', { class: 'hint' }, '페르소나를 선택하세요.')); return; }
    const fields = {};
    const form = h('div', { class: 'p-form' });
    const fieldEl = (f) => {
      const single = f.key === 'name' || f.key === 'age';
      const el = single
        ? h('input', { class: 'field', value: p[f.key] || '' })
        : h('textarea', { class: 'field', rows: f.key === 'etc' || f.key === 'story' ? 5 : 3 }, p[f.key] || '');
      el.addEventListener('input', () => { dirty = true; });
      fields[f.key] = el;
      return [h('label', { class: 'lab' }, f.label, f.required ? h('span', { class: 'req' }, '*') : null), el];
    };
    const req = S.st.personaFields.filter((f) => f.required);
    const opt = S.st.personaFields.filter((f) => !f.required);
    form.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, fieldEl(req[0])), h('div', { style: { width: '140px' } }, fieldEl(req[1]))));
    for (const f of req.slice(2)) form.append(...fieldEl(f));
    const anyOpt = opt.some((f) => String(p[f.key] || '').trim());
    form.append(h('details', { open: anyOpt }, h('summary', null, '추가 설정 (선택)'), opt.map((f) => fieldEl(f))));

    // 이미지
    const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    const drop = h('div', { class: 'drop', onclick: () => fileInput.click() },
      h('div', null, '🖼️ 이미지를 끌어다 놓거나 클릭해서 추가'),
      h('div', { class: 'hint' }, '파일명이 코드가 됩니다 — joy.png → AI가 [img:joy] 로 사용. default.png 는 기본 이미지.'));
    const upload = async (files) => {
      for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        try { await api('POST', `/api/personas/${p.id}/images`, { filename: f.name, data: await fileToB64(f) }); } catch (e) { fail(e); }
      }
      await reloadPersonas(); drawList(); drawImages();
    };
    fileInput.addEventListener('change', () => upload([...fileInput.files]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); });
    const grid = h('div', { class: 'img-grid' });
    const drawImages = () => {
      const cur = personaById(sel);
      grid.innerHTML = '';
      for (const im of cur.images) {
        const codeIn = h('input', { class: 'field', value: im.code, title: '코드 (AI가 [img:코드] 로 사용)' });
        const descIn = h('textarea', { class: 'field', placeholder: '언제 보여줄지 (예: 기쁘거나 칭찬받았을 때)' }, im.desc);
        const patch = async (body) => {
          try { cur.images = await api('PATCH', `/api/personas/${cur.id}/images/${enc(im.file)}`, body); await reloadPersonas(); drawImages(); drawList(); }
          catch (e) { fail(e); codeIn.value = im.code; }
        };
        codeIn.addEventListener('change', () => { if (codeIn.value.trim() !== im.code) patch({ code: codeIn.value.trim() }); });
        descIn.addEventListener('change', () => patch({ desc: descIn.value }));
        grid.append(h('div', { class: 'img-card' },
          h('img', { src: imgUrl(cur, im.file) + `?v=${Date.now()}`, onclick: () => lightbox(imgUrl(cur, im.file)) }),
          h('div', { class: 'code' }, '[img:', codeIn, ']', im.code === 'default' ? h('span', { class: 'badge' }, '기본') : null),
          descIn,
          h('div', { class: 'tools' },
            im.code !== 'default' ? h('button', { class: 'btn small', onclick: () => patch({ code: 'default' }) }, '기본으로') : h('span'),
            h('button', { class: 'btn small danger', onclick: async () => {
              if (!(await confirmBox(`'${im.code}' 이미지를 삭제할까요?`))) return;
              try { await api('DELETE', `/api/personas/${cur.id}/images/${enc(im.file)}`); await reloadPersonas(); drawImages(); drawList(); } catch (e) { fail(e); }
            } }, '삭제'))));
      }
    };
    drawImages();
    form.append(h('label', { class: 'lab', style: { marginTop: '22px' } }, '감정 / 상황 이미지'), drop, fileInput, grid);

    const save = async () => {
      const data = {};
      for (const [k, el] of Object.entries(fields)) data[k] = el.value.trim();
      const missing = req.filter((f) => !data[f.key]).map((f) => f.label);
      if (missing.length) return toast(`필수 항목을 채워주세요: ${missing.join(', ')}`, true);
      try {
        await api('PUT', `/api/personas/${p.id}`, data);
        await reloadPersonas();
        dirty = false; drawList(); toast('저장했어요');
      } catch (e) { fail(e); }
    };
    form.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });
    form.append(h('div', { class: 'p-actions' },
      h('button', { class: 'btn primary', onclick: save }, '저장'),
      h('button', { class: 'btn', onclick: async () => {
        if (S.chat) { await updateChat({ personaId: p.id }); m.close(); }
      } }, '이 페르소나로 대화'),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn', onclick: async () => {
        try { const np = await api('POST', `/api/personas/${p.id}/duplicate`); await reloadPersonas(); sel = np.id; dirty = false; drawList(); drawForm(); toast('복제했어요'); } catch (e) { fail(e); }
      } }, '복제'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmBox(`'${p.name}' 페르소나와 이미지를 모두 삭제할까요?`))) return;
        try {
          S.st.personas = await api('DELETE', `/api/personas/${p.id}`);
          await loadState();
          sel = (S.st.personas[0] || {}).id; dirty = false; drawList(); drawForm();
        } catch (e) { fail(e); }
      } }, '삭제')));
    mainEl.append(form);
  };
  drawList();
  drawForm();
}

// ================= 지침 · 스킬 편집기 =================
async function openRules(selPath) {
  let files = [];
  let sel = selPath || null;
  let dirty = false;
  let original = '';
  const listEl = h('div', { class: 'split-list' });
  const mainEl = h('div', { class: 'split-main' });
  const confirmLeave = async () => !dirty || (await confirmBox('저장하지 않은 변경 사항이 있어요. 버릴까요?', { okText: '버리기' }));
  modal('지침 · 스킬', h('div', { class: 'split' }, listEl, mainEl), { wide: true });

  const load = async () => { files = await api('GET', '/api/rules'); };
  const drawList = () => {
    listEl.innerHTML = '';
    listEl.append(h('div', { class: 'row', style: { marginBottom: '4px' } },
      h('button', { class: 'btn small primary grow', onclick: () => createFile('instructions') }, '＋ 지침'),
      h('button', { class: 'btn small grow', onclick: () => createFile('skills') }, '＋ 스킬'),
      h('button', { class: 'btn small', title: '경로를 직접 입력해서 만들기', onclick: () => createFile('') }, '＋')));
    const groups = [['instructions', '지침 · 항상 적용'], ['memory', '기억 · 항상 적용'], ['skills', '스킬 · 필요할 때 로드']];
    const other = files.filter((f) => !groups.some(([g]) => f.startsWith(g + '/')));
    for (const [g, label] of groups) {
      listEl.append(h('div', { class: 'list-group' }, label));
      const fs = files.filter((f) => f.startsWith(g + '/'));
      if (!fs.length) listEl.append(h('div', { class: 'hint', style: { padding: '2px 10px' } }, '없음'));
      for (const f of fs) listEl.append(fileItem(f, f.slice(g.length + 1)));
    }
    if (other.length) {
      listEl.append(h('div', { class: 'list-group' }, '기타'));
      for (const f of other) listEl.append(fileItem(f, f));
    }
  };
  const fileItem = (f, label) => h('button', { class: 'list-item' + (f === sel ? ' active' : ''), onclick: async () => {
    if (f === sel || !(await confirmLeave())) return;
    sel = f; dirty = false; drawList(); drawEditor();
  } }, h('span', { class: 'grow', style: { wordBreak: 'break-all' } }, label));
  const createFile = async (kind) => {
    if (!(await confirmLeave())) return;
    let name = await ask(kind === 'skills' ? '새 스킬 이름' : kind === 'instructions' ? '새 지침 파일 이름' : '새 파일 경로 (Rule 폴더 기준)', '', {
      placeholder: kind === 'skills' ? '예: 일기-쓰기' : kind === 'instructions' ? '예: 호칭' : '예: instructions/게임/규칙.md',
    });
    if (!name) return;
    name = name.replace(/\.md$/i, '');
    let rel, content;
    if (kind === 'skills') {
      rel = `skills/${name}/SKILL.md`;
      content = `---\nname: ${name}\ndescription: 언제 이 스킬을 쓰는지 한 문장으로\n---\n# ${name}\n\n`;
    } else if (kind === 'instructions') {
      rel = `instructions/${name}.md`;
      content = `---\ntrigger: always_on\n---\n# ${name}\n\n- `;
    } else {
      rel = `${name}.md`;
      content = `# ${name.split('/').pop()}\n\n`;
    }
    if (files.includes(rel)) { sel = rel; dirty = false; drawList(); return drawEditor(); }
    try {
      files = await api('PUT', '/api/rules/file', { path: rel, content });
      sel = rel; dirty = false; drawList(); drawEditor();
    } catch (e) { fail(e); }
  };
  const drawEditor = async () => {
    mainEl.innerHTML = '';
    if (!sel) {
      mainEl.append(h('div', { class: 'hint', style: { lineHeight: 1.8 } },
        h('p', null, h('b', null, 'Rule 폴더'), '는 AI가 읽고 쓸 수 있는 유일한 폴더예요. 모든 프로젝트·페르소나에 전역으로 적용됩니다.'),
        h('p', null, '• ', h('b', null, 'instructions/'), ' — 지침. 채팅할 때마다 자동으로 읽어 시스템 프롬프트에 넣습니다.'),
        h('p', null, '• ', h('b', null, 'memory/'), ' — 기억. 지침처럼 항상 적용되며, AI가 대화 중에 직접 추가합니다.'),
        h('p', null, '• ', h('b', null, 'skills/<이름>/SKILL.md'), ' — 스킬. 평소엔 설명(description)만 넣고, 필요할 때 AI가 본문을 읽습니다.'),
        h('p', null, '지침 맨 위 frontmatter의 ', h('code', null, 'trigger'), ' 로 적용 방식을 바꿀 수 있어요: ', h('code', null, 'always_on'), '(기본) · ', h('code', null, 'model_decision'), '(설명만, 필요할 때 로드) · ', h('code', null, 'off'), '(사용 안 함)')));
      return;
    }
    let content = '';
    try { content = (await api('GET', `/api/rules/file?path=${enc(sel)}`)).content; } catch (e) { return fail(e); }
    original = content;
    const ta = h('textarea', { class: 'field', spellcheck: 'false' }, content);
    const dot = h('span', { class: 'dirty-dot' });
    const save = async () => {
      try { files = await api('PUT', '/api/rules/file', { path: sel, content: ta.value }); original = ta.value; dirty = false; dot.textContent = ''; toast('저장했어요'); } catch (e) { fail(e); }
    };
    ta.addEventListener('input', () => { dirty = ta.value !== original; dot.textContent = dirty ? ' ●' : ''; });
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
      if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
    });
    mainEl.append(h('div', { class: 'editor' },
      h('div', { class: 'row' }, h('span', { class: 'path grow' }, sel, dot),
        h('button', { class: 'btn small danger', onclick: async () => {
          if (!(await confirmBox(`'${sel}' 파일을 삭제할까요?`))) return;
          try { files = await api('DELETE', `/api/rules/file?path=${enc(sel)}`); sel = null; dirty = false; drawList(); drawEditor(); } catch (e) { fail(e); }
        } }, '삭제'),
        h('button', { class: 'btn small primary', onclick: save }, '저장 (Ctrl+S)')),
      ta));
    ta.focus();
  };
  await load();
  drawList();
  drawEditor();
}

// ================= 설정 =================
const ACCENTS = ['#6366f1', '#3b82f6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#111827'];
function openSettings(focus) {
  const body = h('div');
  const m = modal('설정', body, { onClose: () => { renderTopbar(); renderMessages(); } });
  m.box.style.maxWidth = '640px';
  const saveSettings = async (patch) => {
    try { S.st.settings = await api('PUT', '/api/settings', patch); applyTheme(); draw(); } catch (e) { fail(e); }
  };
  const draw = () => {
    const s = S.st.settings;
    body.innerHTML = '';

    // 화면
    const color = h('input', { type: 'color', value: s.accent, title: '직접 고르기' });
    color.addEventListener('change', () => saveSettings({ accent: color.value }));
    const bgInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
    bgInput.addEventListener('change', async () => {
      const f = bgInput.files[0];
      if (!f) return;
      try { S.st.settings = await api('POST', '/api/background', { filename: f.name, data: await fileToB64(f) }); applyTheme(); draw(); } catch (e) { fail(e); }
    });
    body.append(h('div', { class: 'set-sec' },
      h('h4', null, '화면'),
      h('div', { class: 'row', style: { marginBottom: '12px' } }, h('span', { style: { width: '90px' } }, '테마'),
        h('div', { class: 'seg-ctl' },
          h('button', { class: s.theme !== 'dark' ? 'on' : '', onclick: () => saveSettings({ theme: 'light' }) }, '☀️ 라이트'),
          h('button', { class: s.theme === 'dark' ? 'on' : '', onclick: () => saveSettings({ theme: 'dark' }) }, '🌙 다크'))),
      h('div', { class: 'row', style: { marginBottom: '12px' } }, h('span', { style: { width: '90px' } }, '포인트 색'),
        h('div', { class: 'swatches' }, ACCENTS.map((c) => h('button', { class: 'swatch' + (c === s.accent ? ' on' : ''), style: { background: c }, title: c, onclick: () => saveSettings({ accent: c }) })), color)),
      h('div', { class: 'row' }, h('span', { style: { width: '90px' } }, '채팅 배경'),
        s.background ? h('img', { class: 'bg-thumb', src: `/files/assets/${enc(s.background)}` }) : h('div', { class: 'bg-thumb' }),
        h('button', { class: 'btn small', onclick: () => bgInput.click() }, '이미지 선택'),
        s.background ? h('button', { class: 'btn small danger', onclick: async () => { S.st.settings = await api('DELETE', '/api/background'); applyTheme(); draw(); } }, '제거') : null,
        bgInput)));

    // 기본값
    const nameIn = h('input', { class: 'field', value: s.userName, placeholder: '캐릭터가 부를 내 이름 (선택)' });
    nameIn.addEventListener('change', () => saveSettings({ userName: nameIn.value.trim() }));
    const modelSel = h('select', { class: 'field' }, h('option', { value: '' }, '(자동)'));
    for (const [pid, prov] of Object.entries(S.st.providers)) {
      if (!S.st.keys[pid]) continue;
      const g = h('optgroup', { label: prov.label });
      for (const mm of S.st.models[pid] || []) g.append(h('option', { value: `${pid}::${mm.id}`, selected: s.defaultModel === `${pid}::${mm.id}` }, mm.name || mm.id));
      modelSel.append(g);
    }
    modelSel.addEventListener('change', () => saveSettings({ defaultModel: modelSel.value }));
    const perSel = h('select', { class: 'field' }, S.st.personas.map((p) => h('option', { value: p.id, selected: s.defaultPersona === p.id }, p.name)));
    perSel.addEventListener('change', () => saveSettings({ defaultPersona: perSel.value }));
    body.append(h('div', { class: 'set-sec' },
      h('h4', null, '기본값'),
      h('label', { class: 'lab' }, '내 이름'), nameIn,
      h('label', { class: 'lab' }, '기본 모델 (새 채팅)'), modelSel,
      h('label', { class: 'lab' }, '기본 페르소나 (새 채팅)'), perSel));

    // API 키
    const keySec = h('div', { class: 'set-sec', id: 'keys-sec' }, h('h4', null, 'API 키'));
    const keyRow = (pid, label, url, isSearch) => {
      const k = S.st.keys[pid];
      const count = (S.st.models[pid] || []).length;
      const row = h('div', { class: 'key-row' }, h('span', { class: 'nm' }, label));
      if (k) {
        row.append(
          h('span', { class: 'st ok grow' }, `● 연결됨 ${k.hint}${isSearch ? '' : ` · 모델 ${count}개`}`),
          h('button', { class: 'btn small danger', onclick: async () => {
            if (!(await confirmBox(`${label} 키를 삭제할까요?`))) return;
            try { S.st = await api('DELETE', `/api/keys/${pid}`); draw(); renderAll(); } catch (e) { fail(e); }
          } }, '삭제'));
      } else {
        const inp = h('input', { class: 'field', type: 'password', placeholder: 'API 키 붙여넣기', autocomplete: 'off' });
        const btn = h('button', { class: 'btn small primary', onclick: async () => {
          if (!inp.value.trim()) return;
          btn.disabled = true; btn.textContent = '확인 중…';
          try { S.st = await api('POST', '/api/keys', { provider: pid, key: inp.value.trim() }); applyTheme(); toast(`${label} 연결됨`); draw(); renderAll(); }
          catch (e) { fail(e); btn.disabled = false; btn.textContent = '연결'; }
        } }, '연결');
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
        row.append(inp, btn, h('a', { href: url, target: '_blank', rel: 'noopener', class: 'hint' }, '발급'));
      }
      return row;
    };
    for (const [pid, prov] of Object.entries(S.st.providers)) keySec.append(keyRow(pid, prov.label, prov.keyUrl));
    const refreshBtn = h('button', { class: 'btn small', onclick: async () => {
      refreshBtn.disabled = true; refreshBtn.textContent = '불러오는 중…';
      try {
        const r = await api('POST', '/api/models/refresh');
        S.st = r;
        (r.errors || []).forEach((e) => toast(e, true));
        toast('모델 목록을 새로 불러왔어요'); draw(); renderAll();
      } catch (e) { fail(e); refreshBtn.disabled = false; }
    } }, '모델 목록 새로고침');
    keySec.append(h('div', { class: 'row', style: { marginTop: '10px' } }, refreshBtn,
      h('span', { class: 'hint grow' }, '키는 data/keys.json 에 저장되고 이 PC의 앱에서만 각 제공사로 직접 전송됩니다.')));
    keySec.append(h('h4', { style: { marginTop: '22px' } }, '외부 검색 (선택)'),
      h('div', { class: 'hint', style: { marginBottom: '6px' } }, '내장 검색이 없는 모델(DeepSeek 등)이나 내장 검색이 막힌 경우에 사용합니다. 없으면 DuckDuckGo로 대체(불안정).'));
    for (const [pid, sp] of Object.entries(S.st.searchProviders)) keySec.append(keyRow(pid, sp.label, sp.keyUrl, true));
    body.append(keySec);

    // 데이터
    const withKeys = h('input', { type: 'checkbox' });
    const importInput = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
    importInput.addEventListener('change', async () => {
      const f = importInput.files[0];
      if (!f) return;
      if (!(await confirmBox('현재 데이터를 가져온 데이터로 바꿉니다. (현재 데이터는 data_backup_… 폴더로 보관됩니다) 계속할까요?', { okText: '가져오기' }))) return;
      try {
        const r = await fetch('/api/import', { method: 'POST', body: f });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        toast('가져왔어요. 다시 불러옵니다…');
        setTimeout(() => location.reload(), 700);
      } catch (e) { fail(e); }
    });
    body.append(h('div', { class: 'set-sec' },
      h('h4', null, '데이터'),
      h('div', { class: 'hint', style: { marginBottom: '10px', wordBreak: 'break-all' } }, '모든 데이터 위치: ', h('code', null, S.st.dataDir), h('br'), '이 폴더를 통째로 복사하면 다른 PC에서 그대로 이어서 쓸 수 있어요.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { location.href = `/api/export?keys=${withKeys.checked ? 1 : 0}`; } }, '⬇ 전체 내보내기 (zip)'),
        h('label', { class: 'row hint', style: { gap: '4px' } }, withKeys, 'API 키 포함'),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn', onclick: () => importInput.click() }, '⬆ 가져오기'), importInput)));

    if (focus === 'keys') { setTimeout(() => keySec.scrollIntoView({ block: 'start' }), 30); focus = null; }
  };
  draw();
}

// ================= 온보딩 =================
function renderOnboarding() {
  const el = $('#onboarding');
  if (hasLLM()) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '';
  let sel = 'anthropic';
  const card = h('div', { class: 'card' });
  const grid = h('div', { class: 'prov-grid' });
  const draw = () => {
    grid.innerHTML = '';
    for (const [pid, p] of Object.entries(S.st.providers)) {
      grid.append(h('button', { class: 'prov-btn' + (pid === sel ? ' on' : ''), onclick: () => { sel = pid; draw(); } }, p.label));
    }
    const p = S.st.providers[sel];
    card.innerHTML = '';
    const inp = h('input', { class: 'field', type: 'password', placeholder: `${p.label} API 키`, autocomplete: 'off' });
    const btn = h('button', { class: 'btn primary', onclick: async () => {
      if (!inp.value.trim()) return inp.focus();
      btn.disabled = true; btn.textContent = '확인 중…';
      try {
        S.st = await api('POST', '/api/keys', { provider: sel, key: inp.value.trim() });
        applyTheme();
        toast(`${p.label} 연결됨!`);
        renderOnboarding();
        if (S.chat && !S.chat.model) await updateChat({ model: S.st.settings.defaultModel });
        renderAll();
      } catch (e) { fail(e); btn.disabled = false; btn.textContent = '연결'; }
    } }, '연결');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
    card.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, inp), btn),
      h('div', { class: 'hint', style: { marginTop: '10px' } }, '키 발급: ', h('a', { href: p.keyUrl, target: '_blank', rel: 'noopener' }, p.keyUrl), h('br'),
        '키를 넣으면 해당 제공사의 모델 목록을 자동으로 불러옵니다. 나중에 설정에서 더 추가할 수 있어요.'));
    setTimeout(() => inp.focus(), 30);
  };
  draw();
  el.append(h('div', { class: 'onb' },
    h('img', { class: 'logo', src: '/icon.svg', alt: '' }),
    h('h1', null, 'API 키를 연결하세요'),
    h('p', null, '사용할 AI 제공사를 고르고 API 키를 하나 이상 연결하면 바로 대화할 수 있어요.'),
    grid, card));
}

// ================= 전체 렌더 / 이벤트 =================
function renderAll() {
  renderSidebar();
  renderTopbar();
  renderMessages();
  renderOnboarding();
}

function bind() {
  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (!S.streaming) send();
    }
  });
  $('#send').addEventListener('click', () => (S.streaming ? stop() : send()));
  $('#new-chat').addEventListener('click', () => { newChat(); closeSidebarMobile(); });
  $('#persona-pick').addEventListener('click', (e) => personaMenu(e.currentTarget));
  $('#model-pick').addEventListener('click', (e) => modelMenu(e.currentTarget));
  $('#chat-title').addEventListener('click', () => S.chat && renameChat(S.project, S.chat.id, S.chat.title));
  $('#open-personas').addEventListener('click', () => { closeSidebarMobile(); openPersonas(); });
  $('#open-rules').addEventListener('click', () => { closeSidebarMobile(); openRules(); });
  $('#open-settings').addEventListener('click', () => { closeSidebarMobile(); openSettings(); });
  $('#side-open').addEventListener('click', () => $('#app').classList.add('side-open'));
  $('#side-close').addEventListener('click', closeSidebarMobile);
  $('#side-overlay').addEventListener('click', closeSidebarMobile);
  let t = null;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(t);
    const q = e.target.value.trim();
    t = setTimeout(async () => {
      S.search = q;
      S.searchResults = q ? await api('GET', `/api/search?q=${enc(q)}`).catch(() => []) : [];
      renderSidebar();
    }, 200);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenuEl) closeMenu();
    if (e.key === 'Escape' && S.streaming && !$('#modal-root').children.length) stop();
  });
  window.addEventListener('resize', closeMenu);
}

(async function init() {
  bind();
  try {
    await loadState();
  } catch (e) {
    document.body.innerHTML = `<p style="padding:40px">서버에 연결할 수 없습니다. 실행 창이 켜져 있는지 확인하세요.<br>${escapeHtml(e.message)}</p>`;
    return;
  }
  renderAll();
  await openFirstOrNew();
})();
