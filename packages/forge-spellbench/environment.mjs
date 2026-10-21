import { Game } from "./game.mjs";
import {
  PROTOCOL,
  ProtocolError,
  canonical,
  digest,
  object,
  validateRequest,
  requireThat,
} from "./wire.mjs";

export const CATALOG = [
  {
    catalog_id: "mountains",
    name: "Sixty Mountains (spike)",
    decklist: [{ name: "Mountain", count: 60 }],
  },
  {
    catalog_id: "forests",
    name: "Sixty Forests (spike)",
    decklist: [{ name: "Forest", count: 60 }],
  },
  {
    catalog_id: "mixed-lands",
    name: "Thirty Mountains, thirty Forests (spike)",
    decklist: [
      { name: "Forest", count: 30 },
      { name: "Mountain", count: 30 },
    ],
  },
  {
    catalog_id: "red-burn",
    name: "Mountains, Shock, Lightning Bolt and Lava Axe (spike)",
    decklist: [
      { name: "Lava Axe", count: 4 },
      { name: "Lightning Bolt", count: 4 },
      { name: "Mountain", count: 48 },
      { name: "Shock", count: 4 },
    ],
  },
  {
    catalog_id: "red-combat",
    name: "Red creatures and burn (spike)",
    decklist: [
      { name: "Canyon Minotaur", count: 4 },
      { name: "Goblin Piker", count: 4 },
      { name: "Hill Giant", count: 4 },
      { name: "Lava Axe", count: 4 },
      { name: "Lightning Bolt", count: 4 },
      { name: "Mountain", count: 32 },
      { name: "Raging Goblin", count: 4 },
      { name: "Shock", count: 4 },
    ],
  },
  {
    catalog_id: "green-combat",
    name: "Green creatures (spike)",
    decklist: [
      { name: "Centaur Courser", count: 4 },
      { name: "Craw Wurm", count: 4 },
      { name: "Forest", count: 44 },
      { name: "Grizzly Bears", count: 4 },
      { name: "Runeclaw Bear", count: 4 },
    ],
  },
];
export const FORMAT = "forge-spike-bo1";
export const LAND_FORMAT = "forge-land-spike-bo1";
const flags =
  "poison player_counters designations player_progress day_night passed_seats pending_triggers keywords full_name exiled_by stack_text permanent_details known_cards".split(
    " ",
  );

export class Environment {
  constructor(
    api,
    { timeoutMs = 120000, log = () => {}, fingerprint = "development-unverified" } = {},
  ) {
    this.api = api;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.cache = new Map();
    this.gameIds = new Set();
    this.identity = {
      name: "forge-wasm-spike",
      version: api.VERSION,
      source_revision: api.BUILD_COMMIT,
      rules_snapshot_id: `forge-wasm:${fingerprint}`,
      card_pool_identity: `forge-spike-catalog:${digest(CATALOG)}`,
    };
    this.provenance = {
      engine_name: this.identity.name,
      engine_version: this.identity.version,
      rules_snapshot_id: this.identity.rules_snapshot_id,
      card_pool_identity: this.identity.card_pool_identity,
    };
  }

  hello() {
    return {
      response_type: "hello_ok",
      protocol_minor: 0,
      engine: this.identity,
      formats: [FORMAT, LAND_FORMAT],
      deck_sources: ["catalog"],
      catalog: CATALOG,
      rules_supported: { mulligan: ["none", "london"], starting_player: ["host_assigned"] },
      observation: Object.fromEntries(flags.map((key) => [key, false])),
      decision_kinds: [
        "pass",
        "play_land",
        "cast_spell",
        "declare_attack",
        "declare_block",
        "activate_mana_ability",
        "select_object",
        "choose_target",
        "mulligan",
        "order_pick",
      ],
      engine_defaults: {
        trigger_order: null,
        replacement_order: null,
        combat_damage_assignment: "engine_order",
        mana_payment: "engine_autopay",
      },
      rewind: false,
      fairness: { noninterference_probe: false },
      extensions: [],
    };
  }

  error(requestId, error) {
    return {
      response_type: "error",
      protocol: PROTOCOL,
      request_id: requestId,
      error: { code: error.code ?? "malformed_request", message: error.message },
    };
  }

  async handle(request) {
    const id = object(request) && typeof request.request_id === "string" ? request.request_id : "";
    try {
      validateRequest(request);
    } catch (error) {
      return this.error(id, error);
    }
    const payload = canonical(request);
    const cached = this.cache.get(id);
    if (cached)
      return cached.payload === payload
        ? cached.response
        : this.error(id, new ProtocolError("request_id_reuse_mismatch"));
    let response;
    try {
      response = { protocol: PROTOCOL, request_id: id, ...(await this.dispatch(request)) };
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      response = this.error(id, error);
    }
    this.cache.set(id, { payload, response });
    return response;
  }

  async dispatch(r) {
    switch (r.request_type) {
      case "hello":
        return this.hello();
      case "reset": {
        requireThat(!this.gameIds.has(r.game_id), "malformed_request", "game_id already used");
        requireThat(!this.game || this.game.result, "game_already_active");
        requireThat([FORMAT, LAND_FORMAT].includes(r.format), "unsupported_format");
        const decks = r.seats.map(({ deck }) => {
          const found = CATALOG.find((c) => c.catalog_id === deck.catalog_id);
          requireThat(found, "unsupported_deck");
          requireThat(
            r.format !== LAND_FORMAT ||
              ["mountains", "forests", "mixed-lands"].includes(found.catalog_id),
            "unsupported_deck",
          );
          requireThat(deck.deck_id === digest(found.decklist), "deck_id_mismatch");
          return found;
        });
        requireThat(
          ["none", "london"].includes(r.rules.mulligan) &&
            r.rules.starting_player === "host_assigned" &&
            !r.rules.probe &&
            r.rules.extensions.length === 0,
          "unsupported_rule",
        );
        this.game?.close();
        this.gameIds.add(r.game_id);
        this.game = new Game(this.api, r, decks, this.timeoutMs, this.log);
        return { ...(await this.game.advance()), provenance: this.provenance };
      }
      case "step": {
        const g = this.game;
        requireThat(g, "step_before_reset");
        requireThat(r.game_id === g.request.game_id, "game_id_mismatch");
        requireThat(!g.result, "game_already_terminal");
        requireThat(r.expected_step === g.step, "expected_step_mismatch");
        requireThat(r.selection.candidate_id < g.candidates.length, "candidate_id_out_of_range");
        requireThat(
          canonical(r.selection.semantic_echo) ===
            canonical(g.candidates[r.selection.candidate_id].semantic),
          "semantic_echo_mismatch",
        );
        return { ...(await g.select(r.selection.candidate_id)), provenance: this.provenance };
      }
      default:
        throw new ProtocolError("unsupported_request");
    }
  }

  close() {
    this.game?.close();
  }
}
