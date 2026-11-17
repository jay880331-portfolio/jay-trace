# JayTrace SDK 배포 가이드 (GitHub Packages)

`@jaytrace/*` npm 패키지를 GitHub Packages 프라이빗 레지스트리로 배포하고,
지정한 사람만 설치할 수 있게 하는 절차. Flutter 패키지(`jaytrace_flutter`)는 npm이 아니므로 대상 아님.

## 1. 최초 1회: org 생성 (GitHub 웹)

소스 repo는 이전하지 않는다.

1. https://github.com/account/organizations/new 에서 **Free** 플랜으로 org 생성 — 이름은 반드시 `jaytrace`
   (패키지 스코프 `@jaytrace`와 일치해야 배포 가능).
2. org 안에 **패키지 권한 관리용 private repo** `jaytrace/packages` 생성 (README 하나면 충분, 소스 불필요).
   각 패키지의 `repository` 필드가 이 repo를 가리키고 있어서, 배포 시 패키지가 이 repo에 연결되고
   **설치 권한 = 이 repo에 초대된 사람**이 된다.

## 2. 최초 1회: 배포자 인증 설정

1. PAT 발급: https://github.com/settings/tokens → *Generate new token (classic)* → 스코프 **`write:packages`** 체크
   (`repo`가 자동 포함됨).
2. 홈 디렉토리 `~/.npmrc`에 추가 (repo에 커밋 금지):

   ```
   //npm.pkg.github.com/:_authToken=ghp_발급받은토큰
   ```

## 3. 배포하기

각 패키지의 `publishConfig.registry`가 이미 GitHub Packages를 가리키므로 명령은 이것뿐:

```bash
pnpm build
pnpm -r publish --no-git-checks
```

- `pnpm -r publish`는 `private: true`가 아닌 패키지 7개를 전부 배포하고,
  `workspace:*` 의존성을 실제 버전으로 자동 치환한다.
- 이미 배포된 버전은 건너뛰므로, 재배포하려면 해당 패키지의 `version`을 올린다.
- `--no-git-checks`는 브랜치/워킹트리 검사 생략. 릴리스 커밋을 만든 뒤 배포한다면 빼도 된다.

배포 확인: https://github.com/orgs/jaytrace/packages

## 4. 설치하는 사람 안내

### 4-1. 접근 권한 부여 (배포자가)

`jaytrace/packages` repo → Settings → Collaborators → 초대 (**Read** 권한이면 설치 가능).
패키지는 연결된 repo의 권한을 그대로 따른다. 소스 repo에는 초대할 필요 없다.

### 4-2. 설치 설정 (설치자가)

1. 초대 수락 후 PAT 발급 — 스코프 **`read:packages`** 만 체크.
2. 프로젝트 루트(또는 `~/`)의 `.npmrc`:

   ```
   @jaytrace:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=ghp_본인토큰
   ```

3. 설치:

   ```bash
   npm install @jaytrace/browser        # 브라우저 RUM SDK
   npm install @jaytrace/nestjs         # NestJS 서버 SDK
   npm install @jaytrace/cli            # CLI
   ```

   `@jaytrace/*` 스코프만 GitHub Packages에서 받고, 나머지 패키지는 평소처럼 npmjs.org에서 받는다.

## 무료 티어 한도

- Private 패키지: 스토리지 500MB + 월 전송 1GB 무료. 초과 시 기본값은 차단(과금 아님).
- 버전이 누적되므로 한도가 신경 쓰이면 org Packages 페이지에서 오래된 버전 삭제.
