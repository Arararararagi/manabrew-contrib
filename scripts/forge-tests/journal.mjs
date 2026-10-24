import { harness as createHarness } from "./journal-harness.mjs";
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { deck, scriptedAnswer } from "./journal-fixture.mjs";

const { values } = parseArgs({
  options: {
    jar: {
      type: "string",
      default: "forge-harness/target/forge-harness-jar-with-dependencies.jar",
    },
    "forge-home": { type: "string", default: "forge/forge-gui" },
    java: { type: "string", default: "java" },
  },
});
const decisions = 20;
const sessionId = "decision-journal-probe";
const request = {
  gameId: sessionId,
  variant: "Constructed",
  startingLife: 20,
  seed: 43,
  snapshotRecording: false,
  decisionJournal: true,
  players: [0, 1].map((seat) => ({
    name: `Player ${seat}`,
    ai: false,
    bot: seat === 1,
    deck: deck.cards.flatMap(({ name, count }) => Array.from({ length: count }, () => ({ name }))),
  })),
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

const harness = () =>
  createHarness({
    java: values.java,
    jar: values.jar,
    forgeHome: values["forge-home"],
    sessionId,
  });

async function views(engine) {
  const result = [];
  for (const viewer of [0, 1])
    result.push(JSON.parse(await engine.call("getSnapshot", { viewer })));
  return result;
}

const entries = [];
const source = harness();
try {
  await source.call("startGame", { payload: JSON.stringify(request) });
  await assert.rejects(
    source.call("startGame", { payload: JSON.stringify(request) }),
    /session already exists/,
  );
  await assert.rejects(
    source.call("startGame", {
      payload: JSON.stringify({ ...request, gameId: "concurrent-journal" }),
    }),
    /isolated engine process/,
  );
  await assert.rejects(
    source.call("startGame", {
      payload: JSON.stringify({
        ...request,
        gameId: "concurrent-ordinary",
        decisionJournal: false,
      }),
    }),
    /isolated engine process/,
  );
  let prompt = await source.prompt();
  const first = await source.drain();
  assert.equal(first.version, 2);
  assert.deepEqual(JSON.parse(first.startRequest), request);
  assert.deepEqual(first.entries, []);
  assert.equal(await source.drain(), null);
  await assert.rejects(source.call("readDecisionJournal"), /cannot mix/);
  for (let index = 0; index < decisions; index++) {
    if (index === 3) {
      const action = {
        type: "directive",
        player: -1,
        directive: { type: "setSnapshotRecording", enabled: false },
      };
      await source.call("submitAction", { payload: JSON.stringify(action) });
      const batch = await source.consumed();
      assert.equal(batch.entries.length, 1);
      assert.deepEqual(batch.entries[0].action, action);
      assert.deepEqual(batch.entries[0].prompt, prompt);
      assert.equal(batch.entries[0].sequence, entries.length + 1);
      entries.push(batch.entries[0]);
    }
    const action = scriptedAnswer({ prompt });
    await source.call("submitAction", { payload: JSON.stringify(action) });
    const next = await source.prompt(prompt.promptId);
    const batch = await source.drain();
    assert.equal(batch.unavailableReason, undefined);
    assert.equal(batch.startRequest, undefined);
    assert.equal(batch.entries.length, 1);
    assert.equal(batch.nextSequence, entries.length + 2);
    const entry = batch.entries[0];
    assert.equal(entry.sequence, entries.length + 1);
    assert.deepEqual(entry.prompt, prompt);
    assert.deepEqual(entry.action, action);
    assert.equal(entry.playerIndex, Number(prompt.decidingPlayerId?.split("-")[1] ?? -1));
    entries.push(entry);
    prompt = next;
  }
  await source.call("submitAction", {
    payload: JSON.stringify({
      type: "directive",
      player: 0,
      directive: { type: "requestRestore", checkpointId: 999999 },
    }),
  });
  assert.match((await source.consumed()).unavailableReason, /snapshot restore/);
} finally {
  source.close();
}

const gated = harness();
try {
  await assert.rejects(
    gated.call("startGame", {
      payload: JSON.stringify({
        ...request,
        decisionJournal: false,
        decisionJournalCommitBarrier: true,
      }),
    }),
    /requires decisionJournal/,
  );
  await gated.call("startGame", {
    payload: JSON.stringify({ ...request, decisionJournalCommitBarrier: true }),
  });
  const read = async () => JSON.parse(await gated.call("readDecisionJournal"));
  const acknowledge = (sequence) => gated.call("acknowledgeDecisionJournal", { sequence });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await gated.call("getPrompt", { playerIndex: 0 }), "");
  const gatedManifest = await read();
  assert.equal(gatedManifest.nextSequence, 1);
  assert.equal(gatedManifest.commitBarrier, true);
  await assert.rejects(gated.drain(), /cannot mix/);
  await acknowledge(0);
  let prompt = await gated.prompt();
  for (let sequence = 1; sequence <= 5; sequence++) {
    const before = await views(gated);
    await gated.call("submitAction", { payload: JSON.stringify(scriptedAnswer({ prompt })) });
    const deadline = performance.now() + 10_000;
    let batch;
    do {
      const raw = await gated.call("readDecisionJournal");
      if (raw) batch = JSON.parse(raw);
      if (batch?.entries.length) break;
      await pause();
    } while (performance.now() < deadline);
    assert.equal(batch?.entries[0].sequence, sequence);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await views(gated), before);
    assert.deepEqual(JSON.parse(await gated.call("getPrompt", { playerIndex: 0 })), prompt);
    await acknowledge(sequence - 1);
    assert.deepEqual(await read(), batch);
    await acknowledge(sequence);
    prompt = await gated.prompt(prompt.promptId);
  }
  await gated.call("submitAction", {
    payload: JSON.stringify({
      type: "directive",
      player: 0,
      directive: { type: "requestRestore", checkpointId: 1 },
    }),
  });
  const deadline = performance.now() + 10_000;
  while (true) {
    try {
      await gated.call("getGameOver");
    } catch (error) {
      assert.match(error.message, /journal unavailable/);
      break;
    }
    assert(performance.now() < deadline, "restore must fail closed");
    await pause();
  }
  await gated.call("endGame");
  await gated.call("startGame", {
    payload: JSON.stringify({ ...request, decisionJournalCommitBarrier: true }),
  });
  const started = performance.now();
  await gated.call("endGame");
  assert(performance.now() - started < 2000, "close must wake the manifest barrier");
  await gated.call("startGame", {
    payload: JSON.stringify({ ...request, decisionJournalCommitBarrier: true }),
  });
  await read();
  await acknowledge(0);
  prompt = await gated.prompt();
  await gated.call("submitAction", { payload: JSON.stringify(scriptedAnswer({ prompt })) });
  const decisionDeadline = performance.now() + 10_000;
  while (!(await gated.call("readDecisionJournal"))) {
    assert(performance.now() < decisionDeadline, "decision must reach the barrier");
    await pause();
  }
  const closing = performance.now();
  await gated.call("endGame");
  assert(performance.now() - closing < 2000, "close must wake the decision barrier");
} finally {
  gated.close();
}

