# JayTrace Next.js 연동 가이드 (AI 실행용)

> 이 문서를 AI 에이전트에게 그대로 전달하면, 대상 Next.js 프로젝트에 JayTrace RUM(Real User Monitoring)을 처음부터 끝까지 연동할 수 있다. 각 단계는 순서대로 실행하고, 마지막 검증 체크리스트를 모두 통과해야 완료다.
>
> 실측 레퍼런스: sample-web (Next.js 16, pnpm) — 이 문서의 모든 코드는 실제 동작이 확인된 패턴이다.

## 시작 전에 확보할 입력값

아래 기본값(dev — Amplify collector)이 있으므로 사용자에게 묻지 말고 그대로 사용한다. 사용자가 다른 값을 지정한 경우에만 그 값을 쓴다.

| 입력값 | 기본값 (dev) | 설명 |
|--------|--------------|------|
| `ENDPOINT` | `https://<your-collector-host>/jaytrace/rum` | JayTrace collector의 RUM 수집 URL |
| `API_KEY` | `local-dev-key` | collector가 허용하는 API 키 |
| `SERVICE` | 프로젝트명 (예: `sample-web`) | 이 앱을 식별할 서비스명 — 대상 프로젝트의 `package.json` `name`을 사용 |
| `NPM_TOKEN` | 기본값 없음 — **Step 1에서 반드시 확인** | `@jaytrace` 패키지 설치용 GitHub PAT (`read:packages` 권한) |

## Step 0 — 프로젝트 파악

1. 프레임워크·버전 확인: `package.json`에서 `next` 버전을 읽는다.
   - **Next.js 15.3 이상**: 이 가이드를 그대로 따른다 (`instrumentation-client.ts` 사용).
   - **Next.js 15.3 미만**: Step 2의 초기화 코드를 `instrumentation-client.ts` 대신 루트 레이아웃에 마운트되는 `'use client'` 컴포넌트의 `useEffect`(1회 실행)로 옮긴다. 나머지 단계는 동일.
2. 패키지 매니저 확인 (`pnpm-lock.yaml` / `package-lock.json` / `yarn.lock`).
3. `src/` 디렉토리 사용 여부 확인 — 아래 경로의 `src/`는 프로젝트 구조에 맞게 조정한다.
4. 환경변수 관리 방식 확인 (`.env.local` 직접 사용인지, 환경별 파일을 복사하는 스크립트인지).

## Step 1 — 패키지 설치

`@jaytrace/browser`는 GitHub Packages에 배포된다.

**1a. `NPM_TOKEN` 확인 (필수 선행)** — 설치 전에 토큰이 있는지 먼저 확인한다:

```bash
[ -n "$NPM_TOKEN" ] && echo "NPM_TOKEN OK" || echo "NPM_TOKEN MISSING"
```

`MISSING`이면 **여기서 멈추고** 사용자에게 다음을 안내한 뒤 토큰을 받을 때까지 진행하지 않는다:

> `@jaytrace` 패키지 설치에 GitHub Personal Access Token이 필요합니다.
> 1. https://github.com/settings/tokens 에서 `read:packages` 권한의 PAT을 생성하세요.
> 2. 셸 환경에 등록: `export NPM_TOKEN=ghp_...` (영구 적용은 `~/.zshrc`에 추가)

**1b. `.npmrc` 설정** — 프로젝트 루트 `.npmrc`에 레지스트리 설정을 추가한다 (이미 있으면 유지):

```ini
@jaytrace:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

**1c. 설치:**

```bash
pnpm add @jaytrace/browser   # 또는 npm install / yarn add
```

설치 실패(401/404) 시: `NPM_TOKEN`이 유효한지, `read:packages` 권한이 있는지 사용자에게 확인을 요청한다.

## Step 2 — 클라이언트 초기화 (필수)

`src/instrumentation-client.ts` 파일을 생성한다 (이미 있으면 아래 import·호출만 추가):

```typescript
import { initJayTraceNext } from '@jaytrace/browser/next';

