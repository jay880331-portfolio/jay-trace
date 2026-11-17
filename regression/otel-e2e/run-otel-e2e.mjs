// JayTrace otel e2e: RabbitMQ 관통 트레이스 회귀.
//
// docker 로 RabbitMQ 를 띄우고 gateway/consumer 샘플 앱을 기동해
//   1) gateway 문서와 consumer 문서가 같은 traceId 로 묶이는지(traceparent 전파)
//   2) S3 exporter 의 suppressTracing 이 자기추적 루프를 막는지
// 를 검증한다. docker 가 필요해 `pnpm check` 에는 넣지 않는다.
//
// Usage: node regression/otel-e2e/run-otel-e2e.mjs   (or: pnpm test:otel-e2e)
// Requires `pnpm build` first (packages/node/dist 필요).

import { spawn, execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import amqp from "amqplib";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const CONTAINER = "jt-otel-e2e-rabbit";
// 로컬 5672 가 점유돼 있을 수 있어 host 포트는 5673 으로 매핑한다.
const AMQP_URL = "amqp://127.0.0.1:5673";
const QUEUE = "jt-e2e";

const BASE_ENV = {
  ...process.env,
  JAYTRACE_API_KEY: "e2e",
  JAYTRACE_BUCKET: "jt-e2e",
  AWS_REGION: "ap-northeast-2",
  JAYTRACE_EXPORT: "all",
  JT_E2E_AMQP_URL: AMQP_URL,
  JT_E2E_QUEUE: QUEUE
};
delete BASE_ENV.JAYTRACE_EXPORT_DIR;
delete BASE_ENV.JAYTRACE_S3_PREFIX;

const running = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 카운터가 멎을 때까지 기다린다 — 고정 sleep 은 느린 러너에서 flush 타이머를 놓쳐 오탐 실패한다.
// 최소 1회 관측 후 500ms 간격으로 연속 3회(1.5초) 변화가 없으면 안정으로 본다.
// 증폭 중이면 계속 늘어 안정에 못 들고 15초 상한까지 가며, 그때의 큰 값으로 assert 된다.
async function settleCount(read) {
  const deadline = Date.now() + 15_000;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    await sleep(500);
    const current = read();
    stable = current === last && current >= 1 ? stable + 1 : 0;
    last = current;
    if (stable >= 3) {
      break;
    }
  }
  return last;
}

function launch(script, env) {
  const child = spawn(process.execPath, [join(here, script)], { env, stdio: ["ignore", "pipe", "pipe"] });
  const proc = { script, child, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    proc.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    proc.stderr += chunk;
  });
  running.push(proc);
  return proc;
}

async function waitForLine(proc, pattern, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = proc.stdout.match(pattern);
    if (match) {
      return match;
    }
    if (proc.child.exitCode !== null) {
      throw new Error(`${proc.script} exited early (code ${proc.child.exitCode})\n${describe(proc)}`);
    }
    await sleep(100);
  }
  throw new Error(`${proc.script}: timed out waiting for ${pattern}\n${describe(proc)}`);
}

function describe(proc) {
  return `--- ${proc.script} stdout ---\n${proc.stdout}\n--- ${proc.script} stderr ---\n${proc.stderr}`;
}

async function startRabbit() {
  try {
    await execFileAsync("docker", ["info"]);
  } catch {
    console.error("[otel-e2e] docker 가 필요합니다. Docker 데몬을 띄운 뒤 다시 실행하세요.");
    process.exit(1);
  }
  // 이전 실행 잔재 정리.
  await execFileAsync("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
  await execFileAsync("docker", ["run", "-d", "--name", CONTAINER, "-p", "5673:5672", "rabbitmq:3-alpine"]);

  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const connection = await amqp.connect(AMQP_URL);
      await connection.close();
      return;
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw new Error(`rabbitmq 준비 대기 시간 초과: ${lastError instanceof Error ? lastError.message : "unknown"}`);
}

async function readDocuments(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const documents = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const path = join(entry.parentPath ?? entry.path, entry.name);
    documents.push({ name: entry.name, path, document: JSON.parse(await readFile(path, "utf8")) });
  }
  return documents;
}

async function waitForDocuments(dir, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let documents = [];
  while (Date.now() < deadline) {
    documents = await readDocuments(dir);
    const hasGateway = documents.some((entry) => entry.name.startsWith("back-gateway-"));
    const hasConsumer = documents.some((entry) => entry.name.startsWith("back-consumer-"));
    if (hasGateway && hasConsumer) {
      return documents;
    }
    await sleep(250);
  }
  return documents;
}

function kinds(document) {
  return (document.events ?? []).map((event) => event.kind);
}