const retained = harness();
try {
  await retained.call("startGame", { payload: JSON.stringify(request) });
  let prompt = await retained.prompt();
  const read = () => retained.call("readDecisionJournal");
  const acknowledge = (sequence) => retained.call("acknowledgeDecisionJournal", { sequence });
  await assert.rejects(acknowledge(0), /read prefix/);
  const manifest = await read();
  assert.equal(await read(), manifest, "lost manifest delivery must be retryable");
  await assert.rejects(retained.drain(), /cannot mix/);
  await assert.rejects(acknowledge(-1), /read prefix/);
  await assert.rejects(acknowledge(0.5));
  await acknowledge(0);
  await acknowledge(0);
  assert.equal(await read(), "");
  for (let pair = 0; pair < 5; pair++) {
    const actions = [];
    for (let index = 0; index < 2; index++) {
      const action = scriptedAnswer({ prompt });
      action.padding = "x".repeat(1024 * 1024);
      actions.push(action);
      await retained.call("submitAction", { payload: JSON.stringify(action) });
      prompt = await retained.prompt(prompt.promptId);
    }
    const sequence = pair * 2 + 2;
    await assert.rejects(acknowledge(sequence), /read prefix/);
    const raw = await read();
    const batch = JSON.parse(raw);
    assert.equal(await read(), raw, "lost batch delivery must be retryable");
    assert.equal(batch.unavailableReason, undefined);
    assert.equal(batch.startRequest, undefined);
    assert.equal(batch.nextSequence, sequence + 1);
    assert.deepEqual(
      batch.entries.map((entry) => entry.action),
      actions,
    );
    await acknowledge(sequence - 1);
    assert.deepEqual(JSON.parse(await read()).entries, [batch.entries[1]]);
    await acknowledge(sequence - 2);
    await acknowledge(sequence - 1);
    assert.deepEqual(JSON.parse(await read()).entries, [batch.entries[1]]);
    await acknowledge(sequence);
    assert.equal(await read(), "");
  }
  const action = scriptedAnswer({ prompt });
  action.padding = "x".repeat(8 * 1024 * 1024);
  await retained.call("submitAction", { payload: JSON.stringify(action) });
  prompt = await retained.prompt(prompt.promptId);
  const failure = await read();
  assert.match(JSON.parse(failure).unavailableReason, /limit/);
  assert.equal(await read(), failure, "invalidation must survive lost delivery");
  await assert.rejects(acknowledge(10), /unavailable/);
  await retained.call("submitAction", { payload: JSON.stringify(scriptedAnswer({ prompt })) });
  await retained.prompt(prompt.promptId);
  assert.equal(await read(), failure);
} finally {
  retained.close();
}

const disabled = harness();
try {
  const aiRequest = structuredClone(request);
  aiRequest.players[1].ai = true;
  await assert.rejects(
    disabled.call("startGame", { payload: JSON.stringify(aiRequest) }),
    /external decisions/,
  );
  await assert.rejects(
    disabled.call("startGame", {
      payload: JSON.stringify({ ...request, checkpoint: "{}" }),
    }),
    /GameState checkpoints/,
  );
  await disabled.call("startGame", {
    payload: JSON.stringify({ ...request, decisionJournal: false }),
  });
  const prompt = await disabled.prompt();
  await disabled.call("submitAction", { payload: JSON.stringify(scriptedAnswer({ prompt })) });
  await disabled.prompt(prompt.promptId);
  assert.equal(await disabled.drain(), null);
} finally {
  disabled.close();
}

console.log("PASS: journal delivery, acknowledgement barriers, limits and unsupported modes");
