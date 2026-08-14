// ═══════════════════════════════════════════════════════════════════════════════
//  토큰 검증 테스트
//
//  apps-script/Code.gs 의 **실제 verifyToken_()** 을 그대로 불러와
//  위조·오용 토큰 응답을 먹여 본다. 사본을 만들지 않는다 —
//  Code.gs 를 고치면 이 테스트가 바로 그 코드를 검사한다.
//
//  ⚠️ 여기서 검증하는 것은 "tokeninfo 응답이 주어졌을 때의 판정 로직"이다.
//     구글이 실제로 그 응답을 주는지는 편집기의 checkToken() 으로 확인한다.
// ═══════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

let nextResponse = null;   // 각 테스트가 세팅하는 가짜 tokeninfo 응답
let lastUrl = null;

const sandbox = {
  console, JSON, String, Object, Date, Math, encodeURIComponent,
  UrlFetchApp: {
    fetch(url) {
      lastUrl = url;
      if (nextResponse instanceof Error) throw nextResponse;
      return {
        getResponseCode: () => nextResponse.code,
        getContentText:  () => nextResponse.body
      };
    }
  },
  Logger: { log() {} },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
  SpreadsheetApp: {}, DriveApp: {}, ContentService: {}, LockService: {}, ScriptApp: {},
  Utilities: { formatDate: () => '' }, MimeType: {}, Session: {}
};
vm.createContext(sandbox);
vm.runInContext(CODE, sandbox, { filename: 'apps-script/Code.gs' });

const CLIENT_ID = sandbox.GOOGLE_CLIENT_ID;
const DOMAIN    = sandbox.ALLOWED_DOMAIN;

const fail = [];
function check(label, resp, wantError, note) {
  nextResponse = resp;
  let got;
  try { got = sandbox.verifyToken_('T'); }
  catch (e) { got = { error: 'THREW: ' + e.message }; }

  const gotErr = got.error || null;
  const ok = gotErr === wantError;
  const shown = gotErr === null ? `통과 (${got.email})` : gotErr;
  console.log(`${ok ? '  OK ' : '  ✗  '} ${label}\n        → ${shown}${ok ? '' : `   (기대 ${wantError || '통과'})`}`);
  if (note && !ok) console.log(`        ${note}`);
  if (!ok) fail.push(label);
}
const ok200 = obj => ({ code: 200, body: JSON.stringify(obj) });
const GOOD = {
  audience: CLIENT_ID, issued_to: CLIENT_ID,
  email: 'mh.lee@' + DOMAIN, verified_email: true,
  expires_in: 3400, scope: 'https://www.googleapis.com/auth/userinfo.email'
};

console.log(`\n클라이언트 ID: ${CLIENT_ID}`);
console.log(`허용 도메인  : @${DOMAIN}`);

console.log('\n── 정상 통과해야 하는 것 ──');
check('정상 토큰', ok200(GOOD), null);
check('audience 만 있고 issued_to 없음',
  ok200({ ...GOOD, issued_to: undefined }), null);
check('issued_to 만 있고 audience 없음 (폴백)',
  ok200({ ...GOOD, audience: undefined }), null);
check('이메일 대소문자 혼용 → 소문자 정규화',
  ok200({ ...GOOD, email: 'MH.Lee@WyattCorp.COM' }), null);
check('이메일 앞뒤 공백',
  ok200({ ...GOOD, email: '  mh.lee@' + DOMAIN + '  ' }), null);
check('verified_email 필드 자체가 없음 (구 응답 호환)',
  ok200({ ...GOOD, verified_email: undefined }), null);

console.log('\n── 🛑 반드시 막아야 하는 것 ──');
check('★ 제3자 앱이 발급한 토큰 (와이어트 계정이지만 audience 다름)',
  ok200({ ...GOOD, audience: '999-evil.apps.googleusercontent.com',
                   issued_to: '999-evil.apps.googleusercontent.com' }),
  'WRONG_AUDIENCE',
  '이게 뚫리면 직원이 로그인한 아무 사이트가 매출 데이터를 읽어간다');
check('audience 는 우리 것인데 issued_to 가 제3자 (둘 다 일치해야 통과)',
  ok200({ ...GOOD, issued_to: '999-evil.apps.googleusercontent.com' }), 'WRONG_AUDIENCE');
check('audience 가 제3자, issued_to 가 우리 것',
  ok200({ ...GOOD, audience: '999-evil.apps.googleusercontent.com' }), 'WRONG_AUDIENCE');
