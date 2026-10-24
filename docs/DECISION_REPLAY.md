# Decision journal and rewind

## Scope and reading order

This milestone records Forge execution inputs and restores a pending decision by
starting an isolated engine and replaying from game start. It does not change
relay ownership, persist games on the relay, or implement a replay viewer.

Read these files in order:

1. `forge-harness/.../host/DecisionJournal.java`: consumed inputs, bounded delivery,
   acknowledgement and invalidation.
2. `forge-harness/.../host/ManaBrewInteractiveSession.java`: `takeAction`, the only
   journal capture point, and the game-thread snapshot request.
3. `forge-harness/.../host/GameCheckpoint.java`: snapshot validation, reconstruction,
   verification and artifact identity. No Forge state serializer is loaded.
4. `forge-harness/.../host/ManaBrewEngineAdapter.java`: launch restrictions and APIs.
5. `scripts/engine-bench/forge-replay.mjs`: independent-process recovery scenarios.

The `...` prefix above is `src/main/java/forge/harness`.

## Interactive journal history and rewind

Forge games with external decision makers enable `decisionJournal` and
`journalRewind`. The Journal tab replaces Snapshots with consumed decisions grouped
by turn. Each row identifies the deciding seat and action category without exposing
hidden card names, choices, prompts, or verification hashes. Selecting a row asks
the active human seats to approve returning to immediately before that input.
External Manabot decisions are replayed from the journal, without rerunning policy.
Internal Forge AI retains the legacy snapshot controls because its decisions are
not reproducible through this protocol.

`DecisionHistory` retains the complete canonical prefix in engine memory, bounded
by 50,000 entries or 64 MiB, while publishing only the latest 200 positions. Hitting
the bound stops recording with a visible reason; retained positions remain usable and gameplay continues. This is not
durable storage: closing the host loses the history. Journaling never calls
`GameSnapshot`; ordinary rule actions are reconstructed by executing Forge.

An approved rewind freezes the current engine and starts a candidate from the same
initial request and engine artifacts. Every recorded prompt and state/RNG witness,
including the selected pending boundary, must match before replacement. Candidate
failure or timeout resumes the original game. Success discards the abandoned
suffix, clears the local action log, and continues the same room/game identity.
Public prompt IDs advance across replacement so old answers cannot satisfy a new
prompt. Vote messages are host orchestration and are excluded from the input log.

- Browser and WebView: a supervisor worker replaces its engine child worker only
  after `forge:replay_ready`. Candidate SABs are withheld until verification;
  private `forge:journal` payloads never leave the supervisor. Directive lanes are
  retained across promotion, including pending UI queues. Prompt responses belong
  to their original timeline. The supervisor answers control requests itself
  because the engine child's event loop is blocked; ending the game or losing the
  source terminates the candidate too.
- Native desktop and hosted node: one child process per game runs the same
  executable with `--forge-engine-worker`, using the bundled native library.
  This also satisfies G1's one-isolate-per-process restriction.
- JVM node: one fresh harness process per game and per rewind candidate.

Reconstruction has a 120-second budget from before startup, including all candidate
RPC writes and reads. Individual subprocess RPCs also have a 60-second deadline;
cancellation is polled every 20 ms. A transport timeout closes that process rather
than reusing an uncorrelated late response. Failed candidates are killed and reaped
before the source resumes. A non-restore directive already queued in the native
source cancels reconstruction, so it is consumed by the original game.

Interactive rewind owns journal delivery and rejects `decisionJournalCommitBarrier`;
the externally acknowledged foundation API retains its startup/decision barriers.

Threaded engines publish immutable spectator and seat snapshots on the game thread
before exposing each prompt or state revision, and before reporting game over.
RPC reads use these published views: traversing live Forge zones concurrently with
advancement or concession can throw `ConcurrentModificationException` and end the
authoritative game. Single-threaded WebImage reads remain synchronous.

Interactive candidates defer UI snapshots and checkpoint-row projection until the
verified destination. Every intermediate prompt, state/RNG witness and remembered
hand projection is still verified. The final UI views and retained journal rows
are built before `replayReady` becomes true, so promotion sees a complete destination.

