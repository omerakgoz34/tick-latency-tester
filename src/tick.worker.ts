import { probeOnce, tickBody } from "./probe";
import { TICK_MS, WARMUP_OK, inFlightCap, probeTimeout } from "./tick";
import type { Frame, InMsg, Quality, Sample } from "./types";

interface TickPort {
  onmessage: ((ev: MessageEvent<InMsg>) => void) | null;
  postMessage(message: Frame): void;
}

const scope = self as unknown as TickPort;

const RING = 512;
const MAX_MS = 500;

let session = 0;
let url = "";
let durationMs = 0;
let running = false;
let paused = false;
let abort = new AbortController();

let warmupLeft = WARMUP_OK;
let sent = 0;
let lost = 0;
let okCount = 0;
let skipped = 0;
let slips = 0;
let scored = 0;
let ema: number | null = null;
let emaAt = 0;
let jitter = 0;
let prevRtt: number | null = null;
let last: number | null = null;
let sum = 0;
let min: number | null = null;
let max: number | null = null;
let buckets = new Uint32Array(MAX_MS + 1);

const ringOk = new Uint8Array(RING);
const ringT = new Float64Array(RING);
let ringI = 0;
let ringN = 0;

const sendT = new Float64Array(256);
let sendI = 0;
let sendN = 0;

let spikeWeight = 0;
let spikeSamples = 0;
let batch: Sample[] = [];
let accum = 0;
let runStamp = 0;
let nextAt = 0;
let tickTimer = 0;
let postTimer = 0;
let inFlight = 0;

function reset() {
  warmupLeft = WARMUP_OK;
  sent = 0;
  lost = 0;
  okCount = 0;
  skipped = 0;
  slips = 0;
  scored = 0;
  ema = null;
  emaAt = 0;
  jitter = 0;
  prevRtt = null;
  last = null;
  sum = 0;
  min = null;
  max = null;
  buckets = new Uint32Array(MAX_MS + 1);
  ringI = 0;
  ringN = 0;
  sendI = 0;
  sendN = 0;
  batch = [];
  spikeWeight = 0;
  spikeSamples = 0;
  accum = 0;
  inFlight = 0;
}

function elapsed(now: number): number {
  return accum + (paused || !running ? 0 : now - runStamp);
}

function pushWindow(ok: boolean, t: number) {
  ringOk[ringI] = ok ? 1 : 0;
  ringT[ringI] = t;
  ringI = (ringI + 1) % RING;
  if (ringN < RING) ringN++;
}

function windowLoss(now: number): number {
  let n = 0;
  let misses = 0;
  const cutoff = now - 2000;
  for (let i = 0; i < ringN; i++) {
    const idx = (ringI - 1 - i + RING) % RING;
    if (ringT[idx] < cutoff) break;
    n++;
    if (ringOk[idx] === 0) misses++;
  }
  return n ? (misses / n) * 100 : 0;
}

function rate(now: number): number {
  let n = 0;
  const cutoff = now - 1000;
  for (let i = 0; i < sendN; i++) {
    const idx = (sendI - 1 - i + 256) % 256;
    if (sendT[idx] < cutoff) break;
    n++;
  }
  return n;
}

function noteSend(now: number) {
  sendT[sendI] = now;
  sendI = (sendI + 1) % 256;
  if (sendN < 256) sendN++;
}

function addRtt(rtt: number) {
  const bucket = Math.min(MAX_MS, Math.max(0, Math.round(rtt)));
  buckets[bucket]++;
  sum += rtt;
  if (min == null || rtt < min) min = rtt;
  if (max == null || rtt > max) max = rtt;
}

function percentile(p: number): number | null {
  const total = okCount;
  if (!total) return null;
  const target = Math.max(1, Math.ceil(total * p));
  let acc = 0;
  for (let i = 0; i <= MAX_MS; i++) {
    acc += buckets[i];
    if (acc >= target) return i === MAX_MS ? max : i;
  }
  return max;
}

function noteEma(rtt: number, now: number) {
  if (ema == null) {
    ema = rtt;
    emaAt = now;
    return;
  }
  const dt = Math.max(1, now - emaAt);
  emaAt = now;
  const alpha = 1 - Math.exp(-dt / 400);
  ema += alpha * (rtt - ema);
}

function noteSpike(rtt: number) {
  const baseline = percentile(0.5);
  if (baseline == null || baseline <= 0) return;
  spikeSamples++;
  const start = baseline + 0.5;
  if (rtt <= start) return;
  spikeWeight += (rtt - start) / 49.5;
}

function stabilityPct(): number | null {
  if (spikeSamples < 16) return null;
  const raw = 100 * (1 - (2 * spikeWeight) / spikeSamples);
  return Math.max(0, Math.min(100, raw));
}

