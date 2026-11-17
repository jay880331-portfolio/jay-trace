import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";

const distDir = process.env.JAYTRACE_NEXT_DIST_DIR || ".next-console";

await rm(new URL(`../${distDir}`, import.meta.url), { recursive: true, force: true });

const child = spawn("pnpm", [
  "--dir",
  "apps/next-app",
  "exec",
  "next",
  "dev",
  "-p",
  process.env.PORT || "3008"
// next dev는 항상 development여야 한다 — --env-file로 collector .env의 NODE_ENV=production이 새어 들어오면 죽는다.
], { stdio: "inherit", env: { ...process.env, NODE_ENV: "development", JAYTRACE_NEXT_DIST_DIR: distDir } });

child.on("exit", code => process.exit(code ?? 0));