Measured locally on macOS/ARM64 with the GraalVM 21 native engine: five fresh-process
rewinds to input 400 in a four-player Commander fixture, replaying the exact same
saved history before and after deferring UI serialization. Median startup was
1.606 → 1.555 seconds, verified replay 8.047 → 3.605 seconds, and total time to ready
9.638 → 5.160 seconds (46% lower). Each run also checked eight continued inputs and
boards. These are local fixture timings, not staging latency; replay still starts
from game creation, and cold engine/asset initialization remains. Reproduce with
`yarn bench:forge-rewind --native target/debug/self-hosted-node --save-fixture tmp/rewind-fixture.json`,
then after rebuilding use `--fixture tmp/rewind-fixture.json` instead. The hidden-choice
fixture (`--scenario hidden`) compares Ponder/Brainstorm reconstruction, subsequent
boards and retained journal rows against the live source.

Rewind temporarily holds two engines and their card databases. Capacity planning
must account for this peak; shared-isolate/JVM multiplexing settings no longer
apply to hosted gameplay. No relay ownership, crash takeover, durable saved-game
import, or cross-artifact migration is introduced.

## Verification cost and hardening regression

Measured on macOS/aarch64, JDK 18, 1 GiB fixed heap, 2026-10-24. Run
`yarn bench:forge-verification --java-home "$JAVA_HOME"` after building the harness.
The fixture parks a real four-player Commander engine at a prompt, with four
100-card decks, then adds Memnite permanents evenly across the four battlefields.
These are controlled board-size fixtures, not timings from naturally played games.
Each board uses 20 paired warmups and 100 alternating samples per implementation.
Allocation uses `ThreadMXBean` bytes allocated by the measuring thread per call;
it is allocation traffic, not retained heap or process RSS.

| Total permanents | Before median / p95 (ms) | After median / p95 (ms) | Before / after allocated bytes |
| ---------------- | ------------------------ | ----------------------- | ------------------------------ |
| 0                | 3.538 / 4.080            | 2.068 / 2.776           | 4,960,160 / 2,505,232          |
| 40               | 13.543 / 14.438          | 6.797 / 7.383           | 20,202,672 / 9,274,400         |
| 160              | 43.162 / 45.798          | 21.010 / 22.501         | 67,679,568 / 30,753,072        |
| 320              | 84.670 / 90.088          | 41.926 / 44.623         | 131,005,936 / 59,413,408       |

The optimization builds verification views directly and copies sorted JSON members
without repeatedly serializing subtrees. All spectator/player projections, ordered
hidden-zone identities, and the RNG witness remain. The benchmark asserts identical
witnesses before and after on every sample. Replay reuses the witness checked just
before consuming the same input instead of extracting it twice. Large boards still
allocate substantially; these numbers do not establish browser/native latency.

`yarn test:forge-supervisor` covers request settlement, consecutive promotions,
source/candidate failures, cancellation, timeout, and retained directive queues.
`JournalHardeningTest` runs with the harness build and covers both history caps,
seat metadata, prompt/RNG divergence and incompatible delivery modes. Rust
`journal_engine::tests` and `subprocess_tests` exercise hanging/exiting children,
blocked stdin, full stdout queues, failure recovery and process reaping.
`SnapshotConcurrencyTest` reads spectator and two seat views concurrently through startup,
100 decisions and a concession; it reproduced the live-zone traversal race.
The JVM/native and real WebImage rewind scripts cover continuation, rejection,
queued concede, stale responses and nested directives claiming another seat. Browser
response directives are bound to the sending seat. Network responses cannot use
prompt ID zero, which is reserved for in-process absent-player defaults.
Linux/Windows process teardown and actual browser/WebView lifecycle still require
their platform CI/manual validation.

The hardening rerun passed all 22 relay/native-Forge networking cases in 231 seconds,
including concession while observing bots and journal rewind followed by resync.
The default Rust backend also passed its 21 networking cases. Supervisor tests passed
7/7, and subprocess/host library tests passed 26/26 under each of `java-forge` and
`graal-forge`. Harness, native-image, WebImage, TypeScript and desktop `forge-room`
builds passed. Targeted ESLint and dependency-excluding Clippy passed; the full
Clippy invocation remains blocked by an existing `nonminimal_bool` warning in
`forge-foundation/src/sealed_product/card_cosmetics.rs:853`.
All six fresh-JVM replay scenarios passed again after the snapshot concurrency fix,
including four-player Commander, hidden choices, stack responses, RNG/coin flips and
the 1,012-input long game. JVM/native rewind, real WebImage rewind and retained
journal acknowledgement/commit-barrier regressions also passed.

## Four separate responsibilities

