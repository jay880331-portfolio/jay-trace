import { randomBytes } from "node:crypto";

// sample-nest api-gateway는 setGlobalPrefix("api")라 모든 라우트에 /api prefix가 붙는다.
const sampleNestUrl = (process.env.SAMPLE_NEST_URL ?? "http://localhost:3000/api").replace(/\/$/, "");
const consoleUrl = (process.env.JAYTRACE_CONSOLE_URL ?? "http://localhost:3022").replace(/\/$/, "");
// 서비스명은 배포 환경마다 달라서 하드코딩하지 않는다. 지정된 경우에만 비교한다.
const expectedService = process.env.SAMPLE_NEST_SERVICE?.trim() || null;

const result = await runSmoke();
console.log(JSON.stringify({ ok: true, sampleNestUrl, consoleUrl, ...result }, null, 2));

async function runSmoke() {
  const health = await request(`${sampleNestUrl}/jaytrace/health`);
  if (health.status !== 200) {
    throw new Error(`sample-nest jaytrace health failed ${health.status}: ${health.body.slice(0, 300)}`);
  }

  const traceId = randomBytes(16).toString("hex");
  const traceparent = `00-${traceId}-0123456789abcdef-01`;
  const failure = await request(`${sampleNestUrl}/jaytrace-qa/error`, { traceparent });
  if (failure.status !== 500) {
    throw new Error(`expected 500 from /jaytrace-qa/error, got ${failure.status}: ${failure.body.slice(0, 300)}`);
  }

  const trace = await readTrace(traceId);
  const backEventCount = trace.back.events?.length ?? 0;
  const backTimelineCount = trace.back.timeline?.length ?? 0;
  if (backEventCount < 1 || backTimelineCount < 1) {
    throw new Error(
      `backend document has no timeline evidence events=${backEventCount} timeline=${backTimelineCount}: ${traceId}`
    );
  }

  // 서비스명 soft 단언: SAMPLE_NEST_SERVICE가 설정된 경우에만 확인한다.
  if (expectedService && trace.back.service !== expectedService) {
    throw new Error(`unexpected backend service: expected ${expectedService}, got ${trace.back.service}`);
  }

  return {
    traceId,
    healthStatus: health.status,
    health: safeJson(health.body),
    errorStatus: failure.status,
    backService: trace.back.service,
    backServiceChecked: Boolean(expectedService),
    backError: trace.back.error?.name ?? null,
    backEventCount,
    backTimelineCount,
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
