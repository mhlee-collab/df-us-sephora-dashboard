// ═══════════════════════════════════════════════════════════════════════════════
//  검증 러너 —  node test/run.js
//
//  1) index.html 의 모든 <script> 블록을 뽑아 node --check
//  2) apps-script/Code.gs 문법 검사
//  3) 실측값 재현 검사 (test/verify-figures.js)
//  4) 상호작용·규칙 검사 (test/verify-interactions.js)
//
//  3·4 는 test/fixtures/commerce.tsv · channel.tsv 가 있어야 돈다.
//  픽스처는 시트 실데이터라 커밋하지 않는다 — test/README.md 참고.
// ═══════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP  = path.join(__dirname, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

let failed = 0;
function head(t) { console.log('\n' + '─'.repeat(60) + '\n ' + t + '\n' + '─'.repeat(60)); }

// ── 1. index.html 의 인라인 <script> 블록 추출 + node --check ────────────────
head('1. 문법 검증 — index.html <script> 블록');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const blocks = [];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html)) !== null) blocks.push(m[1]);

if (!blocks.length) { console.log('  ✗  인라인 <script> 블록을 찾지 못했습니다.'); failed++; }
blocks.forEach((src, i) => {
  const f = path.join(TMP, 'block' + String(i + 1).padStart(2, '0') + '.js');
  fs.writeFileSync(f, src, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`  OK  블록 ${i + 1} (${src.split('\n').length}줄)`);
  } catch (e) {
    console.log(`  ✗   블록 ${i + 1}\n${e.stderr.toString()}`);
    failed++;
  }
});

// ── 2. Code.gs ──────────────────────────────────────────────────────────────
head('2. 문법 검증 — apps-script/Code.gs');
const gs = path.join(ROOT, 'apps-script', 'Code.gs');
if (fs.existsSync(gs)) {
  const copy = path.join(TMP, 'Code.gs.js');   // node --check 는 .gs 확장자를 모른다
  fs.copyFileSync(gs, copy);
  try {
    execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
    console.log('  OK  Code.gs');
  } catch (e) {
    console.log('  ✗   Code.gs\n' + e.stderr.toString());
    failed++;
  }
} else { console.log('  –   Code.gs 없음 (건너뜀)'); }

// ── 3·4. 데이터 검증 ─────────────────────────────────────────────────────────
const haveFixtures = fs.existsSync(path.join(__dirname, 'fixtures', 'commerce.tsv'))
                  && fs.existsSync(path.join(__dirname, 'fixtures', 'channel.tsv'));
if (!haveFixtures) {
  head('3·4. 데이터 검증 — 건너뜀');
  console.log('  test/fixtures/commerce.tsv · channel.tsv 가 없습니다.');
  console.log('  test/README.md 의 절차대로 시트에서 다시 뽑으면 실행됩니다.');
} else {
  process.env.DFUS_INDEX = path.join(ROOT, 'index.html');
  [['3. 실측값 재현', 'verify-figures.js'], ['4. 상호작용·규칙', 'verify-interactions.js']]
    .forEach(([title, file]) => {
      head(title + ' — test/' + file);
      try {
        const out = execFileSync(process.execPath, [path.join(__dirname, file)],
          { stdio: 'pipe', env: process.env });
        console.log(out.toString().trim());
      } catch (e) {
        console.log((e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : ''));
        failed++;
      }
    });
}

console.log('\n' + (failed ? `❌ 실패 ${failed}건` : '✅ 전부 통과'));
process.exit(failed ? 1 : 0);
