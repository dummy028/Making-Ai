// 시스템 프롬프트 조립: 페르소나 + 이미지 프로토콜 + Rule 폴더(지침/기억/스킬) + 도구 안내
const store = require('./store');
const { PERSONA_FIELDS } = require('./defaults');

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function nowText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} (${WEEKDAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())} ${tz}`.trim();
}

// stable: 매 턴 거의 바뀌지 않는 부분(프롬프트 캐시 대상), dynamic: 현재 시각 등
function buildSystem(persona, settings) {
  const rules = store.collectRules();
  const out = [];
  const name = (persona && persona.name) || 'AI';

  out.push(
    `너는 지금부터 '${name}'(이)라는 인물 그 자체로서 사용자와 1:1 메신저 대화를 한다. ` +
      `아래 캐릭터 설정을 바탕으로 생각하고 말한다. AI·언어모델이라는 언급, 설정에 대한 메타 설명, 캐릭터를 벗어난 말투는 하지 않는다. ` +
      `사용자가 직접 캐릭터 밖의 얘기를 요청할 때만 예외다.`
  );

  if (persona) {
    let p = '# 캐릭터 설정';
    for (const f of PERSONA_FIELDS) {
      const v = String(persona[f.key] || '').trim();
      if (v) p += `\n\n## ${f.label}\n${v}`;
    }
    out.push(p);
  }

  if (settings.userName) out.push(`# 사용자\n사용자의 이름(호칭): ${settings.userName}`);

  const images = (persona && persona.images) || [];
  let img =
    '# 표현 규칙 (화면 표시용 태그)\n' +
    '- 행동·표정 묘사가 필요하면 *별표로 감싼다*. 예: *웃으며 고개를 끄덕인다* 응 좋아. 남발하지 않는다.';
  if (images.length) {
    img +=
      '\n- 대사 맨 앞에 [img:코드] 태그를 붙이면 그 표정/상황 이미지가 대사 옆에 표시되고 태그는 사용자에게 보이지 않는다.' +
      '\n- 한 답변 안에서 감정이 바뀌면 새 태그로 시작하는 줄을 이어 쓴다(새 말풍선으로 나뉜다). 태그는 아래 목록의 코드만 쓴다. 해당하는 게 없으면 태그를 생략한다.' +
      '\n- 예: [img:joy] 그거 진짜 좋다!' +
      '\n\n사용 가능한 이미지 코드:';
    for (const im of images) img += `\n- ${im.code}${im.desc ? `: ${im.desc}` : ''}`;
  }
  out.push(img);

  if (rules.instructions.length) {
    out.push('# 지침 (Rule 폴더)\n\n' + rules.instructions.map((r) => `<!-- ${r.path} -->\n${r.body}`).join('\n\n'));
  }
  if (rules.memory.length) {
    out.push('# 기억 (사용자에 대해 알고 있는 것)\n\n' + rules.memory.map((r) => r.body).join('\n\n'));
  }
  if (rules.skills.length || rules.onDemand.length) {
    let s = '# 스킬 / 조건부 지침\n아래는 설명만 있다. 상황에 맞으면 rules_read로 해당 파일을 먼저 읽고 그 내용을 따른다.';
    for (const k of rules.skills) s += `\n- [스킬] ${k.name}: ${k.description} (파일: ${k.path})`;
    for (const k of rules.onDemand) s += `\n- [지침] ${k.description} (파일: ${k.path})`;
    out.push(s);
  }
  out.push(
    '# 도구\n' +
      '- rules_list / rules_read / rules_write: Rule 폴더(instructions/, memory/, skills/)의 md 파일만 보고, 만들고, 고칠 수 있다. 그 밖의 경로는 접근할 수 없다.\n' +
      '- 웹 검색: 모르는 것·최신 정보·커뮤니티 지식은 검색해서 확인한다.\n' +
      '- 도구를 썼다는 사실을 장황하게 설명하지 않는다.'
  );

  return { stable: out.join('\n\n'), dynamic: `현재 시각: ${nowText()}` };
}

module.exports = { buildSystem };
