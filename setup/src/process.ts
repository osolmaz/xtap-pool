import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export async function captureCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return run(command, args, options, true);
}

export async function inheritCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<void> {
  await run(command, args, options, false);
}

async function run(
  command: string,
  args: readonly string[],
  options: CommandOptions,
  capture: boolean,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const chunks = { stdout: "", stderr: "" };
    if (capture) {
      child.stdout?.on("data", (chunk: Buffer) => {
        chunks.stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        chunks.stderr += chunk.toString("utf8");
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(chunks);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${String(code)}`));
    });
  });
}
