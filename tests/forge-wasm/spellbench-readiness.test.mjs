import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../../scripts/engine-bench/spellbench-readiness.mjs", import.meta.url),
);
const engine = process.env.FORGE_WASM_PACKAGE;
assert(engine, "Set FORGE_WASM_PACKAGE to an installed @manabrew/forge-wasm directory");
const args = [script, "--engine", resolve(engine)];
const options = { timeout: 150000, maxBuffer: 4 * 1024 * 1024 };

test("two external seats finish a game and receive only their own hand", async () => {
  const { stdout } = await run(process.execPath, args, options);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.routedSeats, ["player-0", "player-1"]);
  assert(result.visibleHandChecks > 0);
  assert.equal(result.promptTypes.mulligan, 2);
  assert.equal(result.terminal.turn, 108);
  assert.equal(result.terminal.phase, "draw");
  assert.equal(result.terminal.winner, result.firstActivePlayer);
  assert(result.promptsAnswered > 1000);
  assert.match(result.purpose, /not SpellBench conformance/);
});

test("spells traverse payment, targeting, and combat to a natural result", async () => {
  const { stdout } = await run(process.execPath, [...args, "--scenario", "spells"], options);
  const result = JSON.parse(stdout);
  for (const kind of ["payManaCost", "chooseBoardTargets", "chooseAttackers"]) {
    assert(result.promptTypes[kind] > 0, `Fixture did not exercise ${kind}`);
  }
  assert(result.terminal.life.some((p) => p.life <= 0));
});

test("a held prompt times out and disposing the worker lets Node exit", async () => {
  await assert.rejects(
    run(process.execPath, [...args, "--scenario", "held-prompt", "--timeout", "10000"], {
      ...options,
      timeout: 20000,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.killed, false);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /Forge probe timed out/);
      assert.match(error.stderr, /"diceRolled":[1-9]/);
      return true;
    },
  );
});
