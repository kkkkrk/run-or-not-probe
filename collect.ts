// 뛸까말까 수집기 — 서울시 지하철 실시간 도착정보를 받아 data/ 아래에 쌓는다.
// 실행: node collect.ts   (Node 24, 설치할 것 없음)
//
//   MODE=q15   15분마다 1회. 도착 전체(ALL) + 7호선 위치
//              → raw 파일 2개, runs.csv 1줄, lines.csv 노선마다 1줄
//   MODE=am20  평일 출근. 09:30 KST까지 20초마다 ALL 1회
//              → raw/날짜/am-20s.jsonl.gz에 응답마다 한 줄, runs.csv 응답마다 1줄
//   MODE=pm20  평일 퇴근. 19:30 KST까지 같은 방식 → pm-20s.jsonl.gz
//
// 키가 URL 안에 들어 있다. URL·리다이렉트 주소는 로그나 파일에 남기지 않는다.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// ── 설정 (환경 변수) ─────────────────────────────────────────────
const KEY = process.env.SEOUL_API_KEY ?? "";
const MODE = process.env.MODE || "q15";
const END_AT = process.env.END_AT ? Date.parse(process.env.END_AT) : Infinity; // 지나면 부르지 않는다
const DAILY_CAP = Number(process.env.DAILY_CAP || 3000); // 오늘(KST) runs.csv 줄 수 상한
const MAX_CALLS = Number(process.env.MAX_CALLS || 400); // 20초 작업 한 번의 최대 호출 수
const MANUAL = process.env.MANUAL === "1"; // Actions 탭에서 손으로 실행했을 때

// ── 고정 값 ──────────────────────────────────────────────────────
const API = "http://swopenapi.seoul.go.kr/api/subway"; // https로 바꾸지 않는다
const ARRIVALS = "realtimeStationArrival/ALL"; // 307 → 정적 JSON. fetch가 따라간다
const POS7 = `realtimePosition/0/200/${encodeURIComponent("7호선")}`;
const ARRIVAL_FIELDS = [
  "subwayId", "statnId", "statnNm", "updnLine", "btrainNo", "bstatnId", "bstatnNm",
  "arvlCd", "arvlMsg2", "arvlMsg3", "barvlDt", "recptnDt", "ordkey", "btrainSttus",
];
const POS_FIELDS = ["trainNo", "statnId", "statnNm", "updnLine", "trainSttus", "recptnDt", "statnTid"];
const PENDING = new Set(["3", "4", "5", "99"]); // 전역출발 · 전역진입 · 전역도착 · 운행중
const OK_CODES = ["INFO-000", "INFO-200"]; // 정상 · 데이터 없음(새벽)
const INTERVAL_MS = 20_000;
const WINDOWS = {
  am20: { start: "07:10", end: "09:30", file: "am-20s" },
  pm20: { start: "17:10", end: "19:30", file: "pm-20s" },
};
const MAX_FILE_BYTES = 90 * 1024 * 1024; // GitHub는 100MB 넘는 파일을 받지 않는다
const RUNS = "data/runs.csv";
const RUNS_HEADER = "fetched_at_kst,weekday,mode,arrivals_code,arrivals_rows,pos7_code,pos7_rows,duration_ms,error";
const LINES = "data/lines.csv";
const LINES_HEADER = "fetched_at_kst,subwayId,rows,pending,pending_barvl_pos,stale_180s,future_recptn";

