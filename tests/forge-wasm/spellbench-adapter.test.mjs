import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import {
  canonical,
  digest,
  lines,
  MAX_LINE,
  parseLine,
  validateRequest,
} from "../../packages/forge-spellbench/wire.mjs";
import {
  Environment,
  CATALOG,
  FORMAT,
  LAND_FORMAT,
} from "../../packages/forge-spellbench/environment.mjs";
import { Observer } from "../../packages/forge-spellbench/observation.mjs";
import { PromptDecision } from "../../packages/forge-spellbench/candidates.mjs";
import { ForgeEngine } from "../../packages/forge-wasm/engine.js";

const request = (request_type, fields = {}) => ({
  request_type,
  protocol: "spellbench/v2",
  request_id: "r",
  ...fields,
});
const reset = (fields = {}) =>
  request("reset", {
    game_id: "g",
    format: FORMAT,
    seats: ["p0", "p1"].map((seat) => ({
      seat,
      deck: { catalog_id: "mountains", deck_id: digest(CATALOG[0].decklist) },
    })),
    rules: {
      opponent_decklist: "hidden",
      mulligan: "none",
      starting_player: "host_assigned",
      starting_seat: "p0",
      card_name_domain: { names: ["Mountain"], domain_id: digest(["Mountain"]) },
      extensions: [],
      probe: false,
    },
    game_secret: "ab".repeat(32),
    max_steps: 10,
    max_decisions: 10,
    ...fields,
  });
const card = (id, ownerId = "player-0") => ({
  visibility: "visible",
  id,
  identity: { name: "Mountain", isToken: false },
  ownerId,
  controllerId: ownerId,
  types: ["Land"],
  supertypes: ["Basic"],
  subtypes: ["Mountain"],
  cmc: 0,
  color: "",
  counters: {},
  isFaceDown: false,
  isCopy: false,
  tapped: false,
  summoningSick: true,
  damage: 0,
  phasedOut: false,
});
function view() {
  return {
    turn: 1,
    step: "main1",
    activePlayerId: "player-0",
    priorityPlayerId: "player-0",
    stack: [],
    combatAssignments: [],
    gameOver: false,
    players: ["player-0", "player-1"].map((id) => ({
      id,
      life: 20,
      landsPlayedThisTurn: 0,
      manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    })),
    zones: ["player-0", "player-1"].flatMap((ownerId) =>
      ["hand", "library", "graveyard", "battlefield", "exile", "command"].map((zone) => ({
        ownerId,
        zone,
        cards: zone === "hand" ? [card(`${ownerId}-card`, ownerId)] : [],
        count: zone === "library" ? 59 : zone === "hand" ? 1 : 0,
      })),
    ),
  };
}

test("strict JSON rejects ambiguous numbers, duplicates, malformed Unicode and excessive depth", () => {
  for (const line of [
    '{"a":1,"a":2}',
    '{"a":1e0}',
    '{"a":0.1}',
    '{"a":9007199254740992}',
    '"\\ud800"',
    '"\\udc00"',
    "[".repeat(65) + "0" + "]".repeat(65),
    '{"a":01}',
    "true false",
    '"a\n"',
  ]) {
    assert.throws(() => parseLine(Buffer.from(line)), { code: "malformed_json" }, line);
  }
  assert.throws(() => parseLine(Buffer.from([0xff])), { code: "malformed_json" });
  assert.equal(parseLine(Buffer.from('"\\ud83d\\ude00"')), "😀");
  assert.equal(parseLine(Buffer.from('"a\\\"b"')), 'a"b');
  assert.equal(canonical(parseLine(Buffer.from('{"z":-1,"a":2}\r'))), '{"a":2,"z":-1}');
  assert.throws(() => validateRequest(parseLine(Buffer.from("[]"))), { code: "malformed_request" });
});