function noteJitter(rtt: number) {
  if (prevRtt != null) {
    const d = Math.abs(rtt - prevRtt);
    jitter += (d - jitter) / 16;
  }
  prevRtt = rtt;
}

function qualityOf(arming: boolean, lossPct: number): Quality {
  if (!running || paused || arming) return "idle";
  if (lossPct >= 4 || jitter >= 20) return "bad";
  if (lossPct >= 1 || jitter >= 8) return "warn";
  return "good";
}

function build(now: number, runningFlag: boolean): Frame {
  const resolved = okCount + lost;
  const lossSession = resolved ? (lost / resolved) * 100 : 0;
  const lossWindow = windowLoss(now);
  const stuck = warmupLeft > 0 && lost >= 4;
  const arming = warmupLeft > 0 && !stuck;
  return {
    type: "frame",
    session,
    running: runningFlag,
    arming,
    paused,
    elapsedMs: elapsed(now),
    ema,
    last,
    jitter,
    lossWindow,
    lossSession,
    min,
    avg: okCount ? sum / okCount : null,
    max,
    p95: percentile(0.95),
    baseline: percentile(0.5),
    sent,
    lost,
    skipped,
    slips,
    scored,
    achievedHz: rate(now),
    stability: stabilityPct(),
    quality: runningFlag ? qualityOf(arming, lossWindow) : "idle",
    samples: batch,
  };
}

function post(runningFlag = running) {
  const now = performance.now();
  const msg = build(now, runningFlag);
  batch = [];
  scope.postMessage(msg);
}

function clearTimers() {
  clearTimeout(tickTimer);
  clearInterval(postTimer);
  tickTimer = 0;
  postTimer = 0;
}

function finish() {
  if (!running && !paused) return;
  running = false;
  paused = false;
  clearTimers();
  abort.abort();
  post(false);
}

function launch(now: number) {
  const cap = inFlightCap(ema);
  if (inFlight >= cap) {
    skipped++;
    return;
  }
  const epoch = session;
  const parent = abort.signal;
  const timeout = probeTimeout(ema);
  const dt = elapsed(now);
  inFlight++;
  sent++;
  noteSend(now);
  probeOnce(url, timeout, parent, tickBody(sent)).then((res) => {
    if (epoch !== session) return;
    inFlight--;
    if (!res.ok && res.discard) return;
    const doneAt = performance.now();
    if (res.ok) {
      last = res.rtt;
      if (warmupLeft > 0) {
        warmupLeft--;
        return;
      }
      noteSpike(res.rtt);
      okCount++;
      scored++;
      addRtt(res.rtt);
      noteEma(res.rtt, doneAt);
      noteJitter(res.rtt);
      pushWindow(true, doneAt);
      batch.push({ dt, rtt: res.rtt, ok: true });
      return;
    }
    lost++;
    scored++;
    pushWindow(false, doneAt);
    batch.push({ dt, rtt: res.rtt, ok: false });
  });
}

function schedule() {
  if (!running || paused) return;
  const now = performance.now();
  if (durationMs > 0 && elapsed(now) >= durationMs) {
    finish();
    return;
  }
  let guard = 0;
  while (now >= nextAt && guard < 3) {
    guard++;
    launch(now);
    nextAt += TICK_MS;
  }
  if (now - nextAt > 40) {
    slips += Math.floor((now - nextAt) / TICK_MS);
    nextAt = now + TICK_MS;
  }
  const wait = Math.max(0, nextAt - performance.now());
  tickTimer = setTimeout(schedule, wait) as unknown as number;
}

function start(nextSession: number, nextUrl: string, nextDuration: number) {
  abort.abort();
  clearTimers();
  abort = new AbortController();
  reset();
  session = nextSession;
  url = nextUrl;
  durationMs = nextDuration;
  running = true;
  paused = false;
  runStamp = performance.now();
  nextAt = runStamp + TICK_MS;
  postTimer = setInterval(() => {
    if (running) post(true);
  }, 125) as unknown as number;
  schedule();
}

function pause() {
  if (!running || paused) return;
  const now = performance.now();
  accum += now - runStamp;
  paused = true;
  clearTimeout(tickTimer);
  post(true);
}

function resume() {
  if (!running || !paused) return;
  paused = false;
  const now = performance.now();
  runStamp = now;
  nextAt = now + TICK_MS;
  schedule();
}

scope.onmessage = (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (msg.type === "start") start(msg.session, msg.url, msg.durationMs);
  else if (msg.type === "stop") finish();
  else if (msg.type === "pause") pause();
  else if (msg.type === "resume") resume();
};
