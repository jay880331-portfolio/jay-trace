export { maskReplayInput, maskReplayText, sanitizeReplayLine } from "./mask.js";
export { createReplayDocument, formatReplayLine, isReplayDocument } from "./replay-document.js";
export { ReplayBuffer, type ReplayBufferOptions } from "./replay-buffer.js";
export type {
  CreateReplayDocumentInput,
  ReplayDocument,
  ReplayEvent,
  ReplayEventKind,
  ReplayFrame,
  ReplayMetadata,
  ReplayMode,
  ReplayMutation,
  ReplayOptions,
  ReplayPrivacy,
  ReplayPlatform
} from "./types.js";
export { ReplaySegmenter, ErrorTailBuffer, decideReplaySampling, isReplayV2SegmentDocument, type ReplaySegmenterOptions, type SegmenterAddResult } from "./segmenter.js";
export type { ReplayV2SegmentDocument, WireframeFrame, WireframeNode } from "./types.js";
