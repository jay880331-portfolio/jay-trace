import { homedir } from "node:os";
import { join } from "node:path";
import type { AiRunner, CliOptions, ReplayPlatform } from "./types.js";

export function parseArgs(argv: string[]): CliOptions {
  let explicitLimit = false;
  let explicitAi = false;
  const options: CliOptions = {
    logsDir: join(homedir(), ".jaytrace", "logs"),
    ai: "ollama",
    model: "qwen2.5:14b",
    limit: 1
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--logs-dir" && next) {
      options.logsDir = next;
      index += 1;
    } else if (arg === "--ai" && next) {
      options.ai = parseAi(next);
      explicitAi = true;
      index += 1;
    } else if (arg === "--model" && next) {
      options.model = next;
      index += 1;
    } else if (arg === "--limit" && next) {
      options.limit = Math.max(1, Number.parseInt(next, 10) || 1);
      explicitLimit = true;
      index += 1;
    } else if (arg === "--min-screens" && next) {
      options.minScreens = Math.max(0, Number.parseInt(next, 10) || 0);
      index += 1;
    } else if (arg === "--trace-id" && next) {
      options.traceId = next;
      index += 1;
    } else if (arg === "--session-id" && next) {
      options.sessionId = next;
      index += 1;
    } else if (arg === "--platform" && next) {
      options.platform = parsePlatform(next);
      index += 1;
    } else if (arg === "--sync-s3" && next) {
      options.syncS3 = next;
      index += 1;
    } else if (arg === "--list") {
      options.list = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.list && !explicitLimit) {
    options.limit = 20;
  }

  options.syncOnly = Boolean(options.syncS3) && !options.list && !explicitAi;

  return options;
}

function parseAi(value: string): AiRunner {
  if (value === "ollama" || value === "claude" || value === "print") {
    return value;
  }

  throw new Error("--ai must be one of: ollama, claude, print");
}

function parsePlatform(value: string): ReplayPlatform {
  if (value === "web" || value === "react-native" || value === "flutter") {
    return value;
  }

  throw new Error("--platform must be one of: web, react-native, flutter");
}

function printHelp(): void {
  process.stdout.write(`jaytrace-check

Usage:
  jaytrace-check [--logs-dir ~/.jaytrace/logs] [--sync-s3 s3://bucket/prefix] [--list] [--ai ollama|claude|print] [--model qwen2.5:14b] [--trace-id id] [--session-id id] [--platform web|react-native|flutter] [--min-screens n]

Examples:
  aws s3 sync s3://jaytrace-prod ~/.jaytrace/logs
  jaytrace-check --list
  jaytrace-check --sync-s3 s3://jaytrace-prod   (sync only; add --list or --ai to analyze)
  jaytrace-check --list --min-screens 1
  jaytrace-check --ai print --trace-id 4bf92f3577b34da6a3ce929d0e0e4736
  jaytrace-check --list --session-id session-rn
  jaytrace-check --list --platform web
`);
}
