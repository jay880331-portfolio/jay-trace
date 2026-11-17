import type { ReactNativeReplayClient } from "./types.js";

/** A single entry of FlatList/SectionList `onViewableItemsChanged` `viewableItems`. */
export interface ViewabilityToken {
  item?: unknown;
  key?: string | number | null;
  index?: number | null;
  isViewable?: boolean;
}

export interface ViewabilityChange {
  viewableItems: ViewabilityToken[];
  changed?: ViewabilityToken[];
}

export interface ViewabilityTrackerOptions {
  /** Minimum visible percentage before an item counts as viewed (default 50). */
  itemVisiblePercentThreshold?: number;
  /** Explicit name for an item; takes priority over item.key/item.id/index. */
  nameOf?: (item: unknown) => string | undefined;
}

export interface ViewabilityTracker {
  viewabilityConfig: { itemVisiblePercentThreshold: number };
  onViewableItemsChanged: (info: ViewabilityChange) => void;
}

/**
 * Builds `{ viewabilityConfig, onViewableItemsChanged }` to spread onto a
 * FlatList/SectionList. Each viewable item records a `view` event (name-deduped
 * once per session, 100 per session — enforced by client.recordView).
 */
export function createViewabilityTracker(
  client: ReactNativeReplayClient | null,
  options: ViewabilityTrackerOptions = {}
): ViewabilityTracker {
  const itemVisiblePercentThreshold = options.itemVisiblePercentThreshold ?? 50;

  return {
    viewabilityConfig: { itemVisiblePercentThreshold },
    onViewableItemsChanged(info) {
      // Runs inside the host render/scroll loop — a throw here must never surface.
      try {
        if (!client || !info?.viewableItems) {
          return;
        }
        for (const token of info.viewableItems) {
          if (token.isViewable === false) {
            continue;
          }
          const name = resolveViewName(token, options.nameOf);
          if (name) {
            client.recordView(name);
          }
        }
      } catch {
        // isolation
      }
    }
  };
}

function resolveViewName(token: ViewabilityToken, nameOf?: (item: unknown) => string | undefined): string | undefined {
  const explicit = nameOf?.(token.item);
  if (explicit) {
    return explicit;
  }
  const item = token.item;
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    const key = record.key ?? record.id;
    if (typeof key === "string" && key) {
      return key;
    }
    if (typeof key === "number") {
      return String(key);
    }
  }
  if (typeof token.index === "number") {
    return String(token.index);
  }
  return undefined;
}
