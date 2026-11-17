import {
  DynamicModule,
  MiddlewareConsumer,
  Module,
  NestModule,
  Provider,
  RequestMethod
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";

import { JayTraceContextService } from "./context.js";
import { JayTraceHealthController } from "./jaytrace.health-controller.js";
import { JayTraceInterceptor } from "./jaytrace.interceptor.js";
import { JayTraceMetrics } from "./jaytrace.metrics.js";
import { JayTraceMiddleware } from "./jaytrace.middleware.js";
import { JayTraceRumController } from "./jaytrace.rum-controller.js";
import { S3JayTraceExporter } from "./s3-exporter.js";
import { JAYTRACE_EXPORTER, JAYTRACE_METRICS, JAYTRACE_OPTIONS } from "./tokens.js";
import type { JayTraceModuleAsyncOptions, JayTraceModuleOptions } from "./types.js";

@Module({})
export class JayTraceModule implements NestModule {
  static forRoot(options?: JayTraceModuleOptions, envOverride?: Record<string, string | undefined>): DynamicModule {
    const resolved = options ?? resolveJayTraceEnvOptions(envOverride);
    const optionsProvider: Provider = {
      provide: JAYTRACE_OPTIONS,
      useValue: resolved
    };

    return this.createModule([optionsProvider]);
  }

  static forRootAsync(options: JayTraceModuleAsyncOptions): DynamicModule {
    return this.createModule([
      {
        provide: JAYTRACE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? []
      }
    ], options.imports);
  }

  private static createModule(optionsProviders: Provider[], imports?: DynamicModule["imports"]): DynamicModule {
    const metricsProvider: Provider = {
      provide: JAYTRACE_METRICS,
      useValue: new JayTraceMetrics()
    };

    const exporterProvider: Provider = {
      provide: JAYTRACE_EXPORTER,
      useFactory: (options: JayTraceModuleOptions, metrics: JayTraceMetrics) => new S3JayTraceExporter(options, metrics),
      inject: [JAYTRACE_OPTIONS, JAYTRACE_METRICS]
    };

    return {
      module: JayTraceModule,
      imports,
      controllers: [JayTraceRumController, JayTraceHealthController],
      providers: [
        ...optionsProviders,
        metricsProvider,
        exporterProvider,
        JayTraceContextService,
        JayTraceMiddleware,
        {
          provide: APP_INTERCEPTOR,
          useClass: JayTraceInterceptor
        }
      ],
      exports: [JayTraceContextService, JAYTRACE_EXPORTER]
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(JayTraceMiddleware).forRoutes({
      path: "*",
      method: RequestMethod.ALL
    });
  }
}

export class AirumModule extends JayTraceModule {}

export function resolveJayTraceEnvOptions(
  env: Record<string, string | undefined> = process.env
): JayTraceModuleOptions {
  const missing = [
    !env.JAYTRACE_API_KEY && "JAYTRACE_API_KEY",
    !env.JAYTRACE_BUCKET && "JAYTRACE_BUCKET",
    !env.AWS_REGION && "AWS_REGION"
  ].filter((name): name is string => Boolean(name));

  if (missing.length > 0) {
    throw new Error(
      `[jaytrace] JayTraceModule.forRoot() without options requires env vars: ${missing.join(", ")}. ` +
        `Set them or pass options explicitly.`
    );
  }

  const apiKeys = env.JAYTRACE_API_KEYS?.split(",").map(key => key.trim()).filter(Boolean);
  const captureBody = resolveCaptureBody(env.JAYTRACE_CAPTURE_BODY);
  const drainOnIngest = env.JAYTRACE_DRAIN_ON_INGEST === "1" || env.JAYTRACE_DRAIN_ON_INGEST === "true";

  return {
    apiKey: env.JAYTRACE_API_KEY!,
    ...(apiKeys && apiKeys.length > 0 ? { apiKeys } : {}),
    ...(captureBody !== undefined ? { captureBody } : {}),
    ...(drainOnIngest ? { drainOnIngest } : {}),
    service: env.JAYTRACE_SERVICE ?? "api",
    environment: env.NODE_ENV,
    s3: {
      bucket: env.JAYTRACE_BUCKET!,
      region: env.AWS_REGION!,
      prefix: env.JAYTRACE_S3_PREFIX ?? env.NODE_ENV
    }
  };
}

function resolveCaptureBody(raw: string | undefined): boolean | { maxBytes: number } | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = raw.trim();
  if (value === "") {
    return undefined;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }

  const maxBytes = Number(value);
  if (Number.isFinite(maxBytes) && maxBytes > 0) {
    return { maxBytes };
  }

  return undefined;
}
