# Forge-WASM SpellBench v2 spike

An experimental, standalone Node environment for SpellBench v2. It plays real
two-player BO1 Forge games through the public Forge-WASM API. It is deliberately
limited to six audited catalogs: three basic-land decks, a burn deck, red
creatures with burn, and green creatures. It supports London mulligans,
casting, targeting players or creatures, Forge auto-payment, stack resolution,
attack/block declaration groups and Forge combat damage assignment. This is a
complete environment for these simplified decks, not general card support.

The adapter requires the engine changes in this working tree. The published
`@manabrew/forge-wasm@0.2.0` cannot run it. It adds optional `spellCard`,
`firstTurnControlled` and `isBlocking` observation fields and fixes the harness's
London mulligan boundary. The Forge submodule and WebAssembly runtime remain
unchanged.

## Build and run

Use Node 22+, and build the engine from the repository root. Building needs
the existing Maven, Rust, Binaryen and Oracle GraalVM Web Image toolchain;
running the resulting package needs only Node.

```sh
git submodule update --init forge
export WEBIMAGE_GRAALVM_HOME=/path/to/graalvm/Contents/Home
yarn build:forge-wasm

node packages/forge-spellbench/cli.mjs \
  --experimental --engine packages/forge-wasm
```

The process reads requests on stdin and writes one NDJSON response per request
on stdout. Diagnostics go to stderr. `--timeout 120000` sets the maximum wait
for the next Forge prompt in milliseconds. EOF, SIGINT and SIGTERM dispose the
worker. The `--experimental` flag is required. With no `--engine`, the adapter
imports the installed `@manabrew/forge-wasm`; that package must contain these
extensions and a rebuilt WebAssembly artifact.

Install the authoritative SpellBench checkout at revision
`1ea84689a7059e1cd52166805f56c16f5237dcfa` in a Python 3.11+ environment:

```sh
git clone https://github.com/jackmaiorino/spellbench /tmp/spellbench
git -C /tmp/spellbench checkout 1ea84689a7059e1cd52166805f56c16f5237dcfa
python3 -m venv /tmp/spellbench-venv
/tmp/spellbench-venv/bin/pip install /tmp/spellbench

/tmp/spellbench-venv/bin/spellbench conformance engine \
  --format forge-spike-bo1 \
  --deck red-combat --deck green-combat \
  -- node packages/forge-spellbench/cli.mjs \
  --experimental --engine packages/forge-wasm
```

The official conformance command includes complete, seat-swapped games between
the reference `first` and `uniform` agents. For a standalone unrated Arena run
with a ledger and reports:

```sh
/tmp/spellbench-venv/bin/spellbench run packages/forge-spellbench/example.json
```

Run from the ManaBrew root. The example writes `tmp/forge-spellbench-run`; use a
fresh output directory for each run. SpellBench applies its own disk-reserve
guard: the Arena command was refused on the development machine because it had
about 6 GiB available, below the required 60 GiB. The conformance runner's games
and direct integration tests do not require an Arena artifact directory.

## Supported scope

`forge-spike-bo1` accepts all six catalogs. The original
`forge-land-spike-bo1` format remains available for the three land decks only.
All catalogs contain exactly 60 cards, with at most four copies of each
nonbasic card. These are intentionally simple decks, not competitive lists.

| Catalog        | Contents                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `mountains`    | 60 Mountain                                                                                                         |
| `forests`      | 60 Forest                                                                                                           |
| `mixed-lands`  | 30 Mountain, 30 Forest                                                                                              |
| `red-burn`     | 48 Mountain; four each of Shock, Lightning Bolt, Lava Axe                                                           |
| `red-combat`   | 32 Mountain; four each of Canyon Minotaur, Goblin Piker, Hill Giant, Raging Goblin, Shock, Lightning Bolt, Lava Axe |
| `green-combat` | 44 Forest; four each of Centaur Courser, Craw Wurm, Grizzly Bears, Runeclaw Bear                                    |

- `hello`, `reset`, `step`, strict request validation, ordered errors, game IDs,
  full-process retransmission caching, and both host caps.
- Two external seats, either host-assigned starting seat, visible or hidden
  opponent decklist rules, and `mulligan: none` or `london`. SpellBench's `auto`
  mulligan setting selects London when available.
