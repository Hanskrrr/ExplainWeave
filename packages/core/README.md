# ExplainWeave core

Pure TypeScript document operations. This package does not read files, call models,
or write to Obsidian. The caller owns durable transactions and sidecar recovery.

- `createDocument` and `readDocument` preserve source text. Importing an unmarked
  article creates one node; boundaries are explicit, never inferred from headings.
  Empty and frontmatter-only files may have zero body nodes.
- `writeDocument` returns managed Markdown and a JSON sidecar. The sidecar stores
  identity, hashes, question/evidence records and reading position, not another copy
  of the current body. `exportCleanMarkdown` removes only managed node markers.
- `applyOperation` creates immutable state plus an undo token. Only touched/new
  boundaries receive necessary separators. A full serialization/parse check rejects
  operations whose node markers would be swallowed by unfinished Markdown blocks.
- `split-node` requires an explicit blank-line boundary outside protected code,
  display math and HTML blocks. Ambiguous list, quote and indented continuations are
  conservatively refused; this is not a complete Markdown AST editor.
- `getQuestionCoverage` computes explanation coverage at a reading cursor. Future
  answers do not count as reached. Links bind question and answer versions, the
  question's origin paragraph, ancestor questions, and any explicit prerequisites.
  Prerequisites must occur no later than the answer. A question's origin is a version
  binding, not automatically a prerequisite ordering edge.
- `undoOperation` rejects intervening content changes, but permits navigation and
  sequential undo. Current valid reading position survives content undo. Undo tokens
  contain historical content and must be stored separately from current metadata if
  a host chooses to persist them.
- `reconcileDocument` uses actual Markdown order and explicit node markers. It
  preserves orphaned questions/evidence instead of deleting them. Missing all markers
  in a previously multi-node document produces read-only state. Malformed sidecars
  and duplicate markers throw `CoreError`; callers must preserve existing files and
  offer repair/reload, never replace failed reads with a blank document.

Question text, origin paragraphs and answer content can change independently.
`needs-review` means evidence is stale, missing or structurally inconsistent; it never
means the user failed to understand. The core validates evidence ranges and versions,
but does not claim to judge whether a passage semantically answers a question.

Run `pnpm exec vitest run packages/core/tests/core.test.ts` from the workspace root.
