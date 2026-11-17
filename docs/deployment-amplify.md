# JayTrace AWS Amplify 배포 가이드

콘솔(`apps/next-app`)과 collector(`apps/nest-api`)를 **AWS Amplify Hosting 하나로** 배포하는 절차.
Docker/상시 서버 없이 git push 배포로 통일하고 싶을 때 쓴다. 상시 실행 배포판은 `deployment.md` 참고.

구성은 **Amplify 앱 2개** (같은 리포, 같은 콘솔):

| 조각 | Amplify 앱 | 배포 방식 |
|------|-----------|----------|
| 콘솔 | `jaytrace-console` (appRoot: `apps/next-app`) | Next.js SSR 자동 감지 |
| Collector | `jaytrace-collector` (appRoot: `apps/nest-api`) | [배포 스펙](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-express-server.html) (`.amplify-hosting/` + `deploy-manifest.json`) |

> Amplify의 SSR compute는 **Lambda 기반**이다. 응답 반환 후 프로세스가 freeze되고,
> 유휴가 길면 인스턴스가 폐기된다. collector는 이를 전제로 아래 env 3개를 반드시 켠다.

---

## 1단계. 콘솔 (`apps/next-app`)

Amplify 콘솔 → 새 앱 → 리포 연결 → "My app is a monorepo" 체크 → appRoot `apps/next-app`.
Next.js가 자동 감지된다. 빌드 설정만 pnpm으로 교체:

```yaml
version: 1
applications:
  - appRoot: apps/next-app
    frontend:
      phases:
        preBuild:
          commands:
            - corepack enable && corepack prepare pnpm@latest --activate
            - pnpm install --frozen-lockfile
        build:
          commands:
            - pnpm build
      artifacts:
        baseDirectory: .next
        files:
          - "**/*"
      cache:
        paths:
          - "node_modules/**/*"
```

env는 기존 콘솔 env(S3 조회, DB 인덱스 등)를 Amplify 앱 환경변수로 그대로 옮긴다.

## 2단계. Collector (`apps/nest-api`)

Amplify는 NestJS를 자동 감지하지 못한다. 빌드 출력물을 배포 스펙 형태로 직접 만든다:

```
.amplify-hosting/
├── deploy-manifest.json
└── compute/
    └── default/          # dist + node_modules + package.json (self-contained)
```

`deploy-manifest.json` 최소형 (스키마는 [공식 문서](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-deployment-specification.html)에서 최신 확인):

```json
{
  "version": 1,
  "framework": { "name": "nestjs", "version": "11.0.0" },
  "routes": [
    { "path": "/*", "target": { "kind": "Compute", "src": "default" } }
  ],
  "computeResources": [
    { "name": "default", "runtime": "nodejs20.x", "entrypoint": "main.js" }
  ]
}
```

주의점 2개:

- **엔트리포인트는 3000 포트에서 listen해야 한다.** `main.ts`가 `process.env.PORT ?? 3000`이라 그대로 동작.
- **`compute/default`는 self-contained여야 한다.** pnpm workspace 의존(`@jaytrace/nestjs` 등)이 심링크라
  디렉토리 복사로는 안 된다. `pnpm --filter nest-api deploy --prod <출력경로>`로 격리 설치본을 만들어
  `dist`와 함께 넣는 postbuild 스크립트를 쓴다.

## 3단계. Collector env (필수)

| env | 값 | 이유 |
|-----|----|------|
| `JAYTRACE_DRAIN_ON_INGEST` | `1` | 응답 전에 S3 업로드 완료를 보장 (freeze 시 스팬 유실 방지) |
| `JAYTRACE_RETENTION_TIMER` | `0` | in-process 24h 타이머 비활성화 (Lambda에선 동작 보장 안 됨) |
| `JAYTRACE_INTERNAL_TOKEN` | 랜덤 시크릿 | `POST /internal/retention` 인증. 미설정 시 엔드포인트 404 |

나머지(S3 버킷/리전, retention 일수, DB 인덱서 등)는 기존 collector env 그대로.

## 4단계. EventBridge Scheduler 2개

Lambda 환경에서 죽는 백그라운드 동작을 외부 스케줄로 대체한다:

| 스케줄 | 주기 | 동작 |
|--------|------|------|
| retention | 매일 1회 | `POST https://<collector>/internal/retention` + 헤더 `x-jaytrace-internal: <토큰>` |
| keep-warm | 5분 | collector health 엔드포인트 GET (콜드 스타트 완화) |

EventBridge Scheduler의 "API destination"(HTTP 타깃)으로 만들면 Lambda 없이 끝난다.

## 제약 (알고 쓰기)

- **콜드 스타트**: keep-warm으로 완화되지만, 동시 요청 스파이크 시 첫 요청 1~2초 지연은 남는다.
  Amplify는 provisioned concurrency를 노출하지 않는다.
- **spool 무의미**: S3 업로드 실패 시 로컬 spool(`/tmp`)은 인스턴스 폐기와 함께 사라진다.
  `JAYTRACE_DRAIN_ON_INGEST=1`이면 실패가 5xx로 드러나 SDK 재시도에 맡기는 쪽이 실효적이다.
- **요청당 지연**: drain 대기만큼(S3 PUT ~50–100ms) ingest 응답이 느려진다. SDK가 백그라운드로
  전송하므로 사용자 체감에는 영향 없다.
- **CORS**: collector `main.ts`의 `allowedHeaders`에 `traceparent`, `x-jaytrace-session`,
  `x-jaytrace-internal`이 있어야 브라우저 SDK가 붙는다 (코드에 반영돼 있음).
