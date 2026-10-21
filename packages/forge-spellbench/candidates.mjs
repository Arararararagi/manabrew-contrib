import { BASIC_LANDS, BURN_SPELLS, SPELLS, seatOf } from "./observation.mjs";

export class PromptDecision {
  constructor(prompt, view, refs) {
    this.prompt = prompt;
    this.input = prompt.input;
    this.selected = [];
    this.index = 0;
    this.count = 1;
    this.refs = refs;
    this.priority = this.input.type === "chooseAction";
    this.purpose = null;
    this.source = null;
    if (this.input.type === "chooseBoardTargets") {
      const source = this.ref(prompt.sourceCard?.id);
      if (
        source.zone !== "stack" ||
        !BURN_SPELLS.has(source.card_name) ||
        this.input.intent !== "damage" ||
        this.input.minTargets !== 1 ||
        this.input.maxTargets !== 1 ||
        this.input.chosenTargets !== 0 ||
        this.input.candidates.some(
          (c) =>
            c.kind !== "player" && (c.kind !== "card" || this.ref(c.id).zone !== "battlefield"),
        )
      )
        throw new Error("Unsupported target requirement");
      this.source = source;
    }
    if (this.input.type === "chooseAttackers") {
      if (
        this.input.attackers.some((a) => a.mustAttack) ||
        this.input.attackTargets.some((t) => t.kind !== "player")
      )
        throw new Error("Unsupported attack restriction");
      this.count = this.input.attackers.length;
    } else if (this.input.type === "chooseBlockers") {
      if (
        this.input.error ||
        this.input.attackers.some(
          (a) => a.minBlockers > 1 || a.maxBlockers != null || a.mustBeBlocked,
        )
      )
        throw new Error("Unsupported coupled block restriction");
      this.count = this.input.availableBlockerIds.length;
    }
    if (this.count < 1) throw new Error("Empty decision group");
    if (this.input.type === "chooseCards") {
      if (
        view.step !== "cleanup" ||
        this.input.min !== this.input.max ||
        this.input.min < 1 ||
        prompt.sourceCard
      ) {
        throw new Error("Unsupported card selection");
      }
      this.count = this.input.min;
      this.purpose = "discard";
    } else if (this.input.type === "mulliganPutBack") {
      this.count = this.input.count;
      this.purpose = "mulligan_bottom";
      if (this.count < 1) throw new Error("Empty mulligan bottom prompt");
    }
    if (
      ["chooseCards", "mulliganPutBack"].includes(this.input.type) &&
      (this.count > this.input.cards.length ||
        new Set(this.input.cards.map((c) => c.id)).size !== this.input.cards.length)
    ) {
      throw new Error("Invalid fixed-count choice");
    }
  }

  ref(id) {
    const ref = this.refs.get(id);
    if (!ref) throw new Error("Candidate references an undisclosed object");
    return ref;
  }

  candidates() {
    const input = this.input;
    this.outputs = [];
    const choices = [];
    const add = (semantic, output) => {
      choices.push({ candidate_id: choices.length, semantic, display_text: null });
      this.outputs.push(output);
    };
    if (input.type === "chooseAction") {
      add({ kind: "pass" }, { type: "pass", exhaustStack: false });
      for (const action of input.actions) {
        if (action.type === "undoMana") continue;
        const source = this.ref(action.cardId);
        if (action.type === "cast" && action.mode.type === "normal") {
          if (BASIC_LANDS.has(source.card_name))
            add({ kind: "play_land", source, face: 0 }, { type: "act", actionId: action.id });
          else if (SPELLS.has(source.card_name))
            add(
              { kind: "cast_spell", source, method: "normal" },
              { type: "act", actionId: action.id },
            );
          else throw new Error("Unsupported cast source");
        } else if (action.type === "activateAbility" && action.isManaAbility) {
          if (
            !BASIC_LANDS.has(source.card_name) ||
            input.actions.filter((a) => a.type === "activateAbility" && a.cardId === action.cardId)
              .length !== 1
          ) {
            throw new Error("Multiple abilities on a basic land");
          }
          add(
            {
              kind: "activate_mana_ability",
              source,
              ability_index: 0,
              mana_choice: null,
              cost_target: null,
            },
            { type: "act", actionId: action.id },
          );
        } else throw new Error("Unsupported priority action");
      }
    } else if (input.type === "chooseBoardTargets") {
      for (const target of input.candidates) {
        add(
          {
            kind: "choose_target",
            source: this.source,
            slot: 0,
            target:
              target.kind === "player"
                ? { player: seatOf(target.id) }
                : { object: this.ref(target.id) },
            selected_count: 0,
            minimum: 1,
            maximum: 1,
          },
          { type: "boardTargets", chosen: [target] },
        );
      }
    } else if (input.type === "chooseAttackers") {
      const option = input.attackers[this.index],
        attacker = this.ref(option.attackerId);
      add({ kind: "declare_attack", attacker, defender: null }, null);
      for (const targetId of option.validTargetIds)
        add(
          { kind: "declare_attack", attacker, defender: { player: seatOf(targetId) } },
          { attackerId: option.attackerId, targetId },
        );
    } else if (input.type === "chooseBlockers") {
      const blockerId = input.availableBlockerIds[this.index],
        blocker = this.ref(blockerId);
      add({ kind: "declare_block", blocker, attacker: null }, null);
      for (const a of input.attackers)
        if (a.validBlockerIds.includes(blockerId))
          add(
            { kind: "declare_block", blocker, attacker: this.ref(a.attackerId) },
            { blockerId, attackerId: a.attackerId },
          );
    } else if (input.type === "mulligan") {
      for (const keep of [true, false]) {
        if (!keep && input.handCardIds.length === 0) continue;
        add(
          {
            kind: "mulligan",
            hand_size: input.handCardIds.length,
            mulligans_taken: input.mulliganCount,
            keep,
          },
          { type: "mulliganDecision", keep },
        );
      }
    } else if (["chooseCards", "mulliganPutBack"].includes(input.type)) {
      for (const card of input.cards) {
        if (this.selected.includes(card.id)) continue;
        const ref = this.ref(card.id);
        const semantic =
          input.type === "chooseCards"
            ? {
                kind: "select_object",
                source: null,
                purpose: "discard",
                choice: { object: ref },
                selected_count: this.index,
                minimum: this.count,
                maximum: this.count,
              }
            : {
                kind: "order_pick",
                source: null,
                purpose: "mulligan_bottom",
                item: { object: ref },
                position: this.index,
                count: this.count,
              };
        add(semantic, card.id);
      }
    } else throw new Error(`Unsupported prompt: ${input.type}`);
    if (!choices.length || choices.length > 4096) throw new Error("Invalid candidate count");
    return choices;
  }

  accept(index) {
    const chosen = this.outputs[index];
    if (["chooseAttackers", "chooseBlockers"].includes(this.input.type)) {
      if (chosen) this.selected.push(chosen);
      this.index++;
      if (this.index < this.count) return null;
      return {
        type: this.input.type === "chooseAttackers" ? "declareAttackers" : "declareBlockers",
        assignments: this.selected,
      };
    }
    if (this.input.type === "chooseCards" || this.input.type === "mulliganPutBack") {
      this.selected.push(chosen);
      this.index++;
      if (this.index < this.count) return null;
      return this.input.type === "chooseCards"
        ? { type: "chooseCardsDecision", chosenCardIds: this.selected }
        : { type: "mulliganPutBackDecision", cardIds: this.selected };
    }
    this.index++;
    return chosen;
  }
}
