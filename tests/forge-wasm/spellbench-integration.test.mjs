import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Environment, CATALOG, FORMAT } from "../../packages/forge-spellbench/environment.mjs";
import { canonical, digest } from "../../packages/forge-spellbench/wire.mjs";
import * as api from "../../packages/forge-wasm/node.js";

function reset({
  first = "p0",
  catalog = "mixed-lands",
  opponentCatalog = catalog,
  cap = 60,
  mulligan = "none",
  secret = "ab".repeat(32),
} = {}) {
  const decks = [catalog, opponentCatalog].map((id) => CATALOG.find((d) => d.catalog_id === id));
  const names = [...new Set(decks.flatMap((d) => d.decklist.map((c) => c.name)))].sort();
  return {
    request_type: "reset",
    protocol: "spellbench/v2",
    request_id: "reset",
    game_id: "g",
    format: FORMAT,
    seats: ["p0", "p1"].map((seat, index) => ({
      seat,
      deck: { catalog_id: decks[index].catalog_id, deck_id: digest(decks[index].decklist) },
    })),
    rules: {
      opponent_decklist: "hidden",
      mulligan,
      starting_player: "host_assigned",
      starting_seat: first,
      card_name_domain: { names, domain_id: digest(names) },
      extensions: [],
      probe: false,
    },
    game_secret: secret,
    max_steps: cap,
    max_decisions: cap,
  };
}

async function play(options, policy) {
  const promptCounts = {};
  const observedApi = {
    ...api,
    ForgeEngine: class extends api.ForgeEngine {
      constructor(config) {
        super({
          ...config,
          onPrompt: (p, slot) => {
            promptCounts[p.input.type] = (promptCounts[p.input.type] ?? 0) + 1;
            config.onPrompt(p, slot);
          },
        });
      }
    },
  };
  const env = new Environment(observedApi, {
    timeoutMs: 30000,
    log: (text) => {
      if (text.includes("halted")) console.error(text);
    },
  });
  const hash = createHash("sha256");
  const counts = {},
    firstIds = {},
    newIds = {};
  let firstActive = null;
  try {
    let result = await env.handle(reset(options));
    while (result.response_type === "decision") {
      hash.update(canonical(result));
      const d = result.seat_decision,
        o = d.observation,
        seat = d.acting_seat;
      assert.equal(o.players[seat === "p0" ? 1 : 0].hand, null);
      assert(!JSON.stringify(d).includes("player-"));
      const own = o.players.find((p) => p.seat === seat);
      assert.equal(own.hand.length, own.hand_count);
      const kind = d.candidates[0].semantic.kind;
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (kind === "mulligan") {
        if (own.mulligans_taken === 0) firstIds[seat] = own.hand.map((c) => c.object_id);
        else newIds[seat] = own.hand.map((c) => c.object_id);
      }
      if (o.turn > 0 && firstActive === null) firstActive = o.active_seat;
      const c = policy(d);
      result = await env.handle({
        request_type: "step",
        protocol: "spellbench/v2",
        request_id: `s${result.step}`,
        game_id: "g",
        expected_step: result.step,
        selection: { candidate_id: c.candidate_id, semantic_echo: c.semantic },
      });
    }
    assert.equal(result.response_type, "terminal", JSON.stringify(result));
    assert.notEqual(result.classification, "halted", JSON.stringify(result));
    return {
      result,
      hash: hash.digest("hex"),
      counts,
      firstActive,
      firstIds,
      newIds,
      finalLife: [...env.game.states.values()][0].players.map((p) => p.life),
      promptCounts,
    };
  } finally {
    env.close();
  }
}

const policy = (d) =>
  d.candidates.find(
    (c) => c.semantic.kind === "mulligan" && c.semantic.keep === c.semantic.mulligans_taken >= 2,
  ) ??
  d.candidates.find((c) => c.semantic.kind === "play_land") ??
  d.candidates[0];

