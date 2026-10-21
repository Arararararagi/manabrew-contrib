import { SPELLS, Observer, seatOf } from "./observation.mjs";
import { PromptDecision } from "./candidates.mjs";

export class Game {
  constructor(api, request, decks, timeoutMs, log) {
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.states = new Map();
    this.queue = [];
    this.step = 0;
    this.decisionCount = 0;
    this.seatSteps = { p0: 0, p1: 0 };
    this.groups = { p0: 0, p1: 0 };
    this.mulligans = { p0: 0, p1: 0 };
    this.observer = new Observer(request.game_secret);
    this.engine = new api.ForgeEngine({
      onState: (state, slot) => this.states.set(slot ?? "player-0", state.gameView),
      onPrompt: (prompt, slot) => this.push({ prompt, slot }),
      onError: (error) => this.push({ error: new Error(error.message ?? "Forge error") }),
      onEvent: (event, payload) => {
        if (event === "forge:log") log(payload.text);
        if (event === "game:forced_end") this.push({ error: new Error("Forge worker forced end") });
      },
    });
    this.launch = (async () => {
      await this.engine.init();
      if (this.closed) return;
      await this.engine.startMultiplayerGame({
        decks: decks.map((d) => ({ format: "constructed", cards: d.decklist })),
        playerNames: ["p0", "p1"],
        enginePlayerIndex: 0,
        startingPlayerIndex: request.rules.starting_seat === "p0" ? 0 : 1,
        randomSeed: request.game_secret,
        snapshotRecording: false,
      });
    })().catch((error) => this.push({ error }));
  }

  push(item) {
    if (this.closed) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(item);
    } else this.queue.push(item);
  }

  async next() {
    if (this.queue.length) return this.queue.shift();
    let timer;
    try {
      return await Promise.race([
        new Promise((resolve) => {
          this.waiter = resolve;
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Forge decision timeout")), this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.waiter = null;
    }
  }

  respond(prompt, slot, output) {
    this.engine.respond(prompt.promptId, { type: prompt.input.type, output }, slot);
  }

  terminal(classification, winner, reason) {
    this.result = {
      response_type: "terminal",
      game_id: this.request.game_id,
      classification,
      outcome: classification === "natural" ? (winner ? `${winner}_win` : "draw") : classification,
      winner,
      reason,
      step_count: this.step,
      decision_count: this.decisionCount,
    };
    this.close();
    return this.result;
  }

  halt(error) {
    this.log(`Forge spike halted: ${error.message}`);
    return this.terminal(
      "halted",
      null,
      "engine_contract_failure: unsupported state or engine failure",
    );
  }

  async advance() {
    try {
      while (true) {
        const { prompt, slot, error } = await this.next();
        if (error) throw error;
        const view = this.states.get(slot ?? "player-0");
        if (!view || prompt.decidingPlayerId !== (slot ?? "player-0"))
          throw new Error("Missing seat-specific state");
        if (view.gameOver)
          return this.terminal(
            "natural",
            view.winnerId ? seatOf(view.winnerId) : null,
            "forge_game_over",
          );
        const input = prompt.input;
        if (input.type === "diceRolled")
          throw new Error("Host-assigned start ignored; rebuild Forge-WASM");
        if (input.type === "mulligan" && this.request.rules.mulligan === "none") {
          this.respond(prompt, slot, { type: "mulliganDecision", keep: true });
          continue;
        }
        if (input.type === "mulligan" && input.mulliganCount >= input.handCardIds.length)
          throw new Error(
            "Forge offered a mulligan beyond an empty starting hand; rebuild Forge-WASM",
          );
        if (input.type === "payManaCost") {
          if (!SPELLS.has(input.cardName)) throw new Error("Unsupported payment source");
          if (input.canConfirmFromPool) {
            this.autopayCard = null;
            this.respond(prompt, slot, { type: "pay", auto: false });
          } else {
            if (this.autopayCard === input.cardId)
              throw new Error("Forge autopay made no progress");
            this.autopayCard = input.cardId;
            this.respond(prompt, slot, { type: "pay", auto: true });
          }
          continue;
        }
        if (input.type === "chooseAttackers" && input.attackers.length === 0) {
          this.respond(prompt, slot, { type: "declareAttackers", assignments: [] });
          continue;
        }
        if (input.type === "chooseBlockers" && input.availableBlockerIds.length === 0) {
          this.respond(prompt, slot, { type: "declareBlockers", assignments: [] });
          continue;
        }
        if (input.type === "chooseDamageAssignmentOrder") {
          this.respond(prompt, slot, {
            type: "damageAssignmentOrderDecision",
            orderedBlockerIds: input.blockerIds,
          });
          continue;
        }
        if (input.type === "chooseCombatDamageAssignment") {
          this.respond(prompt, slot, { type: "combatDamageAssignmentDecision", assignments: [] });
          continue;
        }
        if (
          this.step >= this.request.max_steps ||
          this.decisionCount >= this.request.max_decisions
        ) {
          return this.terminal(
            "truncated",
            null,
            this.step >= this.request.max_steps ? "max_steps" : "max_decisions",
          );
        }
        if (view.turn === 1 && seatOf(view.activePlayerId) !== this.request.rules.starting_seat)
          throw new Error("Incorrect starting seat");
        const seat = seatOf(prompt.decidingPlayerId);
        if (input.type === "mulligan") this.mulligans[seat] = input.mulliganCount;
        const projection = this.observer.project(
          view,
          seat,
          this.mulligans,
          input.type === "chooseAction",
        );
        this.pending = new PromptDecision(prompt, view, projection.refs);
        this.slot = slot;
        this.seat = seat;
        this.observation = projection.observation;
        return this.decision();
      }
    } catch (error) {
      return this.halt(error);
    }
  }

  decision() {
    const p = this.pending;
    this.candidates = p.candidates();
    return {
      response_type: "decision",
      game_id: this.request.game_id,
      step: this.step,
      seat_decision: {
        acting_seat: this.seat,
        seat_step: this.seatSteps[this.seat],
        group: { group_id: this.groups[this.seat], substep_index: p.index, substep_count: p.count },
        context: {
          kind: p.priority ? "priority" : "choice",
          source: p.source,
          purpose: p.purpose,
          text: null,
          rewind: false,
        },
        observation: this.observation,
        candidates: this.candidates,
        extensions: {},
      },
    };
  }

  async select(index) {
    try {
      const output = this.pending.accept(index);
      this.step++;
      this.seatSteps[this.seat]++;
      if (!output) return this.decision();
      this.decisionCount++;
      this.groups[this.seat]++;
      if (output.type === "mulliganDecision" && !output.keep) {
        this.mulligans[this.seat]++;
        this.observer.forgetHand(this.seat);
      }
      this.respond(this.pending.prompt, this.slot, output);
      return await this.advance();
    } catch (error) {
      return this.halt(error);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.engine.dispose();
    if (this.waiter) this.waiter({ error: new Error("Game closed") });
  }
}
