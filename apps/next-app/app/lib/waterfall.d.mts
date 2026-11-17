export type WaterfallTone = "request" | "db" | "fetch" | "log" | "error" | "other";

// SDK 확장 필드(depth/spanId/parentSpanId/attrs)는 전부 optional — 없으면 평면 워터폴.
export type WaterfallEvent = {
  at: string;
  kind: string;
  text: string;
  severity?: string;
  durationMs?: number;
  slow?: boolean;
  data?: Record<string, unknown>;
  depth?: number;
  spanId?: string;
  parentSpanId?: string;
  attrs?: Record<string, string | number>;
};

export type WaterfallDocument = {
  startedAt: string;
  endedAt?: string;
  context?: Record<string, unknown>;
};

export type WaterfallBar = {
  index: number;
  event: WaterfallEvent;
  start: number;
  duration: number;
  depth: number;
  tone: WaterfallTone;
};

export type HostContext = { pod?: string; rssMb?: string; heapUsedMb?: string };

export function waterfallTone(event: Pick<WaterfallEvent, "kind" | "severity">): WaterfallTone;
export function eventOffsetSeconds(event: Pick<WaterfallEvent, "at">, baseMs: number): number;
export function spanDepth(spanId: string | undefined, parents: Map<string, string | undefined>): number;
export function waterfallBars(events: WaterfallEvent[], doc: WaterfallDocument): WaterfallBar[];
export function waterfallTotalSeconds(bars: Array<Pick<WaterfallBar, "start" | "duration">>, doc: WaterfallDocument): number;
export function waterfallBarStyle(bar: Pick<WaterfallBar, "start" | "duration">, total: number): { left: string; width?: string };
export function waterfallTicks(total: number): Array<{ ratio: number; label: string }>;
export function formatWaterfallSeconds(value: number, total?: number): string;
export function eventAttrs(event: Pick<WaterfallEvent, "attrs">): Array<[string, string]>;
export function stackFrames(stack: string | undefined): string[];
export function hostContext(context: Record<string, unknown> | undefined): HostContext | null;
