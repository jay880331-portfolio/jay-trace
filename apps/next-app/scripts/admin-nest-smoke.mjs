import { randomBytes } from "node:crypto";

const adminUrl = (process.env.ADMIN_URL ?? "http://localhost:4000").replace(/\/$/, "");
const consoleUrl = (process.env.JAYTRACE_CONSOLE_URL ?? "http://localhost:3022").replace(/\/$/, "");

const result = await runSmoke();
console.log(JSON.stringify({ ok: true, adminUrl, consoleUrl, ...result }, null, 2));

async function runSmoke() {
  const health = await request(`${adminUrl}/jaytrace/health`);
  if (health.status !== 200) {
    throw new Error(`admin jaytrace health failed ${health.status}: ${health.body.slice(0, 300)}`);
  }

  const traceId = randomBytes(16).toString("hex");
  const traceparent = `00-${traceId}-0123456789abcdef-01`;
  const failure = await request(`${adminUrl}/jaytrace-qa/error`, { traceparent });
  if (failure.status !== 500) {
    throw new Error(`expected 500 from /jaytrace-qa/error, got ${failure.status}: ${failure.body.slice(0, 300)}`);
  }

  const trace = await readTrace(traceId);
  return {
    traceId,
    healthStatus: health.status,
    health: safeJson(health.body),
    errorStatus: failure.status,
    backService: trace.back.service,
    backError: trace.back.error?.name ?? null,
    backEventCount: trace.back.events?.length ?? trace.back.timeline?.length ?? 0,
    traceStatus: trace.status,
    services: trace.services,
    sourceMode: trace.sourceMode
  };
}

// 콘솔은 traceId 쿼리를 상세 모드로 취급해 문서 본문을 그대로 돌려준다
// (app/api/traces/route.ts:43), 그리고 side="back" 타임라인 문서는 TraceRow.back으로
// 그룹핑된다 (app/api/lib/traces.ts:178-182). 백엔드 에러 도착 판정은 back.error로 한다.
async function readTrace(traceId) {
  for (let i = 0; i < 30; i += 1) {
    const response = await fetch(`${consoleUrl}/api/traces?traceId=${traceId}&days=1`, {
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      throw new Error(`console read failed ${response.status}: ${await response.text()}`);
    }
    const payload = await response.json();
    const trace = payload.traces?.find(item => item.traceId === traceId);
    if (trace?.back?.error) {
      return { ...trace, sourceMode: payload.sourceMode };
    }
    await sleep(1000);
  }
  throw new Error(`missing backend error document in console: ${traceId}`);
}

async function request(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) }).catch(error => {
    throw new Error(`${url} unreachable: ${error.message}`);
  });
  return { status: response.status, body: await response.text() };
}

function safeJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return body.slice(0, 200);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