test("framer drains an oversized line and accepts the following CRLF request", async () => {
  const input = Readable.from([Buffer.alloc(MAX_LINE, 32), Buffer.from('x\n{"a":1}\r\n')]);
  const output = [];
  for await (const line of lines(input)) output.push(line);
  assert.equal(output[0], null);
  assert.equal(canonical(parseLine(output[1])), '{"a":1}');
});

test("observations isolate hands and allocate fresh per-viewer identities across zone changes and shuffles", () => {
  const observer = new Observer("ab".repeat(32));
  const v = view(),
    m = { p0: 0, p1: 0 };
  const first = observer.project(v, "p0", m, true);
  assert.equal(first.observation.players[1].hand, null);
  assert(!first.refs.has("player-1-card"));
  const id = first.refs.get("player-0-card").object_id;
  assert.equal(observer.project(v, "p0", m, true).refs.get("player-0-card").object_id, id);
  const hand = v.zones.find((z) => z.ownerId === "player-0" && z.zone === "hand");
  const field = v.zones.find((z) => z.ownerId === "player-0" && z.zone === "battlefield");
  field.cards = hand.cards;
  hand.cards = [];
  hand.count = 0;
  const publicId = observer.project(v, "p0", m, true).refs.get("player-0-card").object_id;
  assert.notEqual(publicId, id);
  assert.notEqual(observer.project(v, "p1", m, true).refs.get("player-0-card").object_id, publicId);
  const hand1 = observer.project(v, "p1", m, true).refs.get("player-1-card").object_id;
  observer.forgetHand("p1");
  assert.notEqual(observer.project(v, "p1", m, true).refs.get("player-1-card").object_id, hand1);
  assert(!JSON.stringify(first.observation).includes("player-0-card"));
});

test("graveyard order is oldest first, matching Forge's append order", () => {
  const v = view();
  v.zones.find((z) => z.zone === "graveyard" && z.ownerId === "player-0").cards = [
    card("old"),
    card("new"),
  ];
  const { refs, observation } = new Observer("00".repeat(32)).project(
    v,
    "p0",
    { p0: 0, p1: 0 },
    true,
  );
  assert.deepEqual(
    observation.players[0].graveyard.map((c) => c.object_id),
    [refs.get("old").object_id, refs.get("new").object_id],
  );
});

test("fixed-count cleanup selections and London bottoming preserve order without duplicate candidates", () => {
  const refs = new Map(["a", "b", "c"].map((id) => [id, { object_id: id }]));
  for (const type of ["chooseCards", "mulliganPutBack"]) {
    const d = new PromptDecision(
      { input: { type, min: 2, max: 2, count: 2, cards: [...refs.keys()].map((id) => ({ id })) } },
      { step: "cleanup" },
      refs,
    );
    assert.equal(d.count, 2);
    assert.equal(d.candidates().length, 3);
    assert.equal(d.accept(1), null);
    assert.equal(d.candidates().length, 2);
    const output = d.accept(0);
    assert.deepEqual(output.chosenCardIds ?? output.cardIds, ["b", "a"]);
    assert.equal(
      output.type,
      type === "chooseCards" ? "chooseCardsDecision" : "mulliganPutBackDecision",
    );
  }
});

