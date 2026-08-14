// 상호작용 경로(모드 전환·필터·표·탭)를 전부 밟아 런타임 오류를 잡고,
// 규칙 위반(font: 축약형 · sticky 덮어쓰기 · 툴팁 콜백 후행 대입 · 축 offset)을 검사한다.
// node --check 통과는 최소 조건일 뿐이다.
//
//   실행:  node test/run.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SP = path.join(__dirname, '.tmp');

// verify-figures.js 의 페이로드 빌드 부분을 재사용
const buildSrc = fs.readFileSync(path.join(__dirname, 'verify-figures.js'), 'utf8');
const payloadSrc = buildSrc.split('// ── 2. 최소 DOM 스텁')[0];
const payloadMod = { exports: {} };
vm.runInNewContext(payloadSrc + '\nmodule.exports = payload;',
  { module: payloadMod, require, __dirname, console: { log() {} }, process },
  { filename: 'payload.js' });
const payload = payloadMod.exports;

// ── DOM 스텁 ────────────────────────────────────────────────────────────────
function makeEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {}, children: [],
    classList: { _s: new Set(),
      add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
      toggle(c,v){ v===undefined ? (this._s.has(c)?this._s.delete(c):this._s.add(c)) : (v?this._s.add(c):this._s.delete(c)); },
      contains(c){return this._s.has(c);} },
    querySelectorAll(){ return []; },
    querySelector(){ return makeEl('sub'); },
    appendChild(c){ this.children.push(c); return c; },
    removeChild(c){ const i=this.children.indexOf(c); if(i>=0) this.children.splice(i,1); return c; },
    addEventListener(){}, removeEventListener(){}, closest(){ return null; },
    getContext(){ return {}; }, setAttribute(){}, getAttribute(){ return null; }, focus(){}
  };
  return el;
}
const els = {};
const charts = [];
const sandbox = {
  console, Date, Math, JSON, Set, Map, Array, Object, String, Number,
  parseInt, parseFloat, isNaN, URLSearchParams, setTimeout, clearTimeout,
  setInterval, clearInterval, Promise, fetch,
  document: {
    getElementById(id){ return els[id] || (els[id] = makeEl(id)); },
    querySelectorAll(){ return []; }, querySelector(){ return null; },
    createElement(t){ return makeEl(t); }, addEventListener(){}, removeEventListener(){}
  },
  Chart: class Chart { constructor(c, cfg){ this.cfg = cfg; charts.push(cfg); } destroy(){} },
  sessionStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  localStorage:   { getItem: () => null, setItem(){}, removeItem(){} },
  history: { replaceState(){} },
  location: { hash: '', search: '', pathname: '/' }
};
sandbox.Chart.defaults = { color: '#666', font: { family: '' } };
sandbox.window = sandbox;
sandbox.window.addEventListener = () => {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(SP, 'block01.js'), 'utf8'), sandbox, { filename: 'index.html' });

const fail = [];
function step(label, fn) {
  try { const r = fn(); console.log(`  OK  ${label}${r !== undefined ? ' → ' + r : ''}`); }
  catch (e) { console.log(`  ✗   ${label}: ${e.message}`); fail.push(label + ': ' + e.message); }
}
function assert(label, cond, detail) {
  if (cond) console.log(`  OK  ${label}${detail !== undefined ? ' → ' + detail : ''}`);
  else { console.log(`  ✗   ${label}${detail !== undefined ? ' → ' + detail : ''}`); fail.push(label); }
}
const btn = () => makeEl('btn');

sandbox.applyPayload(payload);

console.log('\n── 통합 탭 컨트롤 ──');
step('기간 토글 월', () => sandbox.setMainPeriod(btn(), 'monthly'));
step('기간 토글 일', () => sandbox.setMainPeriod(btn(), 'daily'));
step('기간 토글 주', () => sandbox.setMainPeriod(btn(), 'weekly'));
step('Visits 토글',   () => sandbox.toggleSeries(btn(), 'visits'));
step('주문 수량 토글', () => sandbox.toggleSeries(btn(), 'orders'));
step('CVR 토글',      () => sandbox.toggleSeries(btn(), 'cvr'));
step('₩ 환산 토글',   () => sandbox.toggleKrw(btn()));
step('₩ 환산 해제',   () => sandbox.toggleKrw(btn()));

