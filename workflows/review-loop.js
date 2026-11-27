// T3 Code Workflows (Labs). Configure the agent pool before installing this file.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

// Fill in model slugs from T3 Settings → Providers. Keep at least two entries.
// The first entry builds by default. An optional model.options array contains
// provider-specific { id, value } pairs. Set runtimeMode only if needed.
const AGENTS = {
  codex: { model: { instanceId: "codex", model: "" } },
  claude: { model: { instanceId: "claudeAgent", model: "" } },
  // Antigravity stopped for manual approval of read-only git commands under
  // "auto" + plan mode, so this entry uses "full-access". The setting also
  // applies when this entry builds. Reviewers run in the project checkout, and
  // plan mode plus the read-only brief are their only write guards; the
  // workflow stops the run if the checkout or branches change during review.
  // neon: { model: { instanceId: "antigravity", model: "" }, runtimeMode: "full-access" },
};

const REVIEW_FOCI = [
  "Correctness, edge cases, maintainability, and repository conventions",
  "Requirements, acceptance criteria, and whether tests verify the intended behavior",
];
const DEFAULT_BASE = "main";
const DEFAULT_ROUNDS = 3;
const GIT_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 15 * 60 * 1000;
const WINDOWS = process.platform === "win32";

const { workflow, step, agent, ask, stop, title } = T3;

const Payload = Schema.Struct({
  task: Schema.String,
  project: Schema.String,
  builder: Schema.optional(Schema.String),
  reviewers: Schema.optional(Schema.Array(Schema.String)),
  baseRef: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  testCommand: Schema.optional(Schema.String),
  maxRounds: Schema.optional(Schema.Number),
});

const Preflight = Schema.Struct({ reason: Schema.String });
const Build = Schema.Struct({
  summary: Schema.String,
  testCommandRun: Schema.String,
  testsPassed: Schema.Boolean,
});
const Verification = Schema.Struct({
  baseSha: Schema.String,
  headSha: Schema.String,
  testRan: Schema.Boolean,
  testOutputTail: Schema.String,
  issues: Schema.Array(Schema.String),
});
const Review = Schema.Struct({
  approved: Schema.Boolean,
  summary: Schema.String,
  problems: Schema.Array(Schema.String),
});
const Snapshot = Schema.Struct({
  checkout: Schema.String,
  head: Schema.String,
  headRef: Schema.String,
  baseTip: Schema.String,
  branchTip: Schema.String,
});
const Merge = Schema.Struct({
  merged: Schema.Boolean,
  commit: Schema.String,
  reason: Schema.String,
});

const promiseStep = (name, returns, run) =>
  step(name, { returns }, Effect.tryPromise({
    try: run,
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  }));

const ref = (branch) => "refs/heads/" + branch;

function deriveBranch(task, runId) {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 32) || "task";
  const suffix = createHash("sha256").update(runId || task).digest("hex").slice(0, 12);
  return "review-loop/" + slug + "-" + suffix;
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || stdout || error.message).trim().slice(-2000);
        reject(new Error("git " + args.join(" ") + " failed: " + detail, { cause: error }));
      } else {
        resolve(stdout);
      }
    });
  });
}

const readGit = async (cwd, args) => (await git(cwd, args)).trim();
const branchSha = (cwd, branch) => readGit(cwd, ["rev-parse", "--verify", ref(branch)]);

async function verifyRefIfPresent(cwd, name) {
  try {
    return await readGit(cwd, ["rev-parse", "--verify", "--quiet", name]);
  } catch (error) {
    if (error.cause?.code === 1) return "";
    throw error;
  }
}

async function checkoutRef(cwd) {
  try {
    return await readGit(cwd, ["symbolic-ref", "--quiet", "HEAD"]);
  } catch (error) {
    if (error.cause?.code === 1) return "";
    throw error;
  }
}

