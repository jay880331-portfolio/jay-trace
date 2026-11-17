import type { ReactNativeReplayClient } from "./types.js";

export interface PressEventLike {
  nativeEvent?: {
    pageX?: number;
    pageY?: number;
    locationX?: number;
    locationY?: number;
  };
}

export function recordReplayPress(client: ReactNativeReplayClient | null, target: string, event?: PressEventLike): void {
  const nativeEvent = event?.nativeEvent;
  const x = nativeEvent?.pageX ?? nativeEvent?.locationX;
  const y = nativeEvent?.pageY ?? nativeEvent?.locationY;
  client?.recordTap(target, x, y);
}

export function withReplayPress<T extends PressEventLike>(
  client: ReactNativeReplayClient | null,
  target: string,
  onPress?: (event: T) => void
): (event: T) => void {
  return (event: T) => {
    // SDK bookkeeping is isolated; the user's onPress throw must propagate.
    try {
      recordReplayPress(client, target, event);
    } catch {
    }
    onPress?.(event);
  };
}

export function withReplayTouch<T extends PressEventLike>(
  client: ReactNativeReplayClient | null,
  target = "screen",
  onTouchStart?: (event: T) => void
): (event: T) => void {
  return withReplayPress(client, target, onTouchStart);
}

export function withReplayTextInput(
  client: ReactNativeReplayClient | null,
  target: string,
  onChangeText?: (text: string) => void
): (text: string) => void {
  return (text: string) => {
    // SDK bookkeeping is isolated; the user's onChangeText throw must propagate.
    try {
      client?.recordInput(target);
    } catch {
    }
    onChangeText?.(text);
  };
}

export function createReplayRootProps<T extends PressEventLike>(
  client: ReactNativeReplayClient | null,
  target = "screen",
  onTouchStart?: (event: T) => void
): { onTouchStart: (event: T) => void } {
  return {
    onTouchStart: withReplayTouch(client, target, onTouchStart)
  };
}
