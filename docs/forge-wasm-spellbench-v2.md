# Forge-WASM / SpellBench v2 investigation

Status: an experimental Node adapter now exists in
[`packages/forge-spellbench`](../packages/forge-spellbench/README.md). It supports
a closed pool of six land, burn and creature catalogs, host-assigned starts,
London mulligans, spell targeting and independent combat declarations. Real games
complete through the standard v2 transport, including combat and burn wins. It is not general Magic/SpellBench
support, and it does not work with the unchanged published 0.2.0 package.

The spike adds optional `startingPlayerIndex` and full-width `randomSeed` start
options, a harness library-shuffle hook, and wrapper failure reporting. The burn
slice additionally needs optional `StackObjectDto.spellCard` projections, because
the original stack lacked spell characteristics. This is an additive typed field;
the existing prompt model, upstream Forge and WASM runtime remain unchanged.
Combat additionally uses optional `firstTurnControlled` and `isBlocking` facts.
Remaining engine-fact gaps below still prevent general decks. The closed burn
catalog uses the audited single-target slot, no-mode/no-X invariant and declared
Forge autopay; those assumptions must not be generalized. The harness now fixes
the discovered London boundary by forcing keep when every drawn card must be
bottomed. The adapter uses Forge's damage default, without reproducing combat
rules. See the adapter README for current verification and remaining blockers.

The following audit records the **unmodified published package and source
baseline**, before those opt-in extensions. References to missing capabilities
and proposed work describe that baseline; the adapter README describes what the
spike actually implements.

## Sources and versions

Inspected on 2026-10-20/21:

| Component                                     | Revision                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| ManaBrew source                               | `f730d21cb` (`origin/main` when this worktree was created)                                        |
| Source package manifest                       | `@manabrew/forge-wasm` `0.3.0`                                                                    |
| Published npm package actually executed       | `@manabrew/forge-wasm` `0.2.0`                                                                    |
| Resolved npm protocol dependency              | `@manabrew/protocol` `5.13.2`                                                                     |
| Published package `BUILD_COMMIT`              | `fdfd147e2ef604d6dcc4ef45e8c7dfa136ecd8bc`                                                        |
| Published tarball integrity                   | `sha512-wN+f37wJyhtQioUMPSyJUn9V/gxXnrn4eNkoOBdM7EEGrgqHN80CY/wXdMfS3Ub9I8iimsc27XSqeyhrx1ek0A==` |
| Source Forge submodule                        | `e7d2b93ba9f800a1f5f3a5de91db1aad3ed46831`                                                        |
| SpellBench                                    | `1ea84689a7059e1cd52166805f56c16f5237dcfa`                                                        |
| Gorge source inspected                        | `311e9a0ac3576b7d89e2083fae62c73a1b8d0d26`                                                        |
| Gorge engine pin used by SpellBench's adapter | `26257e0eda1779d739a07e835c6500b9c4dabc62`                                                        |

At inspection, npm's complete version list was `0.1.0`, `0.2.0`; `latest` was
`0.2.0`. Source `0.3.0` was inspected, not built or executed. It is materially
different from the published package: embedded assets, seed input, external
opponent seats in `startGame`, bot-seat flags, and directive lanes.

Authorities:

