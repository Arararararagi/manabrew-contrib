import { createHmac } from "node:crypto";

export const BURN_SPELLS = new Set(["Shock", "Lightning Bolt", "Lava Axe"]);
export const BASIC_LANDS = new Set(["Mountain", "Forest"]);
export const CREATURES = new Set([
  "Raging Goblin",
  "Goblin Piker",
  "Hill Giant",
  "Canyon Minotaur",
  "Grizzly Bears",
  "Runeclaw Bear",
  "Centaur Courser",
  "Craw Wurm",
]);
export const SPELLS = new Set([...BURN_SPELLS, ...CREATURES]);

export const seatOf = (id) => {
  if (id === "player-0") return "p0";
  if (id === "player-1") return "p1";
  throw new Error("Unknown Forge seat");
};
const phases = {
  untap: "untap",
  upkeep: "upkeep",
  draw: "draw",
  main1: "precombat_main",
  combatBegin: "beginning_of_combat",
  combatDeclareAttackers: "declare_attackers",
  combatDeclareBlockers: "declare_blockers",
  combatFirstStrikeDamage: "combat_damage",
  combatDamage: "combat_damage",
  combatEnd: "end_of_combat",
  main2: "postcombat_main",
  endOfTurn: "end_step",
  cleanup: "cleanup",
};
export class Observer {
  constructor(secret) {
    this.key = Buffer.from(secret, "hex");
    this.viewers = new Map();
  }

  forgetHand(viewer) {
    const state = this.viewers.get(viewer);
    if (state)
      for (const key of state.live.keys()) if (key.endsWith(":hand")) state.live.delete(key);
  }

