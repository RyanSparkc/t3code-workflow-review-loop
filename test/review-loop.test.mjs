import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { once } from "node:events";
import fsPromises, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findT3, invocation, isDirectExecution, launch } from "../scripts/review-loop-cli.mjs";

const source = await readFile(new URL("../workflows/review-loop.js", import.meta.url), "utf8");
const buildOutput = { summary: "Updated answer", testCommandRun: "none", testsPassed: true };
const accepted = { approved: true, problems: [], summary: "Meets requirements" };

function* effect(type, data) {
  return yield { type, ...data };
}

const schema = new Proxy({}, { get: () => () => ({}) });
Object.assign(globalThis, {
  Schema: schema,
  Effect: {
    fn: (body) => body,
    tryPromise: (options) => options.try,
    all: (values) => effect("parallel", { values }),
  },
  T3: {
    workflow: (_name, _options, body) => body,
    title: () => effect("title"),
    stop: (reason) => effect("stop", { reason }),
    step: (name, _options, run) => effect("step", { name, run }),
    agent: (name, options) => effect("agent", { name, options }),
    ask: (name, options) => effect("ask", { name, options }),
  },
});

function loadWorkflow(threeAgents = false) {
  let configured = source.replaceAll('model: ""', 'model: "test-model"');
  if (threeAgents) configured = configured.replace("// neon:", "neon:");
  return import("data:text/javascript;base64," + Buffer.from(configured).toString("base64"));
}

async function evaluate(body, input, handlers) {
  const events = [];
  const work = body(input, { id: "test-run" });
  const handle = async (event) => {
    events.push(event);
    switch (event.type) {
      case "title": return undefined;
      case "step": return event.run();
      case "stop": return { stopped: event.reason };
      case "ask": return handlers.ask(event);
      case "agent": return handlers.agent(event);
      case "parallel":
        return Promise.all(event.values.map((value) => handle(value.next().value)));
      default: throw new Error("Unexpected effect " + event.type);
    }
  };
  let next = work.next();
  while (!next.done) next = work.next(await handle(next.value));
  return { result: next.value, events };
}

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "review loop 測試-"));
  t.after(() => rm(dir, { force: true, recursive: true, maxRetries: 5 }));
  return dir;
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

async function repo(t) {
  const dir = await temp(t);
  const project = join(dir, "project");
  git(dir, "init", "-b", "main", project);
  git(project, "config", "user.name", "Review Loop Test");
  git(project, "config", "user.email", "review-loop-test@example.invalid");
  git(project, "config", "commit.gpgsign", "false");
  const checkout = join(dir, "builder worktree 工作");
  await writeFile(join(project, "answer.txt"), "1");
  git(project, "add", ".");
  git(project, "commit", "-m", "Base");
  const base = git(project, "rev-parse", "HEAD");

  const build = async ({ name, options }) => {
    assert.equal(name, "build");
    assert.equal(options.workspace.startFromOrigin, false);
    git(project, "worktree", "add", "-b", options.workspace.branch, checkout, options.workspace.baseRef);
    await writeFile(join(checkout, "answer.txt"), "2");
    git(checkout, "add", ".");
    git(checkout, "commit", "-m", "Build");
    return { thread: "original-builder", value: buildOutput };
  };
  return { project, checkout, base, build };
}