type Row = Record<string, unknown>;
type Call = { ok: boolean; code: string; rows: Row[]; error: string; at: Date; ms: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isObj = (v: unknown): v is Row => typeof v === "object" && v !== null;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)}KB`;
const why = (c: Call) => [c.code, c.error].filter(Boolean).join(" "); // 실패 이유 한 줄

// ── 시각: 러너는 UTC, 기록은 전부 KST ────────────────────────────
const KST = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul", hourCycle: "h23", weekday: "short",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function kst(d: Date) {
  const p: Record<string, string> = {};
  for (const { type, value } of KST.formatToParts(d)) p[type] = value;
  const date = `${p.year}-${p.month}-${p.day}`;
  const hhmm = `${p.hour}:${p.minute}`;
  return { date, hhmm, iso: `${date}T${hhmm}:${p.second}+09:00`, weekday: WEEKDAYS.indexOf(p.weekday) };
}

// 20초 작업이 도는 시간(평일 07:10~09:30, 17:10~19:30 KST)인가
function in20sWindow(d: Date): boolean {
  const { hhmm, weekday } = kst(d);
  if (weekday === 0 || weekday === 6) return false;
  return Object.values(WINDOWS).some((w) => hhmm >= w.start && hhmm < w.end);
}

// ── 키 가리기 ────────────────────────────────────────────────────
// 로그·CSV에 쓰기 전에 거친다. 키와 URL을 지우고 쉼표·줄바꿈을 없앤다.
function clean(message: string): string {
  let s = message;
  if (KEY) s = s.split(KEY).join("***").split(encodeURIComponent(KEY)).join("***");
  return s.replace(/https?:\/\/\S+/g, "(url)").replace(/[,"\s]+/g, " ").trim().slice(0, 120);
}

function errText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (e.name === "TimeoutError") return "timeout";
  return e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message;
}

// ── API 호출 ─────────────────────────────────────────────────────
async function call(path: string, listKey: string, timeoutMs: number): Promise<Call> {
  const at = new Date(); // 호출 직전 시각
  const done = (ok: boolean, code: string, rows: Row[], error: string): Call =>
    ({ ok, code, rows, error: clean(error), at, ms: Date.now() - at.getTime() });
  try {
    const res = await fetch(`${API}/${KEY}/json/${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return done(false, "", [], `HTTP ${res.status} JSON 아님`);
    }
    const top = isObj(body) ? body : {};
    const status = isObj(top.errorMessage) ? top.errorMessage : top; // 오류 응답은 code가 맨 위에 온다
    const code = typeof status.code === "string" ? status.code : "";
    if (OK_CODES.includes(code)) {
      const list = top[listKey];
      return done(true, code, Array.isArray(list) ? (list as Row[]) : [], "");
    }
    const message = typeof status.message === "string" ? status.message : "";
    return done(false, code, [], message || (code ? "" : `HTTP ${res.status} 응답에 code 없음`));
  } catch (e) {
    return done(false, "", [], errText(e));
  }
}

// 타임아웃 20초, 실패하면 10초 뒤 1회 재시도
async function callWithRetry(path: string, listKey: string): Promise<Call> {
  const first = await call(path, listKey, 20_000);
  if (first.ok) return first;
  await sleep(10_000);
  return call(path, listKey, 20_000);
}

// ── 파일 ─────────────────────────────────────────────────────────
// 슬림 행: 필요한 필드만, 값은 받은 그대로
function slim(rows: Row[], fields: string[]): Row[] {
  return rows.map((row) => {
    const out: Row = {};
    for (const f of fields) if (f in row) out[f] = row[f];
    return out;
  });
}

function appendLine(path: string, header: string, cols: (string | number)[]): void {
  if (!existsSync(path)) {
    mkdirSync("data", { recursive: true });
    writeFileSync(path, `${header}\n`);
  }
  appendFileSync(path, `${cols.join(",")}\n`);
}

// runs.csv의 기록 줄(헤더 제외)을 시각 순으로
function runLines(): string[] {
  if (!existsSync(RUNS)) return [];
  return readFileSync(RUNS, "utf8").split("\n").filter((l) => l && !l.startsWith("fetched_at_kst")).sort();
}

const countToday = (date: string) => runLines().filter((l) => l.startsWith(date)).length;
const arrivalsFailed = (line: string) => !OK_CODES.includes(line.split(",")[3]);