  project(view, viewer, mulligans, priority) {
    let state = this.viewers.get(viewer);
    if (!state) this.viewers.set(viewer, (state = { live: new Map(), sequence: 0 }));
    const live = new Map(),
      refs = new Map();
    const card = (c, zone) => {
      if (
        (zone !== "stack" && c.visibility !== "visible") ||
        !(BASIC_LANDS.has(c.identity.name) || SPELLS.has(c.identity.name)) ||
        c.isFaceDown ||
        c.isCopy ||
        c.identity.isToken
      ) {
        throw new Error("Unsupported card in spike catalog");
      }
      const key = `${c.id}:${zone}`;
      const id =
        state.live.get(key) ??
        `o-${createHmac("sha256", this.key).update(`forge-spike/object:${viewer}:${state.sequence++}`).digest("hex").slice(0, 32)}`;
      live.set(key, id);
      const r = {
        object_id: id,
        card_name: c.identity.name,
        owner_seat: seatOf(c.ownerId),
        controller_seat: ["battlefield", "stack"].includes(zone)
          ? seatOf(c.controllerId)
          : seatOf(c.ownerId),
        zone,
      };
      refs.set(c.id, r);
      if (
        Object.keys(c.counters).length ||
        c.attachedTo ||
        c.phasedOut ||
        (BASIC_LANDS.has(c.identity.name)
          ? c.color !== "" || c.types.join(",") !== "Land" || zone === "stack"
          : CREATURES.has(c.identity.name)
            ? !["R", "G"].includes(c.color) || c.types.join(",") !== "Creature"
            : c.color !== "R" ||
              !["Instant", "Sorcery"].includes(c.types.join(",")) ||
              zone === "battlefield")
      )
        throw new Error("Unsupported permanent state");
      return {
        ...r,
        full_name: null,
        face_down: c.isFaceDown,
        token: c.identity.isToken,
        copy: c.isCopy,
        characteristics: {
          supertypes: c.supertypes.map((t) => t.toLowerCase()),
          types: c.types.map((t) => t.toLowerCase()),
          subtypes: c.subtypes.map((t) => t.toLowerCase()),
          colors: c.color === "R" ? ["red"] : c.color === "G" ? ["green"] : [],
          mana_value: c.cmc,
          power: CREATURES.has(c.identity.name) ? integerStat(c.power) : null,
          toughness: CREATURES.has(c.identity.name) ? integerStat(c.toughness) : null,
          keywords: null,
        },
        permanent:
          zone === "battlefield"
            ? {
                tapped: c.tapped,
                summoning_sick:
                  c.firstTurnControlled ??
                  (CREATURES.has(c.identity.name)
                    ? missing("firstTurnControlled")
                    : c.summoningSick),
                damage: c.damage,
                counters: {},
                attached_to: null,
                attacking: c.isAttacking ?? false,
                attack_target: c.isAttacking ? { player: seatOf(c.attackTargetId) } : null,
                blocking:
                  c.isBlocking ?? (CREATURES.has(c.identity.name) ? missing("isBlocking") : false),
                blocked_attackers: [],
                phased_out: c.phasedOut,
                statuses: null,
                class_level: null,
                chosen: null,
              }
            : null,
        exiled_by: null,
      };
    };
    const cards = (zone, owner) =>
      view.zones
        .filter((z) => z.zone === zone)
        .flatMap((z) => z.cards)
        .filter((c) => seatOf(zone === "battlefield" ? c.controllerId : c.ownerId) === owner)
        .map((c) => card(c, zone));
    const count = (zone, seat) => {
      const found = view.zones.find((z) => z.zone === zone && seatOf(z.ownerId) === seat);
      if (!found) throw new Error(`Missing ${zone} count`);
      return found.count;
    };
    const players = ["p0", "p1"].map((seat) => {
      const p = view.players.find((p) => seatOf(p.id) === seat);
      if (!p || !Number.isInteger(p.landsPlayedThisTurn))
        throw new Error("Missing player fields; rebuild Forge-WASM");
      return {
        seat,
        life: p.life,
        poison: null,
        counters: null,
        mana_pool: p.manaPool,
        lands_played_this_turn: p.landsPlayedThisTurn,
        mulligans_taken: mulligans[seat],
        designations: null,
        progress: null,
        hand_count: count("hand", seat),
        library_count: count("library", seat),
        hand: seat === viewer ? cards("hand", seat) : null,
        battlefield: cards("battlefield", seat),
        graveyard: cards("graveyard", seat),
        exile: cards("exile", seat),
        command: cards("command", seat),
      };
    });
    const stack = view.stack.map((s) => {
      if (!s.spellCard || s.spellCard.id !== s.sourceId || !SPELLS.has(s.spellCard.identity.name))
        throw new Error("Missing spell projection or unsupported stack entry; rebuild Forge-WASM");
      const c = card(s.spellCard, "stack");
      const ref = refs.get(s.sourceId);
      if (ref.controller_seat !== seatOf(s.controllerId) || ref.owner_seat !== seatOf(s.ownerId))
        throw new Error("Stack ownership disagrees with spell projection");
      if (s.targets.length > 1 || s.targets.some((t) => !["player", "card"].includes(t.kind)))
        throw new Error("Unsupported burn target state");
      return {
        ...ref,
        stack_kind: "spell",
        source: null,
        face_down: c.face_down,
        copy: c.copy,
        characteristics: c.characteristics,
        targets: s.targets.map((t) =>
          t.kind === "player"
            ? { player: seatOf(t.id) }
            : refs.get(t.id)?.zone === "battlefield"
              ? { object: refs.get(t.id) }
              : null,
        ),
        divided: null,
        modes: null,
        x_value: null,
        text: null,
      };
    });
    for (const p of players)
      for (const c of p.battlefield) {
        c.permanent.blocked_attackers = view.combatAssignments
          .filter((a) => refs.get(a.blockerId)?.object_id === c.object_id)
          .map((a) => {
            const ref = refs.get(a.attackerId);
            if (ref?.zone !== "battlefield")
              throw new Error("Combat references an absent attacker");
            return ref;
          });
      }
    state.live = live;
    const own = players.find((p) => p.seat === viewer);
    if (own.hand.length !== own.hand_count) throw new Error("Incomplete own hand");
    const phase = view.turn === 0 ? "pregame" : phases[view.step];
    if (!phase) throw new Error("Unknown Forge phase");
    return {
      refs,
      observation: {
        viewer,
        turn: view.turn,
        phase_step: phase,
        active_seat: view.turn === 0 ? null : seatOf(view.activePlayerId),
        priority_seat: priority ? seatOf(view.priorityPlayerId) : null,
        passed_seats: null,
        day_night: null,
        players,
        stack,
        pending_triggers: null,
        known: [],
      },
    };
  }
}

function missing(field) {
  throw new Error(`Missing ${field}; rebuild Forge-WASM`);
}
function integerStat(value) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Unsupported creature characteristic");
  return Number(value);
}
