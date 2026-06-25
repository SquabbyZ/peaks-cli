---
name: always-verify-vitest-config-ts-carve-out-list-against-actual-file-before-planning
description: Always verify vitest.config.ts carve-out list against actual file before planning
metadata:
  type: lesson
  sourceArtifact: .peaks/_runtime/2026-06-25-session-fe94e7/txt/handoff-008-p0-file-size-cap.md
---

On 2026-06-25, the parent PRD for `008-2026-06-25-p0-file-size-cap-refactor` claimed 3 files needed their carve-outs removed from `vitest.config.ts`: `doctor-service.ts`, `project-memory-service.ts`, `config-service.ts`. Cycle 1 QA4 found that `project-memory-service.ts` was NEVER in the carve-out list — only the other 2 were. The parent PRD was written from memory, not from a fresh `grep -n vitest.config.ts`.

Stable rule for future PRD/RD authors: **never state a fact about a configuration file in a PRD without grepping the file in the same planning turn**. Add a "verify" step to the planning checklist.

Stable rule for future Solo orchestrators: when launching the cycle 1 fan-out, the orchestrator should cross-check the parent PRD's claims about file lists, scope, and boundaries against the actual filesystem. Cheap 5-second grep saves a cycle of QA confusion.
