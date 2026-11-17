"use client";

import { useEffect, useRef, useState } from "react";
import type { WireframeFrame, WireframeNode } from "@jaytrace/replay-core";
import { frameAtTime } from "../lib/wireframeFrames.mjs";
import { replayUrl } from "../lib/replayUrl.mjs";
import { ReplayTimeline, type Marker } from "./ReplayTimeline";

export type { Marker };

type ReplayData = {
  sessionId: string;
  engine: string;
  segments: number;
  startedAt: string;
  endedAt: string;
  wireframeFrames: WireframeFrame[];
};

type Status = "loading" | "ready" | "notfound" | "error";

const SPEEDS = [1, 2, 4];

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function renderNode(node: WireframeNode, index: number) {
  const opacity = node.opacity ?? 1;
  if (node.type === "rect") {
    return (
      <rect
        key={index}
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={node.radius ?? 0}
        fill={node.bg ?? "#e5e7eb"}
        opacity={opacity}
      />
    );
  }
  if (node.type === "image") {
    return (
      <g key={index} opacity={opacity}>
        <rect x={node.x} y={node.y} width={node.w} height={node.h} rx={node.radius ?? 0} fill="#d1d5db" />
        <line x1={node.x} y1={node.y} x2={node.x + node.w} y2={node.y + node.h} stroke="#9ca3af" strokeWidth={1} />
        <line x1={node.x + node.w} y1={node.y} x2={node.x} y2={node.y + node.h} stroke="#9ca3af" strokeWidth={1} />
      </g>
    );
  }
  // text: light background always; render the text if present, else a gray bar sized to the char count.
  const fontSize = node.fontSize ?? 12;
  const barWidth = Math.min(node.w, Math.max(8, (node.chars ?? 0) * fontSize * 0.5));
  const barHeight = Math.min(node.h, fontSize);
  return (
    <g key={index} opacity={opacity}>
      <rect x={node.x} y={node.y} width={node.w} height={node.h} rx={4} fill="#f3f4f6" />
      {node.text ? (
        <text
          x={node.x + 2}
          y={node.y + fontSize}
          fontSize={fontSize}
          fill={node.color ?? "#6b7280"}
        >
          {node.text}
        </text>
      ) : (
        <rect
          x={node.x}
          y={node.y + (node.h - barHeight) / 2}
          width={barWidth}
          height={barHeight}
          rx={3}
          fill="#9ca3af"
        />
      )}
    </g>
  );
}

export default function WireframePlayer({
  sessionId,
  days,
  traceId,
  markers
}: {
  sessionId: string;
  days: number;
  traceId?: string;
  markers: Marker[];
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [data, setData] = useState<ReplayData | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [currentMs, setCurrentMs] = useState(0);

  const currentRef = useRef(0);

  const frames = data?.wireframeFrames ?? [];
  const lastFrameMs = frames[frames.length - 1]?.atMs ?? 0;
  const spanMs = data ? Date.parse(data.endedAt) - Date.parse(data.startedAt) : 0;
  const totalMs = Math.max(lastFrameMs, Number.isFinite(spanMs) ? spanMs : 0);

  // 1. Fetch the merged wireframe stream.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setData(null);
    setCurrentMs(0);
    currentRef.current = 0;
    setIsPlaying(false);
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

  // 2. Advance the playhead by real elapsed time * speed while playing.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) * speed;
      last = now;
      let next = currentRef.current + dt;
      if (totalMs && next >= totalMs) {
        next = totalMs;
        currentRef.current = next;
        setCurrentMs(next);
        setIsPlaying(false);
        return;
      }
      currentRef.current = next;
      setCurrentMs(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, speed, totalMs]);

  const togglePlay = () => {
    if (isPlaying) {
      setIsPlaying(false);
      return;
    }
    if (currentRef.current >= totalMs) {
      currentRef.current = 0;
      setCurrentMs(0);
    }
    setIsPlaying(true);
  };

  const seek = (ms: number) => {
    const offset = Math.max(0, Math.min(ms, totalMs));
    setIsPlaying(false);
    currentRef.current = offset;
    setCurrentMs(offset);
  };

  if (status === "loading") {
    return <p className="summary">리플레이 불러오는 중…</p>;
  }
  if (status === "notfound") {
    return <p className="summary">이 세션에는 와이어프레임 리플레이가 없습니다.</p>;
  }
  if (status === "error") {
    return <p className="summary">리플레이를 불러오지 못했습니다.</p>;
  }

  const frame = frameAtTime(frames, currentMs) ?? frames[0] ?? null;

  return (
    <section className="timelinePanel full">
      <header>
        <h3>세션 리플레이 (wireframe)</h3>
        <span>{data ? `세그먼트 ${data.segments}개` : ""}</span>
      </header>
      <div className="replayPlayer" aria-label="와이어프레임 리플레이">
        {frame ? (
          <svg
            data-wireframe
            viewBox={`0 0 ${frame.viewport.width} ${frame.viewport.height}`}
            width="100%"
            preserveAspectRatio="xMidYMid meet"
            style={{ maxHeight: 640, background: "#ffffff" }}
          >
            {frame.nodes.map(renderNode)}
            {frame.pointer ? (
              <circle
                cx={frame.pointer.x}
                cy={frame.pointer.y}
                r={14}
                fill="rgba(73, 80, 246, 0.35)"
                stroke="rgba(73, 80, 246, 0.8)"
                strokeWidth={1}
              />
            ) : null}
          </svg>
        ) : (
          <p className="summary">프레임이 없습니다.</p>
        )}
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
