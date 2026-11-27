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
import { findT3, invocation, isDirectExecution, launch, resolveMergeSignal, signalArgs } from "../scripts/review-loop-cli.mjs";

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
      ask: (event) => ({ _tag: "Some", value: { choice: event.name === "approve-merge" ? "Merge" : "Leave on branch" } }),
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
    ask: (event) => ({ _tag: "Some", value: { choice: event.name === "approve-merge" ? "Merge" : "Leave on branch" } }),
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
    ask: (event) => ({ _tag: "Some", value: { choice: event.name === "approve-merge" ? "Merge" : "Leave on branch" } }),
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
    ask: (event) => ({ _tag: "Some", value: { choice: event.name === "approve-merge" ? "Merge" : "Leave on branch" } }),
  });
  assert.equal(result.merged, false);
  assert.equal(git(project, "rev-parse", "main"), base);
  assert.equal(await readFile(join(project, "answer.txt"), "utf8"), "1");
  assert.equal(await readFile(join(project, output), "utf8"), "local output");
  assert.equal(git(project, "status", "--porcelain"), "");
});

// Builds a branch that adds `files` (forced past ignore rules) and answers Merge.
async function mergeWithAddedFiles(t, setupLocal, files) {
  const { project, checkout, base, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  await setupLocal(project);
  const { result } = await evaluate(workflow, { project, task: "Update answer and add files" }, {
    agent: async (event) => {
      if (event.name !== "build") return { value: accepted };
      const built = await build(event);
      for (const [path, content] of Object.entries(files)) {
        await fsPromises.mkdir(join(checkout, path, ".."), { recursive: true });
        await writeFile(join(checkout, path), content);
        git(checkout, "add", "-f", path);
      }
      git(checkout, "commit", "-m", "Add files");
      return built;
    },
    ask: (event) => ({ _tag: "Some", value: { choice: event.name === "approve-merge" ? "Merge" : "Leave on branch" } }),
  });
  return { project, base, result };
}

test("an added path that collides with a local ignored folder or file refuses the merge", async (t) => {
  // The branch adds a file where an ignored folder exists locally.
  const folder = await mergeWithAddedFiles(t, async (project) => {
    await writeFile(join(project, ".git", "info", "exclude"), "cache/\n");
    await fsPromises.mkdir(join(project, "cache"));
    await writeFile(join(project, "cache", "local.txt"), "local cache");
  }, { cache: "tracked file" });
  assert.equal(folder.result.merged, false);
  assert.match(folder.result.reason, /overwrite a local untracked or ignored path: cache$/m);
  assert.equal(git(folder.project, "rev-parse", "main"), folder.base);
  assert.equal(await readFile(join(folder.project, "cache", "local.txt"), "utf8"), "local cache");

  // The branch adds a file under a path that is an ignored file locally.
  const parent = await mergeWithAddedFiles(t, async (project) => {
    await writeFile(join(project, ".git", "info", "exclude"), "out\n");
    await writeFile(join(project, "out"), "local output");
  }, { "out/result.txt": "tracked result" });
  assert.equal(parent.result.merged, false);
  assert.match(parent.result.reason, /overwrite a local untracked or ignored path: out$/m);
  assert.equal(await readFile(join(parent.project, "out"), "utf8"), "local output");
});

test("ignored folders that the merge does not overwrite stay untouched and do not block it", async (t) => {
  const { project, result } = await mergeWithAddedFiles(t, async (project) => {
    await writeFile(join(project, ".git", "info", "exclude"), "node_modules/\ncache/\n");
    for (let i = 0; i < 200; i++) {
      await fsPromises.mkdir(join(project, "node_modules", "pkg" + i), { recursive: true });
      await writeFile(join(project, "node_modules", "pkg" + i, "index.js"), "module " + i);
    }
    await fsPromises.mkdir(join(project, "cache"));
    await writeFile(join(project, "cache", "local.txt"), "local cache");
  }, { "src/new.txt": "new source", "cache/tracked.txt": "new tracked file inside an ignored folder" });
  assert.equal(result.merged, true, result.reason);
  assert.equal(await readFile(join(project, "src", "new.txt"), "utf8"), "new source");
  assert.equal(await readFile(join(project, "cache", "tracked.txt"), "utf8"), "new tracked file inside an ignored folder");
  assert.equal(await readFile(join(project, "cache", "local.txt"), "utf8"), "local cache");
  assert.equal(await readFile(join(project, "node_modules", "pkg199", "index.js"), "utf8"), "module 199");
});

test("a test command that detaches HEAD is reported as a changed checkout", async (t) => {
  const { project, checkout, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  let reviseBrief = "";
  const { result } = await evaluate(workflow, {
    project, task: "Update answer", testCommand: "git checkout --quiet --detach", maxRounds: 2,
  }, {
    agent: async (event) => {
      if (event.name === "build") return build(event);
      if (event.name === "revise-1") {
        reviseBrief = event.options.brief;
        // Reattach the worktree; the next verification detaches it again.
        git(checkout, "checkout", "--quiet", event.options.brief.match(/on (review-loop\/\S+) and/)[1]);
        return { thread: "original-builder", value: buildOutput };
      }
      return assert.fail("Reviewers must not run while verification fails: " + event.name);
    },
    ask: () => assert.fail("A run with a failing verification must not reach the merge question"),
  });
  assert.match(reviseBrief, /\[workflow\] The test changed the checkout/);
  assert.doesNotMatch(reviseBrief, /symbolic-ref/);
  assert.match(result.stopped, /No approval after 2 rounds/);
});

test("blank entries in an approving review's problems do not trigger a revision", async (t) => {
  const { project, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  let asked = false;
  const { events } = await evaluate(workflow, { project, task: "Update answer" }, {
    agent: async (event) => {
      if (event.name === "build") return build(event);
      return { value: { ...accepted, problems: ["", "   "] } };
    },
    ask: () => { asked = true; return { _tag: "Some", value: { choice: "Leave on branch" } }; },
  });
  assert.equal(asked, true);
  assert.equal(events.some((e) => e.type === "agent" && e.name.startsWith("revise-")), false);
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

// ---- v0.2.0 tests: E (merge retry + CLI), F (.git metadata snapshot), H (missing paths) ----

test("E: retryable merge refusal prompts Retry merge and succeeds once checkout is fixed", async (t) => {
  const { project, base, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  const asked = [];
  const { result, events } = await evaluate(workflow, { project, task: "Update answer" }, {
    agent: (event) => event.name === "build" ? build(event) : { value: accepted },
    ask: async (event) => {
      asked.push(event);
      if (event.name === "approve-merge") {
        // Dirty the target checkout before attempt 1 so merge is refused as retryable.
        await writeFile(join(project, "answer.txt"), "dirty");
        return { _tag: "Some", value: { choice: "Merge" } };
      }
      assert.equal(event.name, "approve-merge-2");
      assert.deepEqual(event.options.choices, ["Retry merge", "Leave on branch"]);
      assert.match(event.options.title, /uncommitted tracked changes/);
      // Clean up the checkout before retrying.
      git(project, "checkout", "--", "answer.txt");
      return { _tag: "Some", value: { choice: "Retry merge" } };
    },
  });
  assert.equal(result.merged, true, result.reason);
  assert.equal(git(project, "show", "-s", "--format=%P", result.commit), base + " " + result.headSha);
  assert.deepEqual(asked.map((e) => e.name), ["approve-merge", "approve-merge-2"]);
  assert.deepEqual(
    events.filter((e) => e.type === "step" && e.name.startsWith("local-merge")).map((e) => e.name),
    ["local-merge", "local-merge-2"],
  );
});

test("E: retryable merge stops after 3 attempts and non-retryable refusal does not re-ask", async (t) => {
  // Case 1: exhausted 3 retryable merge attempts.
  const first = await repo(t);
  const { default: workflow } = await loadWorkflow();
  const askNames1 = [];
  const exhausted = await evaluate(workflow, { project: first.project, task: "Update answer" }, {
    agent: (event) => event.name === "build" ? first.build(event) : { value: accepted },
    ask: async (event) => {
      askNames1.push(event.name);
      await writeFile(join(first.project, "answer.txt"), "still-dirty");
      return { _tag: "Some", value: { choice: event.name === "approve-merge" ? "Merge" : "Retry merge" } };
    },
  });
  assert.equal(exhausted.result.merged, false);
  assert.match(exhausted.result.reason, /merge retry limit reached/);
  assert.deepEqual(askNames1, ["approve-merge", "approve-merge-2", "approve-merge-3"]);

  // Case 2: non-retryable refusal (base branch moved) must NOT ask approve-merge-2.
  const second = await repo(t);
  const askNames2 = [];
  const moved = await evaluate(workflow, { project: second.project, task: "Update answer" }, {
    agent: (event) => event.name === "build" ? second.build(event) : { value: accepted },
    ask: (event) => {
      askNames2.push(event.name);
      git(second.project, "commit", "--allow-empty", "-m", "Moved base");
      return { _tag: "Some", value: { choice: "Merge" } };
    },
  });
  assert.equal(moved.result.merged, false);
  assert.match(moved.result.reason, /base branch moved/);
  assert.match(moved.result.reason, /git merge --no-ff/);
  assert.deepEqual(askNames2, ["approve-merge"]);
});

test("E: CLI resolveMergeSignal picks initial or retry question and rejects non-waiting runs", () => {
  const initialShow = {
    run: { runId: "r1", status: "waiting" },
    steps: [{ name: "approve-merge", kind: "ask", status: "running" }],
  };
  assert.deepEqual(resolveMergeSignal(initialShow, "merge"), { wait: "approve-merge", choice: "Merge" });
  assert.deepEqual(resolveMergeSignal(initialShow, "leave"), { wait: "approve-merge", choice: "Leave on branch" });

  const retryShow = {
    run: { runId: "r1", status: "waiting" },
    steps: [
      { name: "approve-merge", kind: "ask", status: "completed" },
      { name: "local-merge", kind: "step", status: "completed" },
      { name: "approve-merge-2", kind: "ask", status: "running" },
    ],
  };
  assert.deepEqual(resolveMergeSignal(retryShow, "merge"), { wait: "approve-merge-2", choice: "Retry merge" });
  assert.deepEqual(resolveMergeSignal(retryShow, "leave"), { wait: "approve-merge-2", choice: "Leave on branch" });
  assert.deepEqual(signalArgs("merge", "r1", "approve-merge-2"), [
    "workflow", "signal", '{"choice":"Retry merge"}', "--run", "r1", "--wait", "approve-merge-2",
  ]);
  assert.deepEqual(invocation(["merge", "--run", "r1", "--wait", "approve-merge-2"]).t3Args, [
    "workflow", "signal", '{"choice":"Retry merge"}', "--run", "r1", "--wait", "approve-merge-2",
  ]);

  assert.throws(
    () => resolveMergeSignal({ run: { runId: "r1", status: "completed" }, steps: [] }, "merge"),
    /not waiting on a merge question/,
  );
});

test("F: review stops when .git/config, hooks, or info/exclude change, but ignores refs/t3 checkpoints", async (t) => {
  const { default: workflow } = await loadWorkflow();

  // 1. .git/config tampered during review
  const cfgRepo = await repo(t);
  const cfgRes = await evaluate(workflow, { project: cfgRepo.project, task: "Update answer" }, {
    agent: async (event) => {
      if (event.name === "build") return cfgRepo.build(event);
      git(cfgRepo.project, "config", "core.autocrlf", "false");
      return { value: accepted };
    },
    ask: () => assert.fail("Must stop when .git/config changes"),
  });
  assert.match(cfgRes.result.stopped, /Git metadata/);

  // 2. .git/hooks tampered during review
  const hookRepo = await repo(t);
  const hookRes = await evaluate(workflow, { project: hookRepo.project, task: "Update answer" }, {
    agent: async (event) => {
      if (event.name === "build") return hookRepo.build(event);
      await fsPromises.mkdir(join(hookRepo.project, ".git", "hooks"), { recursive: true });
      await writeFile(join(hookRepo.project, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho tampered\n");
      return { value: accepted };
    },
    ask: () => assert.fail("Must stop when .git/hooks changes"),
  });
  assert.match(hookRes.result.stopped, /Git metadata/);

  // 3. .git/info/exclude tampered during review
  const excludeRepo = await repo(t);
  const excludeRes = await evaluate(workflow, { project: excludeRepo.project, task: "Update answer" }, {
    agent: async (event) => {
      if (event.name === "build") return excludeRepo.build(event);
      await writeFile(join(excludeRepo.project, ".git", "info", "exclude"), "secret-drop.txt\n");
      return { value: accepted };
    },
    ask: () => assert.fail("Must stop when .git/info/exclude changes"),
  });
  assert.match(excludeRes.result.stopped, /Git metadata/);

  // 4. Control: T3 checkpoint ref under refs/t3/ must NOT cause a false positive
  const t3Repo = await repo(t);
  const t3Res = await evaluate(workflow, { project: t3Repo.project, task: "Update answer" }, {
    agent: async (event) => {
      if (event.name === "build") return t3Repo.build(event);
      git(t3Repo.project, "update-ref", "refs/t3/orchestration-v2/checkpoints/test/ordinal/1", t3Repo.base);
      return { value: accepted };
    },
    ask: () => ({ _tag: "Some", value: { choice: "Leave on branch" } }),
  });
  assert.equal(t3Res.result.merged, false);
  assert.equal(t3Res.result.reason, "Left on branch.");
});

test("H1: exhausting maxRounds without approval stops and preserves the branch", async (t) => {
  const { project, checkout, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  const { result, events } = await evaluate(workflow, { project, task: "Update answer", maxRounds: 2 }, {
    agent: async (event) => {
      if (event.name === "build") return build(event);
      if (event.name === "revise-1") {
        await writeFile(join(checkout, "answer.txt"), "still-wrong");
        git(checkout, "commit", "-am", "Revise attempt 1");
        return { thread: "original-builder", value: buildOutput };
      }
      return { value: { approved: false, summary: "Still broken", problems: ["Fix answer.txt"] } };
    },
    ask: () => assert.fail("Must not ask merge when approval is never reached"),
  });
  assert.match(result.stopped, /No approval after 2 rounds/);
  assert.deepEqual(events.filter((e) => e.type === "agent").map((e) => e.name), [
    "build", "review-1-claude", "revise-1", "review-2-claude",
  ]);
});

test("H2: verification failures (0 commits, dirty worktree, failing test) skip reviewers and return to builder", async (t) => {
  const { default: workflow } = await loadWorkflow();

  // Case a: 0 commits on build -> skips review-1 -> builder commits in revise-1 -> succeeds in round 2
  const zeroRepo = await repo(t);
  const zeroBriefs = [];
  const zeroRes = await evaluate(workflow, { project: zeroRepo.project, task: "Update answer", maxRounds: 2 }, {
    agent: async (event) => {
      if (event.name === "build") {
        git(zeroRepo.project, "worktree", "add", "-b", event.options.workspace.branch, zeroRepo.checkout, "main");
        return { thread: "original-builder", value: buildOutput };
      }
      if (event.name === "revise-1") {
        zeroBriefs.push(event.options.brief);
        await writeFile(join(zeroRepo.checkout, "answer.txt"), "2");
        git(zeroRepo.checkout, "add", ".");
        git(zeroRepo.checkout, "commit", "-m", "Commit on revise");
        return { thread: "original-builder", value: buildOutput };
      }
      return { value: accepted };
    },
    ask: () => ({ _tag: "Some", value: { choice: "Leave on branch" } }),
  });
  assert.equal(zeroRes.result.rounds, 2);
  assert.match(zeroBriefs[0], /\[workflow\] Commit your changes/);
  assert.equal(zeroRes.events.some((e) => e.type === "agent" && e.name.startsWith("review-1-")), false);

  // Case b: dirty worktree + failing test command both skip reviewers
  const failRepo = await repo(t);
  let failBrief = "";
  const failRes = await evaluate(workflow, {
    project: failRepo.project,
    task: "Update answer",
    testCommand: 'node -e "console.error(\'boom\'); process.exit(1)"',
    maxRounds: 2,
  }, {
    agent: async (event) => {
      if (event.name === "build") return failRepo.build(event);
      if (event.name === "revise-1") {
        failBrief = event.options.brief;
        return { thread: "original-builder", value: buildOutput };
      }
      return assert.fail("Reviewers must be skipped when testCommand fails: " + event.name);
    },
    ask: () => assert.fail("Must not reach approve-merge while testCommand fails"),
  });
  assert.match(failBrief, /\[workflow\] Workflow test failed:/);
  assert.match(failBrief, /boom/);
  assert.match(failRes.result.stopped, /No approval after 2 rounds/);
});

test("H3: builder self-reported test failure skips reviewers unless testCommandRun is none", async (t) => {
  const { default: workflow } = await loadWorkflow();

  // Reported failing check with no fixed --test -> skips review-1 -> revises -> passes round 2
  const r1 = await repo(t);
  let reviseBrief = "";
  const res1 = await evaluate(workflow, { project: r1.project, task: "Update answer", maxRounds: 2 }, {
    agent: async (event) => {
      if (event.name === "build") {
        await r1.build(event);
        return { thread: "original-builder", value: { summary: "Failed locally", testCommandRun: "npm test", testsPassed: false } };
      }
      if (event.name === "revise-1") {
        reviseBrief = event.options.brief;
        return { thread: "original-builder", value: { summary: "Fixed", testCommandRun: "npm test", testsPassed: true } };
      }
      assert.equal(event.name, "review-2-claude");
      return { value: accepted };
    },
    ask: () => ({ _tag: "Some", value: { choice: "Leave on branch" } }),
  });
  assert.match(reviseBrief, /\[builder\] Reported failing verification: npm test/);
  assert.equal(res1.result.rounds, 2);

  // testCommandRun: "none" with testsPassed: false does NOT skip reviewers
  const r2 = await repo(t);
  const res2 = await evaluate(workflow, { project: r2.project, task: "Update answer", maxRounds: 1 }, {
    agent: async (event) => {
      if (event.name === "build") {
        await r2.build(event);
        return { thread: "original-builder", value: { summary: "No tests", testCommandRun: "none", testsPassed: false } };
      }
      return { value: accepted };
    },
    ask: () => ({ _tag: "Some", value: { choice: "Leave on branch" } }),
  });
  assert.equal(res2.result.rounds, 1);
  assert.equal(res2.events.some((e) => e.type === "agent" && e.name === "review-1-claude"), true);
});

test("H4: merge replay recovers an already-committed reviewed merge commit", async (t) => {
  const { project, checkout, base, build } = await repo(t);
  const { default: workflow } = await loadWorkflow();
  let precommitted = "";
  const { result } = await evaluate(workflow, { project, task: "Update answer" }, {
    agent: (event) => event.name === "build" ? build(event) : { value: accepted },
    ask: () => {
      // Simulate T3 crashing after the ref transaction already updated main to the exact merge commit.
      const headSha = git(checkout, "rev-parse", "HEAD");
      const tree = git(project, "rev-parse", headSha + "^{tree}");
      precommitted = git(project, "commit-tree", tree, "-p", base, "-p", headSha, "-m", "Simulated prior merge");
      git(project, "update-ref", "refs/heads/main", precommitted, base);
      return { _tag: "Some", value: { choice: "Merge" } };
    },
  });
  assert.ok(precommitted);
  assert.equal(result.merged, true, result.reason);
  assert.equal(result.commit, precommitted);
});

