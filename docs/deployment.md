# JayTrace 배포 가이드 (사설 배포판)

SDK를 **허가된 사용자/CI만 설치**할 수 있게 배포하는 절차. 공개 npm에는 올리지 않는다.

배포 대상은 4개다:

| 조각 | 위치 | 배포 형태 |
|------|------|----------|
| SDK 패키지 4개 | `packages/{core,replay-core,replay-web,browser-sdk}` | 사설 레지스트리 publish |
| Collector | `apps/nest-api` | 상시 실행 서버 (Docker) |
| 콘솔 | `apps/next-app` | 내부 운영용 웹앱 (self-hosted) |
| S3 버킷 | `infra/aws/` | 전용 버킷 1개 |

---

## 0단계. 레지스트리 선택 (한 번만 결정)

**GitHub Packages 제약:** 패키지 스코프가 GitHub 조직명과 일치해야 한다.
조직이 `example-org`라면 `@jaytrace/browser`를 그대로 publish할 수 없다.

- **옵션 A — GitHub Packages** (sample-web이 GitHub 조직 private 레포일 때 최선):
  패키지 스코프를 조직명으로 변경한다 (`@jaytrace/browser` → `@<org>/jaytrace-browser`).
  모노레포 내 4개 패키지의 `name`과 상호 의존성 표기를 일괄 치환해야 한다.
- **옵션 B — AWS CodeArtifact** (스코프를 `@jaytrace`로 유지하고 싶을 때):
  스코프 제약이 없고 IAM으로 접근 제어. 이미 S3/IAM을 쓰고 있어 운영 결이 맞다.

아래 1~3단계는 옵션 A 기준으로 쓰되, 옵션 B의 차이는 각 단계 끝에 표기한다.

---

## 1단계. S3 전용 버킷 생성 (최초 1회)

현재 개발 환경은 `example-shared-bucket` 버킷을 빌려 쓴다. 프로덕션 트래픽 전에 반드시 분리한다.

```bash
# 미리보기 (AWS 호출 없음)
infra/aws/apply-s3-config.sh --bucket jaytrace-prod --region ap-northeast-2 --create-bucket --dry-run
# 실제 생성: 버킷 + 퍼블릭 차단 + SSE 암호화 + 라이프사이클 + CORS
infra/aws/apply-s3-config.sh --bucket jaytrace-prod --region ap-northeast-2 --create-bucket
```

IAM 정책을 역할별로 만들어 붙인다 (`YOUR_JAYTRACE_BUCKET` → `jaytrace-prod`, 필요하면 `YOUR_JAYTRACE_PREFIX`도 치환):

- `infra/aws/producer-iam-policy.json` → collector 런타임 자격 (PutObject 전용)
- `infra/aws/developer-readonly-iam-policy.json` → 개발자 자격 (읽기 전용으로 유지 가능)
- `infra/aws/console-iam-policy.json` → 콘솔 런타임 자격 (읽기 + `_state/issues/` 아래에만 PutObject)

## 2단계. SDK를 사설 레지스트리에 publish

### 2-1. 인증 설정

jay-trace 레포 루트 `.npmrc` (커밋 금지, 또는 CI 시크릿):

```ini
@<org>:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

로컬에서는 `write:packages` 권한의 PAT를, GitHub Actions에서는 기본 제공 `GITHUB_TOKEN`을 쓴다.

### 2-2. publish

```bash
pnpm build   # dist 최신화 (browser-sdk가 dist를 번들함)
pnpm -r --filter "./packages/*" publish --access restricted --no-git-checks
```

`--access restricted`가 핵심 — 조직 멤버/토큰 보유자만 설치 가능해진다.

### 2-3. CI 자동화 (선택, 권장)

태그 push 시 publish하는 GitHub Actions:

```yaml
# .github/workflows/publish.yml
on:
  push:
    tags: ["v*"]