const burnPolicy = (d) =>
  d.candidates.find((c) => c.semantic.kind === "play_land") ??
  d.candidates.find((c) => c.semantic.kind === "cast_spell") ??
  d.candidates.find(
    (c) => c.semantic.kind === "choose_target" && c.semantic.target.player !== d.acting_seat,
  ) ??
  d.candidates.find(
    (c) => c.semantic.kind === "select_object" && c.semantic.choice.object.card_name === "Mountain",
  ) ??
  d.candidates[0];

const combatPolicy = (d) =>
  d.candidates.find((c) => c.semantic.kind === "declare_attack" && c.semantic.defender) ??
  d.candidates.find((c) => c.semantic.kind === "declare_block" && c.semantic.attacker) ??
  burnPolicy(d);

test(
  "unequal combat decks replay with London mulligans and p1 starting",
  { timeout: 120000 },
  async () => {
    const choose = (d) =>
      d.candidates[0].semantic.kind === "mulligan" ? policy(d) : combatPolicy(d);
    const options = {
      catalog: "red-combat",
      opponentCatalog: "green-combat",
      first: "p1",
      mulligan: "london",
      cap: 160,
    };
    const a = await play(options, choose),
      b = await play(options, choose);
    assert.equal(a.firstActive, "p1");
    assert(a.counts.mulligan > 0 && a.counts.order_pick > 0 && a.counts.declare_attack > 0);
    assert.equal(a.hash, b.hash);
    assert.deepEqual(a.result, b.result);
  },
);

test(
  "London supports two mulligans with fresh hand references and ordered bottoming",
  { timeout: 90000 },
  async () => {
    const bottom = { p0: [], p1: [] };
    const game = await play({ mulligan: "london", cap: 40 }, (d) => {
      if (d.candidates[0].semantic.kind === "order_pick") {
        assert.equal(d.group.substep_count, 2);
        bottom[d.acting_seat].push(d.candidates[0].semantic.item.object.object_id);
      }
      if (d.observation.turn === 1 && d.acting_seat === "p0") {
        assert.equal(d.observation.players[0].mulligans_taken, 2);
        assert(d.observation.players[0].hand_count <= 5);
      }
      return policy(d);
    });
    assert.equal(game.result.classification, "truncated");
    for (const seat of ["p0", "p1"]) {
      assert.equal(bottom[seat].length, 2);
      assert(game.firstIds[seat].every((id) => !game.newIds[seat].includes(id)));
    }
  },
);

test(
  "London reaches zero cards after seven mulligans without offering an eighth",
  { timeout: 90000 },
  async () => {
    let offered = 0,
      bottomed = 0,
      firstHand = null;
    await play({ mulligan: "london", cap: 35 }, (d) => {
      const kind = d.candidates[0].semantic.kind;
      if (kind === "mulligan") {
        if (d.acting_seat === "p0") {
          offered++;
          assert(d.candidates[0].semantic.mulligans_taken < 7);
        }
        return d.candidates.find((c) => c.semantic.keep === (d.acting_seat === "p1"));
      }
      if (kind === "order_pick") {
        assert.equal(d.acting_seat, "p0");
        assert.equal(d.group.substep_count, 7);
        bottomed++;
      }
      if (d.observation.turn === 1 && d.acting_seat === "p0" && firstHand === null) {
        firstHand = d.observation.players[0].hand_count;
        assert.equal(d.observation.players[0].mulligans_taken, 7);
      }
      return d.candidates[0];
    });
    assert.equal(offered, 7);
    assert.equal(bottomed, 7);
    assert.equal(firstHand, 0);
  },
);