function fakeApi(mode = "normal") {
  const instances = [];
  class Engine {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.responses = [];
      instances.push(this);
    }
    async init() {}
    async startMultiplayerGame(options) {
      this.options = options;
      if (mode === "stall") return;
      this.emit();
    }
    emit() {
      const v = view();
      if ((mode === "payment" && this.responses.length < 2) || mode === "payment-stall") {
        this.callbacks.onState({ gameView: v });
        this.callbacks.onPrompt({
          promptId: this.responses.length + 1,
          decidingPlayerId: "player-0",
          input: {
            type: "payManaCost",
            cardId: "spell",
            cardName: "Shock",
            canConfirmFromPool: mode === "payment" && this.responses.length === 1,
            actions: [],
          },
        });
        return;
      }
      if (mode === "group") {
        v.step = "cleanup";
        const hand = v.zones.find((z) => z.zone === "hand" && z.ownerId === "player-0");
        hand.cards = [card("a"), card("b")];
        hand.count = 2;
        this.callbacks.onState({ gameView: v });
        this.callbacks.onPrompt({
          promptId: 1,
          decidingPlayerId: "player-0",
          input: { type: "chooseCards", min: 2, max: 2, cards: [card("a"), card("b")] },
        });
      } else {
        this.callbacks.onState({ gameView: v });
        this.callbacks.onPrompt({
          promptId: 1,
          decidingPlayerId: "player-0",
          input: {
            type: "chooseAction",
            actions: [
              { id: "land", type: "cast", cardId: "player-0-card", mode: { type: "normal" } },
            ],
          },
        });
      }
    }
    respond(id, action) {
      this.responses.push(action);
      this.emit();
    }
    dispose() {
      this.disposed = true;
    }
  }
  return { ForgeEngine: Engine, VERSION: "fixture", BUILD_COMMIT: "fixture", instances };
}
const step = (r, fields = {}) =>
  request("step", {
    request_id: "step",
    game_id: "g",
    expected_step: r.step,
    selection: { candidate_id: 0, semantic_echo: r.seat_decision.candidates[0].semantic },
    ...fields,
  });

test("invalid actions leave the pending decision intact; retransmissions never repeat an engine response", async () => {
  const api = fakeApi(),
    env = new Environment(api);
  try {
    const r = await env.handle(reset());
    assert.equal(r.response_type, "decision");
    assert.equal(api.instances[0].options.startingPlayerIndex, 0);
    assert.equal(api.instances[0].options.randomSeed, "ab".repeat(32));
    assert.equal(
      (await env.handle(step(r, { game_id: "wrong", expected_step: 9 }))).error.code,
      "game_id_mismatch",
    );
    assert.equal(
      (await env.handle(step(r, { request_id: "bad-step", expected_step: 9 }))).error.code,
      "expected_step_mismatch",
    );
    assert.equal(
      (
        await env.handle(
          step(r, { request_id: "bad-id", selection: { candidate_id: 999, semantic_echo: {} } }),
        )
      ).error.code,
      "candidate_id_out_of_range",
    );
    assert.equal(
      (
        await env.handle(
          step(r, { request_id: "bad-echo", selection: { candidate_id: 0, semantic_echo: {} } }),
        )
      ).error.code,
      "semantic_echo_mismatch",
    );
    const good = step(r, { request_id: "good" });
    const next = await env.handle(good);
    assert.equal(next.step, 1);
    assert.deepEqual(await env.handle(good), next);
    assert.deepEqual(await env.handle(reset()), r);
    assert.equal(api.instances[0].responses.length, 1);
    assert.equal(
      (await env.handle({ ...good, expected_step: 1 })).error.code,
      "request_id_reuse_mismatch",
    );
    assert.equal(
      (await env.handle(reset({ request_id: "another", game_id: "another" }))).error.code,
      "game_already_active",
    );
  } finally {
    env.close();
  }
  assert(api.instances[0].disposed);
});

test("schema failures are never cached and deck refusals never start a worker", async () => {
  const api = fakeApi(),
    env = new Environment(api);
  assert.equal(
    (await env.handle(request("hello", { protocol_minor: 0, extra: 1 }))).error.code,
    "malformed_request",
  );
  assert.equal(
    (await env.handle(request("hello", { protocol_minor: 0 }))).response_type,
    "hello_ok",
  );
  const r = reset({ request_id: "reset" });
  r.seats[1].deck.catalog_id = "unsupported";
  assert.equal((await env.handle(r)).error.code, "unsupported_deck");
  assert.equal(api.instances.length, 0);
});

