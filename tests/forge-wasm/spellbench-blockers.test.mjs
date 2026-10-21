import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import test from "node:test";

const published = process.env.FORGE_WASM_PACKAGE;
assert(published, "Set FORGE_WASM_PACKAGE to the installed 0.2.0 package directory");
assert.equal(JSON.parse(readFileSync(resolve(published, "package.json"))).version, "0.2.0");
const sourceWorker = new URL("../../packages/forge-wasm/forge-engine.worker.js", import.meta.url);

async function capture(worker, args) {
  let request;
  const context = {
    SharedArrayBuffer,
    Date: class {
      static now() {
        return 123456789;
      }
    },
    console: {},
    postMessage() {},
    __forgeStartGame(json) {
      request = JSON.parse(json);
    },
    importScripts() {
      context.__forgeBootResolve();
    },
  };
  context.self = context;
  vm.runInNewContext(readFileSync(worker, "utf8"), context);
  const deck = { cards: [{ name: "Mountain", count: 60 }] };
  context.onmessage({
    data: {
      type: "command",
      command: "start_multiplayer_game",
      requestId: "1",
      args: {
        decks: [deck, deck],
        playerNames: ["p0", "p1"],
        enginePlayerIndex: 0,
        forgeAssets: "fixture",
        ...args,
      },
    },
  });
  await new Promise((done) => setImmediate(done));
  assert(request);
  return request;
}

test("reproduces npm 0.2.0 ignoring a caller seed in favor of the clock", async () => {
  const worker = resolve(published, "forge-engine.worker.js");
  const a = await capture(worker, { seed: 42 });
  const b = await capture(worker, { seed: 43 });
  assert.equal(a.seed, 123456789);
  assert.equal(b.seed, a.seed);
});

test("reproduces the source worker reducing caller seeds modulo 2^31 - 1", async () => {
  const a = await capture(sourceWorker, { seed: 42 });
  const b = await capture(sourceWorker, { seed: 42 + 2147483647 });
  assert.equal(a.seed, 42);
  assert.equal(b.seed, a.seed);
});

test("published worker ignores starting-player configuration", async () => {
  for (const worker of [resolve(published, "forge-engine.worker.js")]) {
    const a = await capture(worker, { startingPlayer: 0, startingSeat: "p0" });
    const b = await capture(worker, { startingPlayer: 1, startingSeat: "p1" });
    assert.deepEqual(a, b);
    assert.deepEqual(
      a.players.map((p) => p.ai),
      [false, false],
    );
  }
});

test("source forwards opt-in starting seat and all 256 random seed bits", async () => {
  const seed = "ab".repeat(32);
  const a = await capture(sourceWorker, { startingPlayerIndex: 0, randomSeed: seed });
  const b = await capture(sourceWorker, { startingPlayerIndex: 1, randomSeed: seed });
  assert.equal(a.startingPlayerIndex, 0);
  assert.equal(b.startingPlayerIndex, 1);
  assert.equal(a.randomSeed, seed);
  assert.equal(b.randomSeed, seed);
});
