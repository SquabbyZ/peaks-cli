---
name: large-service-file-splits-must-plan-coverage-for-new-sibling-files-upfront
description: Large service file splits must plan coverage for new sibling files upfront
metadata:
  type: lesson
  sourceArtifact: .peaks/_runtime/2026-06-25-session-fe94e7/txt/handoff-008-p0-file-size-cap.md
---

On 2026-06-25, the file-size cap refactor split `doctor-service.ts` (1067→623), `project-memory-service.ts` (1028→427), and `config-service.ts` (911→630) into 8 new sibling modules. Each new sibling file entered the 100% coverage threshold the moment it was created. The cycle 1 RD sub-agents preserved the public API via re-exports but did not write tests for the new siblings, treating them as "internal" because the existing tests still passed. Cycle 2's QA4 caught this — coverage on `config-service.ts` dropped to 70-85% once the carve-out was lifted. Cycle 2 RD had to add 32 new tests across 6 new test files to close the gap.

Stable rule for future RD sub-agents splitting large files: **a service split is NOT surgical-complete when the public API is preserved**. The new siblings are new files that immediately enter the coverage threshold. Either (a) write tests for the new siblings in the same cycle, or (b) extend the carve-out list in vitest.config.ts as part of the slice. Document the choice in the RD report.

Stable rule for future PRD authors: when a slice goal says "remove the carve-out", include "and write tests for any new sibling files created by the split" as an explicit AC. The current parent PRD did not, and that's why cycle 1 missed it.