console.log('\n── 통합 탭 필터 (MONTH / WEEK) ──');
const MONTHS = [...new Set(payload.commerce.map(r => r.month))].sort();
const LAST_MONTH = MONTHS[MONTHS.length - 1];
const TOTAL_SALES = payload.commerce.reduce((a, r) => a + r.sales, 0);
step(`MONTH=${LAST_MONTH} 선택`, () => { sandbox.selMonths.add(LAST_MONTH); sandbox.refreshMain(true); });
assert('  필터가 실제로 좁힌다', (() => {
  const got = sandbox.sumRows(sandbox.mainFiltered()).sales;
  const want = payload.commerce.filter(r => r.month === LAST_MONTH).reduce((a, r) => a + r.sales, 0);
  return Math.abs(got - want) < 1e-9 && got < TOTAL_SALES;
})(), 'ok');
step('MONTH 해제', () => sandbox.clearFilter('month'));
assert('  해제하면 전체로 복귀',
  Math.abs(sandbox.sumRows(sandbox.mainFiltered()).sales - TOTAL_SALES) < 1e-9, 'ok');
const WK = payload.weeks.map(w => w.key);          // 전부 데이터 파생 — 라벨을 박지 않는다
step(`WEEK=${WK[1]} 선택`, () => { sandbox.selWeeks.add(WK[1]); sandbox.refreshMain(true); });
assert(`  ${WK[1]} vs ${WK[0]} 비교 배지 생성`, /kpi-badge/.test(els['kpiRow'].innerHTML), 'WoW');
assert('  비교 라벨이 데이터 파생',
  els['kpiRow'].innerHTML.includes(sandbox.weekLabel(WK[0])), sandbox.weekLabel(WK[0]));
step(`WEEK=${WK[0]} 선택 (첫 주)`, () => {
  sandbox.selWeeks.clear(); sandbox.selWeeks.add(WK[0]); sandbox.refreshMain(true);
});
assert('  첫 주는 직전 주가 없어 배지 미표시', !/kpi-badge/.test(els['kpiRow'].innerHTML), 'ok');
step('WEEK 해제', () => sandbox.clearFilter('week'));

console.log('\n── 유입 채널 탭 모드 ──');
step('채널별 모드', () => sandbox.setChMode('split'));
step('  지표 Sales', () => sandbox.setChMetric(btn(), 'sales'));
step('  지표 CVR',   () => sandbox.setChMetric(btn(), 'cvr'));
step('  지표 Visits',() => sandbox.setChMetric(btn(), 'visits'));
assert('채널별 계열 수 = 14 (NA 제외)', charts[charts.length-1].data.datasets.length === 14,
  charts[charts.length-1].data.datasets.length);
assert('config.type 명시', charts[charts.length-1].type === 'line', charts[charts.length-1].type);
assert('브랜드 레드가 계열색에 없음',
  !charts[charts.length-1].data.datasets.some(d => String(d.borderColor).toUpperCase() === '#DD061A'), 'ok');
step('합산 모드', () => sandbox.setChMode('sum'));
assert('합산 계열 3개', charts[charts.length-1].data.datasets.length === 3,
  charts[charts.length-1].data.datasets.map(d => d.label).join(','));
assert('합산 config.type = bar', charts[charts.length-1].type === 'bar', charts[charts.length-1].type);

console.log('\n── 유입 채널 탭 기간 ──');
step('기간 일',  () => sandbox.setChPeriod(btn(), 'daily'));
assert('일 축 라벨 세로', charts[charts.length-1].options.scales.x.ticks.minRotation === 90, '90도');
step('기간 월',  () => sandbox.setChPeriod(btn(), 'monthly'));
step('기간 주',  () => sandbox.setChPeriod(btn(), 'weekly'));

console.log('\n── 유입 채널 탭 필터 캐스케이드 ──');
const CH_MONTHS = [...new Set(payload.channel.map(r => r.date.slice(0, 7)))].sort();
const FIRST_MONTH = CH_MONTHS[0];
step(`MONTH=${FIRST_MONTH} 선택`, () => {
  sandbox.selChMonths.add(FIRST_MONTH);
  sandbox.buildChWeekOptions();
  sandbox.refreshChannel(true);
});
assert('  그 달의 주차만 남는다 (캐스케이드)', (() => {
  const inMonth = [...new Set(payload.channel.filter(r => r.date.slice(0,7) === FIRST_MONTH).map(r => r.week))];
  return inMonth.length > 0 && inMonth.length < WK.length;
})(), 'ok');
step('MONTH 해제 → 주 선택도 초기화', () => sandbox.clearFilter('chMonth'));
assert('주 선택 비어 있음', sandbox.selChWeeks.size === 0, sandbox.selChWeeks.size);

console.log('\n── 채널 AND 필터 ──');
// 사용자가 모드를 직접 누른 뒤에는 자동 전환하지 않는 것이 설계다.
// 자동 전환 경로를 보려면 '직접 누름' 플래그를 되돌려야 한다.
assert('모드를 직접 누른 뒤에는 자동 전환 안 함', sandbox.chMode === 'sum', sandbox.chMode);
step('자동 전환 플래그 초기화', () => { sandbox._chModeTouched = false; });
step('Email + Push 선택', () => {
  sandbox.selChChans.add('Email'); sandbox.selChChans.add('Push');
  sandbox.autoChMode(); sandbox.refreshChannel(true);
});
assert('채널 2개 선택 → 자동으로 채널별 모드', sandbox.chMode === 'split', sandbox.chMode);
assert('계열 2개', charts[charts.length-1].data.datasets.length === 2,
  charts[charts.length-1].data.datasets.map(d => d.label).join(','));
