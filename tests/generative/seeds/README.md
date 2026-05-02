# Captured fast-check failure seeds

When the generative buyer-journey property fails (`tests/generative/buyer-journey.test.js`), the runner auto-saves the failing seed + path + counterexample to this directory as `seed-{NNNN}.json`.

Every captured seed is then **automatically replayed** as a permanent regression test — it shows up under `describe('captured seeds — permanent regressions')` in the next test run, even after the original bug is fixed.

## Anatomy of a seed file

```json
{
  "capturedAt": "2026-05-02T01:23:45.678Z",
  "seed": -1234567890,
  "path": "0:1:0:1:1",
  "counterexample": "[[Purchase(buyer_alpha, seed=1, $1, 1L), …]]",
  "commandSchema": "buyer-journey-v1",
  "firstError": "AssertionError: expected 2 to be less than or equal to 1"
}
```

- **seed + path** — what fast-check needs to deterministically reconstruct the failing journey
- **counterexample** — the human-readable shrunk command sequence
- **commandSchema** — versioned so future grammar changes can flag stale seeds
- **firstError** — the assertion that failed; lets you grep across seeds for related issues

## Lifecycle

- A new seed file commits → permanent regression added
- The fix lands → next run, the seed replays and passes (still asserts the bug stays fixed)
- Grammar changes (new commands / invariants) → bump `commandSchema` in the test runner, decide per-seed whether to delete or update

## Manual capture

If you have a failing seed from a CI run that didn't auto-save (rare — only the initial fc.assert path does), drop a JSON file matching the schema above and it'll replay on next run.