permissions:
  contents: read
  packages: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: "https://npm.pkg.github.com" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm -r --filter "./packages/*" publish --access restricted --no-git-checks
        env: { NODE_AUTH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
```

> **옵션 B(CodeArtifact) 차이:** `.npmrc`의 registry URL을 CodeArtifact 엔드포인트로, 토큰은
> `aws codeartifact get-authorization-token`으로 발급(12시간 유효, CI에서 매회 발급).
> 스코프 변경 불필요. 설치 권한은 IAM 정책(`codeartifact:ReadFromRepository`)으로 제어.

## 3단계. Collector 배포

`apps/nest-api`는 stateless NestJS 서버다. S3가 저장소이므로 수평 확장 가능.

```dockerfile
# apps/nest-api/Dockerfile (예시)
FROM node:22-slim
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm --filter @jaytrace/example-nest-api build
CMD ["node", "apps/nest-api/dist/main.js"]
```

런타임 env:

| 변수 | 값 | 비고 |
|------|-----|------|
| `PORT` | 3000 | |
| `JAYTRACE_API_KEY` | 프로덕션 키 (강한 랜덤) | sample-web env와 짝 |
| `JAYTRACE_BUCKET` | `jaytrace-prod` | |
| AWS 자격 | producer IAM (PutObject 전용) | ECS면 태스크 롤 권장 |
| `JAYTRACE_BODY_LIMIT` | `1mb` (기본) | |

배포 후 체크리스트:

- HTTPS 도메인 연결 (예: `https://jaytrace.example.com`) — SDK가 브라우저에서 직접 POST
- `GET /jaytrace/health`를 모니터링에 등록, **spoolBacklog > 100이면 알림** (S3 업로드 실패 적체 신호)
- 스풀 디렉터리(`$TMPDIR/jaytrace-spool` 또는 `spoolDir` 옵션)가 재시작에도 유지되는 볼륨인지 확인

## 4단계. sample-web 연동 전환 (로컬 링크 → 레지스트리)

sample-web 레포에서:

1. `.npmrc` 추가 (2-1과 동일한 2줄, 토큰은 CI 시크릿으로)
2. `pnpm-workspace.yaml`의 jay-trace 로컬 경로 제거, 의존성을 버전으로 교체:
   ```bash
   pnpm add @<org>/jaytrace-browser@^0.1.0
   ```
3. `src/instrumentation-client.ts`의 import 경로만 새 패키지명으로 수정 (코드 3줄은 그대로)
4. 프로덕션 env (배포 파이프라인에 주입, 코드 변경 없음):
   ```
   NEXT_PUBLIC_JAYTRACE_ENDPOINT=https://jaytrace.example.com/jaytrace/rum
   NEXT_PUBLIC_JAYTRACE_API_KEY=<3단계의 프로덕션 키>
   NEXT_PUBLIC_JAYTRACE_REPLAY_SAMPLE_RATE=0.1
   ```

- `sampleRate 0.1` 권장: 에러 세션은 샘플링과 무관하게 100% 캡처되므로 커버리지 손실 없이 저장 비용 1/10 (`infra/aws/README.md` 용량 산정 참고)
- `NEXT_PUBLIC_JAYTRACE_REPLAY_PRIVACY`는 **QA 전용** — 프로덕션에 넣지 않는다 (기본 전체 마스킹 유지)

## 5단계. 콘솔 배포 (내부 운영용)

`apps/next-app`은 **인증이 없다.** 사용자 세션 리플레이를 보는 도구이므로 반드시 접근 제한 뒤에 둔다.

1. VPN 내부망 또는 SSO 프록시(Cloudflare Access, ALB+OIDC 등) 뒤에 배치
2. env: `JAYTRACE_BUCKET=jaytrace-prod`, AWS 자격은 `infra/aws/console-iam-policy.json`
   - 실행 중인 콘솔은 이슈 상태를 저장하므로 `YOUR_JAYTRACE_PREFIX/_state/issues/*`에만 `s3:PutObject`가 필요하다.
   - 개발자 개인 자격은 `developer-readonly-iam-policy.json`을 계속 사용할 수 있다.
3. 빌드·기동:
   ```bash
   pnpm --filter @jaytrace/example-next-app build
   PORT=3022 pnpm --filter @jaytrace/example-next-app start
   ```

`PATCH /api/issues/:fingerprint`는 인증 경계가 아니다. 콘솔의 모든 API는 위 VPN/SSO 프록시가
외부 인증을 담당한다는 전제이므로, PATCH 경로도 동일한 사설 접근 경계 안에서만 노출한다.

> 주의: `.env`에 `NODE_ENV=production`이 있으면 `next dev`(개발 모드)가 오동작한다.
> 프로덕션은 build+start를 쓰므로 무관하지만, 서버에서 dev 모드를 띄울 일이 있으면 `NODE_ENV=development`를 명시한다.

## 6단계. 릴리스 반복 절차

```bash
# jay-trace
pnpm -r --filter "./packages/*" exec npm version patch
git commit -am "release: vX.Y.Z" && git tag vX.Y.Z && git push --tags   # → CI가 publish

# sample-web
pnpm update @<org>/jaytrace-browser && 배포
```

Collector/콘솔은 코드 변경이 있을 때만 이미지 재빌드·재배포하면 된다.