- Priority passing, legal land plays, normal spell casts and basic-land mana
  activations, using Forge's offered action IDs. Mana undo is a UI operation
  and is not exposed.
- Single-target burn spells: every target is supplied by Forge. Payment uses
  the declared `engine_autopay` default through Forge's existing auto button,
  then confirms when Forge reports that the pool covers the cost. A planner
  that makes no progress halts the game instead of silently cancelling a cast.
- Cleanup discards represented as fixed-count `select_object` groups, with no
  engine response until the whole selection is complete. A cap cannot split a group.
- London bottoming uses ordered `order_pick` groups. Seven mulligans correctly
  produce a zero-card starting hand, without offering an eighth mulligan.
- Attacks and blocks are fixed groups with one decision per eligible creature.
  The adapter uses the offered pairings and sends one complete declaration to
  Forge after the group. Only independent declarations are admitted; coupled
  restrictions such as menace or required blocks are rejected.
- Combat damage uses the declared `engine_order` default. The adapter preserves
  Forge's supplied ordering and requests its existing fallback allocation:
  lethal to each blocker, with remaining damage assigned by Forge.
- Per-seat observations, hidden opposing hands, opaque per-viewer object IDs,
  fresh IDs after zone changes, natural outcomes, truncation, explicit failure
  terminals, timeouts and worker disposal.
- Repeatable execution for the supported catalogs, using the full 256-bit
  secret, independent per-seat/per-shuffle streams, and separate object-ID
  derivation. This is not a general noninterference certification.

All five required v2 decision kinds are exercised by the admitted catalogs:
`pass`, `play_land`, `cast_spell`, `declare_attack` and `declare_block`.
Arbitrary decklists and all other catalogs are refused. Optional
observation flags are false, rewind and the noninterference probe are disabled,
and `validate_deck` / `probe_resample` return `unsupported_request`. No rules
defaults other than mana auto-payment and combat damage order are claimed. Unsupported engine states end with
`engine_contract_failure:`, never an invented observation or fallback action.

## Engine extensions and boundaries

`ForgeStartGameOptions` and `ForgeStartMultiplayerGameOptions` gain two optional,
consumer-neutral fields:

- `startingPlayerIndex`: a zero-based seat; skips the interactive opening roll.
- `randomSeed`: 64 lowercase hex characters. The harness uses a SHA-256
  counter generator and installs independent library-shuffle streams through
  Forge's existing controller hook. The hook first orders the library by
  engine card ID, removing dependence on the preceding shared shuffle, then
  shuffles with the seat's stream. The remaining game RNG is a separate stream.

Both require externally controlled seats. The old numeric `seed` and default
behavior remain unchanged when the new fields are absent. Arbitrary cards can
use random effects outside library shuffling; their seat/purpose separation has
not been implemented or audited. Do not interpret this option as general
SpellBench randomness support.

Worker errors and unexpected Node worker exits now reach `onError` and reject
pending commands. A Java start failure returned as JSON becomes a worker failure
event. These are generic wrapper fixes, with no SpellBench dependency.

The original stack projection had a name and targets but no characteristics or
reliable distinction between spells and abilities. The burn slice adds optional
`StackObjectDto.spellCard: CardDto`: present only for a spell whose face is visible
to that viewer, including a spell still being announced. It reuses Forge's card
projection and visibility checks. Absent means unavailable, not an empty card.
The Rust engine leaves it absent; older messages still deserialize and existing
consumers need no changes. This is a generic observation addition, not a new
SpellBench API or a redesign of ManaBrew prompts.

The three burn scripts were inspected in the pinned Forge source: each has
exactly one fixed single-target requirement and no modes, X, divided damage,
additional costs, copies, triggers, random effects or creature permanents.
Those catalog invariants justify target slot 0 and null modes/X/divisions.
The adapter never derives these facts from prompt wording, and never computes
targets, costs or damage itself. General targeting still needs explicit
requirement metadata. Unsupported prompt cardinalities or target zones
halt rather than approximate. Stack identity follows the physical spell across
Forge's temporary casting ID and committed stack ID, then changes on resolution.

