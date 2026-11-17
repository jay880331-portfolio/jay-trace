"use client";

import { useEffect } from "react";
import { initJayTrace } from "@jaytrace/browser";

export function JayTraceClient(): null {
  useEffect(() => {
    const client = initJayTrace({
      apiKey: process.env.NEXT_PUBLIC_JAYTRACE_API_KEY ?? "local-dev-key",
      endpoint: "/jaytrace/rum",
      service: "web",
      environment: process.env.NODE_ENV,
      replay: {
        enabled: true,
        mode: "on-error",
        maskText: false,
        maskInputs: true,
        maxDurationMs: 30000
      }
    });

    return () => client.restore();
  }, []);

  return null;
}
