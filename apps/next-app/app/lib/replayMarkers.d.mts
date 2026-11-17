export type Marker = { atMs: number; kind: "network" | "error"; label: string };
export type TimelineDocLike = { startedAt: string; timeline?: string[] };
export function deriveMarkers(docs: TimelineDocLike[], replayStartedMs: number): Marker[];
