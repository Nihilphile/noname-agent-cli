# Target capture engine excerpts

`source-excerpts.json` contains read-only snapshots from the user's local noname
v1.11.3 distribution, taken on 2026-09-16. The snippets are distributed under
GPL-3.0-only, the same license as this CLI; see the package `LICENSE`.

Every excerpt records its original repository-relative path, one-based inclusive
line interval, SHA-256 of the original complete file bytes, and SHA-256 of the
stored excerpt. Stored excerpts normalize CRLF to LF. No installed game path is
needed to run the tests. Hash checks establish fixture integrity; they do not
claim the currently installed game still matches the recorded file hashes.

The regression executes original `GameEvent.start`, `loop`, `waitNext`, `then`,
`forResult`, and step accessors, plus `ArrayCompiler.compile`, in a minimal
harness. It also executes the original `Player.useCard` single-card split block
with the official borrowed-sword definition as its source contract.

The harness supplies player identities, event queues, lifecycle hooks, manager,
pause manager, and no-op skip/trigger checks. The compiled-step case supplies
already-split step functions; it does not execute the old source parser. These
tests prove capture ordering on those pinned engine paths, not complete engine
execution, character rule correctness, UI visibility, or natural game acceptance.
