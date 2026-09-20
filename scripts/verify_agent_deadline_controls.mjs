import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// One hosted checkout, the existing Cargo cache, and only focused binaries.
// Every mutant must compile, fail its exact assertion, and then be restored.
const started = Date.now();
const totalBudgetMs = 8 * 60_000;
const outputLimit = 4 * 1024 * 1024;
const artifacts = path.join(".local", "deadline-controls", `run-${randomUUID()}`);
fs.mkdirSync(artifacts, { recursive: true });
const originals = new Map(
  ["src/cli/agent.rs", "src/terminal/state.rs"].map((file) => [file, fs.readFileSync(file)]),
);
let active;

function restore() {
  for (const [file, bytes] of originals) {
    fs.writeFileSync(file, bytes);
    assert.ok(fs.readFileSync(file).equals(bytes), `exact restoration failed: ${file}`);
  }
  fs.appendFileSync(path.join(artifacts, "restoration.log"), "original source bytes verified\n");
}

function stopChild() {
  if (!Number.isInteger(active?.pid)) return;
  try {
    process.kill(-active.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  process.on(signal, () => {
    try {
      stopChild();
    } finally {
      try {
        restore();
      } finally {
        process.exit(code);
      }
    }
  });
}

// Also restore on an unexpected stream/filesystem callback exception, which
// would otherwise escape the awaited command's try/finally.
process.on("uncaughtException", (error) => {
  console.error(error);
  try {
    stopChild();
  } finally {
    try {
      restore();
    } finally {
      process.exit(1);
    }
  }
});

async function run(label, command, args, allowanceMs) {
  const timeoutMs = Math.min(allowanceMs, totalBudgetMs - (Date.now() - started) - 5_000);
  assert.ok(timeoutMs > 0, "deadline controls exhausted the whole-run time budget");
  const streams = { stdout: "", stderr: "" };
  let bytes = 0;
  let failure;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CARGO_TERM_COLOR: "never", RUST_BACKTRACE: "0" },
    });
    active = child;
    const timer = setTimeout(() => {
      failure = "command timeout";
      stopChild();
    }, timeoutMs);
    for (const name of ["stdout", "stderr"]) {
      child[name].setEncoding("utf8");
      child[name].on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > outputLimit) {
          failure = "command output limit";
          stopChild();
          return;
        }
        streams[name] += chunk;
        fs.appendFileSync(path.join(artifacts, `${label}.${name}.log`), chunk);
      });
    }
    child.once("error", (error) => {
      failure = error.message;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      active = undefined;
      const record = { code, signal, failure, timeoutMs, bytes };
      fs.writeFileSync(path.join(artifacts, `${label}.json`), `${JSON.stringify(record)}\n`);
      if (failure || signal) reject(new Error(`${label}: ${failure || signal}`));
      else resolve({ ...record, ...streams });
    });
  });
  return result;
}

const targets = {
  unit: { args: ["--bin", "herdr"], name: "herdr", kind: "bin" },
  cli: { args: ["--test", "cli"], name: "cli", kind: "test" },
};

async function compile(label, selected) {
  const result = await run(label, "cargo", [
    "test", "--locked", ...selected.flatMap((key) => targets[key].args),
    "--no-run", "--message-format=json",
  ], 120_000);
  assert.equal(result.code, 0, `${label}: mutant/baseline did not compile`);
  const records = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const binaries = {};
  for (const key of selected) {
    const target = targets[key];
    const matches = records.filter((row) => row.reason === "compiler-artifact"
      && row.profile.test && row.target.name === target.name
      && row.target.kind.includes(target.kind) && row.executable);
    assert.equal(matches.length, 1, `${label}: missing/ambiguous ${key} executable`);
    binaries[key] = matches[0].executable;
  }
  return binaries;
}

const cases = [
  ["cli", "cases::agent_transport::agent_start_deadline_rejects_a_different_kind_on_the_same_named_terminal"],
  ["cli", "cases::agent_transport::agent_start_deadline_accepts_matching_working_agent_identity"],
  ["cli", "cases::agent_transport::agent_start_deadline_rejects_replaced_terminal_or_name"],
  ["cli", "cases::agent_transport::agent_start_accepts_durable_readiness_during_detection_gap"],
  ["unit", "terminal::state::tests::managed_agent_start_deadline_does_not_promote_unknown_process_presence"],
  ["unit", "terminal::state::tests::managed_agent_start_deadline_keeps_an_attached_agent"],
  ["unit", "terminal::state::tests::managed_agent_activates_only_after_matching_settled_detection"],
  ["unit", "terminal::state::tests::managed_agent_mismatch_and_timeout_release_name"],
];

function panicBelongsTo(stderr, name) {
  const prefix = `thread '${name}'`;
  return stderr.split("\n").some((line) => line.startsWith(prefix)
    && /^(?: \([0-9]+\))? panicked at /.test(line.slice(prefix.length)));
}