step('NA 만 선택', () => {
  sandbox.selChChans.clear(); sandbox.selChChans.add('NA');
  sandbox.autoChMode(); sandbox.refreshChannel(true);
});
assert('NA 만 선택 시 계열 0 + 안내', charts[charts.length-1].data.datasets.length === 0
  && /그릴 계열이 없습니다/.test(els['chComboNote'].innerHTML),
  charts[charts.length-1].data.datasets.length + '계열');
assert('NA 만 선택 시 표도 안내로 대체', /표시할 채널이 없습니다/.test(els['chTable'].innerHTML), 'ok');
step('채널 해제', () => { sandbox.clearFilter('chChan'); sandbox._chModeTouched = true; sandbox.setChMode('sum'); });

console.log('\n── 채널별 표 ──');
step('표 Visits', () => sandbox.setChTblMetric(btn(), 'visits'));
let html = els['chTable'].innerHTML;
assert('표에 NA 행 없음', !/>NA</.test(html), 'ok');
assert('표 채널 행 14 + 합계 1', (html.match(/<tr>/g) || []).length === 16, (html.match(/<tr>/g) || []).length);
const INDEX_HTML = fs.readFileSync(process.env.DFUS_INDEX, 'utf8');
// 주석에 규칙을 설명해 둔 문장이 정규식에 걸리므로 주석을 걷어내고 판정한다.
const CSS_RAW  = INDEX_HTML.split('</style>')[0];
const CSS_CODE = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, '');
const JS_CODE  = fs.readFileSync(path.join(SP, 'block01.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// .ch-tbl td:first-child 를 sticky 로 잡은 뒤 같은 선택자로 position 을 다시 선언하면
// 뒤쪽 선언이 sticky 를 덮어쓴다. 선언이 한 번뿐인지 본다.
const firstChildRules = CSS_CODE.match(/\.ch-tbl td:first-child\s*\{[^}]*\}/g) || [];
assert('.ch-tbl td:first-child 선언 1회', firstChildRules.length === 1, firstChildRules.length + '회');
assert('  그 안에 position:sticky', /position:sticky/.test(firstChildRules[0] || ''), 'ok');
assert('  고정 열 width 명시', /width:\s*\d+px/.test(firstChildRules[0] || ''), 'ok');
assert('CSS font: 축약형 없음', !/[;{]\s*font\s*:/.test(CSS_CODE), 'ok');
assert('html{overflow-y:scroll} 있음', /html\{overflow-y:scroll;?\}/.test(CSS_CODE), 'ok');
assert('비밀값 없음 (client_secret 류)',
  !/client_secret|GOCSPX|api[_-]?key\s*[:=]\s*['"]/i.test(INDEX_HTML), 'ok');
assert('툴팁 콜백 후행 대입 없음', !/\.options\.plugins\.tooltip\.callbacks/.test(JS_CODE), 'ok');
assert('축 offset:true 없음', !/offset\s*:\s*true/.test(JS_CODE), 'ok');
assert('document 리스너 이름 붙여 등록', /window\.__dfusDocClick/.test(JS_CODE), 'ok');
assert('  등록 전 제거', /removeEventListener\('click',\s*window\.__dfusDocClick\)/.test(JS_CODE), 'ok');
step('표 Sales', () => sandbox.setChTblMetric(btn(), 'sales'));
step('표 CVR',   () => sandbox.setChTblMetric(btn(), 'cvr'));
html = els['chTable'].innerHTML;
assert('CVR 표에 «-» 또는 표본 주석 존재', /class="dash"|n=/.test(html), 'ok');

console.log('\n── 탭 전환 ──');
step('유입 탭', () => sandbox.switchTab('channel'));
step('통합 탭', () => sandbox.switchTab('main'));
step('사이드바 접기', () => sandbox.toggleSidebar());

console.log('\n── 데이터 재대입 (강제 재렌더) ──');
step('applyPayload 재호출', () => sandbox.applyPayload(payload));
assert('KPI 다시 그려짐 (전체 합계로 복귀)',
  els['kpiRow'].innerHTML.includes(
    '$' + TOTAL_SALES.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })), 'ok');

console.log('\n' + (fail.length ? `❌ 실패 ${fail.length}건:\n  - ${fail.join('\n  - ')}` : '✅ 전부 통과'));
process.exit(fail.length ? 1 : 0);
