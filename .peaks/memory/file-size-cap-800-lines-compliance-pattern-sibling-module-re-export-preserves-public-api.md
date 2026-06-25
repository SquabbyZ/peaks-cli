---
name: file-size-cap-800-lines-compliance-pattern-sibling-module-re-export-preserves-public-api
description: File-size cap (800 lines) compliance pattern: sibling module + re-export preserves public API
metadata:
  type: decision
  sourceArtifact: .peaks/_runtime/2026-06-25-session-fe94e7/txt/handoff-008-p0-file-size-cap.md
---

On 2026-06-25, the peaks-cli project split 3 over-cap service files (`doctor-service.ts` 1067, `project-memory-service.ts` 1028, `config-service.ts` 911) into sibling modules with re-exports. All 3 splits achieved the 800-line cap and preserved public API: the original files re-export every moved symbol via `export { ... } from './<sibling>.js'`. The same pattern was used for `request-artifact-service.ts` (1101→788) in the 2.9.0 release.

Stable pattern for future refactors:
1. Move cohesive-concern functions to a new sibling file under the same directory.
2. The original file keeps the public API types + main function, and re-exports moved symbols.
3. No call-site changes needed (re-exports cover the public surface).
4. The sibling file stays ≤ 600 lines (200-line buffer under the 800 hard cap).

This pattern was validated across 4 service files (2.9.0 + 2.10.0 cycle 1) with 100% re-export coverage verified by QA.

Stable rule for future RD sub-agents: when splitting a service file for size, the re-export pattern is the default; deviation requires a Karpathy #3 surgical justification in the RD report.