test("timeouts and engine errors halt and dispose; terminal and fresh reset lifecycle is explicit", async () => {
  const api = fakeApi("stall"),
    env = new Environment(api, { timeoutMs: 10 });
  const r = await env.handle(reset());
  assert.equal(r.classification, "halted");
  assert.match(r.reason, /^engine_contract_failure:/);
  assert(api.instances[0].disposed);
  const s = request("step", {
    request_id: "after",
    game_id: "g",
    expected_step: 0,
    selection: { candidate_id: 0, semantic_echo: {} },
  });
  assert.equal((await env.handle(s)).error.code, "game_already_terminal");
  assert.equal((await env.handle(reset({ request_id: "reuse" }))).error.code, "malformed_request");
  const next = env.handle(reset({ request_id: "new", game_id: "new" }));
  api.instances.at(-1).callbacks.onError(new Error("worker failed"));
  assert.equal((await next).classification, "halted");
  assert(api.instances.at(-1).disposed);
});

test("post-init worker failures reject commands, notify the consumer, and release seats", async () => {
  let fail,
    message,
    terminated = false,
    reported;
  const engine = new ForgeEngine(
    {
      locations: () => ({}),
      unsupported: () => null,
      spawnWorker: () => ({
        onError: (f) => {
          fail = f;
        },
        onMessage: (f) => {
          message = f;
        },
        postMessage() {},
        terminate: () => {
          terminated = true;
        },
      }),
    },
    {
      onError: (error) => {
        reported = error;
      },
    },
  );
  const init = engine.init();
  message({ type: "event", event: "worker:init", payload: { stage: "ready" } });
  await init;
  const command = engine.command("start", {});
  const error = new Error("worker crash");
  fail(error);
  await assert.rejects(command, /worker crash/);
  assert.equal(reported, error);
  assert(terminated);
});

test("a basic land's global prompt index is not its SpellBench ability index", () => {
  const d = new PromptDecision(
    {
      input: {
        type: "chooseAction",
        actions: [
          {
            type: "activateAbility",
            cardId: "land",
            id: "tap:land:7",
            abilityIndex: 7,
            isManaAbility: true,
          },
        ],
      },
    },
    {},
    new Map([["land", { object_id: "land", card_name: "Mountain" }]]),
  );
  assert.equal(d.candidates()[1].semantic.ability_index, 0);
  assert.deepEqual(d.accept(1), { type: "act", actionId: "tap:land:7" });
});

test("declared autopay floats and confirms through Forge without spending agent steps; a stalled planner halts", async () => {
  for (const mode of ["payment", "payment-stall"]) {
    const api = fakeApi(mode),
      env = new Environment(api);
    try {
      const result = await env.handle(reset());
      const engine = api.instances[0];
      assert.deepEqual(engine.responses[0].output, { type: "pay", auto: true });
      if (mode === "payment") {
        assert.equal(result.response_type, "decision");
        assert.equal(result.step, 0);
        assert.equal(engine.responses.length, 2);
        assert.deepEqual(engine.responses[1].output, { type: "pay", auto: false });
      } else {
        assert.equal(result.classification, "halted");
        assert.equal(engine.responses.length, 1);
        assert(engine.disposed);
      }
    } finally {
      env.close();
    }
  }
});

const burnCard = (id, ownerId = "player-0") => ({
  ...card(id, ownerId),
  identity: { name: "Shock", isToken: false },
  types: ["Instant"],
  supertypes: [],
  subtypes: [],
  color: "R",
  cmc: 1,
});

