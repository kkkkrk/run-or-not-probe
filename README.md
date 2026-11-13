# run-or-not-probe

[뛸까말까](https://github.com/kkkkrk/run-or-not)(지금 뛰면 지하철을 탈 수 있는지 알려 주는 웹앱)의 데이터 수집 레포예요.
GitHub Actions가 서울시 지하철 실시간 도착정보를 정해진 시간마다 받아 `data/`에 커밋해요.

> GitHub 예약 실행(schedule)이 거의 뜨지 않아서(2026-08 말부터 GitHub 쪽 문제로 널리 보고됨) 예약에 기대지 않아요.
> `keeper.yml` 실행 하나가 5시간 반 동안 아래 수집을 시각에 맞춰 직접 하고, 끝나기 전에 다음 keeper를 띄워 이어 가요.
> 예약은 지킴이로만 써요. 가끔이라도 뜨면 keeper가 도는지 보고, 없으면 다시 띄워요.

## 무엇을 확인하려고 모으나

- 앱에서 뺀 노선·역은 다른 시간대에도 `barvlDt`(남은 초)가 늘 0인지, 남긴 역은 늘 값이 있는지. 이전 실측(2026-10-29, 10-30)은 평일 오후뿐이었어요.
- 7호선 유령 열차(도착정보에는 있는데 위치 정보에는 없는 열차)가 시간대마다 얼마나 나오는지.
- 출근·퇴근 시간에 같은 열차를 20초 간격으로 따라가서, 도착 예측이 얼마나 맞는지와 노선별 보정값.

## 수집 모드

기간은 **2026-11-14(토) 00:09 ~ 2026-11-23(월) 19:30 KST**예요. 시각은 전부 KST로 기록해요.

| 모드 (`runs.csv`의 mode) | 언제 | 부르는 것 | 저장 |
|---|---|---|---|
| `q15` | 매일 15분마다 (7·22·37·52분) | 도착 전체(`ALL`) 1회 + 7호선 위치 1회 | `raw/날짜/HHmm-arrivals.json.gz`, `raw/날짜/HHmm-pos7.json.gz` |
| `pos15` | 15분 눈금이 평일 07:10~09:30, 17:10~19:30에 걸리면 | 7호선 위치 1회만 (`ALL`은 20초 작업이 받음) | `raw/날짜/HHmm-pos7.json.gz` |
| `am20` | 평일 07:10에 시작해 09:30까지 | 20초마다 `ALL` 1회 (한 번에 최대 400회) | `raw/날짜/am-20s.jsonl.gz` |
| `pm20` | 평일 17:10에 시작해 19:30까지 | `am20`과 같음 | `raw/날짜/pm-20s.jsonl.gz` |

keeper는 정해진 시각에 정확히 불러요(실행이 바뀌는 사이 1분 안팎은 빌 수 있어요). 분석은 예정 시각이 아니라 기록된 `fetchedAt`으로 해요.

keeper가 커밋하는 때: 15분 수집마다 한 번, 20초 창은 창이 끝날 때 한 번(창 안의 `pos15`도 그때 같이), 다음 keeper로 넘길 때 한 번.
5시간 반 안에 20초 창이 끝까지 안 들어가면 창 시작 15분 전에 넘겨요.

## 파일

```
.github/workflows/keeper.yml    평소 수집 (keeper가 다음 keeper를 띄움) + 지킴이 예약
.github/workflows/collect.yml   손으로 한 번 돌려 볼 때
collect.ts                      수집 스크립트. Node 24로 바로 실행 (node collect.ts), 설치할 것 없음
data/runs.csv                   응답마다 1줄 (q15는 실행마다 1줄)
data/lines.csv                  q15 실행 × 노선마다 1줄 — 빠른 확인용
data/raw/YYYY-MM-DD/            슬림 원본 (필요한 필드만, 값은 받은 그대로)
```

**`data/runs.csv`**

```
fetched_at_kst,weekday,mode,arrivals_code,arrivals_rows,pos7_code,pos7_rows,duration_ms,error
```

- `weekday`는 0(일)~6(토), `mode`는 `q15` · `pos15` · `am20` · `pm20`
- `arrivals_code`가 `INFO-000`이면 정상, `INFO-200`이면 데이터 없음(새벽), 비어 있거나 다른 값이면 실패
- 20초 모드는 7호선 위치를 부르지 않아서 `pos7_*` 칸이, `pos15`는 도착을 부르지 않아서 `arrivals_*` 칸이 비어 있어요

**`data/lines.csv`** (q15만)

```
fetched_at_kst,subwayId,rows,pending,pending_barvl_pos,stale_180s,future_recptn
```

- `pending`: 아직 오지 않은 열차 (`arvlCd`가 3 · 4 · 5 · 99)
- `pending_barvl_pos`: 그중 `barvlDt`가 0보다 큰 행
- `stale_180s`: `recptnDt`가 3분 넘게 묵은 행, `future_recptn`: `recptnDt`가 1분 넘게 미래인 행

**`data/raw`**

- q15 파일 하나는 `{ fetchedAt, code, rows }` JSON을 gzip한 것
- 20초 파일은 한 줄이 응답 하나(`{ fetchedAt, code, rows }`)인 JSONL. 줄마다 따로 gzip해서 이어 붙였어요. 90MB를 넘기면 `am-20s.2.jsonl.gz`로 이어 써요.
- 도착 행 필드: `subwayId, statnId, statnNm, updnLine, btrainNo, bstatnId, bstatnNm, arvlCd, arvlMsg2, arvlMsg3, barvlDt, recptnDt, ordkey, btrainSttus`
- 위치 행 필드: `trainNo, statnId, statnNm, updnLine, trainSttus, recptnDt, statnTid`

```bash
gunzip -c data/raw/2026-11-16/0907-arrivals.json.gz | head -c 400
gunzip -c data/raw/2026-11-16/am-20s.jsonl.gz | wc -l        # 응답 수
```

## 안전장치

- `END_AT`: 이 시각이 지나면 API를 부르지 않고 바로 끝나요.
- `DAILY_CAP`(기본 3000): 오늘(KST) `runs.csv` 줄 수가 이 값 이상이면 부르지 않아요.
- 둘 다 `keeper.yml`(평소 수집)과 `collect.yml`(손으로 실행) 위쪽 `env`에서 바꿔요.
- API 키는 레포 Secret `SEOUL_API_KEY`에만 있어요. 키가 들어가는 URL은 로그와 파일에 남기지 않아요.
- 도착 호출이 15분 수집에서 3회 연속 실패하거나, 20초 수집에서 절반 넘게 실패하거나 5분 내내 실패하면 그 keeper 실행이 끝날 때 실패로 표시돼요(GitHub 실패 메일). 수집과 다음 keeper 띄우기는 그대로 계속해요.

## keeper 다시 띄우기

Actions → keeper에 노란 점(도는 중)이 없으면 Actions → keeper → Run workflow (hours는 그대로 5.5).

## 손으로 한 번 돌려 보기

Actions → collect → Run workflow

- `mode: q15` — 지금 1회 수집 (시간대와 상관없이 `ALL` + 7호선 위치)
- `mode: am20` 또는 `pm20` — 20초 수집을 지금 `test_calls`번(기본 3번, 약 40초)

## 끝나면

`END_AT`이 지나면 keeper가 스스로 멈추고 다음 keeper도 띄우지 않아요. 그 뒤 Actions → keeper → ⋯ → Disable workflow로 지킴이 예약까지 꺼요.

## 출처

서울 열린데이터광장 「서울시 지하철 실시간 도착정보」, 「서울시 지하철 실시간 열차 위치정보」
