/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { PreviewHostBridge } from "./bridge";
import {
  getPoints,
  getSnap,
  mountEngine,
  startRange,
  stopRange,
  clearHistory,
  subscribe,
  type Snap,
} from "./engine";
import { clock, jitterTone, lossTone, ms, pct, stabilityTone, tone } from "./format";
import { paintGraph } from "./graph";
import { getLobby, subscribeLobby, type EdgeState } from "./lobby";
import { REGIONS, type Region } from "./regions";
import { MOVE_BYTES, BUSY_BYTES } from "./probe";
import { TICK_HZ, ticksFor } from "./tick";

function toneText(kind: "good" | "warn" | "bad" | "muted"): string {
  if (kind === "good") return "text-good";
  if (kind === "warn") return "text-warn";
  if (kind === "bad") return "text-red";
  return "text-muted";
}

function pingText(kind: "good" | "warn" | "bad" | "muted"): string {
  if (kind === "warn") return "text-orange";
  return toneText(kind);
}

const REGION_KEY = "tick-latency-region";
const APP_VERSION = "v0.5.1";

const MODES = [
  { id: "15", label: "15s", ms: 15_000 },
  { id: "30", label: "30s", ms: 30_000 },
  { id: "60", label: "60s", ms: 60_000 },
  { id: "live", label: "Live", ms: 0 },
] as const;

function readRegion(): string | null {
  try {
    const id = localStorage.getItem(REGION_KEY);
    return REGIONS.some((region) => region.id === id) ? id : null;
  } catch {
    return null;
  }
}

function bestId(rows: Record<string, EdgeState>): string | null {
  let best: { id: string; rtt: number } | null = null;
  for (const region of REGIONS) {
    const row = rows[region.id];
    if (!row || row.rtt == null) continue;
    if (!best || row.rtt < best.rtt) best = { id: region.id, rtt: row.rtt };
  }
  return best?.id ?? null;
}

function edgeRank(row: EdgeState | undefined): number {
  return row?.rtt == null ? Number.POSITIVE_INFINITY : row.rtt;
}

function orderedRegions(rows: Record<string, EdgeState>): Region[] {
  const index = new Map(REGIONS.map((region, i) => [region.id, i]));
  return [...REGIONS].sort((a, b) => {
    const delta = edgeRank(rows[a.id]) - edgeRank(rows[b.id]);
    if (delta !== 0) return delta;
    return (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0);
  });
}

function when(at: number): string {
  return new Date(at).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Graph() {
  const svgRef = useRef<SVGSVGElement>(null);
  const gridRef = useRef<SVGGElement>(null);
  const lossRef = useRef<SVGPathElement>(null);
  const lineRef = useRef<SVGPolylineElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const grid = gridRef.current;
    const losses = lossRef.current;
    const trace = lineRef.current;
    if (!svg || !grid || !losses || !trace) return;
    let raf = 0;
    let alive = true;
    const draw = () => {
      const current = getSnap();
      paintGraph(svg, grid, losses, trace, getPoints(), current.elapsedMs, current.running);
    };
    const loop = () => {
      raf = 0;
      if (!alive) return;
      draw();
      if (getSnap().running) raf = requestAnimationFrame(loop);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(loop);
    };
    kick();
    const unsub = subscribe(() => {
      if (getSnap().running) kick();
      else draw();
    });
    const observer = new ResizeObserver(draw);
    observer.observe(svg);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      unsub();
    };
  }, []);

  return (
    <svg
      ref={svgRef}
      class="block h-full w-full select-none [-webkit-touch-callout:none]"
      role="img"
      aria-label="Ping over the last 10 seconds"
    >
      <g ref={gridRef} />
      <path ref={lossRef} class="fill-none stroke-red stroke-[1.5px]" />
      <polyline ref={lineRef} class="fill-none stroke-paper stroke-[1.5px]" />
    </svg>
  );
}

