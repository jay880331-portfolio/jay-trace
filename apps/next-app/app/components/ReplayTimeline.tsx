"use client";

import type { Marker } from "../lib/replayMarkers.mjs";

export type { Marker };
export { deriveMarkers } from "../lib/replayMarkers.mjs";

// Markers row under the scrubber: proportional positions, color by kind, click seeks.
export function ReplayTimeline({
  markers,
  total,
  onSeek
}: {
  markers: Marker[];
  total: number;
  onSeek: (atMs: number) => void;
}) {
  if (!total) {
    return null;
  }
  return (
    <div className="replayTimeline" aria-label="리플레이 이벤트 마커">
      {markers
        .filter(marker => marker.atMs <= total)
        .map((marker, index) => (
          <button
            aria-label={marker.label}
            className={`replayTimelineMarker ${marker.kind}`}
            key={`${marker.atMs}-${marker.kind}-${index}`}
            onClick={() => onSeek(marker.atMs)}
            style={{ left: `${(marker.atMs / total) * 100}%` }}
            title={marker.label}
            type="button"
          />
        ))}
    </div>
  );
}
