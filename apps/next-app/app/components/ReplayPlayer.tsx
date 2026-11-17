"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Replayer } from "rrweb";
// rrweb 재생 CSS는 app/console.css로 이동했다 (SSR에 실려 FOUC 방지).
import { ReplayTimeline, type Marker } from "./ReplayTimeline";
import { deriveMarkers, type TimelineDocLike } from "../lib/replayMarkers.mjs";
import { replayUrl } from "../lib/replayUrl.mjs";

export type { Marker };

type ReplayData = {
  sessionId: string;
  engine: string;
  segments: number;
  startedAt: string;
  endedAt: string;
  rrwebEvents: ConstructorParameters<typeof Replayer>[0];
};

type Status = "loading" | "ready" | "notfound" | "error";

const SPEEDS = [1, 2, 4];

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export default function ReplayPlayer({
  sessionId,
  days,
  traceId,
  timelineDocs
}: {
  sessionId: string;
  days: number;
  traceId?: string;
  timelineDocs: TimelineDocLike[];
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [data, setData] = useState<ReplayData | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [currentMs, setCurrentMs] = useState(0);
  const [totalMs, setTotalMs] = useState(0);
  // Origin of the player clock. /api/replay's startedAt is the segment *upload* time and
  // trails the first recorded rrweb event by seconds, so deriving markers against it made
  // every atMs negative and Math.max(0, …) collapsed the whole row onto left:0%.
  // Replayer.getMetaData() is the single source of truth: startTime is the first event's
  // timestamp and totalTime is measured from that same origin, which is also what
  // getCurrentTime() and the scrubber report — one clock for markers, playhead and duration.
  const [originMs, setOriginMs] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const replayerRef = useRef<Replayer | null>(null);

  // 1. Fetch the merged v2 event stream.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setData(null);
    fetch(replayUrl(sessionId, days, traceId))
      .then(async res => {
        if (cancelled) return;
        if (res.status === 404) {
          setStatus("notfound");
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const json = (await res.json()) as ReplayData;
        if (cancelled) return;
        setData(json);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, days, traceId]);

  // 2. Instantiate the Replayer once the container and events are ready.
  useEffect(() => {
    const root = containerRef.current;
    if (!data || !root) return;
    const replayer = new Replayer(data.rrwebEvents, { root, skipInactive: true });
    replayerRef.current = replayer;
    const meta = replayer.getMetaData();
    setTotalMs(meta.totalTime);
    setOriginMs(meta.startTime);
    setCurrentMs(0);
    setIsPlaying(false);
    return () => {
      replayer.pause();
      replayer.destroy();
      replayerRef.current = null;
    };
  }, [data]);

  // Markers share the Replayer's origin, so they land on the same 0..totalMs axis as the
  // scrubber. Before the Replayer mounts totalMs is still 0 and ReplayTimeline renders nothing.
  const markers: Marker[] = useMemo(
    () => (originMs > 0 ? deriveMarkers(timelineDocs, originMs) : []),
    [timelineDocs, originMs]
  );

  // 2b. Scale the recorded viewport down to the card width so it never overflows.
  useEffect(() => {
    const stage = containerRef.current;
    const replayer = replayerRef.current;
    if (!data || !stage || !replayer) return;
    const fit = () => {
      const wrapper = stage.querySelector<HTMLElement>(".replayer-wrapper");
      const iframe = replayer.iframe;
      const recordedWidth = iframe?.offsetWidth || wrapper?.offsetWidth || 0;
      const recordedHeight = iframe?.offsetHeight || wrapper?.offsetHeight || 0;
      if (!wrapper || !recordedWidth || !recordedHeight) return;
      const scale = stage.clientWidth / recordedWidth;
      wrapper.style.transformOrigin = "top left";
      wrapper.style.transform = `scale(${scale})`;
      stage.style.height = `${recordedHeight * scale}px`;
    };
    fit();
    replayer.on("resize", fit);
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => {
      observer.disconnect();
    };
  }, [data]);

  // 3. Apply speed changes live.
  useEffect(() => {
    replayerRef.current?.setConfig({ speed });
  }, [speed]);

  // 4. Poll playhead while playing.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      const replayer = replayerRef.current;
      if (replayer) {
        const t = replayer.getCurrentTime();
        setCurrentMs(t);
        if (totalMs && t >= totalMs) {
          replayer.pause();
          setIsPlaying(false);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, totalMs]);

  const togglePlay = () => {
    const replayer = replayerRef.current;
    if (!replayer) return;
    if (isPlaying) {
      replayer.pause();
      setIsPlaying(false);
    } else {
      replayer.play(currentMs >= totalMs ? 0 : currentMs);
      setIsPlaying(true);
    }
  };

  const seek = (ms: number) => {
    const replayer = replayerRef.current;
    if (!replayer) return;
    const offset = Math.max(0, Math.min(ms, totalMs));
    replayer.pause();
    replayer.play(offset);
    setIsPlaying(true);
    setCurrentMs(offset);
  };

  if (status === "loading") {
    return <p className="summary">리플레이 불러오는 중…</p>;
  }
  if (status === "notfound") {
    return <p className="summary">이 세션에는 v2 리플레이가 없습니다.</p>;
  }
  if (status === "error") {
    return <p className="summary">리플레이를 불러오지 못했습니다.</p>;
  }

  return (
    <section className="timelinePanel full">
      <header>
        <h3>세션 리플레이 (rrweb)</h3>
        <span>{data ? `세그먼트 ${data.segments}개` : ""}</span>
      </header>
      <div className="replayPlayer">
        <div className="replayStage" ref={containerRef} aria-label="rrweb 리플레이" />
      </div>
      <div className="replayControls">
        <button className="replayPlayToggle playButton" onClick={togglePlay} type="button">
          {isPlaying ? "일시정지" : "재생"}
        </button>
        <div className="replaySpeeds" aria-label="재생 속도">
          {SPEEDS.map(value => (
            <button
              className={value === speed ? "active" : ""}
              key={value}
              onClick={() => setSpeed(value)}
              type="button"
            >
              {value}x
            </button>
          ))}
        </div>
        <input
          aria-label="재생 진행률"
          className="replayScrubber"
          max={totalMs || 0}
          min={0}
          onChange={event => seek(Number(event.currentTarget.value))}
          step={100}
          type="range"
          value={Math.min(currentMs, totalMs || 0)}
        />
        <span className="replayTime">
          {clock(currentMs)} / {clock(totalMs)}
        </span>
      </div>
      <ReplayTimeline markers={markers} total={totalMs} onSeek={seek} />
    </section>
  );
}
