import { createJayTraceRumProxy } from "@jaytrace/browser/next/rum-route";

export const runtime = "nodejs";
export const POST = createJayTraceRumProxy();
