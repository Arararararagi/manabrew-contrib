import assert from "node:assert/strict";
import { ForgeEngine } from "../../packages/forge-wasm/node.js";
import { deck, scriptedAnswer } from "./journal-fixture.mjs";

let prompts = [];
let latestView;
let approvedVote = 0;
let highestPrompt = 0;
let error;
let staleErrors = 0;
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
    if (cause?.code === "stalePrompt") staleErrors++;
    else error = cause;
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
  await until(() => prompts.length > 0);
  const injected = prompts.shift();
  const authenticatedSeat = injected.slot === "local" ? 0 : 1;
  const claimedSeat = 1 - authenticatedSeat;
  engine.respond(
    injected.prompt.promptId,
    {
      type: "directive",
      player: claimedSeat,
      directive: { type: "requestRestore", checkpointId: 24 },
    },
    injected.slot,
  );
  await until(() => latestView.restoreVote?.status.type === "pending");
  assert.equal(latestView.restoreVote.requestedByPlayerId, `player-${authenticatedSeat}`);
  engine.directive(
    { type: "restoreVote", voteId: latestView.restoreVote.voteId, accept: false },
    claimedSeat === 0 ? "local" : "player-1",
  );
  await until(() => latestView.restoreVote.status.type === "declined");
  console.log(JSON.stringify({ nestedDirectiveCannotImpersonateAnotherSeat: true }));
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
  await until(() => prompts.length > 0);
  const pending = prompts.shift();
  engine.respond(
    pending.prompt.promptId - 1,
    scriptedAnswer({ prompt: pending.prompt }),
    pending.slot,
  );
  await until(() => staleErrors === 1 && prompts.length > 0);
  const oldVote = latestView.restoreVote.voteId;
  engine.directive({ type: "requestRestore", checkpointId: 4 });
  await until(() => latestView.restoreVote.voteId > oldVote);
  const vote = latestView.restoreVote;
  engine.directive({ type: "restoreVote", voteId: vote.voteId, accept: true }, "player-1");
  await until(() => latestView.decisionHistory.rewinding);
  const other = pending.slot === "local" ? "player-1" : "local";
  engine.directive({ type: "concede" }, other);
  await until(() => latestView?.gameOver);
  console.log(
    JSON.stringify({
      staleResponseRejected: true,
      directivePollingAfterStaleResponse: true,
      queuedConcedeSurvivesPromotion: true,
    }),
  );
} finally {
  engine.dispose();
}
