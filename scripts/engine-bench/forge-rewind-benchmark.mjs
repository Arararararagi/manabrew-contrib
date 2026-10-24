import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { harness } from "./journal-harness.mjs";
import { scriptedAnswer } from "./journal-fixture.mjs";

const { values } = parseArgs({
  options: {
    java: { type: "string", default: "java" },
    jar: {
      type: "string",
      default: "forge-harness/target/forge-harness-jar-with-dependencies.jar",
    },
    "forge-home": { type: "string", default: "forge/forge-gui" },
    native: { type: "string" },
    decisions: { type: "string", default: "400" },
    scenario: { type: "string", default: "commander" },
    samples: { type: "string", default: "5" },
    fixture: { type: "string" },
    "save-fixture": { type: "string" },
  },
});
const sessionId = "rewind-benchmark";
const engine = () => harness({ ...values, forgeHome: values["forge-home"], sessionId });
async function until(read, predicate) {
  const deadline = performance.now() + 120000;
  while (performance.now() < deadline) {
    const result = await read();
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("rewind benchmark timed out");
}
async function view(worker) {
  return JSON.parse(await worker.call("getSnapshot", { viewer: 0 }));
}
function board(view) {
  const { checkpoints, restoreVote, decisionHistory, snapshotRecording, ...state } = view;
  return state;
}
async function directive(worker, player, directive) {
  await worker.call("submitAction", {
    payload: JSON.stringify({ type: "directive", player, directive }),
  });
}
let fixture;
if (values.fixture) {
  fixture = JSON.parse(readFileSync(values.fixture, "utf8"));
} else {
  const target = Number(values.decisions);
  assert(Number.isInteger(target) && target > 0);
  assert(["commander", "hidden"].includes(values.scenario));
  const commander =
    values.scenario === "hidden" ? "Talrand, Sky Summoner" : "Isamaru, Hound of Konda";
  const cards =
    values.scenario === "hidden"
      ? [
          [commander, 1],
          ["Island", 35],
          ["Ponder", 20],
          ["Brainstorm", 20],
          ["Memnite", 24],
        ]
      : [
          [commander, 1],
          ["Plains", 35],
          ["Soul Warden", 20],
          ["Memnite", 24],
          ["Raise the Alarm", 20],
        ];
  const deck = cards.flatMap(([name, count]) => Array.from({ length: count }, () => ({ name })));
  const request = {
    gameId: sessionId,
    variant: "Commander",
    startingLife: 40,
    seed: 43,
    snapshotRecording: false,
    decisionJournal: true,
    journalRewind: true,
    players: Array.from({ length: 4 }, (_, seat) => ({
      name: `Player ${seat}`,
      ai: false,
      commanderNames: [commander],
      deck,
    })),
  };
  const source = engine();
  const continuation = [];
  const promptTypes = new Set();
  try {
    await source.call("startGame", { payload: JSON.stringify(request) });
    let prompt = await source.prompt();
    for (let index = 1; index <= target + 7; index++) {
      const action = scriptedAnswer({ prompt });
      promptTypes.add(prompt.input.type);
      if (index >= target) {
        const state = await view(source);
        continuation.push({ prompt, action, board: board(state), checkpoints: state.checkpoints });
      }
      await source.call("submitAction", { payload: JSON.stringify(action) });
      prompt = await source.prompt(prompt.promptId);
      if (index % 100 === 0) console.error(`Recorded ${index} inputs`);
    }
    await directive(source, 0, { type: "requestRestore", checkpointId: target });
    const vote = await until(
      () => view(source),
      (state) => state.restoreVote?.status.type === "pending",
    );
    for (let seat = 1; seat < 4; seat++) {
      await directive(source, seat, {
        type: "restoreVote",
        voteId: vote.restoreVote.voteId,
        accept: true,
      });
    }
    const snapshot = JSON.parse(await until(() => source.call("getRewindRequest"), Boolean));
    if (values.scenario === "hidden") {
      assert(
        promptTypes.has("chooseCards") && promptTypes.has("reorder"),
        "fixture must reach hidden choices",
      );
    }
    fixture = { target, snapshot, continuation, scenario: values.scenario };
    if (values["save-fixture"]) writeFileSync(values["save-fixture"], JSON.stringify(fixture));
  } finally {
    source.close();
  }
}
const samples = Number(values.samples);
assert(Number.isInteger(samples) && samples > 0);
const results = [];
for (let sample = 0; sample < samples; sample++) {
  const started = performance.now();
  const candidate = engine();
  try {
    const request = {
      ...JSON.parse(fixture.snapshot.journal.startRequest),
      replaySnapshot: fixture.snapshot,
    };
    await candidate.call("startGame", { payload: JSON.stringify(request) });
    const initialized = performance.now();
    await until(
      () => candidate.call("replayReady"),
      (ready) => ready === "true",
    );
    const ready = performance.now();
    const restored = await view(candidate);
    assert.equal(restored.checkpoints.length, Math.min(200, fixture.target - 1));
    assert.equal(restored.restoreVote.status.type, "approved");
    assert.equal(restored.checkpoints.at(-1)?.checkpointId ?? 0, fixture.target - 1);
    for (const boundary of fixture.continuation) {
      assert.deepEqual(
        JSON.parse(await candidate.call("getPrompt", { playerIndex: 0 })),
        boundary.prompt,
      );
      const state = await view(candidate);
      assert.deepEqual(board(state), boundary.board);
      if (boundary.checkpoints) assert.deepEqual(state.checkpoints, boundary.checkpoints);
      await candidate.call("submitAction", { payload: JSON.stringify(boundary.action) });
      await candidate.prompt(boundary.prompt.promptId);
    }
    results.push({
      startupMs: initialized - started,
      replayMs: ready - initialized,
      totalMs: ready - started,
    });
    console.log(JSON.stringify({ sample: sample + 1, ...results.at(-1) }));
  } finally {
    candidate.close();
  }
}
const timings = Object.fromEntries(
  ["startupMs", "replayMs", "totalMs"].map((metric) => {
    const sorted = results.map((sample) => sample[metric]).sort((a, b) => a - b);
    return [
      metric,
      {
        median: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      },
    ];
  }),
);
console.log(
  JSON.stringify({
    runtime: values.native ? "native" : "jvm",
    scenario: fixture.scenario ?? "commander",
    seats: 4,
    target: fixture.target,
    samples,
    timings,
  }),
);