test(
  "creature games expose haste before sickness, combat groups and Forge damage defaults",
  { timeout: 180000 },
  async () => {
    let haste = false,
      attacking = false,
      blocking = false,
      grouped = false,
      creatureTarget = false;
    const game = await play({ catalog: "red-combat", cap: 10000 }, (d) => {
      const o = d.observation;
      grouped ||= d.group.substep_count > 1 && d.candidates[0].semantic.kind.startsWith("declare_");
      for (const p of o.players)
        for (const c of p.battlefield) {
          attacking ||= c.permanent.attacking;
          blocking ||= c.permanent.blocking;
          if (c.permanent.attacking) assert(c.permanent.attack_target?.player);
        }
      const attack = d.candidates.find(
        (c) =>
          c.semantic.kind === "declare_attack" &&
          c.semantic.defender &&
          c.semantic.attacker.card_name === "Raging Goblin",
      );
      if (attack)
        haste ||= o.players
          .flatMap((p) => p.battlefield)
          .find((c) => c.object_id === attack.semantic.attacker.object_id).permanent.summoning_sick;
      const target = d.candidates.find(
        (c) =>
          c.semantic.kind === "choose_target" &&
          c.semantic.target.object?.controller_seat !== d.acting_seat &&
          c.semantic.target.object?.zone === "battlefield",
      );
      if (target) {
        creatureTarget = true;
        return target;
      }
      return combatPolicy(d);
    });
    assert.equal(game.result.classification, "natural");
    assert(haste && attacking && blocking && grouped && creatureTarget);
    assert(game.promptCounts.chooseAttackers > 0 && game.promptCounts.chooseBlockers > 0);
  },
);

test(
  "green combat completes with multiple blockers using engine damage assignment",
  { timeout: 180000 },
  async () => {
    const game = await play({ catalog: "green-combat", cap: 10000 }, (d) => {
      if (d.acting_seat === "p1" && d.candidates[0].semantic.kind === "declare_attack")
        return d.candidates[0];
      return combatPolicy(d);
    });
    assert.equal(game.result.classification, "natural");
    assert(game.promptCounts.chooseCombatDamageAssignment > 0);
    assert(game.finalLife.some((life) => life <= 0));
  },
);

test(
  "burn spells replay through targets, Forge autopay and stack resolution to a damage win",
  { timeout: 240000 },
  async () => {
    let targets = 0,
      stacks = 0,
      damaged = false;
    const check = (d) => {
      const o = d.observation;
      damaged ||= o.players.some((p) => p.life < 20);
      for (const s of o.stack) {
        stacks++;
        assert.equal(s.stack_kind, "spell");
        assert.deepEqual(s.characteristics.colors, ["red"]);
        assert.equal(s.modes, null);
        assert.equal(s.x_value, null);
      }
      if (d.candidates[0].semantic.kind === "choose_target") {
        targets++;
        assert(o.stack.some((s) => s.object_id === d.context.source.object_id));
        for (const c of d.candidates) {
          assert.equal(c.semantic.slot, 0);
          assert.equal(c.semantic.source.object_id, d.context.source.object_id);
          assert(["p0", "p1"].includes(c.semantic.target.player));
        }
      }
      return burnPolicy(d);
    };
    const options = { catalog: "red-burn", cap: 10000 };
    const a = await play(options, check);
    const b = await play(options, burnPolicy);
    assert.equal(a.result.classification, "natural");
    assert(a.result.winner);
    assert(a.finalLife.some((life) => life <= 0));
    assert(targets >= 7);
    assert(stacks > targets);
    assert(damaged);
    assert(a.result.step_count < 1000);
    assert.equal(a.hash, b.hash);
    assert.deepEqual(a.result, b.result);
  },
);

test("mixed decks replay exactly and p1 can start", { timeout: 120000 }, async () => {
  const a = await play({ first: "p1" }, policy);
  const b = await play({ first: "p1" }, policy);
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.result, b.result);
  assert.equal(a.result.classification, "truncated");
  assert.equal(a.firstActive, "p1");
  assert(a.counts.pass > 0);
});