test("CLI passes a UTF-8 task file and shell metacharacters as a single JSON argument", async (t) => {
  const dir = await temp(t);
  const task = '第一行\nx > y & a | b < c "quoted" %PATH% ^ !HOME! $HOME';
  const file = join(dir, "task.md");
  await writeFile(file, "\uFEFF" + task);
  const { t3Args } = invocation([
    "start", "--task-file", file, "--project", dir, "--test", "node --test", "--builder", "claude", "--key", "retry",
  ]);
  const echo = join(dir, "argv.mjs");
  await writeFile(echo, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const child = launch({ file: process.execPath, prefix: [echo], env: process.env }, t3Args, ["ignore", "pipe", "pipe"]);
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  assert.deepEqual(await once(child, "close"), [0, null]);
  const received = JSON.parse(stdout);
  assert.deepEqual(received.slice(0, 4), ["workflow", "start", "review-loop", "--input"]);
  assert.deepEqual(JSON.parse(received[4]), { task, project: resolve(dir), builder: "claude", testCommand: "node --test" });
  assert.deepEqual(received.slice(5), ["--key", "retry"]);
  assert.deepEqual(invocation(["leave", "--run", "123"]).t3Args, [
    "workflow", "signal", '{"choice":"Leave on branch"}', "--run", "123", "--wait", "approve-merge",
  ]);
});

test("timeout stops both the test shell and its running child", { timeout: 15_000 }, async (t) => {
  const dir = await temp(t);
  const { runShell } = await loadWorkflow();
  await writeFile(join(dir, "worker.mjs"), [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync("worker.pid", String(process.pid));',
    'setInterval(() => {}, 1000);',
  ].join("\n"));
  await writeFile(join(dir, "parent.mjs"), [
    'import { spawn } from "node:child_process";',
    'const worker = spawn(process.execPath, ["worker.mjs"], { stdio: "inherit" });',
    'worker.once("close", (code) => { process.exitCode = code ?? 1; });',
  ].join("\n"));

  const result = await runShell("node parent.mjs", dir, 1500);
  const pid = Number(await readFile(join(dir, "worker.pid"), "utf8"));
  assert.equal(result.passed, false);
  assert.match(result.outputTail, /Command timed out/);
  assert.doesNotMatch(result.outputTail, /cleanup failed/);
  // Unix can keep an orphaned process as a zombie briefly. Its state Z means
  // it has exited and cannot execute commands.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(pid, 0);
      if (process.platform !== "win32") {
        const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
        if (state.startsWith("Z")) return;
      }
    } catch (error) {
      if (error.code === "ESRCH" || (error.status === 1 && !error.stdout?.trim())) return;
      throw error;
    }
    await delay(50);
  }
  assert.fail("Test child was still running after the timeout");
});

