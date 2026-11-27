import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const WINDOWS = process.platform === "win32";
const WORKFLOW = "review-loop";
const HELP = [
  "Usage: node scripts/review-loop-cli.mjs <command> [options]",
  "",
  "  start       Start a review with a new key or return an existing run for --key.",
  "  list        List workflow runs.",
  "  questions   List questions waiting for a reply.",
  "  show        Inspect a run; requires --run.",
  "  merge       Approve a local merge; requires --run.",
  "  leave       Keep the work on its branch; requires --run.",
  "",
  "Start options:",
  "  --task TEXT | --task-file FILE    Task and acceptance criteria in UTF-8.",
  "  --project DIR                     Registered T3 Git project root (required).",
  "  --builder NAME                    Entry in AGENTS (default: first entry).",
  "  --reviewers NAMES                 1-2 comma-separated reviewer names (default: others).",
  "  --test COMMAND                    Test command to run in the builder worktree.",
  "  --base BRANCH                     Local target branch (default: main).",
  "  --branch BRANCH                   New worktree branch (default: generated).",
  "  --max-rounds N                    1 to 5 (default: 3).",
  "  --key KEY                         Stable key for retries (default: random).",
  "",
  "Common options: --t3 FILE, --help. Use --json with start, list, questions, and show.",
  "Windows desktop fallback env vars: T3CODE_DESKTOP_EXE and T3CODE_DESKTOP_ENTRY.",
].join("\n");

const string = { type: "string" };
const common = { t3: string, help: { type: "boolean", short: "h" } };
const json = { type: "boolean" };
const commands = new Map([
  ["start", {
    json, task: string, "task-file": string, project: string, builder: string, reviewers: string,
    test: string, base: string, branch: string, "max-rounds": string, key: string,
  }],
  ["list", { json }],
  ["questions", { json }],
  ["show", { json, run: string }],
  ["merge", { run: string }],
  ["leave", { run: string }],
]);

