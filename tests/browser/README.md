# Browser integration fixture

This standalone test fixture mounts the real Notebook UI and controller with the
real domain and transactional storage code. Files live only in an in-memory map;
the fixture does not open or write an Obsidian Vault. Model generation uses the
explicitly labelled offline mock backend.

Run from the repository root:

```sh
pnpm exec playwright install chromium
pnpm exec playwright test --config tests/browser/playwright.config.ts
```

The test runner builds and starts its own server on `127.0.0.1:4177`. For manual
inspection, run `node tests/browser/serve.mjs` and open that address.

Coverage includes wide and narrow layouts, adding questions, exact source evidence,
reading-relative explanation status, real CodeMirror contenteditable edits, stale
evidence, undo, returning from a question branch, and editing/cancelling generation.
Browser input tests do not replace manual testing with a real OS IME in Obsidian.
Markdown uses the safe source-text fallback; this fixture does not test Obsidian's
Markdown renderer or its application-level focus and lifecycle behavior.

Screenshots are written to `explainweave-browser-artifacts` in the OS temporary
directory. Set `EXPLAINWEAVE_BROWSER_ARTIFACTS` to choose another directory. Failure
screenshots and traces go to `explainweave-browser-results` in the OS temporary directory.