initJayTraceNext({
  service: 'SERVICE',            // 예: 'sample-web'
  captureBody: true,             // HTTP 요청/응답 본문 캡처
  captureViews: true,            // 페이지 뷰 캡처
  captureConsole: ['error', 'warn'],
});
```

`initJayTraceNext`는 옵션에 없는 값을 환경변수에서 읽는다 (Step 4 참고). 에러·rage click 발생 시 자동으로 타임라인을 collector로 전송하며, `window.__jayTraceClient`에 클라이언트 인스턴스를 노출한다.

Sentry 등 기존 모니터링 코드가 같은 파일에 있어도 무방하다 — `initJayTraceNext`를 파일 상단에서 호출하면 된다.

## Step 3 — SSR 추적 (권장, 선택)

서버 사이드 렌더링 중의 fetch까지 같은 트레이스로 묶으려면 두 가지를 추가한다.

**3a. `src/instrumentation.ts`** (이미 있으면 nodejs 분기에 한 줄 추가):

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    (await import('@jaytrace/browser/next/server')).registerJayTraceNext({ captureBody: true });
  }
}
```

**3b. 루트 레이아웃의 `<head>`에 traceparent 메타 태그** — SSR 트레이스와 브라우저 트레이스를 연결한다. 루트 `layout.tsx`를 async 컴포넌트로 두고:

```tsx
import { getJayTraceSSRTraceparent } from '@jaytrace/browser/next/server';

// layout 컴포넌트의 <head> 안에:
<meta
  name='jaytrace-traceparent'
  content={(await getJayTraceSSRTraceparent()) ?? ''}
/>
```

주의: 이 SSR 통합은 프로세스 전역 상태 기반이라 로컬/저동시성 QA 용도다. 고동시성 프로덕션 SSR 추적이 필요하면 이 단계를 건너뛴다 (클라이언트 추적만으로도 동작한다).

## Step 4 — 환경변수

프로젝트의 환경변수 파일(대개 `.env.local` 또는 환경별 `.env.*` — 개발 환경 파일이 따로 있으면 그 파일)에 추가한다. 사용자가 별도 값을 주지 않았다면 아래 dev 기본값을 그대로 넣는다 (`NEXT_PUBLIC_JAYTRACE_SERVICE`만 프로젝트명으로 교체):

```bash
# JayTrace (dev — Amplify collector로 전송)
NEXT_PUBLIC_JAYTRACE_API_KEY=local-dev-key
NEXT_PUBLIC_JAYTRACE_ENDPOINT=https://<your-collector-host>/jaytrace/rum
NEXT_PUBLIC_JAYTRACE_SERVICE=sample-web
NEXT_PUBLIC_APP_VERSION=local-qa
```

`NEXT_PUBLIC_APP_VERSION`은 릴리스 태그로 쓰인다 (`NEXT_PUBLIC_JAYTRACE_RELEASE`가 없을 때의 fallback). 이미 프로젝트에 정의돼 있으면 기존 값을 유지한다.

동작 규칙:

- `NEXT_PUBLIC_JAYTRACE_ENDPOINT` 미설정 시 기본값은 same-origin `/jaytrace/rum`.
- endpoint가 cross-origin이면 SDK가 해당 origin을 자동으로 추적 대상에 포함한다. same-origin API 호출은 항상 추적된다.
- Step 3(SSR)을 적용했다면 서버 런타임에서도 이 변수들이 보여야 한다. 서버 전용으로 분리하고 싶으면 `JAYTRACE_ENDPOINT` / `JAYTRACE_API_KEY`(NEXT_PUBLIC_ 접두사 없음)도 인식된다.

선택 변수 (필요 시에만):

```bash
NEXT_PUBLIC_JAYTRACE_TRACE_ORIGINS=https://api.example.com   # 추가 추적 origin (콤마 구분)
NEXT_PUBLIC_JAYTRACE_RELEASE=1.2.3                           # 릴리스 태그 (또는 NEXT_PUBLIC_APP_VERSION)
NEXT_PUBLIC_APP_ENV=production                               # environment 태그 (없으면 NODE_ENV)
NEXT_PUBLIC_JAYTRACE_REPLAY_MODE=on-error                    # 세션 리플레이: always | on-error | off
NEXT_PUBLIC_JAYTRACE_REPLAY_SAMPLE_RATE=0.1                  # 리플레이 샘플링 (0–1)
NEXT_PUBLIC_JAYTRACE_REPLAY_PRIVACY=mask-all                 # mask-all | mask-inputs | allow
```