test("two models review both areas and merge the exact tested commit", async (t) => {
  const { project, checkout, base, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  await writeFile(join(project, "probe.mjs"), [
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'assert.equal(readFileSync("answer.txt", "utf8"), "2");',
  ].join("\n"));
  const { result, events } = await evaluate(workflow, {
    project, task: "Update answer", builder: "claude", testCommand: 'node "' + join(project, "probe.mjs") + '"',
  }, {
    agent: async (event) => {
      if (event.name === "build") return build(event);
      assert.match(event.options.brief, /Correctness.*Requirements/);
      assert.match(event.options.brief, /When approving, leave problems empty/);
      assert.equal(event.options.interactionMode, "plan");
      assert.match(event.options.brief, new RegExp(base + "\\.\\.\\." + git(checkout, "rev-parse", "HEAD")));
      return { value: accepted };
    },
    ask: ({ options }) => {
      assert.equal(options.data.deterministicTestRan, true);
      return { _tag: "Some", value: { choice: "Merge" } };
    },
  });
  assert.equal(result.merged, true, result.reason);
  assert.equal(git(project, "show", "-s", "--format=%P", result.commit), base + " " + result.headSha);
  assert.equal(git(project, "rev-parse", "HEAD^{tree}"), git(project, "rev-parse", result.headSha + "^{tree}"));
  assert.equal(await readFile(join(project, "answer.txt"), "utf8"), "2");
  assert.equal(git(project, "status", "--porcelain"), "?? probe.mjs");
  assert.deepEqual(events.filter((e) => e.type === "agent").map((e) => e.name), ["build", "review-1-codex"]);
});

test("three models revise in the original thread and refuse a merge after the base moves", async (t) => {
  const { project, checkout, build } = await repo(t);
  const { default: workflow } = await loadWorkflow(true);
  const { result, events } = await evaluate(workflow, { project, task: "Update answer" }, {
    agent: async (event) => {
      if (event.name === "build") return build(event);
      if (event.name === "revise-1") {
        assert.equal(event.options.thread, "original-builder");
        assert.match(event.options.brief, /Add the expected result/);
        await writeFile(join(checkout, "answer.txt"), "3");
        git(checkout, "commit", "-am", "Revise");
        return { thread: "original-builder", value: buildOutput };
      }
      if (event.name === "review-1-neon") {
        assert.equal(event.options.runtimeMode, "full-access");
        assert.equal(event.options.interactionMode, "plan");
        return { value: { ...accepted, problems: ["Add the expected result"] } };
      }
      return { value: accepted };
    },
    ask: () => {
      git(project, "commit", "--allow-empty", "-m", "Unreviewed target change");
      return { _tag: "Some", value: { choice: "Merge" } };
    },
  });
  assert.equal(result.merged, false);
  assert.match(result.reason, /base branch moved/);
  assert.equal(git(project, "log", "-1", "--format=%s"), "Unreviewed target change");
  assert.equal(result.rounds, 2);
  assert.deepEqual(events.filter((e) => e.type === "agent").map((e) => e.name), [
    "build", "review-1-claude", "review-1-neon", "revise-1", "review-2-claude", "review-2-neon",
  ]);
});

test("a reviewer that writes into the project checkout stops the run before the merge question", async (t) => {
  const { project, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  const { result, events } = await evaluate(workflow, { project, task: "Update answer" }, {
    agent: async (event) => {
      if (event.name === "build") return build(event);
      // Approves, but leaves a new file behind in the user's checkout.
      await writeFile(join(project, "reviewer-notes.md"), "notes");
      return { value: accepted };
    },
    ask: () => assert.fail("The merge question must not be asked after the checkout changed"),
  });
  assert.match(result.stopped, /project changed while reviewers ran: files in the project checkout changed/);
  assert.equal(events.some((e) => e.type === "ask"), false);
});

test("review stops when a tracked file already modified by the user is edited again", async (t) => {
  const { project, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  const file = join(project, "answer.txt");
  await writeFile(file, "user edit");
  const { result } = await evaluate(workflow, { project, task: "Update answer" }, {
    agent: async (event) => {
      if (event.name === "build") return build(event);
      await writeFile(file, "review edit");
      return { value: accepted };
    },
    ask: () => assert.fail("The merge question must not be asked after a tracked edit"),
  });
  assert.match(result.stopped, /files in the project checkout changed/);
});

test("review stops when the checkout switches to a branch at the same commit", async (t) => {
  const { project, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  git(project, "branch", "other");
  const { result } = await evaluate(workflow, { project, task: "Update answer" }, {
    agent: async (event) => {
      if (event.name === "build") return build(event);
      git(project, "switch", "other");
      return { value: accepted };
    },
    ask: () => assert.fail("The merge question must not be asked after a branch switch"),
  });
  assert.match(result.stopped, /project checkout HEAD moved/);
});

test("review stops explicitly when the target branch is renamed", async (t) => {
  const { project, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  const { result } = await evaluate(workflow, { project, task: "Update answer" }, {
    agent: async (event) => {
      if (event.name === "build") return build(event);
      git(project, "branch", "-m", "renamed");
      return { value: accepted };
    },
    ask: () => assert.fail("The merge question must not be asked after a branch rename"),
  });
  assert.match(result.stopped, /base branch moved/);
});

test("review stops explicitly when the checked-out target ref is deleted", async (t) => {
  const { project, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  const { result } = await evaluate(workflow, { project, task: "Update answer" }, {
    agent: async (event) => {
      if (event.name === "build") return build(event);
      git(project, "update-ref", "-d", "refs/heads/main");
      return { value: accepted };
    },
    ask: () => assert.fail("The merge question must not be asked after a branch deletion"),
  });
  assert.match(result.stopped, /base branch moved/);
});

test("a checkout switch at the final write boundary cannot merge into another branch", async (t) => {
  const { project, base, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  git(project, "branch", "other");
  let switched = false;
  const execFile = childProcess.execFile;
  const spawn = childProcess.spawn;

  const switchBeforeWrite = (file, args, options) => {
    if (file === "git" && options.cwd === project &&
        (args[0] === "merge" || args.includes("update-ref"))) {
      git(project, "switch", "other");
      switched = true;
    }
  };
  t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    switchBeforeWrite(file, args, options);
    return execFile(file, args, options, callback);
  });
  t.mock.method(childProcess, "spawn", (file, args, options) => {
    switchBeforeWrite(file, args, options);
    return spawn(file, args, options);
  });
  syncBuiltinESMExports();
  try {
    const { result } = await evaluate(workflow, { project, task: "Update answer" }, {
      agent: (event) => event.name === "build" ? build(event) : { value: accepted },
      ask: () => ({ _tag: "Some", value: { choice: "Merge" } }),
    });
    assert.equal(switched, true);
    assert.equal(result.merged, false);
    assert.equal(git(project, "rev-parse", "other"), base);
    assert.equal(git(project, "rev-parse", "main"), base);
    assert.equal(await readFile(join(project, "answer.txt"), "utf8"), "1");
    assert.equal(git(project, "status", "--porcelain"), "");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

function interceptRefTransaction(t, intercept) {
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (file, args, options) => {
    const launch = () => spawn(file, args, options);
    return file === "git" && args[0] === "update-ref" && args.includes("--stdin")
      ? intercept(launch)
      : launch();
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("advancing the target immediately before the ref transaction leaves its new commit intact", async (t) => {
  const { project, base, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  let newTarget;
  interceptRefTransaction(t, (launch) => {
    git(project, "commit", "--allow-empty", "-m", "Concurrent target update");
    newTarget = git(project, "rev-parse", "HEAD");
    return launch();
  });

  const { result } = await evaluate(workflow, { project, task: "Update answer" }, {
    agent: (event) => event.name === "build" ? build(event) : { value: accepted },
    ask: () => ({ _tag: "Some", value: { choice: "Merge" } }),
  });
  assert.ok(newTarget);
  assert.notEqual(newTarget, base);
  assert.equal(result.merged, false);
  assert.equal(git(project, "rev-parse", "main"), newTarget);
  assert.equal(await readFile(join(project, "answer.txt"), "utf8"), "1");
  assert.equal(git(project, "status", "--porcelain"), "");
});

test("a ref transaction that exits without committing restores the target checkout", async (t) => {
  const { project, base, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  let abortSent = false;
  interceptRefTransaction(t, (launch) => {
    const child = launch();
    const end = child.stdin.end.bind(child.stdin);
    child.stdin.end = (input) => {
      if (input === "commit\n") {
        abortSent = true;
        return end("abort\n");
      }
      return end(input);
    };
    return child;
  });

  const { result } = await evaluate(workflow, { project, task: "Update answer" }, {
    agent: (event) => event.name === "build" ? build(event) : { value: accepted },
    ask: () => ({ _tag: "Some", value: { choice: "Merge" } }),
  });
  assert.equal(abortSent, true);
  assert.equal(result.merged, false);
  assert.equal(git(project, "rev-parse", "main"), base);
  assert.equal(await readFile(join(project, "answer.txt"), "utf8"), "1");
  assert.equal(git(project, "status", "--porcelain"), "");
});

test("a merge that would replace an ignored local file leaves the checkout intact", async (t) => {
  const { project, checkout, base, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  const output = "local-output.txt";
  await writeFile(join(project, ".git", "info", "exclude"), output + "\n");
  await writeFile(join(project, output), "local output");

  const { result } = await evaluate(workflow, { project, task: "Update answer and add an output file" }, {
    agent: async (event) => {
      if (event.name !== "build") return { value: accepted };
      const built = await build(event);
      await writeFile(join(checkout, output), "tracked output");
      git(checkout, "add", "-f", output);
      git(checkout, "commit", "-m", "Track output");
      return built;
    },
    ask: () => ({ _tag: "Some", value: { choice: "Merge" } }),
  });
  assert.equal(result.merged, false);
  assert.equal(git(project, "rev-parse", "main"), base);
  assert.equal(await readFile(join(project, "answer.txt"), "utf8"), "1");
  assert.equal(await readFile(join(project, output), "utf8"), "local output");
  assert.equal(git(project, "status", "--porcelain"), "");
});

test("preflight preserves permission errors while resolving the project folder", async (t) => {
  const project = await temp(t);
  const { default: workflow } = await loadWorkflow();
  t.mock.method(fsPromises, "stat", async () => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  });
  syncBuiltinESMExports();
  try {
    const { result } = await evaluate(workflow, { project, task: "Update answer" }, {
      agent: () => assert.fail("An unreadable project must stop before build"),
    });
    assert.match(result.stopped, /EACCES: permission denied/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("CLI requires --project for start and supports direct-execution fallback without import.meta.main", async () => {
  assert.throws(
    () => invocation(["start", "--task", "Update answer"]),
    /--project is required/,
  );

  const cliPath = fileURLToPath(new URL("../scripts/review-loop-cli.mjs", import.meta.url));
  assert.equal(isDirectExecution(undefined, cliPath), true);
  assert.equal(isDirectExecution(undefined, fileURLToPath(import.meta.url)), false);
  assert.equal(isDirectExecution(false, cliPath), false);

  const child = launch({ file: process.execPath, prefix: [cliPath], env: process.env }, ["--help"], ["ignore", "pipe", "pipe"]);
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  assert.deepEqual(await once(child, "close"), [0, null]);
  assert.match(stdout, /--project DIR/);
  assert.match(stdout, /T3CODE_DESKTOP_EXE/);
});

test("findT3 supports T3CODE_DESKTOP_EXE + T3CODE_DESKTOP_ENTRY and Windows .cmd shim via --t3", async (t) => {
  const dir = await temp(t);
  const entry = join(dir, "resources", "server.asar", "apps", "server", "dist", "bin.mjs");

  assert.throws(
    () => findT3(undefined, { T3CODE_DESKTOP_EXE: process.execPath }),
    /Set both T3CODE_DESKTOP_EXE and T3CODE_DESKTOP_ENTRY/,
  );

  const fromEnv = findT3(undefined, {
    T3CODE_DESKTOP_EXE: process.execPath,
    T3CODE_DESKTOP_ENTRY: entry,
    T3CODE_HOME: join(dir, "t3home"),
  });
  assert.equal(fromEnv.file, resolve(process.execPath));
  assert.deepEqual(fromEnv.prefix, [entry]);
  assert.equal(fromEnv.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(fromEnv.env.T3CODE_DESKTOP_CLI_LAUNCHER, "1");
  assert.equal(fromEnv.env.T3CODE_HOME, join(dir, "t3home"));

  if (process.platform === "win32") {
    const validShim = join(dir, "t3.cmd");
    await writeFile(validShim, [
      "@echo off",
      "rem Written by T3 Code: runs the desktop app's bundled t3 CLI.",
      `if not defined T3CODE_HOME set "T3CODE_HOME=${join(dir, "shim-home")}"`,
      `"${process.execPath}" "${entry}" %*`,
    ].join("\r\n"));
    const fromShim = findT3(validShim, {});
    assert.equal(fromShim.file, process.execPath);
    assert.deepEqual(fromShim.prefix, [entry]);
    assert.equal(fromShim.env.T3CODE_HOME, join(dir, "shim-home"));
    assert.equal(fromShim.env.ELECTRON_RUN_AS_NODE, "1");

    const badShim = join(dir, "unknown.cmd");
    await writeFile(badShim, "@echo off\r\necho custom\r\n");
    assert.throws(() => findT3(badShim, {}), /T3CODE_DESKTOP_EXE/);
  }
});

test("preflight reports missing or non-directory project path without git ENOENT", async (t) => {
  const dir = await temp(t);
  const { default: workflow } = await loadWorkflow();

  const missingPath = join(dir, "does-not-exist");
  const missing = await evaluate(workflow, { project: missingPath, task: "Update answer" }, {});
  assert.match(missing.result.stopped, /Project directory does not exist/);
  assert.doesNotMatch(missing.result.stopped, /ENOENT/);

  const filePath = join(dir, "not-a-dir.txt");
  await writeFile(filePath, "hello");
  const notDir = await evaluate(workflow, { project: filePath, task: "Update answer" }, {});
  assert.match(notDir.result.stopped, /Project path is not a directory/);
});

test("CLI --reviewers parses 1-2 names and rejects malformed values", async (t) => {
  const dir = await temp(t);
  const single = invocation([
    "start", "--project", dir, "--task", "Check", "--builder", "claude", "--reviewers", "neon",
  ]);
  assert.deepEqual(JSON.parse(single.t3Args[4]).reviewers, ["neon"]);

  const pair = invocation([
    "start", "--project", dir, "--task", "Check", "--builder", "claude", "--reviewers", "neon, codex",
  ]);
  assert.deepEqual(JSON.parse(pair.t3Args[4]).reviewers, ["neon", "codex"]);

  for (const bad of ["", "neon,", ",neon", "a,b,c"]) {
    assert.throws(
      () => invocation(["start", "--project", dir, "--task", "Check", "--reviewers", bad]),
      /--reviewers must list 1 or 2/,
    );
  }
});

test("reviewers option runs only selected agents and validates invalid selections", async (t) => {
  const { project, build } = await repo(t);
  // Enable neon while keeping codex unconfigured (model: "") to verify skipped agents are not required.
  const partialSource = source
    .replace("// neon:", "neon:")
    .replace('claude: { model: { instanceId: "claudeAgent", model: "" } }', 'claude: { model: { instanceId: "claudeAgent", model: "claude-test" } }')
    .replace('neon: { model: { instanceId: "antigravity", model: "" }', 'neon: { model: { instanceId: "antigravity", model: "neon-test" }');
  const { default: partialWorkflow } = await import(
    "data:text/javascript;base64," + Buffer.from(partialSource).toString("base64")
  );

  const { result, events } = await evaluate(partialWorkflow, {
    project, task: "Update answer", builder: "claude", reviewers: ["neon"],
  }, {
    agent: async (event) => {
      if (event.name === "build") return build(event);
      assert.equal(event.name, "review-1-neon");
      assert.match(event.options.brief, /Correctness.*Requirements/);
      return { value: accepted };
    },
    ask: () => ({ _tag: "Some", value: { choice: "Leave on branch" } }),
  });
  assert.equal(result.merged, false);
  assert.deepEqual(events.filter((e) => e.type === "agent").map((e) => e.name), ["build", "review-1-neon"]);

  const { default: workflow } = await loadWorkflow(true);
  const sameAsBuilder = await evaluate(workflow, {
    project, task: "Update answer", builder: "claude", reviewers: ["claude"],
  }, {});
  assert.match(sameAsBuilder.result.stopped, /cannot be the same agent as builder/);

  const duplicate = await evaluate(workflow, {
    project, task: "Update answer", builder: "claude", reviewers: ["neon", "neon"],
  }, {});
  assert.match(duplicate.result.stopped, /Duplicate reviewer/);

  const unknown = await evaluate(workflow, {
    project, task: "Update answer", builder: "claude", reviewers: ["ghost"],
  }, {});
  assert.match(unknown.result.stopped, /Unknown reviewer/);

  const empty = await evaluate(workflow, {
    project, task: "Update answer", builder: "claude", reviewers: [],
  }, {});
  assert.match(empty.result.stopped, /Choose 1 or 2 reviewers/);
});