async function traceThroughRmq(exportDir) {
  const consumer = launch("consumer.mjs", { ...BASE_ENV, JAYTRACE_EXPORT_DIR: exportDir, JAYTRACE_SERVICE: "consumer" });
  await waitForLine(consumer, /consumer ready/);

  const gateway = launch("gateway.mjs", { ...BASE_ENV, JAYTRACE_EXPORT_DIR: exportDir, JAYTRACE_SERVICE: "gateway" });
  const [, port] = await waitForLine(gateway, /gateway listening (\d+)/);

  const response = await fetch(`http://127.0.0.1:${port}/boom`);
  check(response.status === 500, `gateway /boom 이 500 이 아님: ${response.status}`);

  const documents = await waitForDocuments(exportDir);
  const listing = documents.map((entry) => entry.name).join(", ") || "(없음)";
  check(documents.length >= 2, `문서가 2개 미만: [${listing}]\n${describe(gateway)}\n${describe(consumer)}`);

  const gatewayDoc = documents.find((entry) => entry.name.startsWith("back-gateway-"));
  const consumerDoc = documents.find((entry) => entry.name.startsWith("back-consumer-"));
  check(gatewayDoc !== undefined, `back-gateway-* 문서 없음: [${listing}]\n${describe(gateway)}`);
  check(consumerDoc !== undefined, `back-consumer-* 문서 없음: [${listing}]\n${describe(consumer)}`);

  // 핵심: traceparent 가 RMQ 헤더로 넘어가 두 서비스가 한 트레이스로 묶인다.
  check(
    gatewayDoc.document.traceId === consumerDoc.document.traceId,
    `traceId 불일치 (traceparent 전파 실패): gateway=${gatewayDoc.document.traceId} consumer=${consumerDoc.document.traceId}`
  );

  check(kinds(gatewayDoc.document).includes("queue"), `gateway 문서에 queue 이벤트 없음: [${kinds(gatewayDoc.document).join(", ")}]`);
  check(
    (consumerDoc.document.events ?? []).some((event) => event.kind === "log" && event.text.includes("consumer failing on purpose")),
    `consumer 문서에 실패 로그 없음: ${JSON.stringify(consumerDoc.document.events)}`
  );

  // consumer 의 root 는 수동 스팬이 아니라 amqplib consume 스팬이어야 한다.
  check(
    typeof consumerDoc.document.summary === "string" && consumerDoc.document.summary.startsWith(`MSG ${QUEUE} process`),
    `consumer root 가 consume 스팬이 아님: ${consumerDoc.document.summary}`
  );
  check(consumerDoc.document.error !== undefined, "consumer 문서에 error 가 기록되지 않음");
  // gateway 의 root 도 수동 스팬 없이 http 계측 SERVER 스팬 하나다.
  check(
    kinds(gatewayDoc.document).filter((kind) => kind === "request").length === 1,
    `gateway 문서의 request 이벤트가 1개가 아님: [${kinds(gatewayDoc.document).join(", ")}]`
  );
  check(gatewayDoc.document.context?.statusCode === 500, `gateway 문서 statusCode 가 500 이 아님: ${gatewayDoc.document.context?.statusCode}`);

  console.log(`[otel-e2e] 관통 트레이스 확인: traceId=${gatewayDoc.document.traceId} 문서 ${documents.length}개`);
}

// S3 exporter 가 자기 PUT 을 계측하면 PUT 스팬이 그 자체로 root 가 되어
// PUT -> 문서 -> PUT 루프가 돈다. 루프의 씨앗은 gateway 부팅 시의 ping 요청 —
// 활성 스팬 없이 나가는 CLIENT 스팬이라 root 로 잡힌다.
// 정상이면 PUT 은 ping 문서 1회 + /boom 문서 1회 = 2회, 깨지면 3초에 수백 회.
async function suppressTracingLoop() {
  let puts = 0;
  const stub = http.createServer((req, res) => {
    if (req.method === "PUT") {
      puts += 1;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { etag: '"jt-e2e"' }).end();
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubPort = stub.address().port;

  try {
    const gateway = launch("gateway.mjs", {
      ...BASE_ENV,
      JAYTRACE_SERVICE: "gateway-s3",
      AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${stubPort}`,
      AWS_ACCESS_KEY_ID: "dummy",
      AWS_SECRET_ACCESS_KEY: "dummy",
      AWS_MAX_ATTEMPTS: "1",
      JT_E2E_PING_URL: `http://127.0.0.1:${stubPort}/ping`
    });
    const [, port] = await waitForLine(gateway, /gateway listening (\d+)/);

    const response = await fetch(`http://127.0.0.1:${port}/boom`);
    check(response.status === 500, `suppressTracing 시나리오 /boom 이 500 이 아님: ${response.status}`);

    const observed = await settleCount(() => puts);
    check(observed >= 2, `S3 PUT 이 ${observed}회뿐 — 시나리오가 실제 export 경로를 타지 않음\n${describe(gateway)}`);
    check(observed <= 5, `S3 PUT ${observed}회 — suppressTracing 이 깨져 자기추적 루프가 돈다\n${describe(gateway)}`);
    console.log(`[otel-e2e] suppressTracing 확인: /boom 1회 후 PUT ${observed}회에서 안정`);
  } finally {
    stub.close();
  }
}

async function cleanup() {
  for (const proc of running) {
    proc.child.kill("SIGKILL");
  }
  await execFileAsync("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
}

const exportDir = await mkdtemp(join(tmpdir(), "jaytrace-otel-e2e-"));
let failed = false;
try {
  await startRabbit();
  await traceThroughRmq(exportDir);
  await suppressTracingLoop();
  console.log(`[otel-e2e] ok (${checks} checks)`);
} catch (error) {
  failed = true;
  console.error(`[otel-e2e] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[otel-e2e] export dir 보존: ${exportDir}`);
} finally {
  await cleanup();
  if (!failed) {
    await rm(exportDir, { recursive: true, force: true });
  }
}

process.exit(failed ? 1 : 0);