function checkPanicOwnerFormats() {
  const name = cases[0][1];
  // Rust's current libtest includes a numeric thread ID after the full name.
  for (const suffix of ["", " (16231)"]) {
    assert.ok(panicBelongsTo(`thread '${name}'${suffix} panicked at fixture.rs:79:5:\n`, name));
  }
  for (const header of [
    `thread '${name}_other' (16231) panicked at `,
    `thread '${name}' (not-a-number) panicked at `,
    `thread '${name}' (16231 panicked at `,
    `thread '${name}' () panicked at `,
    `thread '${name}' (-16231) panicked at `,
    `prefix thread '${name}' (16231) panicked at `,
  ]) {
    assert.ok(!panicBelongsTo(header, name), `accepted malformed/wrong panic owner: ${header}`);
  }
  fs.writeFileSync(path.join(artifacts, "panic-owner-formats.log"),
    "PASS legacy and numeric-ID headers; rejected wrong owner and malformed IDs\n");
}

async function checkCase(label, binary, name, marker) {
  const result = await run(label, binary, [name, "--exact", "--nocapture", "--test-threads=1"], 30_000);
  const failed = Boolean(marker);
  assert.equal(result.code, failed ? 101 : 0, `${label}: unexpected test exit`);
  // Libtest's exact-name result AND one executed test are required. Empty
  // selectors, ignored tests, process crashes and compile errors never count.
  assert.ok(result.stdout.includes(`test ${name} ... ${failed ? "FAILED" : "ok"}\n`),
    `${label}: missing exact named test result`);
  const summary = failed
    ? "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured;"
    : "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured;";
  assert.ok(result.stdout.includes(summary), `${label}: missing exact execution counts`);
  if (failed) {
    assert.ok(panicBelongsTo(result.stderr, name), `${label}: wrong panic owner`);
    assert.ok(result.stderr.includes(marker), `${label}: wrong assertion`);
  }
}

async function baseline(label) {
  const binaries = await compile(`${label}-compile`, ["unit", "cli"]);
  for (const [index, [target, name]] of cases.entries()) {
    await checkCase(`${label}-${index}`, binaries[target], name);
  }
}

function replaceOnce(file, anchor, replacement) {
  const original = originals.get(file).toString("utf8");
  assert.equal(original.split(anchor).length, 2, `missing/ambiguous mutation anchor: ${file}`);
  fs.writeFileSync(file, original.replace(anchor, replacement));
  assert.notEqual(fs.readFileSync(file, "utf8"), original, "mutation made no change");
}

const deadlineAdmission = `                if let Some(outcome) = named_agent_start_outcome(
                    &response["result"]["agent"],
                    name,
                    expected_kind,
                    expected_terminal_id,
                ) {
                    return Ok(outcome);
                }`;
const recognizedState = `                if known_agent == Some(managed.kind)
                    && matches!(
                        self.state,
                        AgentState::Idle | AgentState::Blocked | AgentState::Working
                    )`;
const promotion = `${recognizedState}
                {
                    self.managed_agent = Some(ManagedAgent {
                        kind: managed.kind,
                        phase: ManagedAgentPhase::Active,
                    });
                    return true;
                }
`;
const controls = [
  {
    label: "wrong-kind", file: "src/cli/agent.rs", anchor: deadlineAdmission,
    replacement: `                let agent = &response["result"]["agent"];
                if agent["terminal_id"].as_str() == Some(expected_terminal_id)
                    && agent["name"].as_str() == Some(name)
                    && agent["interactive_ready"].as_bool().unwrap_or(false)
                {
                    return Ok(Ok(agent.clone()));
                }`,
    caseIndex: 0, marker: "deadline accepted a different agent kind on the same named terminal",
  },
  {
    label: "unknown-ready", file: "src/terminal/state.rs", anchor: recognizedState,
    replacement: "                if known_agent == Some(managed.kind)",
    caseIndex: 4, marker: "matching process presence with Unknown state became interactive-ready",
  },
  {
    label: "working-cleared", file: "src/terminal/state.rs", anchor: promotion, replacement: "",
    caseIndex: 5, marker: "startup deadline cleared the attached Working agent",
  },
];

try {
  checkPanicOwnerFormats();
  const head = await run("source-head", "git", ["rev-parse", "HEAD"], 10_000);
  assert.equal(head.code, 0, "cannot record candidate identity");
  const clean = await run("source-clean", "git", ["diff", "--exit-code", "HEAD", "--", ...originals.keys()], 10_000);
  assert.equal(clean.code, 0, "deadline controls require committed source inputs");
  await baseline("baseline");
  for (const control of controls) {
    try {
      replaceOnce(control.file, control.anchor, control.replacement);
      const patch = await run(`${control.label}-patch`, "git", ["diff", "--", control.file], 10_000);
      assert.equal(patch.code, 0, "cannot retain mutation patch");
      const [target, name] = cases[control.caseIndex];
      const binaries = await compile(`${control.label}-compile`, [target]);
      await checkCase(control.label, binaries[target], name, control.marker);
    } finally {
      restore();
    }
  }
  await baseline("restored");
} catch (error) {
  fs.writeFileSync(path.join(artifacts, "FAIL"), `${error.stack || error}\n`);
  throw error;
} finally {
  restore();
}
fs.writeFileSync(path.join(artifacts, "PASS"), "all three causal controls and restored baseline passed\n");
console.log(`Agent deadline controls passed; evidence: ${artifacts}`);
