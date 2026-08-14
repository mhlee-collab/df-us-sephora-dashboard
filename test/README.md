# 검증

```
node test/run.js
```

| 단계 | 내용 | 픽스처 필요 |
|---|---|---|
| 1 | `index.html` 의 모든 인라인 `<script>` 블록에 `node --check` | |
| 2 | `apps-script/Code.gs` 문법 검사 | |
| 3 | **토큰 검증** — 위조·오용 토큰 응답을 실제 `verifyToken_()` 에 먹여 본다 | |
| 4 | 실측값 재현 — 총 매출 · 방문 · 주문 · 일자별 매출 · 주차 배분 · NA 비중 | ✔ |
| 5 | 상호작용(기간·필터·모드·표·탭) 런타임 오류 + 코드 규칙 검사 | ✔ |

**문법 검증 통과는 최소 조건일 뿐이다.** 3~5단계까지 통과해야 의미가 있다.

3단계는 `Code.gs` 의 **실제** `verifyToken_()` 을 VM 에 올려 `UrlFetchApp` 만 스텁으로
바꿔 돌린다. 사본을 만들지 않으므로 `Code.gs` 를 고치면 그 코드가 바로 검사된다.
막아야 하는 것 — 제3자 앱이 발급한 토큰(`audience` 불일치), `audience` 필드 소실(fail closed),
유사·서브·접미사 위조 도메인, 미확인 이메일, 만료·위조 토큰, JSON 아닌 응답, 네트워크 예외.

⚠️ 3단계가 검증하는 것은 **「tokeninfo 응답이 주어졌을 때의 판정」**이다.
구글이 실제로 그 필드를 주는지는 Apps Script 편집기에서 **`checkToken()`** 으로 확인한다
(실제 토큰을 붙여넣고 1회 실행 → 응답 필드와 판정 결과가 로그로 나온다).

5단계가 잡는 규칙 위반:

- CSS `font:` 축약형 (Pretendard 가 Arial 로 떨어진다)
- `html{overflow-y:scroll}` 누락 (스크롤바 생성/소멸 → 차트 리사이즈 캐스케이드)
- `.ch-tbl td:first-child` 중복 선언 (뒤쪽 선언이 sticky 를 덮어쓴다)
- 고정 열 `width` 누락 (`table{width:100%}`만 주면 열이 늘어 `left:` 가 어긋난다)
- 차트 생성 후 `chart.options.plugins.tooltip.callbacks.*` 대입 (`Maximum call stack`)
- 축 `offset:true` (0 기준선이 17~21px 뜬다)
- `document` 리스너를 이름 없이 등록 (강제 재렌더 때 여러 벌 쌓인다)
- `index.html` 에 비밀값

---

## 픽스처

3·4단계는 `test/fixtures/` 에 다음 3개가 있어야 돈다.

| 파일 | 내용 |
|---|---|
| `commerce.tsv` | `RAW_commerce` 전량 (헤더 행 포함) |
| `channel.tsv` | `RAW_유입` 전량 (헤더 행 포함) |
| `expected.json` | 기대값 (총 매출 · 방문 · 주문 · 일자별 매출 · 주차 배분 · NA 비중 …) |

🛑 **이 리포지토리는 공개다. 셋 다 시트 실데이터라 절대 커밋하지 않는다.**
`.gitignore` 가 `test/fixtures/` 를 막고 있다. 이 줄을 지우지 말 것.
같은 이유로 **검증 스크립트 안에도 수치를 박지 않는다** — 전부 `expected.json` 에서 읽는다.

없으면 아래 절차로 다시 뽑는다.

1. 구글 시트 `[DF_US] 세포라 대시보드 RAW` 를 **xlsx 로 다운로드**
   (Drive 커넥터: `download_file_content(fileId, exportMimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')`)
2. xlsx 는 zip 이다. 풀어서 `xl/worksheets/sheet2.xml`(RAW_commerce) ·
   `sheet3.xml`(RAW_유입) 을 `xl/sharedStrings.xml` 로 문자열을 되살리며
   **헤더 행 포함 탭 구분 TSV** 로 저장한다.
3. 열 순서는 시트 그대로 — `verify-figures.js` 가 위치로 읽는다
   (⚠️ 검증 스크립트만 위치 기반이다. **파서(`Code.gs`)는 완전 일치 헤더명 기반**이며
   이 둘이 어긋나면 검증이 먼저 깨지도록 일부러 이렇게 두었다).

4. `expected.json` 을 아래 뼈대로 채운다. 값은 시트에서 직접 집계해 넣는다
   (Apps Script 편집기에서 **`checkTotals`** 를 실행하면 대부분이 로그로 나온다).

```jsonc
{
  "range":    { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "days": 0 },
  "commerce": { "visits": 0, "sales": "0.00", "salesFormatted": "0.00",
                "salesKrwFormatted": "0", "orders": 0, "weeks": { "W1": 0 } },
  "channel":  { "visits": 0, "sales": "0.00", "naSales": "0.00", "naPct": "0.00%",
                "channelCount": 0, "chartChannelCount": 0, "weeks": { "W1": 0 } },
  "dailySales":   ["0.00"],            // 기간의 날짜 수만큼, 날짜 오름차순
  "naOver15Days": ["YYYY-MM-DD"],      // 일별 NA 비중이 15% 를 넘은 날
  "weekKeys":     ["W1"],
  "w1Label":      "W1 M/D–M/D"         // 첫 주 라벨 (화면 표기와 동일해야 한다)
}
```

## 검증되는 불변식

수치를 몰라도 늘 참이어야 하는 것들 — 데이터가 쌓여도 그대로 유지된다.

- `RAW_commerce` 매출 합계 **=** `RAW_유입` 매출 합계 (NA 포함)
- 통합 탭 CVR(주문÷방문) **=** 원본 `Conversion TY` 방문 가중 합산
- `RAW_유입` 방문 **<** `RAW_commerce` 방문 (집계 단위가 다르다)
- 차트·표 매출 **=** 전체 매출 − NA 매출
- NA 의 CVR 은 `null` (0 으로 찍지 않는다)
- 결측 채널 채움 행 수 **=** 채널 수 × 일수 − 원본 행 수
- 첫 주는 직전 주가 없으므로 비교 배지를 그리지 않는다

데이터가 쌓이면 `expected.json` 만 갱신한다. 검증 스크립트는 건드릴 필요가 없다.
