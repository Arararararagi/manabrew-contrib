# Decision journal and rewind

PvP and external Manabot games use `decisionJournal` and `journalRewind`.
The Journal tab shows redacted consumed decisions from `gameView.checkpoints`;
Forge AI games retain legacy snapshots. Internal Forge AI is not deterministic
under replay and is rejected by journal mode.

## Reconstruction and promotion

An approved restore vote freezes the authoritative engine. A fresh worker/process
replays the selected prefix from the original start request and seed, checking
every prompt, deciding seat, state witness and RNG position. The candidate becomes
authoritative only after terminal verification and publication of its final views.
Then the source is terminated. Failure disposes of the candidate and resumes the
source. There is no idle spare or shadow engine.

- Browser/WebView: `forge-engine.worker.js` supervises the engine and buffers
  candidate SABs until `forge:replay_ready`. Directive lanes and queued directives
  survive promotion; prompt IDs advance so stale responses cannot be accepted.
- JVM/native: `journal_engine.rs` owns subprocess reconstruction and promotion.
  Replay has a 120-second total deadline; subprocess RPCs have 60-second deadlines
  and poll cancellation every 20 ms. Failed transports are killed and reaped,
  because their uncorrelated late replies cannot safely be reused.
- Ending the game or losing the authoritative worker cancels reconstruction.
  A queued non-restore directive prevents native promotion.

Forge global IDs and caches require one journal game per worker/process. Never
reconstruct inside the authoritative engine. Rewind temporarily holds two engines
and their card databases; container memory must allow for concurrent candidates.

## History and verification

`DecisionHistory` retains at most 64 MiB or 50,000 consumed inputs. Reaching the cap
stops recording but preserves rewind within the retained prefix. Successful rewind
discards the abandoned suffix. Votes and rewind requests are orchestration, not
recorded gameplay inputs. Full journals and witnesses contain hidden information
and must remain private to the engine host.

Verification covers canonical prompts, every seat's view, spectator state, ordered
card identities in all zones (including libraries), and the primitive RNG stream.
It is not a serialization of every Forge field: delayed triggers and stack locals
are reconstructed by execution. Tests must compare continued play, not only the
restored board. Cross-runtime, cross-artifact and cross-version replay are unsupported.

Threaded RPCs read immutable views published by the game thread before prompts,
revisions and game over; they must never traverse live Forge zones. During replay,
UI views and checkpoint rows are deferred until the destination. Per-input
verification and remembered-hand updates still run.

## Delivery API

`DecisionJournal` records inputs before dispatch. Version 2 batches contain the
exact `startRequest`, then ordered entries with `sequence`, `playerIndex`,
`prompt`, `action` and `verification`. Consumers choose either drained delivery or
`readDecisionJournal` plus cumulative `acknowledgeDecisionJournal`; never mix modes.
Acknowledgement cannot exceed the prefix already read. Retries and duplicate
acknowledgements are supported.

The delivery queue is limited to 4096 entries or 8 MiB. Overflow or legacy snapshot
restoration invalidates delivery explicitly. This queue is separate from retained
interactive history. `decisionJournalCommitBarrier` holds startup until sequence 0
is acknowledged and holds each decision until its own acknowledgement; acknowledge
only after durable receipt. Interactive rewind owns delivery and rejects this flag.

`exportReplaySnapshot` packages a pending boundary and prefix;
`restoreReplaySnapshot` reconstructs and verifies it in an isolated JVM. Export is
queued on the game thread, so acknowledge pending commit barriers first. Snapshots
pin the harness artifact, assets and effective preferences; these must remain
immutable during a session. Durable storage and host takeover are separate work.

## Regression checks

Use Node 24 and JDK 18–21. Build the relevant harness/native/WebImage artifacts first.
Tests live in `scripts/forge-tests/`:

- `yarn test:forge-journal`: delivery, acknowledgements, barriers and invalidation.
- `yarn test:forge-replay`: fresh-JVM reconstruction, hidden choices, multiplayer,
  stack responses, RNG, corrupted snapshots and continued play.
- `yarn test:forge-rewind [--native <node binary>]`: votes, rewind and failure recovery.
- `yarn test:forge-supervisor`: command/SAB handling, promotion and teardown.
- `yarn test:forge-rewind-wasm`: real WebImage replacements and continued play.

`yarn build:harness` runs seat/limit, ordering and snapshot-concurrency regressions.
Rust `journal_engine::tests` and `subprocess_tests` cover hangs, exits, cancellation
and child cleanup. The networking rewind case requires
`REGRESSION_NODE_ENGINE_BACKEND=forge` to exercise Forge rather than the default Rust engine.