// Git worktree porcelain -z preserves Unicode and whitespace in checkout paths.
async function findWorktree(project, branch) {
  const output = await git(project, ["worktree", "list", "--porcelain", "-z"]);
  let worktree = "";
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) worktree = field.slice("worktree ".length);
    if (field === "branch " + ref(branch)) return worktree;
  }
  return "";
}

async function preflight(project, base, branch) {
  let stats;
  try {
    stats = await stat(project);
  } catch (error) {
    return { reason: error.code === "ENOENT"
      ? "Project directory does not exist: " + project
      : "Could not access project directory: " + error.message };
  }
  if (!stats.isDirectory()) {
    return { reason: "Project path is not a directory: " + project };
  }
  try {
    if (await readGit(project, ["rev-parse", "--is-inside-work-tree"]) !== "true" ||
        await readGit(project, ["rev-parse", "--show-prefix"]) !== "") {
      return { reason: "Pass the root of a Git checkout registered in T3 Code." };
    }
    for (const name of [base, branch]) {
      if (await readGit(project, ["check-ref-format", "--branch", name]) !== name) {
        return { reason: "Use a literal local branch name: " + name };
      }
    }
    await branchSha(project, base);
    if (await verifyRefIfPresent(project, ref(branch))) {
      return { reason: "Local branch " + branch + " already exists. Choose a fresh branch." };
    }
    return { reason: "" };
  } catch (error) {
    return { reason: error.message + "\nCheck the Git checkout and local base branch." };
  }
}

// The command is supplied by the operator and runs in the server's shell.
export function runShell(command, cwd, timeoutMs = TEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: !WINDOWS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    let timedOut = false;
    let cleanupComplete = false;
    let closed = false;
    let cleanupTimer;
    let timeoutMessage = "Command timed out.";

    const append = (chunk) => {
      tail = (tail + chunk).slice(-1800);
    };
    const finish = (passed, message = "") => {
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      resolve({ passed, outputTail: [message, tail.trim()].filter(Boolean).join("\n") });
    };
    const afterCleanup = (error) => {
      cleanupComplete = true;
      if (error) timeoutMessage += " Tree cleanup failed: " + error.message;
      if (closed) finish(false, timeoutMessage);
      else cleanupTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(false, timeoutMessage);
      }, 3000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (WINDOWS) {
        const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
        execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
          timeout: 5000,
          windowsHide: true,
        }, (error) => {
          if (error && child.exitCode === null) child.kill();
          afterCleanup(error);
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
          afterCleanup();
        } catch (error) {
          afterCleanup(error.code === "ESRCH" ? undefined : error);
        }
      }
    }, timeoutMs);

    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", append);
    }
    child.once("error", (error) => finish(false, error.message));
    child.once("close", (code, signal) => {
      closed = true;
      if (!timedOut) finish(code === 0, code === 0 ? "" : "Command exited with " + (signal || code) + ".");
      else if (cleanupComplete) finish(false, timeoutMessage);
    });
  });
}

async function verify(project, base, branch, command) {
  const result = { baseSha: "", headSha: "", testRan: false, testOutputTail: "", issues: [] };
  try {
    result.baseSha = await branchSha(project, base);
    result.headSha = await branchSha(project, branch);
    const range = result.baseSha + ".." + result.headSha;
    if (await readGit(project, ["rev-list", "--count", range]) === "0") {
      result.issues.push("Commit your changes on " + branch + ".");
    }
    if (await readGit(project, ["merge-base", result.baseSha, result.headSha]) !== result.baseSha) {
      result.issues.push("Rebase " + branch + " onto the current local " + base + " and verify again.");
    }

    const checkout = await findWorktree(project, branch);
    if (!checkout) {
      result.issues.push("Restore the builder worktree with " + branch + " checked out.");
      return result;
    }
    if (await readGit(checkout, ["status", "--porcelain", "--untracked-files=all"])) {
      result.issues.push("Commit the deliverable and clear unrelated non-ignored changes before verification.");
    }

    if (command && result.issues.length === 0) {
      const test = await runShell(command, checkout);
      result.testRan = true;
      result.testOutputTail = test.outputTail;
      if (!test.passed) result.issues.push("Workflow test failed:\n" + test.outputTail);
      const checkedOutBranch = await readGit(checkout, ["symbolic-ref", "--quiet", "HEAD"]);
      const checkedOutSha = await readGit(checkout, ["rev-parse", "HEAD"]);
      if (checkedOutBranch !== ref(branch) || checkedOutSha !== result.headSha ||
          await readGit(checkout, ["status", "--porcelain", "--untracked-files=all"])) {
        result.issues.push("The test changed the checkout. Restore a clean checkout at the verified commit.");
      }
    }
  } catch (error) {
    result.issues.push(error.message);
  }
  return result;
}