async function rawCatalogGame(catalog) {
  let engine, timer;
  const states = new Map(),
    trace = [];
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("raw burn game timeout")), 120000);
      engine = new api.ForgeEngine({
        onState: (s, slot) => states.set(slot ?? "player-0", s.gameView),
        onError: reject,
        onPrompt: (prompt, slot) => {
          try {
            const v = states.get(slot ?? "player-0"),
              input = prompt.input;
            if (v.gameOver)
              return resolve({ trace, winner: v.winnerId, life: v.players.map((p) => p.life) });
            let output;
            switch (input.type) {
              case "mulligan":
                output = { type: "mulliganDecision", keep: true };
                break;
              case "chooseAction": {
                const zones = (zone, seat) =>
                  v.zones
                    .filter((z) => z.zone === zone)
                    .flatMap((z) => z.cards)
                    .filter((c) => (zone === "battlefield" ? c.controllerId : c.ownerId) === seat);
                trace.push({
                  turn: v.turn,
                  seat: prompt.decidingPlayerId.slice(-1),
                  life: v.players.map((p) => p.life),
                  mana: v.players.map((p) => p.manaPool),
                  hand: zones("hand", prompt.decidingPlayerId).map((c) => c.identity.name),
                  battlefield: ["player-0", "player-1"].map((s) =>
                    zones("battlefield", s).map((c) => [
                      c.identity.name,
                      c.tapped,
                      c.firstTurnControlled,
                      c.isAttacking ?? false,
                      c.isBlocking,
                      c.damage,
                    ]),
                  ),
                  graveyard: ["player-0", "player-1"].map((s) =>
                    zones("graveyard", s).map((c) => c.identity.name),
                  ),
                  stack: v.stack.map((s) => [
                    s.identity.name,
                    s.targets.map((t) => t.id.slice(-1)),
                  ]),
                });
                const lands = new Set(
                  zones("hand", prompt.decidingPlayerId)
                    .filter((c) => c.types.includes("Land"))
                    .map((c) => c.id),
                );
                const casts = input.actions.filter((a) => a.type === "cast");
                const action = casts.find((a) => lands.has(a.cardId)) ?? casts[0];
                output = action
                  ? { type: "act", actionId: action.id }
                  : { type: "pass", exhaustStack: false };
                break;
              }
              case "chooseBoardTargets":
                output = {
                  type: "boardTargets",
                  chosen: [
                    input.candidates.find(
                      (c) => c.kind === "player" && c.id !== prompt.decidingPlayerId,
                    ),
                  ],
                };
                break;
              case "payManaCost":
                output = { type: "pay", auto: !input.canConfirmFromPool };
                break;
              case "chooseAttackers":
                output = {
                  type: "declareAttackers",
                  assignments:
                    prompt.decidingPlayerId === "player-0"
                      ? input.attackers.map((a) => ({
                          attackerId: a.attackerId,
                          targetId: a.validTargetIds[0],
                        }))
                      : [],
                };
                break;
              case "chooseBlockers":
                output = {
                  type: "declareBlockers",
                  assignments: input.availableBlockerIds.flatMap((blockerId) => {
                    const a = input.attackers.find((a) => a.validBlockerIds.includes(blockerId));
                    return a ? [{ blockerId, attackerId: a.attackerId }] : [];
                  }),
                };
                break;
              case "chooseDamageAssignmentOrder":
                output = {
                  type: "damageAssignmentOrderDecision",
                  orderedBlockerIds: input.blockerIds,
                };
                break;
              case "chooseCombatDamageAssignment":
                output = { type: "combatDamageAssignmentDecision", assignments: [] };
                break;
              case "chooseCards": {
                const sorted = [...input.cards].sort(
                  (a, b) =>
                    Number(b.identity.name === "Mountain") - Number(a.identity.name === "Mountain"),
                );
                output = {
                  type: "chooseCardsDecision",
                  chosenCardIds: sorted.slice(0, input.min).map((c) => c.id),
                };
                break;
              }
              default:
                throw new Error(`Unexpected raw prompt ${input.type}`);
            }
            engine.respond(prompt.promptId, { type: input.type, output }, slot);
          } catch (error) {
            reject(error);
          }
        },
      });
      engine
        .startMultiplayerGame({
          decks: [0, 1].map(() => ({
            format: "constructed",
            cards: CATALOG.find((d) => d.catalog_id === catalog).decklist,
          })),
          playerNames: ["p0", "p1"],
          enginePlayerIndex: 0,
          startingPlayerIndex: 0,
          randomSeed: "ab".repeat(32),
          snapshotRecording: false,
        })
        .catch(reject);
    });
  } finally {
    clearTimeout(timer);
    engine?.dispose();
  }
}

