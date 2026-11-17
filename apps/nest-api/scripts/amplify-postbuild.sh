#!/usr/bin/env bash
# Amplify 배포 스펙(.amplify-hosting/) 생성. deployment-amplify.md 2단계.
set -euo pipefail
cd "$(dirname "$0")/../../.."

HOSTING=apps/nest-api/.amplify-hosting
OUT="$HOSTING/compute/default"

rm -rf "$HOSTING"
# workspace 의존(@jaytrace/nestjs 등)까지 실파일로 격리 설치 (self-contained).
# hoisted: Amplify 번들러가 pnpm 심링크를 못 따라가므로 실파일로 깐다 (콘솔 앱과 동일 이유)
pnpm --filter @jaytrace/example-nest-api deploy --prod --config.node-linker=hoisted "$OUT"
# dist는 pack 규칙상 deploy 결과에 포함되지만, 혹시 빠졌으면 복사
[ -d "$OUT/dist" ] || cp -r apps/nest-api/dist "$OUT/dist"
# 로컬 시크릿이 배포 아티팩트에 실리면 안 된다.
rm -f "$OUT/.env"

# Amplify env는 빌드 타임에만 존재한다. 런타임(Lambda)에 전달하려면
# 빌드 시점 env를 번들 .env로 구워 넣고, 부트스트랩에서 로드한다.
env | grep '^JAYTRACE_' > "$OUT/.env" || true

cat > "$OUT/server.mjs" <<'EOF'
import { fileURLToPath } from "node:url";
try {
  process.loadEnvFile(fileURLToPath(new URL("./.env", import.meta.url)));
} catch {} // .env 없으면(로컬 검증 등) 셸 env 그대로 사용
await import("./dist/main.js");
EOF

cat > "$HOSTING/deploy-manifest.json" <<'EOF'
{
  "version": 1,
  "framework": { "name": "nestjs", "version": "11.0.0" },
  "routes": [
    { "path": "/*", "target": { "kind": "Compute", "src": "default" } }
  ],
  "computeResources": [
    { "name": "default", "runtime": "nodejs20.x", "entrypoint": "server.mjs" }
  ]
}
EOF

echo "amplify-postbuild: $(du -sh "$OUT" | cut -f1) at $HOSTING"