// Compare status, index changes and worktree changes. Binary patches keep
// a second edit to a dirty tracked file visible even if its status is unchanged.
async function snapshot(project, base, branch) {
  const diff = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--full-index"];
  const [status, staged, unstaged, head, headRef, baseTip, branchTip] = await Promise.all([
    git(project, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(project, [...diff, "--cached", "--"]),
    git(project, [...diff, "--"]),
    verifyRefIfPresent(project, "HEAD"),
    checkoutRef(project),
    verifyRefIfPresent(project, ref(base)),
    verifyRefIfPresent(project, ref(branch)),
  ]);
  return {
    checkout: createHash("sha256").update(JSON.stringify([status, staged, unstaged])).digest("hex"),
    head, headRef, baseTip, branchTip,
  };
}

function snapshotChanges(before, after) {
  const changes = [];
  if (before.checkout !== after.checkout) changes.push("files in the project checkout changed");
  if (before.head !== after.head || before.headRef !== after.headRef) {
    changes.push("the project checkout HEAD moved");
  }
  if (before.baseTip !== after.baseTip) changes.push("the base branch moved");
  if (before.branchTip !== after.branchTip) changes.push("the review branch moved");
  return changes;
}

async function updateCheckout(project, from, to) {
  const added = await git(project, ["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", from, to, "--"]);
  if (added) {
    // read-tree can overwrite ignored files, unlike the previous merge with
    // --no-overwrite-ignore. Check both file and directory collisions first.
    const ignored = await git(project, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
    if (ignored) {
      const ignoreCase = await readGit(project, ["config", "--type=bool", "--default=false", "--get", "core.ignoreCase"]);
      const paths = (output) => (ignoreCase === "true" ? output.toLowerCase() : output).split("\0").filter(Boolean);
      const additions = paths(added);
      const collision = paths(ignored).find((local) => additions.some((path) =>
        path === local || path.startsWith(local + "/") || local.startsWith(path + "/")));
      if (collision) throw new Error("Merging would overwrite an ignored local file: " + collision);
    }
  }
  await git(project, ["read-tree", "-m", "-u", from, to]);
}

async function updateReviewedBranch(project, target, source, baseSha, headSha, commit, message) {
  const child = spawn("git", ["update-ref", "-m", message, "--stdin"], {
    cwd: project, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let detail = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { detail = (detail + chunk).slice(-2000); });
  child.stdin.on("error", (error) => { detail ||= error.message; });
  child.once("error", (error) => { detail ||= error.message; });
  const exited = new Promise((resolve) => child.once("close", resolve));
  const timer = setTimeout(() => {
    detail ||= "Git ref transaction timed out.";
    child.kill();
  }, GIT_TIMEOUT_MS);
  const responses = createInterface({ input: child.stdout });
  const replies = responses[Symbol.asyncIterator]();
  const expect = async (acknowledgement, fallback) => {
    for (let reply = await replies.next(); !reply.done; reply = await replies.next()) {
      if (reply.value === acknowledgement) return;
    }
    await exited;
    throw new Error(detail.trim() || fallback);
  };
  let checkoutUpdated = false;

  try {
    // Git locks both named refs and compares their expected SHAs at prepare.
    // Updating the checked-out branch also locks HEAD in the files backend.
    child.stdin.write([
      "start",
      "option no-deref",
      "update " + target + " " + commit + " " + baseSha,
      "verify " + source + " " + headSha,
      "update ORIG_HEAD " + baseSha,
      "prepare",
      "",
    ].join("\n"));
    await expect("prepare: ok", "Git could not lock the verified refs.");
    if (await checkoutRef(project) !== target) {
      throw new Error("The checked-out branch changed before the merge.");
    }
    if (await readGit(project, ["status", "--porcelain", "--untracked-files=no"])) {
      throw new Error("The target checkout gained uncommitted tracked changes before the merge.");
    }

    // Two-tree read preserves local files it cannot safely replace.
    await updateCheckout(project, baseSha, commit);
    checkoutUpdated = true;
    await git(project, ["diff", "--cached", "--quiet", commit, "--"]);
    await git(project, ["diff", "--quiet", "--"]);
    child.stdin.end("commit\n");
    await expect("commit: ok", "Git exited without committing the ref transaction.");
    if (await exited !== 0) {
      throw new Error(detail.trim() || "Git could not commit the ref transaction.");
    }
  } catch (error) {
    if (!child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end("abort\n");
    await exited;
    if (checkoutUpdated) {
      try {
        const current = await verifyRefIfPresent(project, target);
        if (current === commit) return;
        if (current !== baseSha || await checkoutRef(project) !== target) {
          throw new Error("The target ref or checkout changed.");
        }
        // Roll back only our two-tree update. Git refuses to overwrite intervening edits.
        await updateCheckout(project, commit, baseSha);
      } catch (rollbackError) {
        throw new Error(error.message + "\nCheckout rollback failed: " + rollbackError.message +
          "\nInspect git status before retrying.", { cause: error });
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
    responses.close();
  }
}

async function merge(project, base, branch, baseSha, headSha) {
  const target = ref(base);
  const source = ref(branch);
  const refused = (reason) => ({ merged: false, commit: "", reason });
  const success = (commit) => ({ merged: true, commit, reason: "Merged locally into " + base + "." });
  try {
    if (await checkoutRef(project) !== target) {
      return refused("Check out " + base + " in the selected project before merging.");
    }
    const current = await branchSha(project, base);
    const tree = await readGit(project, ["rev-parse", headSha + "^{tree}"]);
    if (current !== baseSha) {
      // A replay after the transaction committed can recover its result.
      if (await readGit(project, ["show", "-s", "--format=%T%n%P", current]) === tree + "\n" + baseSha + " " + headSha) {
        return success(current);
      }
      return refused("The base branch moved after verification. Start a fresh review before merging.");
    }
    if (await branchSha(project, branch) !== headSha) {
      return refused("The source branch moved after verification. Start a fresh review before merging.");
    }
    if (await readGit(project, ["status", "--porcelain", "--untracked-files=no"])) {
      return refused("The target checkout has uncommitted tracked changes.");
    }
    for (const operation of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      if (await verifyRefIfPresent(project, operation)) {
        return refused("Finish the existing Git operation before merging (" + operation + ").");
      }
    }

    // Verification required baseSha to be an ancestor of headSha. A no-fast-forward
    // merge therefore has the reviewed tree and these two parents, in this order.
    const message = "Merge " + branch + " into " + base + " (reviewed " + headSha.slice(0, 12) + ")";
    const sign = await readGit(project, ["config", "--type=bool", "--default=false", "--get", "commit.gpgSign"]);
    const commit = await readGit(project, [
      "commit-tree", tree, "-p", baseSha, "-p", headSha, "-m", message, ...(sign === "true" ? ["-S"] : []),
    ]);
    await updateReviewedBranch(project, target, source, baseSha, headSha, commit, message);
    return success(commit);
  } catch (error) {
    return refused(error.message);
  }
}

function testInstruction(command) {
  return command
    ? "Run the configured test command before committing: " + command + "\nThe workflow will run it again."
    : 'Run relevant project checks and report what ran. Use testCommandRun="none" if the project has no relevant checks.';
}

export default workflow(
  "review-loop",
  { version: 4, payload: Payload },
  Effect.fn(function* (input, run) {
    const project = input.project.trim();
    if (!isAbsolute(project) || !input.task.trim()) {
      return yield* stop("Pass an absolute project path and a task with acceptance criteria.");
    }
    const names = Object.keys(AGENTS);
    if (names.length < 2) {
      return yield* stop("Configure at least two entries in AGENTS.");
    }
    for (const name of names) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        return yield* stop("Invalid agent name in AGENTS: " + name + ".");
      }
    }

    const builder = input.builder?.trim() || names[0];
    if (!Object.hasOwn(AGENTS, builder)) {
      return yield* stop("Unknown builder " + builder + ". Choose " + names.join(", ") + ".");
    }

    let reviewers;
    if (input.reviewers === undefined) {
      const others = names.filter((name) => name !== builder);
      if (others.length > REVIEW_FOCI.length) {
        return yield* stop(
          "More than " + REVIEW_FOCI.length + " reviewers are available in AGENTS. " +
          "Pass reviewers with 1 or " + REVIEW_FOCI.length + " names from: " + others.join(", ") + ".",
        );
      }
      reviewers = others;
    } else {
      const requested = input.reviewers.map((name) => name.trim());
      if (requested.length < 1 || requested.length > REVIEW_FOCI.length) {
        return yield* stop("Choose 1 or " + REVIEW_FOCI.length + " reviewers.");
      }
      const seen = new Set();
      for (const name of requested) {
        if (!Object.hasOwn(AGENTS, name)) {
          return yield* stop("Unknown reviewer " + JSON.stringify(name) + ". Choose " + names.join(", ") + ".");
        }
        if (name === builder) {
          return yield* stop("Reviewer cannot be the same agent as builder (" + builder + ").");
        }
        if (seen.has(name)) {
          return yield* stop("Duplicate reviewer: " + name + ".");
        }
        seen.add(name);
      }
      reviewers = requested;
    }

    for (const name of [builder, ...reviewers]) {
      const model = AGENTS[name].model;
      if (!model?.instanceId?.trim() || !model?.model?.trim()) {
        return yield* stop("Set a provider instance and model slug for AGENTS." + name + " in review-loop.js.");
      }
    }
    const base = input.baseRef?.trim() || DEFAULT_BASE;
    const branch = input.branch?.trim() || deriveBranch(input.task, run?.id);
    const command = input.testCommand?.trim() || "";
    const rounds = input.maxRounds ?? DEFAULT_ROUNDS;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
      return yield* stop("maxRounds must be an integer from 1 to 5.");
    }
    const task = input.task.trim();
    const testLine = testInstruction(command);

    yield* title("Review loop [" + builder + "]: " + task.slice(0, 100));
    const check = yield* promiseStep("preflight", Preflight, () => preflight(project, base, branch));
    if (check.reason) return yield* stop(check.reason);

    const built = yield* agent("build", {
      project,
      ...AGENTS[builder],
      workspace: { type: "worktree", baseRef: base, startFromOrigin: false, branch },
      timeout: "2 hours",
      brief: [
        task,
        "",
        "Work in the provided worktree on " + branch + ". Commit your changes on this branch.",
        "Keep changes scoped to the task. Do not push.",
        testLine,
        "Report summary, testCommandRun, and testsPassed.",
      ].join("\n"),
      returns: Build,
    });

    let latest = built.value;
    for (let round = 1; round <= rounds; round++) {
      const verified = yield* promiseStep("verify-" + round, Verification,
        () => verify(project, base, branch, command));
      const problems = verified.issues.map((issue) => "[workflow] " + issue);
      if (!command && !latest.testsPassed && latest.testCommandRun.trim().toLowerCase() !== "none") {
        problems.push("[builder] Reported failing verification: " + latest.testCommandRun);
      }

      let reviews = [];
      if (problems.length === 0) {
        const verificationNote = verified.testRan
          ? "The workflow ran and passed: " + command
          : "Builder reported testCommandRun=" + JSON.stringify(latest.testCommandRun) +
            ", testsPassed=" + latest.testsPassed + ".";
        const before = yield* promiseStep("review-snapshot-" + round, Snapshot,
          () => snapshot(project, base, branch));
        if (before.baseTip !== verified.baseSha || before.branchTip !== verified.headSha) {
          return yield* stop("The base or review branch changed before review. Start a fresh run.");
        }
        reviews = yield* Effect.all(reviewers.map((name, index) => agent(
          "review-" + round + "-" + name,
          {
            project,
            ...AGENTS[name],
            interactionMode: "plan",
            timeout: "45 minutes",
            brief: [
              "Review the change read-only.",
              "Review focus: " + (reviewers.length === 1 ? REVIEW_FOCI.join(". ") : REVIEW_FOCI[index]),
              "Inspect git diff " + verified.baseSha + "..." + verified.headSha +
                " and git show " + verified.headSha + ":<path>.",
              "Do not edit files, switch branches, or commit.",
              verificationNote,
              "Approve only if the change meets the task, has no material defects in scope, and has credible verification.",
              "If rejecting, list concrete problems with file paths and reasons.",
              "When approving, leave problems empty: every listed problem is treated as a required fix.",
              "",
              "Task: " + task,
            ].join("\n"),
            returns: Review,
          },
        )), { concurrency: reviewers.length });
        const after = yield* promiseStep("review-integrity-" + round, Snapshot,
          () => snapshot(project, base, branch));
        const changes = snapshotChanges(before, after);
        if (changes.length > 0) {
          return yield* stop(
            "The project changed while reviewers ran: " + changes.join("; ") + ". " +
            "Inspect the checkout before continuing. If you made these changes yourself, start a fresh run.",
          );
        }
        reviews.forEach(({ value }, index) => {
          if (value.approved && value.problems.length === 0) return;
          const findings = value.problems.length ? value.problems : [value.summary || "Rejected without details."];
          problems.push(...findings.map((finding) => "[" + reviewers[index] + "] " + finding));
        });
      }

      if (problems.length === 0) {
        const answer = yield* ask("approve-merge", {
          title: "Approved in round " + round + ". Merge " + branch + " into " + base + "?",
          choices: ["Merge", "Leave on branch"],
          data: {
            builder, project, base, branch,
            baseSha: verified.baseSha,
            headSha: verified.headSha,
            summary: latest.summary,
            testCommandRun: command || latest.testCommandRun,
            deterministicTestRan: verified.testRan,
            testOutputTail: verified.testOutputTail,
            reviews: reviews.map(({ value }, index) => ({ reviewer: reviewers[index], summary: value.summary })),
          },
          timeout: "7 days",
        });

        const result = { builder, project, base, branch, headSha: verified.headSha, rounds: round };
        if (answer._tag !== "Some" || answer.value.choice !== "Merge") {
          return { ...result, merged: false, commit: "", reason: "Left on branch." };
        }
        const merged = yield* promiseStep("local-merge", Merge,
          () => merge(project, base, branch, verified.baseSha, verified.headSha));
        return { ...result, ...merged };
      }

      if (round === rounds) break;
      const revised = yield* agent("revise-" + round, {
        thread: built.thread,
        timeout: "2 hours",
        brief: [
          "Resolve the issues below in the existing worktree on " + branch + " and commit the fixes.",
          ...problems.map((problem) => "- " + problem),
          "",
          testLine,
          "Do not push. Report an updated summary, testCommandRun, and testsPassed.",
        ].join("\n"),
        returns: Build,
      });
      latest = revised.value;
    }

    return yield* stop("No approval after " + rounds + " rounds. Review the preserved branch " + branch + ".");
  }),
);