| Layer                | Contract                                                                                      | First milestone                        |
| -------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------- |
| Decision journal     | Ordered execution inputs, exact initial request, verification witnesses                       | Included                               |
| Deterministic replay | Re-execute those inputs and refuse the first observed mismatch                                | Included, isolated JVM/native/WebImage |
| Snapshot restoration | Package a journal prefix and pending boundary; return a usable engine only after verification | Harness API and interactive rewind     |
| Durable ownership    | Persist before publication, fence writers, arbitrate host replacement                         | Preserved for a follow-up              |

A prompt is not a decision. The game thread records an action when it dequeues
it, immediately before dispatch. This includes Directives, acknowledgements,
and invalid answers that the controller consumes and rejects. Recording only
successful choices would miss their effects on prompt sequence and execution.
Automatic rule actions are regenerated by Forge, not added as artificial player
choices. Random draws come from the seeded engine RNG; their consumption is
checked, not played back as independent decisions.

With `journalRewind`, `requestRestore` and `restoreVote` select and approve journal
rewind. Without it they retain the legacy `GameSnapshot` operation, which invalidates
a delivery journal because it uses a different, lossy mechanism. Replay restoration
is host orchestration, not a new player prompt.
Existing concede and recording-control Directives travel through their existing
channel and are journaled at their actual consumption boundary.

## Journal v2 and snapshot v1

The journal header contains `version: 2`, `startRequest` (the exact JSON string,
including a full-width seed), and `entries`. An entry contains:

- `sequence`, starting at 1, contiguous;
- `playerIndex`, the pending decision's seat (a Directive's actor remains in its action);
- `prompt`, the full canonical game-protocol prompt;
- `action`, the canonical input submitted to the engine;
- `verification`, a state digest and the seeded RNG consumption position before dispatch.

JSON object key order is ignored; array order is significant. Choice and card IDs
are compared exactly. Journal games use native card IDs so observer reads cannot
allocate new parity IDs and change the subsequent action protocol.

The version changes because old v1 journals lack verification witnesses. There
is no silent v1 upgrade. The preserved relay store rejects new fields and must be
updated explicitly in the follow-up, including its feature/version negotiation.

Delivery is independent of replay: consumers either drain batches, or read and
cumulatively acknowledge them. Mixing modes fails. Retained delivery survives a
lost reply; acknowledgements cannot exceed the prefix actually read. The optional
`decisionJournalCommitBarrier` holds startup at sequence zero and each dequeued
input until acknowledged. In this milestone there is no durable receipt provider:
acknowledgement is a caller contract, not a claim that storage has committed.
A journal retains at most 4096 undelivered entries or 8 MiB; exceeding the limit
invalidates it explicitly. Consumers must collect the complete prefix externally.
There is no compaction and no GameState replay base.

A snapshot contains the full journal prefix, pending prompt, terminal verification,
next sequence, and engine/assets/preferences identity. All of this is private host
data, including hashes: neither journal nor snapshot belongs in per-seat traffic,
analytics, public game logs, or a replay viewer without a separate redaction layer.

## API usage

Start an isolated harness with `decisionJournal: true`, external decision makers,
and known seed/decks/variant. External bots are ordinary decision makers; Forge's
internal AI is rejected. Collect `startRequest` and all entries from delivery.
At any pending decision, pass this accumulated history to:

```json
{
  "command": "exportReplaySnapshot",
  "sessionId": "game-id",
  "payload": "{\"version\":2,\"startRequest\":\"...\",\"entries\":[...]}"
}
```

The export request is serviced on the game thread between consumed inputs. Finished
games are not restorable through this pending-decision API. If a
commit barrier is enabled, acknowledge the current prefix before requesting an
export. The caller owns storing the returned snapshot. It can then kill the engine.
In a fresh process with the same engine and assets:

```json
{ "command": "restoreReplaySnapshot", "payload": "<snapshot JSON returned above>" }
```

Restoration starts at game creation, checks every pre-input prompt and state/RNG
witness, verifies that each input was re-recorded identically, and checks the final
pending boundary. It returns the normal session handle only after those checks.
A mismatch closes the new session and throws with the first mismatching sequence.
Continue through the ordinary action API. The restored journal uses retained
read/acknowledge delivery, with the replayed prefix already acknowledged.

The adapter has the same `exportReplaySnapshot(sessionId, history)` and
`restoreReplaySnapshot(snapshot)` methods. The exported snapshot API remains a threaded JVM API. Interactive rewind uses
`startGame` with `replaySnapshot` in a fresh worker/process, as described above,
with `getRewindRequest`, `replayReady` and `resumeAfterFailedRewind` on threaded hosts.

