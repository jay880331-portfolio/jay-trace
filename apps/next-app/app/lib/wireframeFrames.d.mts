import type { WireframeFrame } from "@jaytrace/replay-core";

export type WireframeSegmentLike = {
  seq: number;
  startedAt: string;
  wireframeFrames?: WireframeFrame[];
};

export function mergeWireframeFrames(segments: WireframeSegmentLike[]): WireframeFrame[];
export function frameAtTime(frames: WireframeFrame[], t: number): WireframeFrame | null;