The eight creature scripts are vanilla creatures except Raging Goblin's haste.
They add no coupled combat restrictions, attack/block costs, triggers or
activated abilities. Their legal combat pairings come directly from Forge;
the adapter contains no attack, blocking or damage rules solver.

`CardDto.firstTurnControlled` exposes `Card.isFirstTurnControlled()` independently
of haste; the existing `summoningSick` behavior is preserved for old consumers.
`CardDto.isBlocking` exposes `Combat.isBlocking()`, including a blocker whose
attacker has left combat. The list of surviving blocked attackers still comes
from `combatAssignments`. The Rust producer supplies the former and leaves the
latter absent. Missing creature facts halt this adapter rather than silently
using the old, differently defined field.

The pinned Forge London implementation allows another mulligan when its bottom
count equals the drawn hand size. The harness previously deferred bottoming
until keep, allowing an extra mulligan and then an invalid seven-card keep.
The controller now forces keep at that boundary and still asks the player to
order all bottomed cards. It rejects an impossible larger bottom count. This
is an engine-side correction, with no adapter mulligan policy or upstream edit.

The adapter is split into `wire.mjs` (framing/schema), `environment.mjs`
(protocol lifecycle), `game.mjs` (worker/prompt progression), `observation.mjs`
(seat projections/identities), and `candidates.mjs` (response mapping). It
imports no private worker/SAB implementation. Its identity includes the built
WASM hash; source checkouts still report the package's development stamp.

## Remaining blockers

General decks still need engine facts for ability stack kinds, announced
modes/X/divisions, Oracle-order ability indices, target requirements and choice
purpose, plus legal completion queries for coupled choices such as blocking.
Native card IDs persist across zone changes; tracking only visible snapshots is
sufficient for these catalogs, but not for arbitrary effects with unobserved
intermediate moves. Random card effects also need stronger seat/purpose
isolation than the current per-seat library streams. These gaps are why
arbitrary decklists and unsupported cards remain refused.

ManaBrew's priority `abilityIndex` indexes the entire prompt, so it cannot be
forwarded as SpellBench's Oracle-order ability index. For this closed catalog,
each basic land has exactly one mana ability: the adapter reports index 0 and
retains the original engine action ID for the response. Multiple abilities on
a card cause an explicit halt. This mapping must not be generalized by name or
by parsing ability descriptions.

See [the investigation](../../docs/forge-wasm-spellbench-v2.md) for the complete
source audit and original package blockers.

## Verification

```sh
yarn test:spellbench
node --test tests/forge-wasm/spellbench-integration.test.mjs
```

Integration tests require the rebuilt engine. They cover deterministic mixed
decks, both starting seats, raw-API observation comparison, independence from
the opposing library's size, natural deck-exhaustion completion, invalid engine
configuration, stdout isolation, EOF and signal cleanup. Burn and creature tests
compare every priority observation and the final result against complete games
through the raw public API. Further tests exercise haste, creature targets,
multiple blockers, Forge damage allocation, ordered London bottoming through a
zero-card hand, and deterministic replay with unequal decks and either starting
seat. Unit tests cover
strict framing, invalid requests/actions, retransmissions, references, ordered
selections, group caps, spell incarnations, target responses, stalled autopay,
timeouts and post-initialization worker failures.

Local verification passed **19 adapter unit tests and 14 integration tests**,
three unchanged-API regression tests, three protocol serialization tests, the
Rust agent-interface compilation check, and five Java regression mains.
The local adapter suite ran as 32 tests together plus the subsequently added
unequal-deck replay test separately; all passed.

The current six-catalog run passed **21/21 official checks**, including **12
natural games** between the reference `first` and `uniform` agents: two per
catalog, with London mulligans. No game halted or truncated. Current results,
source fingerprints and build provenance are recorded in
[conformance-results-combat.json](conformance-results-combat.json).

Earlier results remain in [conformance-results-burn.json](conformance-results-burn.json)
and [conformance-results.json](conformance-results.json); each describes its
earlier scope and artifact hash. The local build reused an existing framed asset
bundle, and all 13 admitted card scripts were checked against the pinned Forge
source. Passing the suite for these catalogs is not a claim of general card
support.