- [SpellBench v2 specification](https://github.com/jackmaiorino/spellbench/blob/1ea84689a7059e1cd52166805f56c16f5237dcfa/spec/SPELLBENCH_PROTOCOL_V2.md).
- [Official environment checker](https://github.com/jackmaiorino/spellbench/blob/1ea84689a7059e1cd52166805f56c16f5237dcfa/python/spellbench/conformance.py)
  and `python/tests/test_engine_conformance.py`.
- `python/spellbench/messages.py`, `host/validator.py`, `host/hidden.py`,
  `python/tests/fake_v2_engine.py`, `python/tests/test_golden_replay_v2.py`,
  and `goldens/protocol_v2/`.
- [Gorge adapter in SpellBench](https://github.com/jackmaiorino/spellbench/tree/1ea84689a7059e1cd52166805f56c16f5237dcfa/engines/gorge):
  `internal/server`, `session`, `gamecfg`, `secrets`, `identity`, `observe`,
  and `mapping`. The public Gorge checkout has bot integration and design
  material; the environment implementation inspected here lives in SpellBench.
- Local [package API](../packages/forge-wasm/forge.d.ts),
  [Node entry](../packages/forge-wasm/node.js),
  [wrapper](../packages/forge-wasm/engine.js),
  [worker](../packages/forge-wasm/forge-engine.worker.js),
  [seat transport](../packages/forge-wasm/seat.js), and
  [ManaBrew protocol](../manabrew-rs/crates/manabrew-protocol/src/).

## What already works

`startMultiplayerGame` can start exactly two externally controlled seats. Its
name does not require Commander. Use constructed decks, two player names, and
`enginePlayerIndex: 0`. The local seat's callback slot is `undefined`; the second
seat's slot is `"player-1"`. Echo that slot in `respond`.

The published `startGame` uses Forge AI opponents; it is not the two-external-seat
entry point. Source `0.3.0` changes this behavior, so a consumer must pin and
verify the version it uses.

The Node conditional export creates a `worker_threads` worker. The worker
evaluates the generated Web Image launcher, runs the Java game synchronously,
and parks on SharedArrayBuffer input. `respond` writes to the seat buffer.
State, prompt, display, and protocol-error messages arrive through callbacks.
There is no synchronous `step` or state-query API.

`init()` means the JS worker is ready, not that Forge has loaded. The start
promise acknowledges setup before the game reaches its first prompt. A
consumer must wait for the deciding seat's state and prompt. The wire prompt
field is `promptId`, despite the older README example using `prompt.id`.

Seat views already redact unobservable cards. The investigation's two-player
fixtures verified each seat's complete own hand and an empty opponent-hand
card list. This is fixture evidence, not a general hidden-information audit.

Completion is available through final `state.gameView.gameOver` and `winnerId`.
Both seats' final boards agreed in the completed land game. `game:over` alone
does not provide an outcome. Engine errors and forced termination must take
precedence over a board that appears terminal.

`dispose()` terminates the worker. Create a fresh instance for each accepted
reset. This avoids inheriting Java session/global state and is compatible with
the public API; no shared engine singleton is needed.

## Mandatory blockers

### 1. Randomness cannot be made compliant from Node

Specification §11.6 requires all game randomness to derive from `game_secret`,
separated by seat and purpose, with at least 64-bit stream seeds. Hidden
randomness may not use a generator with fewer than 64 bits of state.

Published `0.2.0` has no public seed option and its worker always sends
`Date.now() % 2147483647`. Providing an extra `seed` property does nothing.
Source `0.3.0` accepts `seed: number`, but `gameSeed` reduces it modulo
`2147483647`.

The reproducible worker-request capture shows:

| Worker                              | Supplied seed | Seed passed to Java |
| ----------------------------------- | ------------: | ------------------: |
| npm 0.2.0, clock fixed at 123456789 |            42 |           123456789 |
| npm 0.2.0, same clock               |            43 |           123456789 |
| source 0.3.0                        |            42 |                  42 |
| source 0.3.0                        |    2147483689 |                  42 |

The source harness constructs one
[`CountingRandom`](../forge-harness/src/main/java/forge/harness/common/CountingRandom.java)
in `ManaBrewEngineAdapter.startGame` and installs it through
`MyRandom.setRandom` in `ManaBrewInteractiveSession.start`. `CountingRandom`
extends `java.util.Random` and delegates to its 48-bit generator. Both players
use the same game-thread provider. The pinned Forge `Player.shuffle` calls
`Collections.shuffle(list, MyRandom.getRandom())`; `MyRandom.getRandom()` takes
no seat or purpose.

Hashing a 256-bit secret into the existing seed does not fix seed width, RNG
state width, or stream separation. Reordering input decks does not bypass
Forge's shuffles. A smaller card catalog does not remove opening shuffles.

Smallest viable direction: an opt-in engine-neutral randomness configuration
carrying seed bytes losslessly, backed by an appropriate deterministic
generator and explicit seat/purpose context at random operations. Preserve the
legacy seed path for existing callers. The Java harness and rebuilt Web Image
must participate; a larger JS seed alone is insufficient. Audit opening
shuffles, mulligans, later shuffles, random choices, and dice/coin operations.
Use existing controller hooks where possible; any upstream hook must be scoped
to operations whose context cannot otherwise be supplied. This is an engine
capability project, not an adapter-side workaround.

### 2. Neither permitted starting-player rule is exposed

Specification §9.1 requires a nonempty supported set drawn from
`host_assigned` and `toss_winner_chooses`.

`ManaBrewInteractiveController.chooseStartingPlayer` calls
`ManaBrewInteractiveSession.awaitFirstPlayerRoll`. The session rolls d20s,
publishes `diceRolled`, waits for acknowledgements, and returns the roll winner.
The only answer is `diceRolledAcknowledged`. The winner never chooses who
starts. Neither public start-options interface exposes a starting player.
Worker-request captures confirm that extra `startingSeat`/`startingPlayer`
properties are not forwarded.

Thus the current behavior is neither allowed rule. It cannot truthfully
advertise either, even for basic-land-only decks.

Smallest extension: an optional engine-neutral `startingPlayerIndex` in both
start APIs and the Java start request. When present, the controller honors that
seat without the startup roll; when absent, behavior stays unchanged. That
enables `host_assigned` only. Supporting `toss_winner_chooses` additionally needs
a real choice prompt; a display acknowledgement is not a choice.

Searching seeds until a desired player wins, restarting until the roll
matches, or relabeling unequal decks after the roll changes initialization
semantics and is not an acceptable substitute.

### 3. General observations require facts absent from the projection

Specification §§5–6 requires more than a renamed ManaBrew game view:

- ManaBrew `engine-card-*` values come from `ParityCardMap` and persist across
  zones. They must never be forwarded. HMAC aliases can hide native ids, but
  snapshots alone cannot reliably identify a leave-and-return within one
  engine action or distinguish successive hidden-zone looks. An engine
  incarnation token and look lifetime, or a complete relevant event stream,
  are needed for general cards. Display events are presentation hints, not
  that guaranteed stream.
- `StackObjectDto` has source, owner, controller, presentation text,
  `isPermanentSpell`, `isCasting`, face data, and targets. It does not expose
  spell/activated/triggered classification, spell characteristics, copy state,
  announced X, mode indices, or divided amounts. `isPermanentSpell: false`
  does not distinguish an instant from an activated ability. `null` is not
  permission to discard a value the rules say is present.
- `combatAssignments` supplies current attacker/blocker pairs. It is not a
  general substitute for the independent `blocking` flag after an attacker
  disappears. A retained flag needs authoritative lifecycle information.
- ManaBrew's presentation-oriented phase and priority values need explicit
  pregame/no-priority interpretation. Do not copy them unconditionally during
  resolution or mulligans.

The smallest additions should extend the existing typed game projection with
engine facts, not SpellBench objects. Incarnation/look tokens remain private
adapter inputs, never agent-visible counters. A deliberately restricted
catalog can avoid some unsupported states, but not blockers 1 and 2.

### 4. Interactive answers are not complete legal candidates

Specification §7.1 requires every offered candidate to extend to a legal
complete answer. ManaBrew's prompts are an interactive controller contract:
some answers select multiple objects at once; others can be retried, cancelled,
or rolled back after additional decisions.

For example, `ChooseBlockersInput` has pairwise legal blockers and some
per-attacker quotas, but not a general query for legal completions of a
partially chosen declaration. `CombatChoiceSpace` uses Forge's pairwise
`canAttack`/`canBlock`; the Node wrapper exposes neither Forge's complete
declaration validator nor a side-effect-free prefix probe. Reimplementing
menace, must-block, extra-block, attack-cost, and coupled restrictions in the
adapter would duplicate rules logic.

The initial raw-API spell probe repeatedly selected a cast which Forge then
failed to complete, logged `AI failed to play Shock`, and restored. It reached
the probe's 10,000-response guard. A second run prioritizing lands and trying
each card once per turn still repeated payment prompts with `auto: true`
(9,722 payment prompts before the guard). The final probe uses the offered
mana actions and confirms only when `canConfirmFromPool` is true; that game
completed. These are agent policies, not adapter legality filters or fixes to
the engine. The underlying auto-payment behavior was not diagnosed; these
runs establish a rollback/retry path, not a claim that every offered cast is
illegal.

SpellBench §8 rewind is explicit: undo the entire action, abandon its groups,
remove the failed candidate, and re-pose priority with `context.rewind: true`.
The public API has no typed action rollback/commit notification. Repeated
priority, prompt id changes, and text logs are insufficient evidence of a
complete rollback. User-driven restore voting is a different mechanism.

Smallest direction: expose engine-authored legal completion information for
compound decisions and explicit action commit/rollback information, with
validation remaining in Forge. Restrict a catalog until these are available.
Do not submit speculative answers to the live game to discover legality.

## Decision-family mapping

This is a mapping assessment, not a supported-kinds declaration.

| ManaBrew surface                               | SpellBench representation                                     | Qualification                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chooseAction` pass                            | `pass`, candidate 0                                           | Direct; binding and per-seat counters belong to the adapter.                                                                                                                                          |
| `cast` action                                  | `play_land`, `cast_spell`, or a special action                | `cast` also represents lands. Use typed card/mode data; do not classify by label text. Castability and rollback need the safeguards above.                                                            |
| `activateAbility`                              | `activate_ability` / `activate_mana_ability`                  | Verify Oracle-order class indices, granted abilities, and mana choices; a similarly named integer is not automatically equivalent.                                                                    |
| `undoMana`                                     | No corresponding v2.0 priority kind                           | Presentation undo cannot be relabeled as an ability or as SpellBench rewind.                                                                                                                          |
| `mulligan`                                     | `mulligan`                                                    | London keep/mulligan; `none` can auto-keep under the declared rule. Track public mulligan counts.                                                                                                     |
| `mulliganPutBack`                              | `order_pick`, `mulligan_bottom`                               | k picks; preserve bottom-block order, including the final required pick.                                                                                                                              |
| `chooseBoardTargets`                           | `choose_target` / finish                                      | Need target requirement slot in Oracle order and legality after each pick; `chosenTargets` is not a slot id.                                                                                          |
| `chooseCards`                                  | `select_object` / finish                                      | `min`/`max` allow simple decomposition, but semantic purpose and repeated-pick constraints need authoritative information.                                                                            |
| `chooseFromSelection`                          | Modes, printed options, naming, costs, or other typed choices | Labels, weights, and repetition do not identify the rules family. Do not map every prompt to `choose_option`. Weighted choices are not ordinary mode counts.                                          |
| `chooseBoolean`, `chooseColor`, `chooseNumber` | Corresponding typed choices                                   | Use semantic purpose; X must have a payable bound. Use `other` only where the spec licenses it, not to disguise another required kind.                                                                |
| `payManaCost`                                  | Declared `engine_autopay` where valid                         | Existing `{type:"pay", auto:true}` delegates to Forge. `pay_mana` is reserved in v2.0. Convoke/delve and optional-cost elections cannot silently disappear into a default without checking its scope. |
| `chooseAttackers`, `chooseBlockers`            | Fixed groups of `declare_attack` / `declare_block`            | Each prefix must remain completable; pairwise eligibility alone is insufficient.                                                                                                                      |
| `scry`                                         | `arrange_card` then `order_pick`                              | Fixed 2n−1 group, including forced choices; combine the final partition/order into one native answer. Destination arrays are not independent physical decisions.                                      |
| `reorder`                                      | `order_pick`                                                  | Need purpose and, for triggers, trigger identity/Oracle-order metadata; `ReorderItem.card` plus optional text does not supply all trigger fields.                                                     |
| Damage ordering/assignment                     | `order_pick`/`distribute`, or declared engine damage default  | Preserve amount constraints and actual Forge order; do not compute a new damage policy in the adapter.                                                                                                |
| `revealCards`, `diceRolled`                    | Internal acknowledgements, where they contain no choice       | Preserve legitimate knowledge without inventing a `choose_boolean` decision. Startup dice cannot implement either starting-player rule.                                                               |
| `gameOver`                                     | `terminal` from authoritative final state                     | Never count it as an agent choice or respond as though it were one.                                                                                                                                   |

Multi-stage decisions are representable in principle. One ManaBrew prompt can
become several SpellBench substeps buffered in Node, with exactly one native
response after the group completes. Conversely, one SpellBench advancement may
consume internal acknowledgements and declared defaults before exposing the
next real decision. There is no one-to-one prompt/step correspondence.

Gorge illustrates why native hooks matter: its adapter uses a shuffle planner,
tracks zone changes through engine events (including round trips inside one
step), and checks declaration completions through native acceptance/probe
operations. Those facilities are not present in Forge-WASM's public wrapper.
Its architecture is therefore not directly transferable.

## Adapter design after the blockers are resolved

Keep a separate Node package consuming `@manabrew/forge-wasm`. No SpellBench
dependency or abstraction belongs in the engine package.

```text
SpellBench Arena
  -> NDJSON transport and strict request validation
  -> one-game lifecycle / pending decision
  -> seat observation + candidate/group translation
  -> published Forge-WASM API
  -> worker / Forge
```

Boundaries:

1. Transport: strict UTF-8, 8 MiB framing, duplicate-key rejection, integer
   lexical validation, depth/surrogate checks, exact object schemas, one
   response per request. Plain `JSON.parse` alone is insufficient. Cache
   accepted request identities/payloads/responses without replaying side
   effects; parsing failures must not poison the cache.
2. Lifecycle: one fresh engine per accepted reset, bounded initialization and
   advancement, states partitioned by seat, pending prompt ownership, and
   explicit disposal on EOF/signals/errors/terminal. Invalid requests preserve
   the pending decision and follow §9.4 error precedence.
3. Observations: construct an allowlisted projection. Remove native ids,
   checkpoint/timestamp counters, diagnostics, cosmetics, and other-seat
   prompts. Re-key references per seat and incarnation/look; do not alias all
   cards globally. Declare optional fields false when unsupported. With
   `known_cards: false`, current looks/searches still require `known` entries.
4. Candidates: keep the private candidate-to-native-response mapping with the
   pending decision. Dense ids, distinct semantics, pass first, hidden-zone
   name/id ordering, ≤4096 candidates, correct fixed groups, independent
   per-seat counters. Never accept raw engine ids from agents.
5. Errors: separate rejected protocol requests, engine contract failures,
   host truncation, and natural outcomes. A crash or timeout is not a draw.
   Diagnostics go to stderr; protocol stdout contains NDJSON only.

`node.js` subscribes to worker `error`, but the wrapper only rejects the
initialization promise. A post-init worker error can be lost after that promise
has resolved, and worker exit is not exposed. Timeouts plus disposal can bound
this today; forwarding post-init failures through the existing `onError`
callback is a small consumer-neutral improvement worth making with the
lifecycle work. `WasmMain` also returns an error JSON on some exceptions while
the worker ignores the returned string; `game:over` is not proof of success.

The seat transport has a 256 KiB buffer. This is distinct from SpellBench's
8 MiB transport requirement. Large engine states need an explicit failure
path; a missing/dropped message must not become an incomplete observation.

### Decks and outcomes

Begin with a named, audited two-player BO1 catalog after initialization is
fixed. Advertising `decklist` implies validating card support, format
legality, and whether every required decision can be represented. The public
API has no deck-validation call, card-catalog query, or capability query.
Passing `format: "pauper"` merely selects the worker's `Constructed` variant;
it does not demonstrate Pauper legality. Successful `startGame` is not deck
validation.

A fixed catalog can be checked without porting deck rules, and unknown decks
can be refused with `unsupported_deck`. Arbitrary-deck support should obtain
validation from Forge through a separate read-only operation. Unsupported
formats/rules must be refused before allocating a game.

Use `gameOver` and the winner to report natural wins/draws only after ruling out
engine failure. Use a neutral reason if the API lacks a more precise loss
reason. Host caps produce `truncated`; unrepresentable decisions produce
`halted` with `engine_contract_failure:`. Check group budgets before opening a
fixed group; do not truncate halfway through one. Never emit the host-only
`forfeit` classification.

## Reproduce the investigation

No Java installation or browser is needed. Node 20+ is required; these checks
used Node `v22.22.0`.

From the ManaBrew worktree:

```sh
npm install --prefix /tmp/forge-spellbench-runtime --ignore-scripts \
  --no-audit --no-fund --save-exact \
  @manabrew/forge-wasm@0.2.0 @manabrew/protocol@5.13.2

export FORGE_WASM_PACKAGE=/tmp/forge-spellbench-runtime/node_modules/@manabrew/forge-wasm

node --test tests/forge-wasm/spellbench-blockers.test.mjs
node --test tests/forge-wasm/spellbench-readiness.test.mjs

node scripts/engine-bench/spellbench-readiness.mjs \
  --engine "$FORGE_WASM_PACKAGE" --scenario lands
node scripts/engine-bench/spellbench-readiness.mjs \
  --engine "$FORGE_WASM_PACKAGE" --scenario spells
```

The probe emits one JSON summary on stdout, logs to stderr, bounds elapsed time
and prompt count, and disposes its worker. Its tiny fixture policy is not a
reference SpellBench agent. The decks are 60 Mountains, or 52 Mountains plus
four Shocks and four Raging Goblins. The spell policy prioritizes lands, tries a
card at most once per turn, selects Forge's offered mana actions and confirms
when Forge says the pool is sufficient, targets the opposing player with
Shock, attacks, and does not block.

`spellbench-blockers.test.mjs` reproduces known blockers in the pinned release
and source worker; its passing results mean the blockers are reproduced, not
that the engine is ready. It captures the worker's JSON start request with a
stub launcher and fixed clock; it does not execute or replace Forge randomness.
The other test file runs real WebAssembly in child Node processes. Keep these
investigation checks separate from a future adapter conformance suite.

### Original investigation verification

Final combined Node investigation run: **6 passed, 0 failed, 0 skipped** in
95.8 seconds. JavaScript syntax, Prettier, and `git diff --check` also passed.
These are the six local investigation tests, not the official conformance suite.

- Complete raw-API land game: passed, both seats routed, own-hand isolation
  checked, matching terminal state, turn 108 draw step, starting seat wins by
  the other seat drawing from an empty library.
- Seed and startup configuration reproductions: 3/3 passed.
- Held-prompt timeout/disposal: passed; child exits itself with code 1, with
  no stdout protocol-like output.
- Spell fixture: passed with explicit offered mana actions; payment, targeting,
  and attack prompts occurred and a player reached zero or negative life.
  Earlier auto-pay policy runs failed as described above.
- Deterministic execution: unsupported by published 0.2.0; source 0.3.0's
  numeric seed is insufficient for v2.0.
- General hidden-information/noninterference, invalid SpellBench actions,
  grouped decisions, reset/retransmission, and failure adjudication: not
  verified by these raw-API fixtures.

### Spike verification (2026-10-21)

The original investigation did not run conformance. The subsequent spike now
runs the official environment checker and its `first`/`uniform` games; see the
adapter's [commands and limitations](../packages/forge-spellbench/README.md) and
[machine-readable results](../packages/forge-spellbench/conformance-results-combat.json).
The current six-catalog run passed all 21 official checks and 12 natural
reference-agent games, including London mulligans. Local checks cover all five
mandatory decision kinds, complete burn and combat games against raw-API traces,
ordered mulligan bottoming through a zero-card hand, and deterministic replay.
The initial checker passed 21/21, but a subsequent natural-game regression found
that the basic-land mana index had been mistaken for a per-card index. That bug
was fixed and regression-tested before the final checks. The official suite
accepts engine-reported `halted` endings, so separate tests require natural
completion and the final report retains the game check's ending classifications.

Golden engine replays compare the reference fake engine's identity and scenario
states exactly; they are not portable Forge transcripts. They were inspected,
not counted as adapter tests. Source package regression runs exercise the old
start options as well as the opt-in adapter path.

The tested Web Image was rebuilt from this worktree's harness and pinned Forge.
It used the existing local framed asset bundle rather than rebuilding the Rust
archive; the result record includes both bundle and WASM SHA-256 fingerprints.
The documented normal build regenerates that bundle from the pinned Forge tree.
No built binary is tracked.
