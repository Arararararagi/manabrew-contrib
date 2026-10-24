# Forge WASM package

Read `/AGENTS.md` and `/scripts/AGENTS.md` for packaging workflows.

`yarn build:forge-wasm-package --stub-engine` followed by `yarn verify:forge-wasm-package` checks packing, consumer types, and Vite bundling only; never publish a stub build.

`decisionJournal: true` makes an ordinary engine emit `forge:journal` batches, the hidden consumed-input stream shared with JVM and native (see the harness AGENTS file). Older artifacts ignore the option, so require the initial manifest.

`journalRewind: true` requires `decisionJournal` and external decision makers. The worker becomes a responsive supervisor with one engine child. It starts a fresh candidate on approved rewind, withholds its SABs until replay verification, then replaces the source; failure resumes the source. Full journals and replay witnesses remain private inside this boundary. Public prompt IDs remain monotonic across swaps. `node-worker.cjs` mirrors nested workers for the real WebImage integration regression (`yarn test:forge-rewind-wasm`); rebuild the WebImage after Java transport changes.

The supervisor owns control-command responses while its leaf is blocked. Retain directive SABs and their UI queues across promotion; only prompt SABs are replaced. Stop every child on game termination/source failure. A stale prompt response must return to directive polling. `yarn test:forge-supervisor` exercises these interleavings without compiling WebImage.