for (const catalog of ["red-burn", "green-combat"])
  test(
    `${catalog} preserves the public Forge API's complete game trace and outcome`,
    { timeout: 180000 },
    async () => {
      const trace = [];
      const adapted = await play({ catalog, cap: 10000 }, (d) => {
        if (d.context.kind === "priority") {
          const o = d.observation;
          trace.push({
            turn: o.turn,
            seat: d.acting_seat.slice(-1),
            life: o.players.map((p) => p.life),
            mana: o.players.map((p) => p.mana_pool),
            hand: o.players.find((p) => p.seat === d.acting_seat).hand.map((c) => c.card_name),
            battlefield: o.players.map((p) =>
              p.battlefield.map((c) => [
                c.card_name,
                c.permanent.tapped,
                c.permanent.summoning_sick,
                c.permanent.attacking,
                c.permanent.blocking,
                c.permanent.damage,
              ]),
            ),
            graveyard: o.players.map((p) => p.graveyard.map((c) => c.card_name)),
            stack: o.stack.map((s) => [s.card_name, s.targets.map((t) => t.player.slice(-1))]),
          });
        }
        if (d.acting_seat === "p1" && d.candidates[0].semantic.kind === "declare_attack")
          return d.candidates[0];
        return combatPolicy(d);
      });
      const raw = await rawCatalogGame(catalog);
      assert(trace.length > 50);
      assert.deepEqual(trace, raw.trace);
      assert.equal(adapted.result.winner, `p${raw.winner.slice(-1)}`);
      assert.deepEqual(adapted.finalLife, raw.life);
    },
  );

test(
  "a complete all-land game ends naturally with the host-assigned starting seat winning on deck exhaustion",
  { timeout: 180000 },
  async () => {
    const game = await play(
      { first: "p1", catalog: "mountains", cap: 10000, mulligan: "none" },
      (d) => d.candidates[0],
    );
    assert.equal(game.result.classification, "natural");
    assert.equal(game.result.outcome, "p1_win");
    assert.equal(game.result.winner, "p1");
    assert.equal(game.firstActive, "p1");
    assert(game.counts.select_object > 0);
    assert(game.result.step_count > 1000);
  },
);

async function rawOpening(opponentCount) {
  let engine;
  const states = new Map(),
    hands = {};
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("opening timeout")), 30000);
      engine = new api.ForgeEngine({
        onState: (s, slot) => states.set(slot ?? "player-0", s.gameView),
        onError: reject,
        onPrompt: (prompt, slot) => {
          try {
            assert.equal(prompt.input.type, "mulligan");
            const seat = slot ?? "player-0";
            hands[seat] = states
              .get(seat)
              .zones.find((z) => z.zone === "hand" && z.ownerId === seat)
              .cards.map((c) => c.identity.name);
            if (Object.keys(hands).length === 2) resolve(hands);
            else
              engine.respond(
                prompt.promptId,
                { type: "mulligan", output: { type: "mulliganDecision", keep: true } },
                slot,
              );
          } catch (error) {
            reject(error);
          }
        },
      });
      engine
        .startMultiplayerGame({
          decks: [
            { format: "constructed", cards: [{ name: "Mountain", count: opponentCount }] },
            { format: "constructed", cards: CATALOG[2].decklist },
          ],
          playerNames: ["p0", "p1"],
          enginePlayerIndex: 0,
          startingPlayerIndex: 0,
          randomSeed: "ab".repeat(32),
          snapshotRecording: false,
        })
        .catch(reject);
    });
  } finally {
    clearTimeout(timer);
    engine?.dispose();
  }
}

