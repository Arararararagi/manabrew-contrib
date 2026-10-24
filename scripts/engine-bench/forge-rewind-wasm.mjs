import assert from "node:assert/strict";
import { ForgeEngine } from "../../packages/forge-wasm/node.js";
import { deck, scriptedAnswer } from "./journal-fixture.mjs";

let prompts = [];
let latestView;
let approvedVote = 0;
let highestPrompt = 0;
let error;
const bySeat = new Map();
const inputs = new Map();
const engine = new ForgeEngine({
  onState: ({ gameView }, slot = "local") => {
    bySeat.set(slot, gameView);
    latestView = gameView;
    if (
      gameView.restoreVote?.status.type === "approved" &&
      gameView.restoreVote.voteId > approvedVote
    ) {
      approvedVote = gameView.restoreVote.voteId;
      prompts = [];
    }
  },
  onPrompt: (prompt, slot = "local") => {
    const view = bySeat.get(slot);
    const sequence = (view?.checkpoints.at(-1)?.checkpointId ?? 0) + 1;
    if (!approvedVote) inputs.set(sequence, prompt.input);
    highestPrompt = Math.max(highestPrompt, prompt.promptId);
    prompts.push({ prompt, slot, view });
  },
  onError: (cause) => {
    error = cause;
  },
  onEvent: (name, payload) => {
    if (name === "game:forced_end") error = new Error(payload.message);
    if (name === "forge:log" && payload.level === "error")
      process.stderr.write(payload.text + "\n");
    assert.notEqual(name, "forge:journal", "raw private journals must stay inside the supervisor");
  },
});
async function until(predicate) {
  const deadline = performance.now() + 120000;
  while (!predicate()) {
    if (error) throw error;
    assert(performance.now() < deadline, "WASM rewind timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function answerNext() {
  await until(() => prompts.length > 0);
  const { prompt, slot } = prompts.shift();
  engine.respond(prompt.promptId, scriptedAnswer({ prompt }), slot);
}
try {
  await engine.startMultiplayerGame({
    decks: [deck, deck],
    playerNames: ["One", "Two"],
    enginePlayerIndex: 0,
    seed: 42,
    decisionJournal: true,
    journalRewind: true,
    snapshotRecording: false,
  });
  while ((latestView?.checkpoints.at(-1)?.checkpointId ?? 0) < 80) await answerNext();
  for (const target of [24, 4]) {
    const oldHighest = highestPrompt;
    const oldVote = latestView.restoreVote?.voteId ?? 0;
    engine.directive({ type: "requestRestore", checkpointId: target });
    await until(() => latestView.restoreVote?.voteId > oldVote);
    const vote = latestView.restoreVote;
    assert.deepEqual(vote.awaitingPlayerIds, ["player-1"]);
    engine.directive({ type: "restoreVote", voteId: vote.voteId, accept: true }, "player-1");
    await until(() => approvedVote === vote.voteId && prompts.length > 0);
    const restored = prompts[0];
    assert(restored.prompt.promptId > oldHighest, "wire prompt IDs must advance across rewind");
    assert.deepEqual(restored.prompt.input, inputs.get(target));
    assert.equal(restored.view.checkpoints.at(-1)?.checkpointId ?? 0, target - 1);
    for (let index = 0; index < 8; index++) await answerNext();
    console.log(JSON.stringify({ runtime: "wasm", target, continued: 8 }));
  }
} finally {
  engine.dispose();
}
