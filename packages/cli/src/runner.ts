import { spawn } from "node:child_process";
import type { AiRunner } from "./types.js";

export async function runAi(ai: AiRunner, model: string, prompt: string): Promise<number> {
  if (ai === "print") {
    process.stdout.write(prompt);
    return 0;
  }

  const command = ai === "ollama" ? "ollama" : "claude";
  const args = ai === "ollama" ? ["run", model] : ["--print"];

  return await runProcess(command, args, prompt);
}

export async function runAwsSync(source: string, destination: string): Promise<number> {
  return await runProcess("aws", ["s3", "sync", source, destination], undefined);
}

function runProcess(command: string, args: string[], input: string | undefined): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "inherit", "inherit"]
    });

    child.on("error", (error) => {
      process.stderr.write(`[jaytrace] failed to start ${command}: ${error.message}\n`);
      resolve(1);
    });

    child.on("close", (code) => {
      resolve(code ?? 1);
    });

    child.stdin.end(input);
  });
}
