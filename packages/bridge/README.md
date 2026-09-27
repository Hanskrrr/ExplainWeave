# Cowork handoff bridge

This package creates and validates data only. It does not launch applications,
read source files, write task packs, choose return-file locations or edit articles.

1. `prepareTaskPack(document, options)` captures selected source nodes and the
   question/ancestor context needed for a writing task. It includes a content
   fingerprint and a restrictive JSON return schema.
2. The host writes `serializeTaskPack(task)` to a task-local file. Use
   `buildCoworkURL({ q, folder, file })` with absolute paths and a short instruction.
   Text and path parameters are URL-encoded. Application length guards reject long
   prompts instead of silently truncating them; put article content in the file.
3. On import, validate the locally archived task with `parseTaskPack(raw)`. Never
   cast an arbitrary JSON file into the expected-task type.
4. `parseReturnDraft(raw, task, currentDocument)` validates the return schema,
   task/document/node/question identifiers, baseline fingerprint and Markdown.
   Extra fields such as file paths or filesystem edits are rejected. The result is
   a **candidate**, not an instruction to apply it.
5. Check `assertTaskCurrent(task, document)` again at adoption time if the article
   may have changed after import. Omitting the optional current document from
   `parseReturnDraft` checks task correlation only; it cannot detect later changes
   to a document it has not received.

Fingerprints include source content, node order and question/relationship state;
they exclude reading position and the aggregate save revision. Checksums and task
IDs correlate returns but do not authenticate who wrote a file. Markdown may mention
paths as prose; no returned path is interpreted as a destination or opened.

Opening `claude://cowork/new` prepares a client handoff. This package does not report
that a prompt was sent or that a Cowork task completed. Live-client verification is
separate from these offline protocol tests.
