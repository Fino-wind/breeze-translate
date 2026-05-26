# NanFeng Inline Translator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a direct-run Chrome Manifest V3 extension that stores user vocabulary, calls an OpenAI-compatible LLM, and annotates English text nodes inline without changing page HTML structure.

**Architecture:** The extension uses `popup` for vocabulary management and launch actions, `options` for API configuration, `background` for centralized storage and LLM requests, and `content` for DOM-safe traversal, restore, and inline text replacement. Shared behavior stays minimal and plain ES modules are avoided to keep the extension directly loadable.

**Tech Stack:** Manifest V3, vanilla JavaScript, HTML5, CSS3, `chrome.storage.local`, `fetch`, Chrome messaging APIs.

---

### Task 1: Scaffold the extension shell

**Files:**
- Create: `manifest.json`
- Create: `popup.html`
- Create: `popup.css`
- Create: `popup.js`
- Create: `options.html`
- Create: `options.css`
- Create: `options.js`
- Create: `background.js`
- Create: `content.js`

**Step 1: Define the extension file map and defaults**

- Add `manifest.json` with MV3 metadata, permissions, host permissions, popup, options page, background service worker, and content script registration.
- Add static HTML shells for popup and options with placeholder containers sized for Chrome extension panels.
- Add JS entry files with message constants, default storage shape, and bootstrapping stubs.

**Step 2: Run a syntax sanity check on the empty shell**

Run: `node --check popup.js && node --check options.js && node --check background.js && node --check content.js`
Expected: all files pass syntax parsing.

**Step 3: Load unpacked extension in Chrome manually**

Run manually: open `chrome://extensions`, enable developer mode, load `/Users/finochat/Desktop/Nanfengword`
Expected: extension loads without manifest errors.

### Task 2: Implement storage defaults and options page

**Files:**
- Modify: `options.html`
- Modify: `options.css`
- Modify: `options.js`
- Modify: `background.js`

**Step 1: Write a minimal manual failing check**

- In Chrome, open Options page before implementation.
- Expected initial failure: fields do not load defaults, save action does nothing.

**Step 2: Implement storage initialization and form hydration**

- In `background.js`, create helpers to read and merge default storage.
- In `options.js`, load settings on startup, bind inputs, and save them into `chrome.storage.local`.
- In `options.css`, apply the approved minimalist visual system and save state styles.

**Step 3: Re-run validation**

Run manually: open Options page, edit values, click save, reload page.
Expected: saved values persist and success state appears.

### Task 3: Implement popup vocabulary management

**Files:**
- Modify: `popup.html`
- Modify: `popup.css`
- Modify: `popup.js`
- Modify: `background.js`

**Step 1: Write a minimal manual failing check**

- Open Popup before implementation.
- Expected initial failure: vocabulary lists are empty placeholders without add/delete/clear behavior.

**Step 2: Implement vocabulary state and UI actions**

- In `popup.js`, load vocabulary from storage and render known/learning sections.
- Add handlers for add, remove, clear, and mutual exclusion between the two lists.
- Add status messaging and options-page navigation.
- In `popup.css`, style cards, chips, inputs, and the primary CTA.

**Step 3: Re-run validation**

Run manually: add duplicate words, move a word between lists, clear each list.
Expected: words are lowercased, deduplicated, and never exist in both lists at once.

### Task 4: Implement background LLM request pipeline

**Files:**
- Modify: `background.js`

**Step 1: Write a minimal manual failing check**

- Trigger an annotation request from the console or popup before request logic exists.
- Expected initial failure: background cannot build or send the model request.

**Step 2: Implement request helpers**

- Add message handlers for `ANNOTATE_TEXT` and storage getters.
- Build the fixed system prompt with interpolated known and learning words.
- Call `fetch` against `{baseUrl}/chat/completions`.
- Normalize success payloads and user-facing error payloads.

**Step 3: Re-run validation**

Run manually with a valid compatible endpoint.
Expected: background returns plain processed text or a normalized error object.

### Task 5: Implement content-script scan, restore, and replacement

**Files:**
- Modify: `content.js`

**Step 1: Write a minimal manual failing check**

- Open a sample English page and click the popup CTA before content logic exists.
- Expected initial failure: page text does not change or duplicate annotation handling is missing.

**Step 2: Implement DOM-safe traversal**

- Register a message handler for `START_ANNOTATION`.
- Collect eligible text nodes while skipping forbidden containers and non-natural-language fragments.
- Cache original text, restore previous runs, then process nodes with a small concurrency limit.
- Replace only `textNode.nodeValue` when returned text passes safety checks.

**Step 3: Re-run validation**

Run manually on an article page with links, bold text, and list items.
Expected: inline annotations appear inside text only, and HTML structure remains intact.

### Task 6: Polish UI states and end-to-end behavior

**Files:**
- Modify: `popup.js`
- Modify: `popup.css`
- Modify: `options.js`
- Modify: `options.css`
- Modify: `content.js`
- Modify: `background.js`

**Step 1: Write a minimal manual failing check**

- Exercise invalid settings, API failures, and repeated runs.
- Expected initial failure: weak feedback, unclear status, or missing rerun restoration.

**Step 2: Implement final polish**

- Add loading, success, error, and completion status surfaces in popup and options.
- Ensure repeated annotation runs restore original text before reprocessing.
- Tighten copy, transitions, spacing, and dark-theme variables.

**Step 3: Re-run validation**

Run manually across at least one success page and one failure case.
Expected: UI states are clear, recoverable, and visually consistent.

### Task 7: Verify deliverable and package readiness

**Files:**
- Verify: `manifest.json`
- Verify: `popup.html`
- Verify: `popup.css`
- Verify: `popup.js`
- Verify: `options.html`
- Verify: `options.css`
- Verify: `options.js`
- Verify: `background.js`
- Verify: `content.js`

**Step 1: Run final syntax verification**

Run: `node --check popup.js && node --check options.js && node --check background.js && node --check content.js`
Expected: all files pass syntax checks.

**Step 2: Run final manual extension verification**

Run manually: reload unpacked extension, save settings, manage words, annotate an English page twice.
Expected: settings persist, lists behave correctly, annotations appear, second run restores and reapplies cleanly.

**Step 3: Package readiness review**

- Confirm required files exist.
- Confirm no bundler or extra runtime dependency is required.
- Confirm user can load the folder directly as an unpacked extension.

**Step 4: Commit**

Run if the workspace becomes a git repo: `git add manifest.json popup.html popup.css popup.js options.html options.css options.js background.js content.js docs/plans && git commit -m "feat: build NanFeng inline translator extension"`
Expected: new feature commit recorded.
