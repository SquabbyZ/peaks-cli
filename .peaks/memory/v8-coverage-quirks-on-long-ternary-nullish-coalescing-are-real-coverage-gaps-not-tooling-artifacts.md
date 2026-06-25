---
name: v8-coverage-quirks-on-long-ternary-nullish-coalescing-are-real-coverage-gaps-not-tooling-artifacts
description: v8 coverage quirks on long ternary / nullish-coalescing are real coverage gaps, not tooling artifacts
metadata:
  type: lesson
  sourceArtifact: .peaks/_runtime/2026-06-25-session-fe94e7/txt/handoff-008-p0-file-size-cap.md
---

On 2026-06-25, refactoring `src/services/config/config-service.ts` L371/L550/L576/L617 from single-line ternary / nullish-coalescing into multi-line equivalents did NOT push branches coverage from 94.38% to 100%. The refactor actually REGRESSED lines/statements 100% → 99.53% by surfacing a new uncovered branch (the `isRecord(source) === false` path in `getConfig` at L585-586). Cycle 1's "v8 reporter quirk" hypothesis was FALSIFIED.

Stable rule for future RD sub-agents: when coverage reports branches < 100% on a file, **never assume it's a v8 quirk**. Read the file, find the exact uncovered lines via the coverage report, and assume it's a real branch until proven otherwise. The v8 reporter may have quirks, but the symptoms are usually genuine.

Stable rule for future Solo orchestrators: a coverage closure cycle that includes "v8 quirk refactor" should be paired with a hypothesis-test outcome — if branches stays < 100%, the orchestrator should NOT spend another cycle on the same hypothesis.

Stable rule for vitest.config.ts maintainers: the 100% branches threshold on a 600+ line service file (config-service.ts at 630) is fragile; small changes in expression shape can flip the threshold. Consider threshold tuning per file-size bucket if the project values stability over strict 100%.