## What verification proves, and what it cannot prove

The state witness hashes every seat's view, the spectator view, and ordered card
identities in every registered player's zones, including the complete libraries.
This catches hidden-library divergence that comparing visible boards misses.
RNG tracking intercepts `Random.next(bits)`, covering boolean, float, double and
bounded/rejection-sampled integer draws, rather than counting only `nextInt`.
The seed is installed before game construction as well as on the game thread.

The witness is **not a complete serialization or a proof of every Forge field**.
Delayed triggers, replacement caches, Java stack locals and controller internals
are reconstructed by execution. A divergence confined to one of those fields may
only be detected when it affects a later witness. Regression tests must therefore
resume restored games and compare subsequent decisions as well as the immediate
boundary. Do not extend a state serializer and mistake it for complete recovery.

The packaged harness jar (containing Forge), resource-tree content and effective
Forge preferences are pinned. Exploded classpath builds are refused because hashing
only harness classes would omit engine dependencies. Assets and preferences must
remain immutable during a session. Different engine versions,
asset sets, preference sets, cross-engine migration, and JVM/native/WASM equivalence
are unsupported. One journaled game owns its process: starting another game while
it runs, or starting it inside an existing game process, fails. Ordinary games
retain their existing multiplexing behavior. This constraint protects global
Forge counters and caches until their isolation is separately established.

The existing in-memory UI `GameSnapshot` rollback remains available to ordinary
games. The PR-only `GameCheckpoint` GameState serializer and its turn-start host
handoff are removed from this milestone and preserved with the recovery branch.
The Journal tab replaces these controls for supported Forge games.

## Determinism audit

| Source                   | Finding / boundary                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unordered iteration      | `Card.getLockedRooms()` used an enum `HashSet`; `UnlockDoorEffect` turns it directly into indexed choices. Reproduced opposite choice orders in independent JVMs after identity-hash perturbation. The fork patch uses `EnumSet`.        |
| Unordered maps generally | Do not blanket-replace. Many card/player maps have numeric IDs, lookup-only use, or results sorted later. Static-ability dependency maps, counter maps and random choices over arbitrary iterables remain audit hotspots.                |
| Initial deck order       | The fork already sorts `Match.preparePlayerZone` cards by name before shuffling. Creation still precedes sorting and equal names with different printings are not totally ordered: broader printing/collision fixtures are still needed. |
| RNG                      | `MyRandom` is thread-local and defaults to `SecureRandom` on unseeded threads. Journal startup now seeds before construction and on the execution thread; the complete primitive stream is witnessed.                                    |
| Scheduling               | Internal AI uses time budgets and workers and is refused. Harness execution is a named game thread so `GameAction.invoke` executes inline. Other asynchronous callbacks remain a risk requiring coverage.                                |
| Global state             | Spell/trigger/static/stack IDs and lazy card caches are reset when idle. Concurrent games are explicitly excluded from journal mode. Sequential reuse and unlisted static caches need further coverage.                                  |
| Object identity          | Enum hashing affects Room ordering despite a fixed RNG seed; regression tests perturb identity hashes. Identity-sensitive effect/counter ordering is not assumed solved globally.                                                        |
| AI                       | Record external bot outputs; do not rerun the bot policy during reconstruction. Internal Forge AI is unsupported.                                                                                                                        |