test("spell stack references survive announcement, change at resolution, and never reveal opposing hands", () => {
  const observer = new Observer("ab".repeat(32));
  const v = view();
  const hand = v.zones.find((z) => z.zone === "hand" && z.ownerId === "player-0");
  hand.cards = [burnCard("spell")];
  const project = () => observer.project(v, "p0", { p0: 0, p1: 0 }, true);
  const handId = project().refs.get("spell").object_id;
  hand.cards = [];
  hand.count = 0;
  v.stack = [
    {
      id: "casting-1",
      sourceId: "spell",
      controllerId: "player-0",
      ownerId: "player-0",
      isCasting: true,
      spellCard: burnCard("spell"),
      targets: [],
    },
  ];
  delete v.stack[0].spellCard.visibility;
  const casting = project();
  const stackId = casting.refs.get("spell").object_id;
  assert.notEqual(stackId, handId);
  assert.equal(casting.observation.stack[0].stack_kind, "spell");
  assert.deepEqual(casting.observation.stack[0].characteristics.colors, ["red"]);
  assert.equal(casting.observation.players[1].hand, null);
  v.stack[0].id = "engine-stack-17";
  v.stack[0].isCasting = false;
  v.stack[0].targets = [{ kind: "player", id: "player-1" }];
  assert.equal(project().refs.get("spell").object_id, stackId);
  assert.deepEqual(project().observation.stack[0].targets, [{ player: "p1" }]);
  const other = observer.project(v, "p1", { p0: 0, p1: 0 }, true);
  assert.notEqual(other.refs.get("spell").object_id, stackId);
  delete v.stack[0].spellCard;
  assert.throws(project, /Missing spell projection/);
  v.stack = [];
  const graveyard = v.zones.find((z) => z.zone === "graveyard" && z.ownerId === "player-0");
  graveyard.cards = [burnCard("spell")];
  graveyard.count = 1;
  assert.notEqual(project().refs.get("spell").object_id, stackId);
});

test("burn casts and targets echo only the offered Forge actions; unsupported target shapes halt", () => {
  const source = { object_id: "spell", card_name: "Shock", zone: "hand" };
  const refs = new Map([["native-spell", source]]);
  const cast = new PromptDecision(
    {
      input: {
        type: "chooseAction",
        actions: [
          {
            type: "cast",
            cardId: "native-spell",
            mode: { type: "normal" },
            id: "engine-action-31",
          },
        ],
      },
    },
    {},
    refs,
  );
  assert.deepEqual(cast.candidates()[1].semantic, { kind: "cast_spell", source, method: "normal" });
  assert.deepEqual(cast.accept(1), { type: "act", actionId: "engine-action-31" });
  source.zone = "stack";
  const input = {
    type: "chooseBoardTargets",
    intent: "damage",
    minTargets: 1,
    maxTargets: 1,
    chosenTargets: 0,
    candidates: [{ kind: "player", id: "player-1" }],
  };
  const make = () => new PromptDecision({ sourceCard: { id: "native-spell" }, input }, {}, refs);
  const target = make();
  assert.deepEqual(target.candidates()[0].semantic, {
    kind: "choose_target",
    source,
    slot: 0,
    target: { player: "p1" },
    selected_count: 0,
    minimum: 1,
    maximum: 1,
  });
  assert.deepEqual(target.accept(0), { type: "boardTargets", chosen: input.candidates });
  input.maxTargets = 2;
  assert.throws(make, /Unsupported target requirement/);
  input.maxTargets = 1;
  input.chosenTargets = 1;
  assert.throws(make, /Unsupported target requirement/);
});

test("the legacy land format refuses the burn catalog before launching a worker", async () => {
  const api = fakeApi();
  const env = new Environment(api);
  const deck = CATALOG.find((d) => d.catalog_id === "red-burn");
  const r = reset({
    format: LAND_FORMAT,
    seats: ["p0", "p1"].map((seat) => ({
      seat,
      deck: { catalog_id: deck.catalog_id, deck_id: digest(deck.decklist) },
    })),
  });
  assert.equal((await env.handle(r)).error.code, "unsupported_deck");
  assert.equal(api.instances.length, 0);
  assert.equal(env.hello().engine_defaults.mana_payment, "engine_autopay");
});

test("a step cap cannot split a fixed-count group", async () => {
  const api = fakeApi("group"),
    env = new Environment(api);
  try {
    const first = await env.handle(reset({ max_steps: 1 }));
    assert.equal(first.seat_decision.group.substep_count, 2);
    const second = await env.handle(step(first));
    assert.equal(second.seat_decision.group.substep_index, 1);
    assert.equal(api.instances[0].responses.length, 0);
    const last = await env.handle(step(second, { request_id: "last" }));
    assert.equal(last.classification, "truncated");
    assert.equal(last.step_count, 2);
    assert.equal(last.decision_count, 1);
    assert.equal(api.instances[0].responses.length, 1);
  } finally {
    env.close();
  }
});