export function invocation(argv) {
  const [command, ...args] = argv;
  if (!command || ["help", "--help", "-h"].includes(command)) return null;
  if (!commands.has(command)) throw new Error("Unknown command " + command + ". Use --help.");
  const { values } = parseArgs({ args, options: { ...common, ...commands.get(command) } });
  if (values.help) return null;

  let t3Args = ["workflow", command];
  if (command === "start") {
    if ((values.task === undefined) === (values["task-file"] === undefined)) {
      throw new Error("Provide exactly one of --task and --task-file.");
    }
    const task = values.task ?? readFileSync(values["task-file"], "utf8").replace(/^\uFEFF/, "");
    if (!task.trim()) throw new Error("The task is empty.");
    const project = values.project?.trim();
    if (!project) {
      throw new Error("--project is required (pass the registered T3 Git project root, e.g. --project .).");
    }
    const rounds = values["max-rounds"];
    if (rounds !== undefined && !/^[1-5]$/.test(rounds)) throw new Error("--max-rounds must be 1 to 5.");
    let reviewers;
    if (values.reviewers !== undefined) {
      const parts = values.reviewers.split(",").map((name) => name.trim());
      if (parts.some((name) => !name) || parts.length < 1 || parts.length > 2) {
        throw new Error("--reviewers must list 1 or 2 comma-separated agent names.");
      }
      reviewers = parts;
    }
    const payload = {
      task,
      project: resolve(project),
      builder: values.builder,
      reviewers,
      baseRef: values.base,
      branch: values.branch,
      testCommand: values.test,
      maxRounds: rounds === undefined ? undefined : Number(rounds),
    };
    const key = values.key === undefined ? "review-loop-" + randomUUID() : values.key.trim();
    if (!key) throw new Error("--key cannot be empty.");
    t3Args.push(WORKFLOW, "--input", JSON.stringify(payload), "--key", key);
  } else if (command === "show" || command === "merge" || command === "leave") {
    const runId = values.run?.trim();
    if (!runId || runId.startsWith("-")) throw new Error("--run must be a T3 workflow run ID.");
    if (command === "show") t3Args.push(runId);
    else {
      const choice = command === "merge" ? "Merge" : "Leave on branch";
      t3Args = [
        "workflow", "signal", JSON.stringify({ choice }), "--run", runId, "--wait", "approve-merge",
      ];
    }
  }
  if (values.json) t3Args.push("--json");
  return { t3Args, explicitPath: values.t3 };
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// Read the installed T3 shim as data. Batch argument expansion corrupts JSON payloads.
function windowsShim(shimPath, env) {
  let contents;
  try {
    contents = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const desktop = contents.includes("Written by T3 Code: runs the desktop app's bundled t3 CLI.");
  const lines = contents.split(/\r?\n/);
  if (desktop) {
    const launch = lines.find((line) => /^"[^"]+" "[^"]+" %\*$/.test(line));
    const [, executable, entry] = launch?.match(/^"([^"]+)" "([^"]+)" %\*$/) ?? [];
    const file = executable?.replaceAll("%%", "%");
    if (file && isAbsolute(file) && extname(file).toLowerCase() === ".exe" && isExecutable(file) &&
        /[\\/]apps[\\/]server[\\/]dist[\\/]bin\.mjs$/i.test(entry)) {
      const home = lines.find((line) => /^if not defined T3CODE_HOME set "T3CODE_HOME=/.test(line))
        ?.match(/^if not defined T3CODE_HOME set "T3CODE_HOME=([^"]+)"$/)?.[1];
      return {
        file,
        prefix: [entry.replaceAll("%%", "%")],
        env: {
          ...env,
          T3CODE_HOME: env.T3CODE_HOME || home?.replaceAll("%%", "%") || join(homedir(), ".t3"),
          T3CODE_CLI_PATH: shimPath,
          ELECTRON_RUN_AS_NODE: "1",
          T3CODE_DESKTOP_CLI_LAUNCHER: "1",
        },
      };
    }
  } else {
    const [, executable] = contents.trim().match(/^@echo off\r?\n"([^"]+)" %\*$/i) ?? [];
    if (executable && isAbsolute(executable) && basename(executable).toLowerCase() === "t3.exe" &&
        isExecutable(executable)) {
      return { file: executable, prefix: [], env };
    }
  }
  return null;
}

export function findT3(explicitPath, env = process.env) {
  if (explicitPath !== undefined) {
    if (!explicitPath.trim()) {
      throw new Error("--t3 must point to an executable T3 CLI (t3.exe or T3-generated t3.cmd on Windows).");
    }
    const file = resolve(explicitPath);
    if (WINDOWS && extname(file).toLowerCase() === ".cmd") {
      const target = windowsShim(file, env);
      if (target) return target;
      throw new Error(
        "--t3 points to a .cmd file that is not a recognized T3 launcher shim. " +
        "Use t3.exe, or set T3CODE_DESKTOP_EXE and T3CODE_DESKTOP_ENTRY for T3 Desktop.",
      );
    }
    if ((WINDOWS && extname(file).toLowerCase() !== ".exe") || !isExecutable(file)) {
      throw new Error("--t3 must point to an executable T3 CLI (t3.exe or T3-generated t3.cmd on Windows).");
    }
    return { file, prefix: [], env };
  }

  const desktopExe = env.T3CODE_DESKTOP_EXE?.trim();
  const desktopEntry = env.T3CODE_DESKTOP_ENTRY?.trim();
  if (desktopExe || desktopEntry) {
    if (!desktopExe || !desktopEntry) {
      throw new Error("Set both T3CODE_DESKTOP_EXE and T3CODE_DESKTOP_ENTRY to override the T3 Desktop CLI launcher.");
    }
    const file = resolve(desktopExe);
    if ((WINDOWS && extname(file).toLowerCase() !== ".exe") || !isExecutable(file)) {
      throw new Error("T3CODE_DESKTOP_EXE must point to an executable T3 Desktop binary.");
    }
    if (!isAbsolute(desktopEntry)) {
      throw new Error("T3CODE_DESKTOP_ENTRY must be an absolute path to T3 Desktop's bundled CLI entry (bin.mjs).");
    }
    return {
      file,
      prefix: [desktopEntry],
      env: {
        ...env,
        T3CODE_HOME: env.T3CODE_HOME || join(homedir(), ".t3"),
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_DESKTOP_CLI_LAUNCHER: "1",
      },
    };
  }

  const t3Home = env.T3CODE_HOME || join(homedir(), ".t3");
  const folders = [
    ...(env.PATH || env.Path || "").split(delimiter).map((dir) => dir.replace(/^"|"$/g, "")).filter(isAbsolute),
    env.T3CODE_INSTALL_BIN_DIR || join(homedir(), ".local", "bin"),
    join(t3Home, "bin"),
  ];
  for (const dir of new Set(folders)) {
    const file = join(dir, WINDOWS ? "t3.exe" : "t3");
    if (isExecutable(file)) return { file, prefix: [], env };
    if (WINDOWS) {
      const target = windowsShim(join(dir, "t3.cmd"), env);
      if (target) return target;
    }
  }
  throw new Error(
    "T3 CLI not found. Open T3 Desktop to create its launcher, install the T3 CLI, " +
    "pass --t3 FILE, or set T3CODE_DESKTOP_EXE and T3CODE_DESKTOP_ENTRY.",
  );
}

export function launch(target, args, stdio = "inherit") {
  return spawn(target.file, [...target.prefix, ...args], {
    env: target.env,
    stdio,
    windowsHide: true,
    shell: false,
  });
}

export function isDirectExecution(metaMain, argv1 = process.argv[1]) {
  if (typeof metaMain === "boolean") return metaMain;
  if (!argv1) return false;
  const normalize = (file) => {
    let target = resolve(file);
    try {
      target = realpathSync(target);
    } catch {
      // Keep resolved path when realpath is unavailable.
    }
    return WINDOWS ? target.toLowerCase() : target;
  };
  return normalize(argv1) === normalize(fileURLToPath(import.meta.url));
}

async function main(argv) {
  const request = invocation(argv);
  if (!request) {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  const child = launch(findT3(request.explicitPath), request.t3Args);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

if (isDirectExecution(import.meta.main)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write("review-loop: " + error.message + "\n");
    process.exitCode = 1;
  }
}

