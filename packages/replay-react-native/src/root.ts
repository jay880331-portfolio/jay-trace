import { createElement, useEffect, type ReactNode } from "react";
import { View, AppState } from "react-native";

import { ensureJayTraceClient, getJayTraceClient, type JayTraceRootConfig } from "./root-core.js";
import { createReactNavigationReplayTracker, type ReactNavigationRefLike } from "./navigation.js";
import { createReplayRootProps } from "./press.js";
import type { JayTraceReactNativeClient } from "./init.js";

export interface JayTraceRootProps extends JayTraceRootConfig {
  navigationRef?: ReactNavigationRefLike & {
    addListener?: (type: "state", listener: () => void) => (() => void) | { remove?: () => void } | void;
  };
  children: ReactNode;
}

export function JayTraceRoot(props: JayTraceRootProps): ReturnType<typeof createElement> {
  const { navigationRef, children, ...config } = props;
  const client = ensureJayTraceClient({ appState: AppState, ...config });

  useEffect(() => {
    if (!navigationRef || !client.replay) {
      return;
    }
    const tracker = createReactNavigationReplayTracker(client.replay, navigationRef);
    tracker.onReady();
    const subscription = navigationRef.addListener?.("state", () => tracker.onStateChange());
    return () => {
      if (typeof subscription === "function") {
        subscription();
      } else if (subscription && typeof subscription.remove === "function") {
        subscription.remove();
      }
    };
  }, [navigationRef, client]);

  const rootProps = client.replay ? createReplayRootProps(client.replay) : {};
  return createElement(View, { ...rootProps, style: { flex: 1 } }, children);
}

export function useJayTrace(): JayTraceReactNativeClient | null {
  return getJayTraceClient();
}
