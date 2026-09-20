# Live policy runtime

`config/live-policy.example.json` is strict declarative JSON. Its top-level shape is exactly `schemaVersion` and `rules`. A rule has an identifier, `block` or `normal` safety class, integer priority, finite weight of at least one, finite predicates, and a bounded command sequence. It accepts only a finite allow-list of observation fields, comparators and reviewed command IDs; JavaScript, selectors, URLs and costs are rejected.

Safety blocks win first. Remaining rules are ordered by descending integer priority and finite weight, with JSON order as the final tie-break. Each sequence step receives a fresh observation and stops on a failed, skipped or ambiguous outcome. `live run --once --dry-run` uses the same planner and makes no command.

Command cost is immutable adapter metadata. The initial verified command is `hero.encourage`, with 25 prana and zero charges. JSON cannot lower that cost or authorize charge handling. A live command requires a configured single-account identity and an adapter-derived stable diary event ID. The final snapshot must have the same hero and event as the step's first snapshot and have `mode=idle`; this avoids authorizing a click against a new event or active adventure. An intent hashes the fixed command, hero and event, without a policy rule ID, so renaming JSON rules cannot enable a duplicate click. An ambiguous prior operation remains blocked by command ID.

The adapter invokes the runner's journal gate only after its bounded reaction delay and final DOM recheck. The runner then re-evaluates the JSON policy, verifies the immutable command metadata, persists the final observation and decision, checks its shared browser lease, and atomically records the operation. Ambiguity is never retried.

The runner is adapter-neutral. The Orca adapter is host-only; browser-runtime/Playwright remains a separate optional runtime. No unsupported expedition or ZPG command is configured by the example policy. The application runs on Bun 1.4.2; `browser.Dockerfile` provides the optional Chromium image.