test(
  "the public API's p1 opening hand is independent of the other seat's library size",
  { timeout: 90000 },
  async () => {
    const a = await rawOpening(60);
    const b = await rawOpening(61);
    assert.deepEqual(a["player-1"], b["player-1"]);
    const env = new Environment(api);
    try {
      let r = await env.handle(reset());
      while (r.response_type === "decision" && r.seat_decision.acting_seat !== "p1") {
        const c = r.seat_decision.candidates[0];
        r = await env.handle({
          request_type: "step",
          protocol: "spellbench/v2",
          request_id: `s${r.step}`,
          game_id: "g",
          expected_step: r.step,
          selection: { candidate_id: c.candidate_id, semantic_echo: c.semantic },
        });
      }
      assert.equal(r.response_type, "decision");
      assert.deepEqual(
        r.seat_decision.observation.players[1].hand.map((c) => c.card_name),
        a["player-1"],
      );
    } finally {
      env.close();
    }
  },
);

test(
  "CLI stdout is NDJSON and EOF or SIGTERM releases a worker held at a decision",
  { timeout: 90000 },
  async () => {
    for (const signal of [null, "SIGTERM"]) {
      const child = spawn(
        process.execPath,
        ["packages/forge-spellbench/cli.mjs", "--experimental", "--engine", "packages/forge-wasm"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stderr.resume();
      const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const exit = once(child, "exit");
      const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
      try {
        child.stdin.write(`${JSON.stringify(requestHello())}\n`);
        assert.equal(JSON.parse((await output.next()).value).response_type, "hello_ok");
        child.stdin.write(`${JSON.stringify(reset())}\n`);
        assert.equal(JSON.parse((await output.next()).value).response_type, "decision");
        if (signal) child.kill(signal);
        else child.stdin.end();
        const [code, killedBy] = await exit;
        assert.equal(code, 0);
        assert.equal(killedBy, null);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }
  },
);

const requestHello = () => ({
  request_type: "hello",
  protocol: "spellbench/v2",
  request_id: "hello",
  protocol_minor: 0,
});

test("invalid deterministic options fail before loading Forge", { timeout: 10000 }, async () => {
  const engine = new api.ForgeEngine();
  const deck = { cards: [{ name: "Mountain", count: 60 }] };
  const options = { decks: [deck, deck], playerNames: ["p0", "p1"], enginePlayerIndex: 0 };
  try {
    await assert.rejects(
      engine.startMultiplayerGame({ ...options, randomSeed: "bad" }),
      /randomSeed/,
    );
    await assert.rejects(
      engine.startMultiplayerGame({ ...options, startingPlayerIndex: 2 }),
      /startingPlayerIndex/,
    );
    await assert.rejects(
      engine.startMultiplayerGame({ ...options, startingPlayerIndex: 0, forgeAiSeats: [1] }),
      /externally controlled/,
    );
  } finally {
    engine.dispose();
  }
});

test("EOF during startup cannot leave a new worker behind", { timeout: 15000 }, async () => {
  const child = spawn(
    process.execPath,
    ["packages/forge-spellbench/cli.mjs", "--experimental", "--engine", "packages/forge-wasm"],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  const exit = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    child.stdin.end(`${JSON.stringify(reset())}\n`);
    const [code, signal] = await exit;
    assert.equal(code, 0);
    assert.equal(signal, null);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