// lines.csv: 노선(subwayId)마다 1줄. 역 단위 계산은 여기서 하지 않는다 (raw로 나중에)
function appendLineStats(fetchedAt: string, at: Date, rows: Row[]): number {
  const stats = new Map<string, number[]>(); // [rows, pending, pending_barvl_pos, stale_180s, future_recptn]
  for (const r of rows) {
    const id = String(r.subwayId ?? "");
    const s = stats.get(id) ?? [0, 0, 0, 0, 0];
    s[0]++;
    if (PENDING.has(String(r.arvlCd))) {
      s[1]++;
      if (Number(r.barvlDt) > 0) s[2]++;
    }
    // recptnDt는 "2026-10-29 16:01:50" (KST, 시간대 표기 없음)
    const age = (at.getTime() - Date.parse(`${String(r.recptnDt).replace(" ", "T")}+09:00`)) / 1000;
    if (age > 180) s[3]++;
    if (age < -60) s[4]++;
    stats.set(id, s);
  }
  const sorted = [...stats].sort(([a], [b]) => a.localeCompare(b));
  for (const [id, s] of sorted) appendLine(LINES, LINES_HEADER, [fetchedAt, id, ...s]);
  return sorted.length;
}

// ── 상시 15분 ────────────────────────────────────────────────────
async function runQ15(): Promise<number> {
  const before = runLines();
  const t0 = Date.now();
  const arr = await callWithRetry(ARRIVALS, "realtimeArrivalList");
  const pos = await callWithRetry(POS7, "realtimePositionList"); // 두 호출은 차례로
  const k = kst(arr.at); // fetchedAt = 도착 호출 직전 시각
  const dir = `data/raw/${k.date}`;
  const stamp = k.hhmm.replace(":", "");
  // 응답을 받았으면 { fetchedAt, code, rows } 한 파일로 저장
  const save = (name: string, c: Call, fields: string[]): void => {
    if (!c.ok) {
      console.log(`${name}: 실패 ${why(c)}`);
      return;
    }
    mkdirSync(dir, { recursive: true });
    const gz = gzipSync(JSON.stringify({ fetchedAt: k.iso, code: c.code, rows: slim(c.rows, fields) }));
    writeFileSync(`${dir}/${stamp}-${name}.json.gz`, gz);
    console.log(`${name}: ${c.code} ${c.rows.length}행 · raw ${kb(gz.length)}`);
  };

  console.log(`[q15] ${k.iso} (요일 ${k.weekday})`);
  save("arrivals", arr, ARRIVAL_FIELDS);
  save("pos7", pos, POS_FIELDS);
  const error = [arr.error, pos.error].filter(Boolean).join(" / ");
  appendLine(RUNS, RUNS_HEADER, [k.iso, k.weekday, "q15", arr.code, arr.rows.length, pos.code, pos.rows.length, Date.now() - t0, error]);
  if (arr.ok) console.log(`lines.csv: ${appendLineStats(k.iso, arr.at, arr.rows)}줄`);

  // 도착 호출이 3회 연속 실패면 exit 1 → GitHub 실패 메일
  if (!arr.ok && before.length >= 2 && before.slice(-2).every(arrivalsFailed)) {
    console.log("::error::도착 호출 3회 연속 실패");
    return 1;
  }
  return 0;
}

// ── 출근·퇴근 20초 ───────────────────────────────────────────────
// 응답 한 개 = jsonl 한 줄. 줄마다 따로 gzip해서 덧붙이므로 중간에 멈춰도 파일은 그대로 읽힌다.
function appendGzLine(date: string, name: string, line: string): string {
  const gz = gzipSync(`${line}\n`);
  mkdirSync(`data/raw/${date}`, { recursive: true });
  for (let part = 1; ; part++) {
    const path = `data/raw/${date}/${name}${part === 1 ? "" : `.${part}`}.jsonl.gz`;
    if (!existsSync(path) || statSync(path).size + gz.length <= MAX_FILE_BYTES) {
      appendFileSync(path, gz);
      return path;
    }
  }
}

