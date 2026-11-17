export declare const HISTOGRAM_BOUNDS: number[];
export declare const HISTOGRAM_SIZE: number;

export function toHistogram(value: unknown): number[];
export function mergeHistograms(values: unknown[]): number[];
export function histogramTotal(histogram: number[]): number;
// 표본이 없으면 null, 마지막 버킷(30s) 초과면 Infinity.
export function histogramPercentile(histogram: number[], quantile: number): number | null;
export function histogramRank(histogram: number[], durationMs: number): number | null;
export function clampStatsHours(value: string | null): number;
export function formatLatency(ms: number | null | undefined): string;
export function formatRank(rank: number | null | undefined): string | null;