The fork fix is intentionally narrow: [de6654d46d8](https://github.com/witchesofthehill/forge/commit/de6654d46d8)
on `fix/replay-room-choice-order`. The pinned Forge merge includes that commit alongside current main's Forge changes. The regression
fails against the original pinned fork.

Specific remaining audit targets:

- `StaticAbility`, `Trigger` and `ReplacementEffect` hash codes include their
  `Class` object's identity hash. Dependency graphs and effect tables using those
  keys need fixtures that distinguish lookup-only use from order-sensitive use.
  In contrast, `GameEntity.hashCode()` returns its numeric ID; a player/card-keyed
  `HashMap` is not automatically evidence of cross-process divergence.
- `GameEntityCounterTable` uses a hash table and hash multisets. Mixed counter
  types with replacement effects need coverage before changing their iteration.
- `Aggregates.random(Iterable)` consumes RNG in iteration order. Both its input
  ordering and its call count matter; a stable seed alone is insufficient.
- `CardDb.addUnassignedCardPrints` assigns upcoming cards using the current date.
  The artifact digest does not freeze the clock. Replay across release dates for
  upcoming/unassigned printings is unverified; the fixtures use established cards.

These are identified risks, not reproduced game divergences. The matrix does not
establish determinism for the entire Forge card catalog or every JVM configuration.

The matrix also exposed a launch bug: `startingLife` was parsed but never applied
to `RegisteredPlayer`. Explicit values now take effect; an omitted value retains
Forge's variant default. Every scenario asserts its initial life total, including
100 life for the coin-flip fixture.

## Automated checks

Use JDK 18–21 (CI uses 21) and Node 24. Initialize the pinned Forge submodule.

```sh
node scripts/harness.mjs test
yarn bench:forge-journal --jar forge-harness/target/forge-harness-jar-with-dependencies.jar --forge-home forge/forge-gui
yarn test:forge-replay
yarn test:forge-rewind
yarn test:forge-rewind --native target/debug/self-hosted-node
yarn test:forge-rewind-wasm
```

The harness build runs existing Java regressions and the Room-order regression
under perturbed JVM identity hashes. The journal probe checks startup/decision
barriers, lost/partial/duplicate acknowledgements, mode mixing, overflow, internal
AI rejection and invalidation. The replay matrix runs real Forge games, kills the
source process, restores at multiple decision boundaries in independent processes,
and compares a continuation suffix. It emits decision counts, prompt types, maximum
turn, journal bytes and restore duration (including process startup/asset identity).
`--scenario <name>` selects one fixture; `--repeats N` controls fresh restorations.
The rewind regression checks votes, four selected positions, continued play and
failed-candidate recovery against either JVM or native workers. The WASM regression
executes the built WebImage through the Node worker shim, replaces workers twice,
checks monotonic prompt IDs and continues play. It is not a browser UI check.
The networking regression `journal_rewind_keeps_the_room_and_resumes_play` exercises
the real relay, external bot and node, including resync after rewind.
Set `REGRESSION_NODE_ENGINE_BACKEND=forge` when running this suite; the default
selects the Rust engine and omits the journal rewind case.
CI runs the JVM probes whenever the Forge/harness job is selected, including fork bumps.

## Interactive rewind evidence (2026-10-24)

On macOS, the interactive JVM (Zulu JDK 18) and native (GraalVM Community 21,
Serial GC) regressions each restored positions 1, 4, 24 and 60 after 100 consumed
inputs, compared eight subsequent inputs at every position, rejected a corrupted
state witness, and continued the original game after rejection. The WebImage
regression ran through Node 24 nested workers, restored positions 24 and 4,
continued eight inputs each time, and checked monotonic public prompt IDs and
absence of private journal events in the caller's stream.

The full relay/native-node networking suite passed all 22 regressions in 271
seconds, including rewind with an external bot, retained game identity, human-seat
resync and continued play. It exposed decimal
serialization of restored vote IDs, now fixed by preserving integer JSON values;
the host also validates the candidate's public state/prompt before replacement.

The Java harness build and existing regressions, TypeScript build, targeted ESLint,
Rust formatting, native Clippy, JVM backend check, and desktop `forge-room` compile
check passed. Native library and WebImage artifacts were rebuilt. No manual UI
verification was run. Linux/G1 and Windows runtime results remain for CI, where
native rewind and the production image's worker regression are now configured.

## Recorded local evidence (2026-10-19)

The complete six-fixture matrix passed on macOS with Zulu JDK 18. The constructed
fixture and delivery probe were rerun with Node 24 after the final snapshot
metadata/packaging validation changes; the other matrix runs used Node 22.
These measurements precede extraction onto current `main`; subsequent integration
checks are recorded in the PR. Linux/JDK 21 and native/WASM CI results should be
checked on the published commits.

| Fixture            | Source decisions | Max turn | Max stack | Successful restores | Journal bytes | Cold restore range |
| ------------------ | ---------------: | -------: | --------: | ------------------: | ------------: | -----------------: |
| constructed        |              192 |        8 |         2 |                  11 |       127,327 |          6.2–8.4 s |
| hidden-random      |              312 |        9 |         1 |                  10 |       307,336 |          6.6–9.3 s |
| commander-triggers |              412 |        9 |         3 |                  10 |       193,035 |         7.3–13.8 s |
| stack-responses    |              332 |       12 |         3 |                  12 |       272,411 |          6.9–9.6 s |
| random-coins       |              192 |        4 |         1 |                   8 |       216,917 |         7.0–10.6 s |
| long-game          |             1012 |       55 |         1 |                   8 |     3,257,429 |         7.0–18.6 s |

Source decisions include the 12-input continuation beyond the late saved boundary.
Every source process was killed with SIGKILL. Each saved boundary was restored
twice in independent processes, once with perturbed JVM identity hashing, and
continued for 12 inputs. The additional constructed restoration enables the
acknowledgement barrier and also continues for 12 inputs. Timings include process
startup, asset identification and replay; several fixtures ran concurrently, so
these are correctness-run measurements rather than a performance benchmark.

Eight constructed negative cases reject changed prompts, hidden-state witnesses,
RNG traces, seeds, terminal state, sequence entries, boundary length and artifact
identity. Failed restoration leaves no accessible session. The Room regression
failed before the fork patch at identity perturbations 2, 9, 13 and 14, and passes
with the patch.

Additional checks passed:

- Java reactor build, four existing harness regression mains and four Room-order
  JVM runs; 81-input journal delivery/replay probe and its failure-path checks.
- `cargo test -p self-hosted-node --lib`: 16 tests.
- `cargo test -p manabrew-server --lib`: 33 tests.
- `REGRESSION_NODE_ENGINE_BACKEND=forge cargo test -p networking-tests --test networking_regression -- --ignored`:
  21 tests, using real JVM Forge execution (209 seconds).
- Targeted ESLint, `tsc -b`, and whitespace checks.

Before extraction, the original journal probe, two node history tests, and SQLite
store probe passed, including atomic append, retry/fencing and four relay-store
restart/crash cases. The full original hosted-takeover probe was **not rerun**.
The foundation networking suite is not evidence for the deferred takeover state
machine. Graal native and WASM artifacts were not rebuilt or runtime-tested in
this pass; their journal transport remains in the diff, with types updated to v2.

Local audit logs remain under `tmp/refocus-*` in the original extraction worktree.
The Forge fix is published and pinned. Before leaving draft, check Linux/JDK 21
and native/WASM build CI on the resulting commits. Keep broader card/printing
and dependency/counter coverage listed as limitations rather than claiming
universal Forge determinism.

## Preserved work and PR sequence

The complete original implementation at `aceee1ff5` remains in
[PR #1026](https://github.com/witchesofthehill/manabrew/pull/1026), on the unchanged
`feat/relay-journal-shadow-engines` branch, and locally as
`preserve/pr-1026-host-recovery`. The independently extracted foundation is on
`feat/forge-decision-replay-foundation`, based on current `main`; its history does
not include the deferred distributed implementation.

1. This foundation, interactive journal rewind, and the small Forge ordering patch. Review the journal,
   restoration API, isolation restrictions and regression evidence first.
2. Durable SQLite storage and cold host takeover. Port the preserved store,
   transport and node orchestration onto journal v2 and reuse the verified
   restoration API instead of keeping a second replay implementation. Keep the
   GameState takeover fallback out of the supported recovery path.
3. Durable user-facing saved-game replay and richer redacted logs, depending on 1 and a
   persistence/export policy.
4. Shadow engines, parity and migration, after determinism/versioning contracts
   have broader evidence. No warm replicas are introduced here.

The split requires adapting node replay to the new engine API and journal v2;
it does not duplicate storage or ownership code. The existing distributed code
and its tests remain recoverable from the preserved branch.

Before the takeover follow-up is reviewable, address these findings:

- `ResumeRoom` broadcasts `HostChanged` before the node fences the writer and
  replays a concurrently committed suffix. A suffix replay failure can therefore
  become visible after an apparently successful takeover. Claim/fence, verify
  the final prefix, and publish must be separate transitions.
- `replay_entries` acknowledges the last input and returns without checking the
  resulting pending decision or hidden state. Use the foundation's final witness.
- A 20-second disconnect timer is a suspicion threshold, not proof of host death.
  Reconnection and offer/token races need an explicit state-transition contract.
- Preserve the fresh-process isolation used by interactive rewind when integrating
  host takeover. Reintroducing shared-isolate concurrency requires an independent
  proof of per-game counter/cache isolation.
- Add fault tests for failure while replaying the final suffix, source death during
  append, losing the claim reply, competing recoverers, and reconnect during an
  outstanding handoff. Existing probes cover store atomicity, fencing, lost append
  replies, relay restart, initial replay rejection, and a successful takeover, but
  do not establish all these transitions.
