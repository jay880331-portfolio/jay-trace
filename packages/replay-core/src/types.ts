export type ReplayPlatform = "web" | "react-native" | "flutter";

export type ReplayMode = "off" | "on-error" | "always";

export type ReplayPrivacy = "mask-all" | "mask-inputs" | "allow";

export type ReplayEventKind =
  | "viewport"
  | "route"
  | "click"
  | "input"
  | "scroll"
  | "mutation"
  | "network"
  | "screenshot"
  | "gesture"
  | "error";

export interface ReplayEvent {
  at: string;
  kind: ReplayEventKind;
  text: string;
}

export interface ReplayFrame {
  at: string;
  kind: ReplayEventKind;
  text: string;
  type?: "dom" | "image";
  url?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  html?: string;
  image?: string;
  mediaType?: string;
}

export interface ReplayMutation {
  at: string;
  target: string;
  targetPath?: string;
  type: "attributes" | "childList";
  attributeName?: string;
  value?: string | null;
  addedHtml?: string[];
  removedCount?: number;
}

export type ReplayMetadata = Record<string, string | number | boolean | null | undefined>;

export interface ReplayDocument {
  schema: "jaytrace.replay.v1";
  platform: ReplayPlatform;
  traceId: string;
  sessionId?: string;
  traceparent?: string;
  mode: Exclude<ReplayMode, "off">;
  startedAt: string;
  endedAt?: string;
  metadata?: ReplayMetadata;
  events: string[];
  frames?: ReplayFrame[];
  mutations?: ReplayMutation[];
}

export interface CreateReplayDocumentInput {
  platform: ReplayPlatform;
  traceId: string;
  sessionId?: string;
  traceparent?: string;
  mode: Exclude<ReplayMode, "off">;
  startedAt: Date;
  endedAt?: Date;
  metadata?: ReplayMetadata;
  events: ReplayEvent[];
  frames?: ReplayFrame[];
  mutations?: ReplayMutation[];
}

export interface ReplayOptions {
  enabled?: boolean;
  mode?: ReplayMode;
  sampleRate?: number;
  privacy?: ReplayPrivacy;
  maskText?: boolean;
  maskInputs?: boolean;
  maxEvents?: number;
  maxDurationMs?: number;
}

export interface WireframeNode {
  type: "rect" | "text" | "image";
  x: number;
  y: number;
  w: number;
  h: number;
  bg?: string;
  radius?: number;
  opacity?: number;
  chars?: number;
  text?: string;
  fontSize?: number;
  color?: string;
}

export interface WireframeFrame {
  atMs: number;
  viewport: { width: number; height: number };
  pointer?: { x: number; y: number; kind: "tap" | "move" };
  nodes: WireframeNode[];
}

export interface ReplayV2SegmentDocument {
  schema: "jaytrace.replay.v2";
  engine: "rrweb" | "wireframe";
  platform: "web" | "react-native" | "flutter";
  traceId: string;
  sessionId: string;
  seq: number;
  startedAt: string;
  endedAt: string;
  metadata?: ReplayMetadata;
  rrwebEvents?: unknown[];
  wireframeFrames?: WireframeFrame[];
}
