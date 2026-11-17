import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { registerInstrumentations, type Instrumentation } from "@opentelemetry/instrumentation";
import { AmqplibInstrumentation } from "@opentelemetry/instrumentation-amqplib";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { MySQL2Instrumentation } from "@opentelemetry/instrumentation-mysql2";
import { NestInstrumentation } from "@opentelemetry/instrumentation-nestjs-core";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { WinstonInstrumentation } from "@opentelemetry/instrumentation-winston";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { patchConsole } from "./console-patch.js";
import { createNodeDbIndexer, type NodeDbIndexer } from "./db-indexer.js";
import { isIgnoredHttpPath, parseInstrumentDisable, resolveNodeOptions } from "./env.js";
import type { ExportInput, JayTraceExporter, JayTraceExportOptions } from "./exporter-types.js";
import { FileJayTraceExporter } from "./file-exporter.js";
import { JayTraceLogRecordProcessor, JayTraceSpanProcessor } from "./processors.js";
import { getJayTraceRuntime, setJayTraceRuntime, type JayTraceStatus } from "./runtime.js";
import { S3JayTraceExporter } from "./s3-exporter.js";
import { TraceBuffer } from "./trace-buffer.js";

/**
 * Exporter that stands in for the real one until env is available.
 *
 * `import "@jaytrace/node/init"` has to run before the app requires anything it wants to
 * instrument, which on the host app is before secrets are loaded. So collection starts immediately
 * and the destination is decided on first use — and re-decided until it succeeds.
 */
class LazyExporter implements JayTraceExporter {
  /** undefined = never tried, null = last attempt found no env (retry), object = delegating. */
  private delegate: JayTraceExporter | null | undefined;
  private indexer: NodeDbIndexer | undefined;
  private buffer: TraceBuffer | undefined;
  private service: string | undefined;
  private dropped = 0;
  private warned = false;

  attach(buffer: TraceBuffer): void {
    this.buffer = buffer;
  }

  get configured(): boolean {
    return this.delegate !== null && this.delegate !== undefined;
  }

  get serviceName(): string | undefined {
    return this.service;
  }

  get droppedDocuments(): number {
    return this.dropped;
  }

  /** Cheap enough to run per export: it is a handful of process.env reads. */
  resolve(): boolean {
    if (this.delegate) {
      return true;
    }
    const resolved = resolveNodeOptions();
    if (!resolved) {
      this.delegate = null;
      return false;
    }

    // JAYTRACE_DB_* arrives in the same secret as JAYTRACE_API_KEY, so it is readable exactly
    // when the exporter resolves. Uploads stay the source of truth; the row is only an index.
    this.indexer = createNodeDbIndexer() ?? undefined;
    if (this.indexer) {
      const indexer = this.indexer;
      resolved.options.onExported = (info) => {
        indexer.indexDocument(info);
      };
    }

    this.delegate = resolved.exportDir
      ? new FileJayTraceExporter(resolved.exportDir, resolved.options)
      : new S3JayTraceExporter(resolved.options);
    this.service = resolved.options.service;
    // The buffer was built with placeholder options; only now do service and policy become real.
    this.buffer?.updateOptions(resolved.options, resolved.exportPolicy);
    return true;
  }

  export(input: ExportInput): void {
    if (!this.resolve()) {
      this.dropped += 1;
      if (!this.warned) {
        this.warned = true;
        process.stderr.write(
          "[jaytrace] exporter not configured (needs JAYTRACE_API_KEY, JAYTRACE_BUCKET, AWS_REGION) — " +
            "documents are dropped until it is; call startJayTrace() after loading secrets\n"
        );
      }
      return;
    }
    this.delegate?.export(input);
  }

  /** Exporter first: its onExported hook is what feeds the indexer. */
  async drain(): Promise<void> {
    await this.delegate?.drain?.();
    await this.indexer?.drain();
  }
}

const INSTRUMENTATIONS: Record<string, () => Instrumentation> = {
  amqplib: () => new AmqplibInstrumentation(),
  // Only here for `http.route`: it is express that knows the matched route template, and it feeds
  // it back onto the http SERVER span. Its own layer spans are INTERNAL, so the converter drops them.
  express: () => new ExpressInstrumentation(),
  // Incoming only: k8s probes (/health, /health/ready) would otherwise fill the dashboard with
  // error traces. Outgoing calls stay traced — they are what a failing request needs to explain.
  http: () => new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => isIgnoredHttpPath(req.url) }),
  mysql2: () => new MySQL2Instrumentation(),
  pg: () => new PgInstrumentation(),
  // Default config keeps log-sending on, so winston/pino records reach the log processor.
  winston: () => new WinstonInstrumentation(),
  pino: () => new PinoInstrumentation(),
  "nestjs-core": () => new NestInstrumentation()
};

// Placeholder until env shows up: only the service name is worth guessing this early.
function placeholderOptions(): JayTraceExportOptions {
  return {
    apiKey: "",
    service: process.env.JAYTRACE_SERVICE ?? "api",
    s3: { bucket: "", region: "" }
  };
}

// Module scope guards a repeat import inside one module instance; the global runtime guards
// a second module instance (dual ESM/CJS). console must never end up double-patched.
let booted = false;

function bootstrap(): void {
  if (booted || getJayTraceRuntime()) {
    return;
  }
  booted = true;

  const exporter = new LazyExporter();
  const buffer = new TraceBuffer({ options: placeholderOptions(), exporter, exportPolicy: "errors" });
  exporter.attach(buffer);
  // Usually env is already there at boot, so the placeholder is replaced before the first span.
  exporter.resolve();

  const tracerProvider = new NodeTracerProvider({ spanProcessors: [new JayTraceSpanProcessor(buffer)] });
  tracerProvider.register();

  const loggerProvider = new LoggerProvider({ processors: [new JayTraceLogRecordProcessor(buffer)] });
  logs.setGlobalLoggerProvider(loggerProvider);

  const disabled = parseInstrumentDisable();
  registerInstrumentations({
    instrumentations: Object.entries(INSTRUMENTATIONS)
      .filter(([name]) => !disabled.has(name))
      .map(([, create]) => create()),
    tracerProvider,
    loggerProvider
  });

  if (!disabled.has("console")) {
    patchConsole((severity, text) => {
      // No active span means no root to attach to — the buffer counts it as dropped.
      buffer.onLog(trace.getActiveSpan()?.spanContext().spanId, { atMs: Date.now(), severity, text });
    });
  }

  setJayTraceRuntime({
    buffer,
    start: () => exporter.resolve(),
    status: (): JayTraceStatus => ({
      configured: exporter.configured,
      ...(exporter.serviceName ? { service: exporter.serviceName } : {}),
      droppedSpans: buffer.droppedSpans,
      droppedDocuments: exporter.droppedDocuments
    })
  });
}

try {
  if (process.env.JAYTRACE_DISABLE !== "1" && process.env.JAYTRACE_DISABLE !== "true") {
    bootstrap();
  }
} catch (error) {
  // Instrumentation is never worth a failed boot.
  process.stderr.write(
    `[jaytrace] init failed, tracing disabled: ${error instanceof Error ? error.message : "unknown error"}\n`
  );
}