배포 환경(스테이징/프로덕션)에도 켜려면 해당 환경의 변수 주입 경로(CI, 호스팅 콘솔, 환경별 `.env.*` 파일)에 같은 변수를 추가해야 한다 — 빌드 타임에 인라인되므로 변수 없이 빌드하면 그 환경에서는 비활성화된 상태로 남는다.

## Step 5 (선택) — 사용자 식별 & 커스텀 로깅

**사용자 식별** — 로그인 사용자 정보를 알게 되는 지점(기존 auth provider 등)에서:

```typescript
window.__jayTraceClient?.setUser(
  user ? { id: String(user.id), name: user.name } : null
);
```

**커스텀 이벤트/로그** — 비즈니스 이벤트를 타임라인에 남기고 싶은 곳에서:

```typescript
window.__jayTraceClient?.log('info', '결제 버튼 클릭', { plan: 'pro' });
window.__jayTraceClient?.addAction('CheckoutStarted', { plan: 'pro' });
```

`window.__jayTraceClient`의 타입은 `@jaytrace/browser`를 import하는 순간 전역으로 선언되므로 별도 타입 선언이 필요 없다. 옵셔널 체이닝(`?.`)을 반드시 사용한다 (SDK가 비활성화된 환경 대비).

## Step 6 (선택) — same-origin 프록시 라우트

CORS를 피하거나 API 키를 서버에만 두고 싶을 때만 사용한다. `app/jaytrace/rum/route.ts` 생성:

```typescript
export { POST } from '@jaytrace/browser/next/rum-route';
```

이 경우 클라이언트 env는 `NEXT_PUBLIC_JAYTRACE_ENDPOINT`를 **설정하지 않고** (기본값 `/jaytrace/rum` 사용), 서버 env에 실제 collector 주소를 준다:

```bash
JAYTRACE_RUM_ENDPOINT=ENDPOINT
JAYTRACE_API_KEY=API_KEY   # 프록시가 서버 키를 body에 주입
```

기본 연동(Step 4의 cross-origin endpoint 직접 전송)으로 충분하면 이 단계는 건너뛴다.

## 검증 체크리스트 (전부 통과해야 완료)

1. **타입/빌드**: `pnpm build`(또는 프로젝트 빌드 명령)가 성공한다.
2. **초기화 확인**: `pnpm dev`로 앱을 띄우고 브라우저 콘솔에서 `window.__jayTraceClient`가 객체를 반환한다 (`undefined`가 아님).
3. **전송 확인**: 브라우저 DevTools Network 탭에서, 콘솔에 `window.__jayTraceClient.flush('manual')`을 실행했을 때 `ENDPOINT`로의 `POST` 요청이 발생하고 응답이 `200 { "ok": true }`다.
4. **SSR 연결 확인** (Step 3 적용 시): 페이지 소스에 `<meta name="jaytrace-traceparent" content="00-...">`가 비어있지 않은 값으로 렌더링된다.
5. 3번의 POST가 실패하면: 응답 코드별 원인 — `401/403`은 API_KEY 불일치, `404`는 ENDPOINT 경로 오류(`/jaytrace/rum`까지 포함해야 함), CORS 에러는 collector의 허용 origin 설정 또는 Step 6 프록시 사용을 검토한다.

## 트러블슈팅

| 증상 | 원인 / 해결 |
|------|-------------|
| 설치 시 401/404 | `NPM_TOKEN` 미설정 또는 권한 부족. `read:packages` PAT 필요 |
| `window.__jayTraceClient`가 undefined | `instrumentation-client.ts`가 로드되지 않음 — Next.js 15.3+인지, 파일이 `src/`(또는 루트) 바로 아래인지 확인 |
| 이벤트가 안 보임 | 이벤트는 에러·rage click·수동 flush 시에만 전송된다. 평상시 조용한 것이 정상 |
| 배포 환경에서 비활성 | 해당 환경 빌드에 `NEXT_PUBLIC_JAYTRACE_*` 변수가 주입되지 않음. 빌드 타임 인라인이므로 재빌드 필요 |
| traceparent 메타가 빈 값 | Step 3a의 `registerJayTraceNext`가 실행되지 않음 — `instrumentation.ts`의 nodejs 분기 확인 |