async function run20s(mode: "am20" | "pm20"): Promise<number> {
  const w = WINDOWS[mode];
  const start = kst(new Date());
  // 손으로 실행하면 시간대와 상관없이 MAX_CALLS번 부른다
  const windowEnd = MANUAL ? Infinity : Date.parse(`${start.date}T${w.end}:00+09:00`);
  const stopAt = Math.min(windowEnd, END_AT);
  let today = countToday(start.date);
  let calls = 0;
  let fails = 0;
  let streak = 0; // 연속 실패
  let path = "";
  console.log(`[${mode}] ${start.iso} 시작 · ${MANUAL ? "손으로 실행" : `${w.end}까지`} · 최대 ${MAX_CALLS}회`);

  const t0 = Date.now();
  for (let i = 0; i < MAX_CALLS; i++) {
    const due = t0 + i * INTERVAL_MS; // 20초 눈금. 호출이 늦어져도 밀리지 않는다
    if (due >= stopAt) break;
    if (due > Date.now()) await sleep(due - Date.now());
    if (today >= DAILY_CAP) {
      console.log(`DAILY_CAP ${DAILY_CAP} 도달 → 멈춤`);
      break;
    }
    const c = await call(ARRIVALS, "realtimeArrivalList", 15_000); // 다음 눈금 전에 끝나게 15초, 재시도 없음
    const k = kst(c.at);
    if (c.ok) {
      path = appendGzLine(k.date, w.file, JSON.stringify({ fetchedAt: k.iso, code: c.code, rows: slim(c.rows, ARRIVAL_FIELDS) }));
    }
    appendLine(RUNS, RUNS_HEADER, [k.iso, k.weekday, mode, c.code, c.rows.length, "", "", c.ms, c.error]);
    calls++;
    today++;
    if (c.ok) {
      streak = 0;
    } else {
      fails++;
      streak++;
      console.log(`${k.iso} 실패 ${why(c)}`);
    }
    if (streak >= 15) {
      console.log("연속 15회(5분) 실패 → 멈춤");
      break;
    }
    if (calls === 1 || calls % 30 === 0) console.log(`${k.iso} ${calls}회째 · ${c.code} ${c.rows.length}행 · ${c.ms}ms`);
  }

  const size = path ? ` · ${path} ${(statSync(path).size / 1024 / 1024).toFixed(1)}MB` : "";
  console.log(`[${mode}] 끝 · ${calls}회 (실패 ${fails})${size}`);
  if (streak >= 15 || fails * 2 > calls) {
    console.log(`::error::20초 수집 실패가 많음 (${fails}/${calls})`);
    return 1;
  }
  return 0;
}

// ── 시작 ─────────────────────────────────────────────────────────
function configError(message: string): number {
  console.log(`::error::${message}`);
  return 1;
}

async function main(): Promise<number> {
  if (MODE !== "q15" && MODE !== "am20" && MODE !== "pm20") return configError("MODE는 q15 · am20 · pm20 중 하나");
  if (Number.isNaN(END_AT)) return configError("END_AT을 날짜로 읽을 수 없음");
  if (!(DAILY_CAP > 0) || !(MAX_CALLS > 0)) return configError("DAILY_CAP · MAX_CALLS는 0보다 큰 숫자");

  const now = new Date();
  if (now.getTime() >= END_AT) {
    console.log("END_AT이 지나서 API를 부르지 않고 끝냄");
    return 0;
  }
  if (MODE === "q15" && !MANUAL && in20sWindow(now)) {
    console.log("20초 작업이 도는 시간이라 바로 끝냄");
    return 0;
  }
  if (!KEY) {
    // 예약 실행은 조용히 넘어간다 (Secret 등록 전에 실패 메일이 쏟아지지 않게)
    console.log(`::${MANUAL ? "error" : "warning"}::SEOUL_API_KEY가 비어 있음 — 레포 Secret을 등록해야 수집이 시작됨`);
    return MANUAL ? 1 : 0;
  }
  if (countToday(kst(now).date) >= DAILY_CAP) {
    console.log(`오늘 runs.csv가 이미 DAILY_CAP(${DAILY_CAP})줄 이상이라 부르지 않고 끝냄`);
    return 0;
  }
  return MODE === "q15" ? runQ15() : run20s(MODE);
}

process.exitCode = await main().catch((e: unknown) => configError(clean(errText(e))));
