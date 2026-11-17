import type { ReactNativeReplayClient } from "./types.js";

export interface ReactNavigationRouteLike {
  key?: string;
  name: string;
  params?: unknown;
}

export interface ReactNavigationRefLike {
  getCurrentRoute: () => ReactNavigationRouteLike | undefined;
}

export interface ReactNavigationReplayTracker {
  onReady: () => void;
  onStateChange: () => void;
  recordCurrentRoute: () => void;
}

export function createReactNavigationReplayTracker(
  client: ReactNativeReplayClient | null,
  navigationRef: ReactNavigationRefLike
): ReactNavigationReplayTracker {
  let lastRouteKey = "";
  let lastRouteName = "";
  let lastRouteStartedAt = 0;

  function recordCurrentRoute(): void {
    if (!client) {
      return;
    }

    const route = navigationRef.getCurrentRoute();
    if (!route) {
      return;
    }

    const key = route.key ?? route.name;
    if (key === lastRouteKey) {
      return;
    }

    const now = Date.now();
    if (lastRouteName && lastRouteStartedAt) {
      client.recordScreenEnd(lastRouteName, now - lastRouteStartedAt);
    }

    lastRouteKey = key;
    lastRouteName = route.name;
    lastRouteStartedAt = now;
    client.recordScreen(route.name);
  }

  return {
    onReady: recordCurrentRoute,
    onStateChange: recordCurrentRoute,
    recordCurrentRoute
  };
}

export function createReactNativeComponentLifecycleTracker(
  client: ReactNativeReplayClient | null,
  name: string,
  now: () => number = Date.now
): { mount: () => void; unmount: () => void } {
  let mountedAt: number | undefined;
  return {
    mount() {
      mountedAt = now();
      client?.recordComponentMount(name);
    },
    unmount() {
      client?.recordComponentUnmount(name, mountedAt === undefined ? 0 : now() - mountedAt);
    }
  };
}

export function withReactNativeRumLifecycle<P>(
  client: ReactNativeReplayClient | null,
  name: string,
  Component: (props: P) => unknown,
  React: { useEffect: (effect: () => void | (() => void), deps: unknown[]) => void; createElement: (component: (props: P) => unknown, props: P) => unknown }
): (props: P) => unknown {
  return function JayTraceRumLifecycle(props: P) {
    React.useEffect(() => {
      const tracker = createReactNativeComponentLifecycleTracker(client, name);
      tracker.mount();
      return tracker.unmount;
    }, []);
    return React.createElement(Component, props);
  };
}
