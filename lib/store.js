// 모든 데이터는 data/ 폴더 하나에 파일로 저장된다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const defaults = require('./defaults');

const ROOT = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const P = {
  root: ROOT,
  rules: path.join(ROOT, 'rules'),
  personas: path.join(ROOT, 'personas'),
  projects: path.join(ROOT, 'projects'),
  assets: path.join(ROOT, 'assets'),
  settings: path.join(ROOT, 'settings.json'),
  keys: path.join(ROOT, 'keys.json'),
  models: path.join(ROOT, 'models.json'),
};

const DEFAULT_PROJECT = '기본';
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

// ---------- 공통 ----------
function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function writeJSON(file, obj) { writeFileAtomic(file, JSON.stringify(obj, null, 2)); }
function uid(prefix) { return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
function safeName(name) {
  const s = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/^\.+/, '').trim().slice(0, 60);
  return s;
}
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function walk(dir, base = dir) {
  let out = [];
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    if (it.name.startsWith('.')) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) out = out.concat(walk(full, base));
    else if (it.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// ---------- 초기화 ----------
function ensureData() {
  const fresh = !fs.existsSync(P.rules);
  for (const d of [P.root, P.personas, P.projects, P.assets]) fs.mkdirSync(d, { recursive: true });
  if (fresh) {
    for (const [rel, content] of Object.entries(defaults.RULE_FILES)) {
      const f = path.join(P.rules, rel);
      if (!fs.existsSync(f)) writeFileAtomic(f, content);
    }
  }
  if (!fs.existsSync(P.settings)) writeJSON(P.settings, defaults.SETTINGS);
  if (!fs.existsSync(P.keys)) writeJSON(P.keys, {});
  if (!fs.readdirSync(P.personas).some((n) => !n.startsWith('.'))) {
    const id = 'p-haru';
    savePersona(id, defaults.PERSONA);
    const s = getSettings();
    if (!s.defaultPersona) setSettings({ defaultPersona: id });
  }
  fs.mkdirSync(path.join(P.projects, DEFAULT_PROJECT, 'chats'), { recursive: true });
}

// ---------- 설정 / 키 / 모델 ----------
function getSettings() { return { ...defaults.SETTINGS, ...readJSON(P.settings, {}) }; }
function setSettings(patch) {
  const s = { ...getSettings(), ...patch };
  writeJSON(P.settings, s);
  return s;
}
function getKeys() { return readJSON(P.keys, {}); }
function setKey(provider, entry) {
  const k = getKeys();
  if (entry) k[provider] = entry; else delete k[provider];
  writeJSON(P.keys, k);
}
function getModels() { return readJSON(P.models, {}); }
function setModels(provider, list) {
  const m = getModels();
  if (list) m[provider] = list; else delete m[provider];
  writeJSON(P.models, m);
}

// ---------- 페르소나 ----------
const PERSONA_FIELDS = defaults.PERSONA_FIELDS;
const LABEL_TO_KEY = Object.fromEntries(PERSONA_FIELDS.map((f) => [f.label, f.key]));

function personaToMd(p) {
  let md = `# ${p.name || '이름 없음'}\n\n`;
  for (const f of PERSONA_FIELDS) {
    const v = String(p[f.key] || '').trim();
    if (!v && !f.required) continue;
    md += `## ${f.label}\n${v}\n\n`;
  }
  return md;
}
function mdToPersona(md) {
  const p = {};
  const parts = md.split(/^## (.+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const label = parts[i].trim();
    const val = (parts[i + 1] || '').trim();
    const key = LABEL_TO_KEY[label];
    if (key) p[key] = val;
    else if (val) p.etc = `${p.etc ? p.etc + '\n\n' : ''}### ${label}\n${val}`;
  }
  if (!p.name) {
    const m = md.match(/^# (.+)$/m);
    if (m) p.name = m[1].trim();
  }
  return p;
}
function personaDir(id) {
  if (!/^[\w-]+$/.test(id || '')) throw new Error('잘못된 페르소나 ID');
  return path.join(P.personas, id);
}
function readImageMeta(id) { return readJSON(path.join(personaDir(id), 'images', 'images.json'), {}); }
function listImages(id) {
  const dir = path.join(personaDir(id), 'images');
  const meta = readImageMeta(id);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => IMG_EXT.test(f)); } catch {}
  return files
    .map((file) => {
      const code = file.replace(IMG_EXT, '');
      return { code, file, desc: (meta[file] && meta[file].desc) || '' };
    })
    .sort((a, b) => (a.code === 'default' ? -1 : b.code === 'default' ? 1 : a.code.localeCompare(b.code)));
}
function getPersona(id) {
  try {
    const md = fs.readFileSync(path.join(personaDir(id), 'persona.md'), 'utf8');
    return { id, ...mdToPersona(md), images: listImages(id) };
  } catch { return null; }
}
function listPersonas() {
  let ids = [];
  try { ids = fs.readdirSync(P.personas).filter((n) => !n.startsWith('.')); } catch {}
  return ids
    .map((id) => getPersona(id))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}