check('audience·issued_to 둘 다 없음 → fail closed',
  ok200({ ...GOOD, audience: undefined, issued_to: undefined }), 'AUDIENCE_MISSING');
check('audience 가 빈 문자열',
  ok200({ ...GOOD, audience: '', issued_to: '' }), 'AUDIENCE_MISSING');
check('audience 가 우리 ID 의 접두사',
  ok200({ ...GOOD, audience: CLIENT_ID.slice(0, 20), issued_to: undefined }), 'WRONG_AUDIENCE');
check('audience 가 우리 ID 를 포함한 더 긴 문자열',
  ok200({ ...GOOD, audience: CLIENT_ID + '.evil.com', issued_to: undefined }), 'WRONG_AUDIENCE');

check('다른 도메인 계정 (gmail)',
  ok200({ ...GOOD, email: 'someone@gmail.com' }), 'UNAUTHORIZED_DOMAIN');
check('유사 도메인 evil-wyattcorp.com',
  ok200({ ...GOOD, email: 'x@evil-' + DOMAIN }), 'UNAUTHORIZED_DOMAIN');
check('접미사 위조 wyattcorp.com.evil.com',
  ok200({ ...GOOD, email: 'x@' + DOMAIN + '.evil.com' }), 'UNAUTHORIZED_DOMAIN');
check('서브도메인 sub.wyattcorp.com',
  ok200({ ...GOOD, email: 'x@sub.' + DOMAIN }), 'UNAUTHORIZED_DOMAIN');
check('로컬파트 없음 (@wyattcorp.com)',
  ok200({ ...GOOD, email: '@' + DOMAIN }), 'INVALID_TOKEN');
check('@ 가 없는 문자열',
  ok200({ ...GOOD, email: 'mh.lee' }), 'INVALID_TOKEN');
check('@ 가 두 개 (x@a@wyattcorp.com)',
  ok200({ ...GOOD, email: 'x@a@' + DOMAIN }), 'UNAUTHORIZED_DOMAIN');

check('verified_email: false',
  ok200({ ...GOOD, verified_email: false }), 'UNVERIFIED_EMAIL');
check('email 필드 없음 (email 스코프 없는 토큰)',
  ok200({ ...GOOD, email: undefined }), 'INVALID_TOKEN');
check('email 이 빈 문자열',
  ok200({ ...GOOD, email: '' }), 'INVALID_TOKEN');

check('tokeninfo 400 (만료·위조 토큰)',
  { code: 400, body: '{"error_description":"Invalid Value"}' }, 'INVALID_TOKEN');
check('tokeninfo 401', { code: 401, body: '{}' }, 'INVALID_TOKEN');
check('tokeninfo 500', { code: 500, body: '' }, 'INVALID_TOKEN');
check('응답이 JSON 이 아님', { code: 200, body: '<html>oops</html>' }, 'TOKEN_VERIFY_FAILED');
check('네트워크 예외', new Error('DNS 실패'), 'TOKEN_VERIFY_FAILED');

console.log('\n── 부가 확인 ──');
nextResponse = ok200(GOOD);
sandbox.verifyToken_('SOME/TOKEN?&=+VALUE');
const encoded = lastUrl.includes(encodeURIComponent('SOME/TOKEN?&=+VALUE'));
console.log(`${encoded ? '  OK ' : '  ✗  '} 토큰이 URL 인코딩돼 전달됨\n        → ${encoded}`);
if (!encoded) fail.push('토큰 URL 인코딩');

const usesTokeninfo = lastUrl.indexOf('https://www.googleapis.com/oauth2/v2/tokeninfo') === 0;
console.log(`${usesTokeninfo ? '  OK ' : '  ✗  '} 검증 엔드포인트\n        → ${lastUrl.split('?')[0]}`);
if (!usesTokeninfo) fail.push('검증 엔드포인트');

// 통과 응답이 email 외에 아무것도 흘리지 않는지
nextResponse = ok200(GOOD);
const passed = sandbox.verifyToken_('T');
const keys = Object.keys(passed).join(',');
console.log(`${keys === 'email' ? '  OK ' : '  ✗  '} 통과 시 반환 필드\n        → {${keys}}`);
if (keys !== 'email') fail.push('통과 반환 필드');

console.log('\n' + (fail.length ? `❌ 실패 ${fail.length}건:\n  - ${fail.join('\n  - ')}` : '✅ 전부 통과'));
process.exit(fail.length ? 1 : 0);