export function App() {
  const [snap, setSnap] = useState<Snap>(getSnap);
  const [lobby, setLobby] = useState(getLobby);
  const [regionId, setRegionId] = useState<string | null>(readRegion);
  const [mode, setMode] = useState<(typeof MODES)[number]["id"]>("15");

  useEffect(() => {
    const unsub = subscribe(() => setSnap(getSnap()));
    const unsubLobby = subscribeLobby(() => setLobby(getLobby()));
    const stop = mountEngine();
    setSnap(getSnap());
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") stopRange();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unsub();
      unsubLobby();
      stop();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (regionId) return;
    const id = bestId(lobby);
    if (id) setRegionId(id);
  }, [lobby, regionId]);

  const region = REGIONS.find((item) => item.id === regionId) ?? null;
  const best = bestId(lobby);
  const shown = snap.arming || snap.ema == null ? snap.last : snap.ema;
  const pingTone = tone(shown);
  const recent = getPoints().slice(-48);
  const cells = recent.length ? recent : Array.from({ length: 48 }, () => null);
  const skipDenom = snap.sent + snap.skipped;
  const skipRate = skipDenom ? snap.skipped / skipDenom : 0;
  const duration = MODES.find((item) => item.id === mode)?.ms ?? 15_000;
  const bestStability = snap.runs.reduce<number | null>((best, run) => {
    if (typeof run.stability !== "number") return best;
    return best == null || run.stability > best ? run.stability : best;
  }, null);
  const icon = `${import.meta.env.BASE_URL}favicon.svg`;

  return (
    <div class="flex min-h-full flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <PreviewHostBridge />
      <header class="flex items-center justify-between gap-3 border-b border-line px-4 py-5">
        <div class="flex min-w-0 items-center gap-[0.7rem]">
          <img class="h-9 w-9 shrink-0" src={icon} alt="" width="36" height="36" />
          <div>
            <p class="m-0 text-[0.72rem] font-semibold tracking-[0.16em] text-red">
              128-tick netcode
            </p>
            <p class="m-0 text-[clamp(1.05rem,3.4vw,1.45rem)] font-semibold leading-none tracking-[0.08em] text-paper">
              <b class="font-semibold text-red">TICK</b> LATENCY TESTER
            </p>
            <p class="m-0 mt-[0.2rem] text-[0.68rem] tracking-[0.08em] text-muted">{APP_VERSION}</p>
          </div>
        </div>
        <div class="flex shrink-0 flex-col items-end tracking-[0.12em]">
          <span class="text-[0.68rem] text-muted">UDP PATH</span>
          <strong
            class={`text-[1.25rem] font-semibold tracking-[0.04em] tabular-nums ${pingText(snap.udpState === "blocked" ? "bad" : tone(snap.udp))}`}
          >
            {snap.udpState === "blocked"
              ? "Blocked"
              : snap.udp == null
                ? "…"
                : `${ms(snap.udp)} ms`}
          </strong>
        </div>
      </header>
      <div class="grid min-h-0 flex-1 grid-cols-1 min-[861px]:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
        <aside class="max-h-[15.5rem] min-h-0 overflow-auto border-b border-line min-[861px]:max-h-none min-[861px]:border-r min-[861px]:border-b-0">
          <p class="mx-[0.85rem] mt-4 mb-3 text-[0.78rem] tracking-[0.04em] text-muted">
            Public city edges. Not game servers.
          </p>
          <div class="pt-2">
            {orderedRegions(lobby).map((item) => (
              <EdgeButton
                key={item.id}
                region={item}
                row={lobby[item.id]}
                selected={item.id === regionId}
                best={item.id === best}
                locked={snap.running}
                onPick={setRegionId}
              />
            ))}
          </div>
        </aside>
        <main class="flex min-w-0 flex-col gap-[1.45rem] overflow-auto p-4">
          <div>
            <h1 class="m-0 text-[1.55rem] font-semibold tracking-[0.06em] text-paper">
              {region ? `${region.code}  ${region.city}` : "Pick a city"}
            </h1>
            <p class="m-0 mt-2 text-[0.85rem] tracking-[0.08em] text-muted">
              {snap.running ? clock(snap.elapsedMs) : `${TICK_HZ} hertz target`}
              {" · "}
              7.8 ms tick
            </p>
          </div>
          {snap.running && snap.paused && (
            <p class="m-0 border-l-[3px] border-warn px-[0.55rem] py-[0.35rem] text-[0.95rem] font-semibold tracking-[0.16em] text-warn">
              PAUSED
            </p>
          )}
          {snap.running && !snap.paused && snap.arming && (
            <p class="m-0 border-l-[3px] border-muted px-[0.55rem] py-[0.35rem] text-[0.95rem] font-semibold tracking-[0.16em] text-paper">
              ARMING LINK
            </p>
          )}
          {snap.running && !snap.paused && !snap.arming && snap.quality === "bad" && (
            <p
              class="m-0 border-l-[3px] border-red px-[0.55rem] py-[0.35rem] text-[0.95rem] font-semibold tracking-[0.16em] text-red"
              role="status"
            >
              NETWORK PROBLEM
            </p>
          )}
          <div class="flex flex-col items-stretch gap-4 min-[861px]:flex-row min-[861px]:items-end min-[861px]:justify-between">
            <div>
              <p
                class={`m-0 flex items-end gap-2 font-semibold tabular-nums ${pingText(pingTone)}`}
              >
                {shown == null ? (
                  <span class="mb-1 h-1.5 w-12 bg-current" />
                ) : (
                  <span class="text-[clamp(4.2rem,16vw,6.6rem)] leading-none tracking-[-0.03em]">
                    {ms(shown)}
                  </span>
                )}
                <span class="mb-1 text-[1.1rem] tracking-[0.14em] text-muted">ms</span>
              </p>
              <p class="m-0 mt-1 text-[0.95rem] tracking-[0.08em] text-muted">
                {shown == null
                  ? "Waiting for the first tick"
                  : `${ticksFor(shown).toFixed(1)} server ticks`}
                {snap.last != null && snap.ema != null ? ` · last ${ms(snap.last)}` : ""}
              </p>
            </div>
            <div class="grid flex-1 grid-cols-3 gap-[0.45rem] min-[861px]:max-w-[28rem]">
              <div class="min-w-0 border border-line bg-panel px-[0.65rem] pt-3.5 pb-2.5">
                <b
                  class={`block text-[1.55rem] leading-none font-semibold tabular-nums ${snap.scored ? pingText(jitterTone(snap.jitter, snap.baseline ?? shown)) : "text-muted"}`}
                >
                  {snap.scored ? `${ms(snap.jitter, 1)} ms` : "—"}
                </b>
                <span class="mt-1.5 block text-[0.72rem] tracking-[0.04em] text-muted">Jitter</span>
              </div>
              <div class="min-w-0 border border-line bg-panel px-[0.65rem] pt-3.5 pb-2.5">
                <b
                  class={`block text-[1.55rem] leading-none font-semibold tabular-nums ${snap.scored ? pingText(lossTone(snap.lossWindow)) : "text-muted"}`}
                >
                  {snap.scored ? pct(snap.lossWindow) : "—"}
                </b>
                <span class="mt-1.5 block text-[0.72rem] tracking-[0.04em] text-muted">Loss, 2 seconds</span>
              </div>
              <div class="min-w-0 border border-line bg-panel px-[0.65rem] pt-3.5 pb-2.5">
                <b class="block text-[1.55rem] leading-none font-semibold text-paper tabular-nums">
                  {snap.p95 == null ? "—" : ms(snap.p95)}
                </b>
                <span class="mt-1.5 block text-[0.72rem] tracking-[0.04em] text-muted">95th percentile</span>
              </div>
            </div>
          </div>
          <div class="flex flex-col gap-[0.4rem]">
            <div class="relative h-44 border border-line bg-panel-2 select-none [-webkit-touch-callout:none] min-[861px]:h-64">
            <Graph />
            {snap.sent === 0 && (
              <p class="pointer-events-none absolute inset-0 m-0 flex items-center justify-center tracking-[0.12em] text-muted">
                Tick stream appears here
              </p>
            )}
          </div>
          <div class="flex h-[0.55rem] gap-0.5" aria-hidden="true">
            {cells.map((point, index) => (
              <span
                key={index}
                class={
                  point == null ? "flex-1 bg-line" : point.ok ? "flex-1 bg-paper" : "flex-1 bg-red"
                }
              />
            ))}
            </div>
          </div>
          <p class="m-0 flex flex-wrap gap-x-[0.85rem] gap-y-1 text-[0.85rem] tracking-[0.05em] text-muted tabular-nums">
            <span class={snap.min == null ? undefined : pingText(tone(snap.min))}>
              Minimum {ms(snap.min)}
            </span>
            <span class={snap.avg == null ? undefined : pingText(tone(snap.avg))}>
              Average {ms(snap.avg)}
            </span>
            <span class={snap.max == null ? undefined : pingText(tone(snap.max))}>
              Maximum {ms(snap.max)}
            </span>
            <span class={snap.scored ? pingText(lossTone(snap.lossSession)) : undefined}>
              Session loss {snap.scored ? pct(snap.lossSession) : "—"}
            </span>
            <span>
              {snap.achievedHz}/{TICK_HZ} hertz
            </span>
            <span>
              {MOVE_BYTES}–{BUSY_BYTES} bytes
            </span>
          </p>
          {skipRate > 0.12 && snap.sent > 30 && (
            <p class="m-0 text-[0.85rem] text-warn">
              Some ticks were skipped so a slow reply would not queue locally and inflate the ping.
            </p>
          )}
          <div class="flex flex-wrap items-stretch gap-[0.55rem]">
            {snap.running ? (
              <button
                type="button"
                class="mx-1 min-h-[3.25rem] flex-1 basis-48 -skew-x-[10deg] cursor-pointer border border-paper bg-transparent text-[1.35rem] font-semibold tracking-[0.16em] text-paper uppercase"
                onClick={stopRange}
              >
                <span class="inline-block skew-x-[10deg]">Stop</span>
              </button>
            ) : (
              <button
                type="button"
                class="mx-1 min-h-[3.25rem] flex-1 basis-48 -skew-x-[10deg] cursor-pointer border-0 bg-red text-[1.35rem] font-semibold tracking-[0.16em] text-bg uppercase enabled:hover:bg-[color-mix(in_srgb,var(--color-red)_86%,white)] disabled:cursor-not-allowed disabled:bg-[#7a2a32] disabled:text-paper"
                disabled={!region}
                onClick={() => {
                  if (!region) return;
                  try {
                    localStorage.setItem(REGION_KEY, region.id);
                  } catch {
                    // Ignore private mode.
                  }
                  startRange(region, duration);
                }}
              >
                <span class="inline-block skew-x-[10deg]">Start test</span>
              </button>
            )}
            <div
              class="flex min-h-[3.25rem] flex-[2_1_16rem] border border-line"
              role="group"
              aria-label="Duration"
            >
              {MODES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  class="flex-1 cursor-pointer border-0 bg-transparent font-semibold tracking-[0.12em] text-muted uppercase aria-pressed:bg-paper aria-pressed:text-bg disabled:cursor-not-allowed"
                  aria-pressed={mode === item.id}
                  disabled={snap.running}
                  onClick={() => setMode(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          {snap.runs.length > 0 && (
            <section>
              <div class="mb-2 flex w-fit items-center gap-2">
                <p class="m-0 text-[0.72rem] tracking-[0.14em] text-muted">Test History</p>
                <button
                  type="button"
                  class="cursor-pointer border border-line bg-transparent px-2 py-1 text-[0.72rem] tracking-[0.08em] text-muted"
                  onClick={clearHistory}
                >
                  Clear
                </button>
              </div>
              <ol class="m-0 flex list-none flex-col gap-[0.2rem] overflow-x-auto p-0">
                {snap.runs.map((run) => {
                  const stability = typeof run.stability === "number" ? run.stability : null;
                  const leading = stability != null && stability === bestStability;
                  return (
                    <li
                      key={run.at}
                      class="flex flex-wrap gap-x-[0.85rem] gap-y-[0.35rem] text-[0.9rem] text-muted tabular-nums"
                    >
                      <span
                        class={
                          stability == null
                            ? "text-paper"
                            : `${leading ? "font-semibold " : ""}${pingText(stabilityTone(stability))}`
                        }
                      >
                        Stability {stability == null ? "—" : pct(stability)}
                        {leading ? " Best" : ""}
                      </span>
                      <span>{run.code}</span>
                      <span>{ms(run.avg)} ms</span>
                      <span>Jitter {ms(run.jitter, 1)} ms</span>
                      <span>Loss {pct(run.loss)}</span>
                      <span>
                        {run.seconds}s · {when(run.at)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
          <section class="text-[0.92rem] text-muted">
            <h2 class="m-0 mb-4 text-[0.95rem] font-semibold tracking-[0.1em] text-paper">
              How this measures
            </h2>
            <p class="mb-4 max-w-[42rem] text-[0.78rem] tracking-[0.04em] text-warn">
              This tool only intended to test 128-tick latency stability similar to how FPS games
              work using Amazon AWS servers. This is not an actual raw ping test for games.
            </p>
            <p class="mb-4 max-w-[42rem]">
              A 128-tick shooter sends a packet every 7.8 ms and times the round trip. This does
              that on a warm HTTPS/2 connection. Most ticks upload {MOVE_BYTES} bytes. Every eighth
              tick uploads {BUSY_BYTES} bytes, closer to a busy client update than an empty check.
              Handshake samples are thrown out. The reply stays short. The edge does not send a
              world snapshot back.
            </p>
            <p class="mb-4 max-w-[42rem]">
              Jitter is the RFC 3550 average. Loss is a probe that was sent and did not return.
              Stopping the test does not count as loss. If the link cannot hold that many probes in
              flight, extra ticks are skipped instead of queued.
            </p>
            <p class="mb-4 max-w-[42rem]">
              UDP PATH is a STUN datagram to the nearest public relay. That number is closer to
              in-game ping. The city list is a cloud edge in that city, not a game server. A real
              match can be lower where the game peers off the public internet.
            </p>
            <p class="mb-4 max-w-[42rem]">
              Stability is calculated using how high and how many times ping spikes occurs relative to
              measured baseline ping. A sample counts only when it is more than 0.5 ms above the
              baseline ping. It counts as one full spike at 50 ms above the baseline ping, and as more
              if it goes higher. The score falls to 0% when half of the samples are full spikes.
            </p>
            <p class="mb-4 max-w-[42rem]">
              A live range is a few megabytes a minute. The screen stays awake while it runs.
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}

function EdgeButton({
  region,
  row,
  selected,
  best,
  locked,
  onPick,
}: {
  region: Region;
  row: EdgeState | undefined;
  selected: boolean;
  best: boolean;
  locked: boolean;
  onPick: (id: string) => void;
}) {
  const offline = (row?.fails ?? 0) >= 2 && row?.rtt == null;
  const value = row?.rtt ?? null;
  return (
    <button
      type="button"
      class={
        selected
          ? "grid w-full min-h-11 cursor-pointer grid-cols-[2.7rem_minmax(0,1fr)_auto] items-center gap-[0.45rem] border-y-0 border-r-0 border-l-2 border-l-red bg-panel px-[0.85rem] py-[0.45rem] text-left font-[inherit] text-paper disabled:cursor-not-allowed disabled:opacity-70"
          : "grid w-full min-h-11 cursor-pointer grid-cols-[2.7rem_minmax(0,1fr)_auto] items-center gap-[0.45rem] border-y-0 border-r-0 border-l-2 border-l-transparent bg-transparent px-[0.85rem] py-[0.45rem] text-left font-[inherit] text-paper disabled:cursor-not-allowed disabled:opacity-70"
      }
      aria-pressed={selected}
      disabled={locked}
      onClick={() => onPick(region.id)}
    >
      <span class="font-semibold tracking-[0.06em]">{region.code}</span>
      <span class="truncate text-[0.92rem] text-muted">
        {region.city}
        {best && (
          <em class="ml-[0.4rem] text-[0.72rem] tracking-[0.08em] text-red not-italic">Best</em>
        )}
      </span>
      <span class={`text-[1.2rem] font-semibold tabular-nums ${pingText(tone(value))}`}>
        {offline ? "Off" : value == null ? "···" : ms(value)}
      </span>
    </button>
  );
}