test("unsupported starting-player rules are refused before a worker starts", async () => {
  const api = fakeApi(),
    env = new Environment(api);
  const r = reset();
  r.rules.starting_player = "toss_winner_chooses";
  r.rules.starting_seat = null;
  assert.equal((await env.handle(r)).error.code, "unsupported_rule");
  assert.equal(api.instances.length, 0);
});

test("card-name domain digests sort by Unicode code point, not UTF-16 code unit", () => {
  const r = reset();
  r.rules.card_name_domain = { names: ["𐀀", ""], domain_id: digest(["", "𐀀"]) };
  assert.doesNotThrow(() => validateRequest(r));
});

test("combat declarations are fixed groups with one buffered response and only Forge-offered pairings", () => {
  const refs = new Map(
    ["a", "b", "x", "y"].map((id) => [id, { object_id: id, zone: "battlefield" }]),
  );
  const attackers = new PromptDecision(
    {
      input: {
        type: "chooseAttackers",
        attackers: ["a", "b"].map((attackerId) => ({
          attackerId,
          validTargetIds: ["player-1"],
          mustAttack: false,
        })),
        attackTargets: [{ id: "player-1", kind: "player" }],
      },
    },
    {},
    refs,
  );
  assert.equal(attackers.count, 2);
  assert.equal(attackers.candidates().length, 2);
  assert.equal(attackers.accept(1), null);
  assert.equal(attackers.candidates()[0].semantic.attacker.object_id, "b");
  assert.deepEqual(attackers.accept(0), {
    type: "declareAttackers",
    assignments: [{ attackerId: "a", targetId: "player-1" }],
  });
  const input = {
    type: "chooseBlockers",
    availableBlockerIds: ["x", "y"],
    attackers: [
      { attackerId: "a", validBlockerIds: ["x", "y"], minBlockers: 1, mustBeBlocked: false },
      { attackerId: "b", validBlockerIds: ["y"], minBlockers: 1, mustBeBlocked: false },
    ],
  };
  const blocks = new PromptDecision({ input }, {}, refs);
  assert.equal(blocks.candidates().length, 2);
  assert.equal(blocks.accept(1), null);
  assert.equal(blocks.candidates().length, 3);
  assert.deepEqual(blocks.accept(2), {
    type: "declareBlockers",
    assignments: [
      { blockerId: "x", attackerId: "a" },
      { blockerId: "y", attackerId: "b" },
    ],
  });
  input.attackers[0].minBlockers = 2;
  assert.throws(() => new PromptDecision({ input }, {}, refs), /coupled block/);
});

test("creature projection distinguishes haste from first-turn control and a blocker whose attacker left", () => {
  const v = view(),
    observer = new Observer("ab".repeat(32));
  const goblin = {
    ...card("goblin"),
    identity: { name: "Raging Goblin", isToken: false },
    color: "R",
    types: ["Creature"],
    supertypes: [],
    subtypes: ["Goblin", "Berserker"],
    power: "1",
    toughness: "1",
    cmc: 1,
    summoningSick: false,
    firstTurnControlled: true,
    isBlocking: true,
  };
  const battlefield = v.zones.find((z) => z.zone === "battlefield" && z.ownerId === "player-0");
  battlefield.cards = [goblin];
  battlefield.count = 1;
  const projected = observer.project(v, "p0", { p0: 0, p1: 0 }, true).observation.players[0]
    .battlefield[0];
  assert.equal(projected.permanent.summoning_sick, true);
  assert.equal(projected.permanent.blocking, true);
  assert.deepEqual(projected.permanent.blocked_attackers, []);
  assert.equal(projected.characteristics.power, 1);
  delete goblin.firstTurnControlled;
  assert.throws(() => observer.project(v, "p0", { p0: 0, p1: 0 }, true), /firstTurnControlled/);
});