function savePersona(id, data) {
  const dir = personaDir(id);
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  const clean = {};
  for (const f of PERSONA_FIELDS) clean[f.key] = String(data[f.key] || '').trim();
  writeFileAtomic(path.join(dir, 'persona.md'), personaToMd(clean));
  return getPersona(id);
}
function createPersona(data) { return savePersona(uid('p-'), data); }
function deletePersona(id) { fs.rmSync(personaDir(id), { recursive: true, force: true }); }
function duplicatePersona(id) {
  const src = personaDir(id);
  const nid = uid('p-');
  fs.cpSync(src, personaDir(nid), { recursive: true });
  const p = getPersona(nid);
  return savePersona(nid, { ...p, name: `${p.name} (복사본)` });
}
function imageCode(s) { return String(s || '').trim().replace(/[^\w가-힣-]/g, '').slice(0, 40); }
function saveImage(id, filename, buf, desc) {
  const dir = path.join(personaDir(id), 'images');
  fs.mkdirSync(dir, { recursive: true });
  const ext = (path.extname(filename) || '.png').toLowerCase();
  if (!IMG_EXT.test(ext)) throw new Error('이미지 파일만 올릴 수 있습니다.');
  let code = imageCode(path.basename(filename, path.extname(filename))) || 'img';
  // 같은 코드가 있으면 덮어쓰기 (다른 확장자 파일 제거)
  for (const im of listImages(id)) if (im.code === code) fs.rmSync(path.join(dir, im.file), { force: true });
  const file = code + ext;
  fs.writeFileSync(path.join(dir, file), buf);
  if (desc !== undefined) updateImage(id, file, { desc });
  return listImages(id);
}
function updateImage(id, file, { code, desc }) {
  const dir = path.join(personaDir(id), 'images');
  const meta = readImageMeta(id);
  if (!IMG_EXT.test(file) || !fs.existsSync(path.join(dir, path.basename(file)))) throw new Error('이미지를 찾을 수 없습니다.');
  file = path.basename(file);
  let cur = file;
  if (code !== undefined) {
    const nc = imageCode(code);
    if (!nc) throw new Error('코드는 영문/숫자/한글/-/_ 만 가능합니다.');
    const nf = nc + path.extname(file).toLowerCase();
    if (nf !== file) {
      const clash = listImages(id).find((im) => im.code === nc);
      if (clash && nc !== 'default') throw new Error(`'${nc}' 코드가 이미 있습니다.`);
      if (clash) {
        // 기본 이미지 교체: 기존 default 는 바뀌는 이미지의 원래 코드를 물려받음
        const oldCode = file.replace(IMG_EXT, '');
        const swapped = oldCode + path.extname(clash.file).toLowerCase();
        const tmp = `${clash.file}.swap`;
        fs.renameSync(path.join(dir, clash.file), path.join(dir, tmp));
        fs.renameSync(path.join(dir, file), path.join(dir, nf));
        fs.renameSync(path.join(dir, tmp), path.join(dir, swapped));
        const mOld = meta[clash.file] || {};
        const mNew = meta[file] || {};
        delete meta[clash.file];
        delete meta[file];
        meta[nf] = mNew;
        meta[swapped] = mOld;
        cur = nf;
        if (desc !== undefined) meta[cur] = { ...(meta[cur] || {}), desc: String(desc) };
        writeJSON(path.join(dir, 'images.json'), meta);
        return listImages(id);
      }
      fs.renameSync(path.join(dir, file), path.join(dir, nf));
      meta[nf] = meta[file] || {};
      delete meta[file];
      cur = nf;
    }
  }
  if (desc !== undefined) meta[cur] = { ...(meta[cur] || {}), desc: String(desc) };
  writeJSON(path.join(dir, 'images.json'), meta);
  return listImages(id);
}
function deleteImage(id, file) {
  const dir = path.join(personaDir(id), 'images');
  file = path.basename(file);
  fs.rmSync(path.join(dir, file), { force: true });
  const meta = readImageMeta(id);
  delete meta[file];
  writeJSON(path.join(dir, 'images.json'), meta);
  return listImages(id);
}
function personaImagePath(id, file) {
  const f = path.join(personaDir(id), 'images', path.basename(file));
  return IMG_EXT.test(f) ? f : null;
}

