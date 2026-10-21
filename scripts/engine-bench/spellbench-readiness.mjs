#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const { values } = parseArgs({
  options: {
    engine: { type: "string" },
    scenario: { type: "string", default: "lands" },
    timeout: { type: "string", default: "120000" },
  },
});
assert(["lands", "spells", "held-prompt"].includes(values.scenario), "Unknown scenario");
const timeoutMs = Number(values.timeout);
assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "Invalid timeout");
const api = await import(
  values.engine ? pathToFileURL(resolve(values.engine, "node.js")).href : "@manabrew/forge-wasm"
);
const cards =
  values.scenario === "spells"
    ? [
        { name: "Mountain", count: 52 },
        { name: "Shock", count: 4 },
        { name: "Raging Goblin", count: 4 },
      ]
    : [{ name: "Mountain", count: 60 }];
const deck = { format: "constructed", cards };
const states = new Map();
const promptTypes = {};
const routedSeats = new Set();
const terminalSeats = new Set();
const attempts = new Set();
let firstActivePlayer = null;
let visibleHandChecks = 0;
let promptsAnswered = 0;
let settled = false;
let resolveGame;
let rejectGame;
const completion = new Promise((resolve, reject) => {
  resolveGame = resolve;
  rejectGame = reject;
});

function fail(error) {
  if (settled) return;
  settled = true;
  rejectGame(error instanceof Error ? error : new Error(JSON.stringify(error)));
}

function reply(prompt, view) {
  const input = prompt.input;
  switch (input.type) {
    case "diceRolled":
      return { type: "diceRolledAcknowledged" };
    case "mulligan":
      return { type: "mulliganDecision", keep: true };
    case "chooseAction": {
      const offered = input.actions.filter((a) => a.type === "cast");
      const visibleCards = view.zones.flatMap((z) =>
        z.cards.filter((c) => c.visibility === "visible"),
      );
      const lands = new Set(visibleCards.filter((c) => c.types.includes("Land")).map((c) => c.id));
      const key = (a) => `${prompt.decidingPlayerId}:${view.turn}:${a.cardId}`;
      const action =
        offered.find((a) => lands.has(a.cardId)) ?? offered.find((a) => !attempts.has(key(a)));
      if (action) attempts.add(key(action));
      return action ? { type: "act", actionId: action.id } : { type: "pass" };
    }
    case "payManaCost": {
      if (input.canConfirmFromPool) return { type: "pay", auto: false };
      const action = input.actions.find((a) => a.type === "activateManaAbility");
      return action ? { type: "act", actionId: action.id } : { type: "cancel" };
    }
    case "chooseBoardTargets": {
      assert.equal(input.minTargets, 1);
      assert.equal(input.maxTargets, 1);
      const target = input.candidates.find(
        (c) => c.kind === "player" && c.id !== prompt.decidingPlayerId,
      );
      assert(target, "Fixture expected an opponent target for Shock");
      return { type: "boardTargets", chosen: [target] };
    }
    case "chooseAttackers":
      return {
        type: "declareAttackers",
        assignments: input.attackers.map((a) => ({
          attackerId: a.attackerId,
          targetId: a.validTargetIds[0],
        })),
      };
    case "chooseBlockers":
      return { type: "declareBlockers", assignments: [] };
    case "chooseCards":
      return {
        type: "chooseCardsDecision",
        chosenCardIds: input.cards.slice(0, input.min).map((c) => c.id),
      };
    case "chooseFromSelection":
      throw new Error(`Unexpected selection in fixture at turn ${view.turn}`);
    default:
      throw new Error(`Unsupported fixture prompt: ${input.type}`);
  }
}

const engine = new api.ForgeEngine({
  onState(state, slot) {
    if (settled) return;
    try {
      const seat = slot ?? "player-0";
      const view = state.gameView;
      states.set(seat, view);
      if (view.turn > 0 && firstActivePlayer === null) firstActivePlayer = view.activePlayerId;
      for (const zone of view.zones.filter((z) => z.zone === "hand")) {
        if (zone.ownerId === seat) {
          assert.equal(zone.cards.length, zone.count);
        } else {
          assert.equal(zone.cards.length, 0, "Fixture leaked the other seat's hand");
        }
        visibleHandChecks++;
      }
      if (view.gameOver) terminalSeats.add(seat);
      if (terminalSeats.size === 2) {
        const other = states.get(seat === "player-0" ? "player-1" : "player-0");
        assert.equal(view.winnerId, other.winnerId);
        assert(["player-0", "player-1"].includes(view.winnerId));
        settled = true;
        resolveGame({
          winner: view.winnerId,
          turn: view.turn,
          phase: view.step,
          life: view.players.map((p) => ({ seat: p.id, life: p.life })),
        });
      }
    } catch (error) {
      fail(error);
    }
  },
  onPrompt(prompt, slot) {
    if (settled) return;
    try {
      const seat = slot ?? "player-0";
      assert.equal(prompt.decidingPlayerId, seat);
      routedSeats.add(seat);
      const type = prompt.input.type;
      promptTypes[type] = (promptTypes[type] ?? 0) + 1;
      if (type === "gameOver" || values.scenario === "held-prompt") return;
      assert(promptsAnswered < 10000, "Fixture exceeded prompt budget");
      const view = states.get(seat);
      assert(view, "Prompt arrived without this seat's state");
      engine.respond(prompt.promptId, { type, output: reply(prompt, view) }, slot);
      promptsAnswered++;
    } catch (error) {
      fail(error);
    }
  },
  onError: fail,
  onEvent(event, payload) {
    if (event === "forge:log") process.stderr.write(`${payload.text}\n`);
    if (event === "game:forced_end") fail(new Error(`Forge forced end: ${payload.reason}`));
  },
});
const timer = setTimeout(() => fail(new Error("Forge probe timed out")), timeoutMs);
const stop = () => fail(new Error("Forge probe interrupted"));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const launch = (async () => {
  await engine.init();
  if (settled) return;
  await engine.startMultiplayerGame({
    decks: [deck, deck],
    playerNames: ["p0", "p1"],
    enginePlayerIndex: 0,
  });
})();
launch.catch(fail);
try {
  const terminal = await completion;
  process.stdout.write(
    `${JSON.stringify({
      purpose: "Forge-WASM public API investigation; not SpellBench conformance",
      version: api.VERSION,
      buildCommit: api.BUILD_COMMIT,
      scenario: values.scenario,
      routedSeats: [...routedSeats].sort(),
      visibleHandChecks,
      promptTypes,
      promptsAnswered,
      firstActivePlayer,
      terminal,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.stderr.write(`${JSON.stringify({ promptTypes, promptsAnswered })}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  engine.dispose();
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
}
