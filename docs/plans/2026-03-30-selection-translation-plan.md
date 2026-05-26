# Selection Translation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add selection-based hover translation and context-menu vocabulary actions to the Chrome extension while reusing the existing storage and model configuration.

**Architecture:** `content.js` handles selection capture and the floating card UI, `background.js` owns context menus, short-text translation, and vocabulary writes, and `shared.js` provides normalization and message constants. The feature remains lightweight and independent from the full-page inline annotation pipeline.

**Tech Stack:** Manifest V3, vanilla JavaScript, HTML/CSS, `chrome.storage.local`, `chrome.contextMenus`, `fetch`.

---

### Task 1: Add shared selection helpers

**Files:**
- Modify: `shared.js`
- Test: `tests/core.test.js`

**Step 1: Write the failing test**

- Add tests for selection validation, selection normalization, and new message constants.

**Step 2: Run test to verify it fails**

Run: `node --test tests/core.test.js`
Expected: FAIL because the new helper APIs do not exist yet.

**Step 3: Write minimal implementation**

- Add helper functions for normalizing selected text and validating whether a selection should trigger the floating card.
- Add message constants for selection translation and vocabulary writes.

**Step 4: Run test to verify it passes**

Run: `node --test tests/core.test.js`
Expected: PASS for the new helper tests and no regressions.

### Task 2: Add background selection translation and context menus

**Files:**
- Modify: `background.js`

**Step 1: Write the failing test surrogate**

- Add helper tests in `tests/core.test.js` for vocabulary update behavior if needed.
- Confirm manually that right-click actions do not exist before implementation.

**Step 2: Run test to verify it fails**

Run: `node --test tests/core.test.js`
Expected: FAIL for any new shared helper coverage, and manual check shows no menu items.

**Step 3: Write minimal implementation**

- Register `chrome.contextMenus` items for selected text.
- Add `TRANSLATE_SELECTION` and `ADD_WORD_TO_LIST` message handlers.
- Reuse existing storage merge logic for known/learning lists.
- Add a small in-memory cache for repeated short-text translations.

**Step 4: Run test to verify it passes**

Run: `node --test tests/core.test.js`
Expected: PASS.

### Task 3: Build floating selection card in content script

**Files:**
- Modify: `content.js`

**Step 1: Write the failing test surrogate**

- Manual expected failure: selecting text on a page shows no floating card.

**Step 2: Implement minimal selection card flow**

- Listen for selection changes.
- Validate short English selections.
- Request translation from background.
- Render a lightweight floating card near the selection.
- Add buttons for known/learning words and copy translation.

**Step 3: Run verification**

Run manually in Chrome on a docs page.
Expected: selecting an English word or short phrase shows the floating card and actions work.

### Task 4: Polish dismissal, caching, and verification

**Files:**
- Modify: `content.js`
- Modify: `background.js`
- Modify: `popup.js`

**Step 1: Write the failing test surrogate**

- Manual expected failure: card does not hide cleanly on scroll, click-away, or Escape.

**Step 2: Implement minimal polish**

- Close the card on click-away, Escape, and significant scroll.
- Ensure adding a word updates storage cleanly without duplicates.
- Keep popup counts accurate because popup already reads latest storage.

**Step 3: Run verification**

Run manually in Chrome.
Expected: card lifecycle is clean, context menu writes work, popup reflects updated vocabulary.

### Task 5: Final verification

**Files:**
- Verify: `shared.js`
- Verify: `background.js`
- Verify: `content.js`
- Verify: `popup.js`
- Verify: `tests/core.test.js`

**Step 1: Run automated verification**

Run: `node --test tests/core.test.js`
Expected: all tests pass.

**Step 2: Run syntax verification**

Run: `node --check shared.js && node --check background.js && node --check content.js && node --check popup.js && node --check options.js`
Expected: all scripts parse successfully.

**Step 3: Manual browser verification**

- Reload the extension in `chrome://extensions`
- Test selection card on an English docs page
- Test both context menu items with selected text
- Open popup and confirm vocabulary counts update

Expected: all interactions work without page breakage.