// ---------- 프로젝트 / 채팅 ----------
function projectDir(name) {
  const n = safeName(name);
  if (!n) throw new Error('프로젝트 이름이 올바르지 않습니다.');
  return path.join(P.projects, n);
}
function chatFile(project, id) {
  if (!/^[\w-]+$/.test(id || '')) throw new Error('잘못된 채팅 ID');
  return path.join(projectDir(project), 'chats', `${id}.json`);
}
function listProjects() {
  let names = [];
  try { names = fs.readdirSync(P.projects, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch {}
  const projects = names.map((name) => {
    const dir = path.join(P.projects, name, 'chats');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
    const chats = files
      .map((f) => {
        const c = readJSON(path.join(dir, f), null);
        if (!c) return null;
        return { id: c.id, title: c.title, updated: c.updated, personaId: c.personaId, count: (c.messages || []).length };
      })
      .filter(Boolean)
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const pmeta = readJSON(path.join(P.projects, name, 'project.json'), {});
    return { name, created: pmeta.created || 0, updated: chats[0] ? chats[0].updated : pmeta.created || 0, chats };
  });
  return projects.sort((a, b) => (a.name === DEFAULT_PROJECT ? -1 : b.name === DEFAULT_PROJECT ? 1 : b.updated - a.updated));
}
function createProject(name) {
  const dir = projectDir(name);
  if (fs.existsSync(dir)) throw new Error('같은 이름의 프로젝트가 있습니다.');
  fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
  writeJSON(path.join(dir, 'project.json'), { created: Date.now() });
  return safeName(name);
}
function renameProject(oldName, newName) {
  const a = projectDir(oldName);
  const b = projectDir(newName);
  if (a === b) return safeName(newName);
  if (fs.existsSync(b)) throw new Error('같은 이름의 프로젝트가 있습니다.');
  fs.renameSync(a, b);
  return safeName(newName);
}
function deleteProject(name) {
  fs.rmSync(projectDir(name), { recursive: true, force: true });
  fs.mkdirSync(path.join(P.projects, DEFAULT_PROJECT, 'chats'), { recursive: true });
}
function getChat(project, id) { return readJSON(chatFile(project, id), null); }
function saveChat(project, chat) {
  chat.updated = Date.now();
  writeJSON(chatFile(project, chat.id), chat);
  return chat;
}
function createChat(project, { personaId, model }) {
  fs.mkdirSync(path.join(projectDir(project), 'chats'), { recursive: true });
  const chat = { id: uid('c-'), title: '새 채팅', created: Date.now(), updated: Date.now(), personaId, model, messages: [] };
  return saveChat(project, chat);
}
function deleteChat(project, id) { fs.rmSync(chatFile(project, id), { force: true }); }
function moveChat(project, id, toProject) {
  const c = getChat(project, id);
  if (!c) throw new Error('채팅을 찾을 수 없습니다.');
  fs.mkdirSync(path.join(projectDir(toProject), 'chats'), { recursive: true });
  writeJSON(chatFile(toProject, id), c);
  deleteChat(project, id);
}
function searchChats(q) {
  q = String(q || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const p of listProjects()) {
    for (const meta of p.chats) {
      const c = getChat(p.name, meta.id);
      if (!c) continue;
      let snippet = null;
      if ((c.title || '').toLowerCase().includes(q)) snippet = '';
      for (const m of c.messages || []) {
        const t = (m.text || '').replace(/\[img:[^\]]*\]/g, '');
        const i = t.toLowerCase().indexOf(q);
        if (i >= 0) { snippet = t.slice(Math.max(0, i - 30), i + q.length + 50).replace(/\s+/g, ' '); break; }
      }
      if (snippet !== null) out.push({ project: p.name, id: c.id, title: c.title, updated: c.updated, snippet });
      if (out.length >= 50) return out;
    }
  }
  return out;
}

// ---------- Rule 폴더 (AI가 읽고 쓸 수 있는 유일한 경로) ----------
function rulePath(rel) {
  rel = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel || rel.split('/').some((s) => s === '..' || s === '.' || s === '')) throw new Error('잘못된 경로입니다.');
  if (!/\.md$/i.test(rel)) throw new Error('md 파일만 다룰 수 있습니다.');
  const full = path.resolve(P.rules, rel);
  if (!isInside(P.rules, full)) throw new Error('Rule 폴더 밖에는 접근할 수 없습니다.');
  // 심볼릭 링크로 밖을 가리키는 경우 차단
  let probe = full;
  while (!fs.existsSync(probe) && probe !== P.rules) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  const realRoot = fs.realpathSync(P.rules);
  if (real !== realRoot && !isInside(realRoot, real)) throw new Error('Rule 폴더 밖에는 접근할 수 없습니다.');
  return { rel, full };
}
function listRules() { return walk(P.rules).filter((f) => /\.md$/i.test(f)); }
function readRule(rel) {
  const { full } = rulePath(rel);
  if (!fs.existsSync(full)) throw new Error(`파일이 없습니다: ${rel}`);
  return fs.readFileSync(full, 'utf8');
}
function writeRule(rel, content) {
  const r = rulePath(rel);
  const text = String(content ?? '');
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error('파일이 너무 큽니다 (최대 256KB).');
  writeFileAtomic(r.full, text);
  return r.rel;
}
function deleteRule(rel) {
  const { full } = rulePath(rel);
  fs.rmSync(full, { force: true });
  // 빈 폴더 정리
  let d = path.dirname(full);
  while (d !== P.rules && isInside(P.rules, d)) {
    try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch { break; }
    d = path.dirname(d);
  }
}
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([\w-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}
function firstLine(body) {
  return (body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '').slice(0, 200);
}
// 시스템 프롬프트에 넣을 Rule 내용 수집
function collectRules() {
  const files = listRules();
  const instructions = [];
  const onDemand = []; // trigger: model_decision 인 지침
  const memory = [];
  const skills = [];
  for (const rel of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(P.rules, rel), 'utf8'); } catch { continue; }
    const { meta, body } = parseFrontmatter(text);
    if (/(^|\/)SKILL\.md$/i.test(rel) && rel.startsWith('skills/')) {
      const folder = rel.split('/').slice(-2, -1)[0];
      skills.push({ path: rel, name: meta.name || folder, description: meta.description || firstLine(body) });
      continue;
    }
    if (rel.startsWith('skills/')) continue; // 스킬의 보조 파일은 필요할 때만 읽음
    const trigger = (meta.trigger || 'always_on').toLowerCase();
    if (trigger === 'off' || trigger === 'manual') continue;
    if (trigger === 'model_decision') {
      onDemand.push({ path: rel, description: meta.description || firstLine(body) });
      continue;
    }
    if (!body.trim()) continue;
    if (rel.startsWith('memory/')) memory.push({ path: rel, body: body.trim() });
    else instructions.push({ path: rel, body: body.trim() });
  }
  return { instructions, onDemand, memory, skills };
}

// ---------- 내보내기 / 가져오기 ----------
function allDataFiles({ includeKeys }) {
  return walk(P.root)
    .filter((rel) => !/\.tmp$/.test(rel))
    .filter((rel) => includeKeys || rel !== 'keys.json');
}

module.exports = {
  P, DEFAULT_PROJECT, uid, safeName, isInside, walk,
  ensureData, getSettings, setSettings, getKeys, setKey, getModels, setModels,
  listPersonas, getPersona, createPersona, savePersona, deletePersona, duplicatePersona,
  listImages, saveImage, updateImage, deleteImage, personaImagePath,
  listProjects, createProject, renameProject, deleteProject,
  getChat, saveChat, createChat, deleteChat, moveChat, searchChats,
  listRules, readRule, writeRule, deleteRule, collectRules, rulePath,
  allDataFiles, readJSON, writeJSON,
};
