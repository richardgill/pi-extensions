import { spawn } from "node:child_process";

type Command = readonly [string, readonly string[]];

type CommandResult = {
  command: string;
  exitCode: number | null;
};

const commands: Command[] = [
  ["pnpm", ["run", "check"]],
  ["pnpm", ["run", "misc-checks"]],
  ["pnpm", ["run", "typecheck"]],
  ["pnpm", ["run", "test"]],
  ["pnpm", ["run", "knip"]],
];

const formatCommand = ([command, args]: Command) => [command, ...args].join(" ");

const runCommand = (commandToRun: Command): Promise<CommandResult> =>
  new Promise((resolve) => {
    const [command, args] = commandToRun;
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("close", (exitCode) => resolve({ command: formatCommand(commandToRun), exitCode }));
  });

const runCiCommand = async (command: Command) => {
  const result = await runCommand(command);

  if (result.exitCode !== 0) {
    console.error(`\n❌ ${result.command} failed`);
    process.exit(2);
  }

  console.log(`✅ ${result.command} success`);
};

const main = async () => {
  console.log(`Running local-ci: ${commands.map(formatCommand).join(", ")}\n`);

  for (const command of commands) {
    await runCiCommand(command);
  }
};

void main();
