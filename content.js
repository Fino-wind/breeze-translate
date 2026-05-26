const contentCore = globalThis.NanFengCore;
const trackedBlocks = new Map();
let activeRunId = 0;

const CANDIDATE_SELECTOR = 'article, main, section, blockquote, p, li, td, th, figcaption, h1, h2, h3, h4, h5, h6, div, dd, dt, details, summary';
const BLOCKED_SELECTOR = 'script, style, code, pre, textarea, input, noscript, button, nav, svg, canvas, video, audio';
const MAX_BATCH_SIZE = 8;
const MAX_BATCH_CHARS = 3000;
const MAX_CONCURRENT_BATCHES = 4;
const VIEWPORT_MARGIN = 999999;
const SELECTION_CARD_ID = 'nanfeng-selection-card';
let selectionCard = null;
let selectionHideTimer = 0;
let lastSelectionText = '';

function isElementVisible(element) {
  if (!element || !(element instanceof Element)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false;
  }

  return element.getClientRects().length > 0;
}

function isEditable(element) {
  return Boolean(element && element.closest('[contenteditable="true"], [contenteditable=""], [role="textbox"]'));
}

function isNearViewport(element) {
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  return rect.bottom >= -VIEWPORT_MARGIN && rect.top <= viewportHeight + VIEWPORT_MARGIN;
}

function hasNestedCandidate(element) {
  return Array.from(element.children).some(function hasNested(child) {
    return child.matches && child.matches(CANDIDATE_SELECTOR);
  });
}

function hasMeaningfulTextNodes(element) {
  return Array.from(element.childNodes).some(function hasText(node) {
    return node.nodeType === Node.TEXT_NODE && /\S/.test(node.nodeValue || '');
  });
}

function readCurrentHtml(element) {
  return element.innerHTML;
}

function escapeHtml(text) {
  const temp = document.createElement('div');
  temp.textContent = text;
  return temp.innerHTML;
}

function writeCurrentHtml(element, html) {
  console.log('[breeze] WRITE tag=' + element.tagName + ' len=' + html.length + ' has中文=' + /[一-鿿]/.test(html));
  element.textContent = '';
  element.insertAdjacentHTML('afterbegin', html);
}

function buildPlaceholderMap(nodes) {
  const placeholderMap = new Map();
  let placeholderIndex = 0;
  let serializedText = '';

  nodes.forEach(function appendNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      serializedText += node.nodeValue || '';
      return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const token = contentCore.buildPlaceholderToken(placeholderIndex);
      placeholderIndex += 1;
      placeholderMap.set(token, node.outerHTML);
      serializedText += token;
    }
  });

  return {
    placeholderMap: placeholderMap,
    serializedText: serializedText,
  };
}

function shouldConsiderElement(element) {
  if (!element || element.closest(BLOCKED_SELECTOR)) {
    return false;
  }

  if (!isElementVisible(element) || isEditable(element)) {
    return false;
  }

  if (!isNearViewport(element)) {
    return false;
  }

  if (hasNestedCandidate(element)) {
    return false;
  }

  if (!hasMeaningfulTextNodes(element)) {
    return false;
  }

  return true;
}

function buildBlockCandidate(element) {
  const childNodes = Array.from(element.childNodes).filter(function filterNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return /\S/.test(node.nodeValue || '');
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      return !node.matches(BLOCKED_SELECTOR);
    }

    return false;
  });

  if (!childNodes.length) {
    return null;
  }

  const sourceHtml = readCurrentHtml(element);
  const serialized = buildPlaceholderMap(childNodes);
  const originalText = serialized.serializedText;

  if (!contentCore.shouldProcessTextCandidate(originalText, { hasElementSiblings: childNodes.some(function hasElement(node) {
    return node.nodeType === Node.ELEMENT_NODE;
  }) })) {
    return null;
  }

  return {
    element: element,
    originalHtml: sourceHtml,
    originalText: originalText,
    placeholderMap: serialized.placeholderMap,
    serializedText: serialized.serializedText,
  };
}

function collectBlockCandidates() {
  const elements = Array.from(document.querySelectorAll(CANDIDATE_SELECTOR));
  const candidates = [];

  elements.forEach(function eachElement(element) {
    if (!shouldConsiderElement(element)) {
      return;
    }

    const candidate = buildBlockCandidate(element);
    if (candidate) {
      candidates.push(candidate);
    }
  });

  return candidates;
}

function restoreTrackedBlocks() {
  trackedBlocks.forEach(function restoreEntry(entry) {
    if (!entry.element || !entry.element.isConnected) {
      return;
    }

    if (entry.annotatedHtml && readCurrentHtml(entry.element) === entry.annotatedHtml) {
      writeCurrentHtml(entry.element, entry.originalHtml);
    }
  });

  trackedBlocks.clear();
}

function sendRuntimeMessage(message) {
  return new Promise(function resolveMessage(resolve, reject) {
    chrome.runtime.sendMessage(message, function handleResponse(response) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

function ensureSelectionCard() {
  if (selectionCard) {
    return selectionCard;
  }

  const card = document.createElement('div');
  card.id = SELECTION_CARD_ID;
  card.style.cssText = 'position:fixed;z-index:2147483647;min-width:240px;max-width:320px;padding:14px;border-radius:14px;background:rgba(255,255,255,0.96);color:#0f172a;box-shadow:0 18px 40px -20px rgba(15,23,42,.45);border:1px solid rgba(148,163,184,.22);backdrop-filter:blur(14px);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:none;';
  card.innerHTML = [
    '<div style="font-size:12px;color:#64748b;letter-spacing:.08em;text-transform:uppercase;">Selection</div>',
    '<div data-role="source" style="margin-top:6px;font-size:15px;font-weight:600;line-height:1.45;"></div>',
    '<div data-role="translation" style="margin-top:8px;font-size:14px;line-height:1.6;color:#334155;"></div>',
    '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">',
    '<button data-action="known" style="border:0;border-radius:10px;padding:9px 12px;background:#e0e7ff;color:#3730a3;cursor:pointer;font-size:13px;">已掌握，不翻译</button>',
    '<button data-action="copy" style="border:0;border-radius:10px;padding:9px 12px;background:#f1f5f9;color:#334155;cursor:pointer;font-size:13px;">复制释义</button>',
    '</div>',
    '<div data-role="status" style="margin-top:10px;font-size:12px;color:#64748b;"></div>',
  ].join('');

  card.addEventListener('mousedown', function stopMouseDown(event) {
    event.stopPropagation();
  });
  card.addEventListener('click', function handleCardClick(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      return;
    }

    handleSelectionAction(button.dataset.action).catch(function onError(error) {
      setSelectionCardStatus(error && error.message ? error.message : '操作失败。');
    });
  });

  document.documentElement.appendChild(card);
  selectionCard = card;
  return card;
}

function setSelectionCardStatus(message) {
  const status = ensureSelectionCard().querySelector('[data-role="status"]');
  status.textContent = message || '';
}

function hideSelectionCard() {
  if (!selectionCard) {
    return;
  }

  selectionCard.style.display = 'none';
  lastSelectionText = '';
}

function positionSelectionCard(rect) {
  const card = ensureSelectionCard();
  const margin = 10;
  card.style.display = 'block';
  card.style.left = '-9999px';
  card.style.top = '-9999px';

  const cardRect = card.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + margin;

  if (left + cardRect.width > window.innerWidth - margin) {
    left = window.innerWidth - cardRect.width - margin;
  }
  if (left < margin) {
    left = margin;
  }
  if (top + cardRect.height > window.innerHeight - margin) {
    top = rect.top - cardRect.height - margin;
  }
  if (top < margin) {
    top = margin;
  }

  card.style.left = Math.round(left) + 'px';
  card.style.top = Math.round(top) + 'px';
}

function getSelectionInfo() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const text = contentCore.normalizeSelectedText(selection.toString());
  if (!contentCore.shouldTranslateSelection(text)) {
    return null;
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) {
    return null;
  }

  return { text: text, rect: rect };
}

async function handleSelectionAction(action) {
  if (!lastSelectionText) {
    return;
  }

  if (action === 'copy') {
    const translation = ensureSelectionCard().querySelector('[data-role="translation"]').textContent || '';
    await navigator.clipboard.writeText(translation);
    setSelectionCardStatus('已复制释义。');
    return;
  }

  const listKey = action === 'known' ? 'knownWords' : 'learningWords';
  const response = await sendRuntimeMessage({
    type: contentCore.MESSAGE_TYPES.ADD_WORD_TO_LIST,
    word: lastSelectionText,
    listKey: listKey,
  });

  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : '写入词库失败。');
  }

  setSelectionCardStatus(listKey === 'knownWords' ? '已加入认识词库。' : '已加入不认识词库。');
}

async function showSelectionCard() {
  const info = getSelectionInfo();
  if (!info) {
    hideSelectionCard();
    return;
  }

  const card = ensureSelectionCard();
  card.querySelector('[data-role="source"]').textContent = info.text;
  card.querySelector('[data-role="translation"]').textContent = '翻译中...';
  setSelectionCardStatus('');
  positionSelectionCard(info.rect);
  lastSelectionText = info.text;

  const response = await sendRuntimeMessage({
    type: contentCore.MESSAGE_TYPES.TRANSLATE_SELECTION,
    text: info.text,
  });

  if (!response || !response.ok) {
    card.querySelector('[data-role="translation"]').textContent = '';
    setSelectionCardStatus(response && response.error ? response.error : '划词翻译失败。');
    return;
  }

  card.querySelector('[data-role="translation"]').textContent = response.text;
}

function scheduleSelectionCard() {
  window.clearTimeout(selectionHideTimer);
  selectionHideTimer = window.setTimeout(function triggerSelectionCard() {
    showSelectionCard().catch(function ignoreError() {
      hideSelectionCard();
    });
  }, 220);
}

function bindSelectionEvents() {
  document.addEventListener('mouseup', function onMouseUp() {
    scheduleSelectionCard();
  });

  document.addEventListener('mousedown', function onMouseDown(event) {
    if (selectionCard && selectionCard.contains(event.target)) {
      return;
    }
    setTimeout(function deferredHide() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        hideSelectionCard();
      }
    }, 80);
  });

  document.addEventListener('keydown', function onKeyDown(event) {
    if (event.key === 'Escape') {
      hideSelectionCard();
    }
  });

  window.addEventListener('scroll', function onScroll() {
    hideSelectionCard();
  }, true);
}

function chunkCandidates(candidates) {
  const batches = [];
  let currentBatch = [];
  let currentChars = 0;

  candidates.forEach(function pushCandidate(candidate) {
    const nextLength = candidate.serializedText.length;
    const exceedsSize = currentBatch.length >= MAX_BATCH_SIZE;
    const exceedsChars = currentChars + nextLength > MAX_BATCH_CHARS;

    if (currentBatch.length && (exceedsSize || exceedsChars)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(candidate);
    currentChars += nextLength;
  });

  if (currentBatch.length) {
    batches.push(currentBatch);
  }

  return batches;
}

async function runWithConcurrency(items, worker, limit) {
  const results = [];
  let index = 0;

  async function consumeQueue() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, function createWorker() {
    return consumeQueue();
  });

  await Promise.all(workers);
  return results;
}

async function annotateBatch(batch, runId) {
  const response = await sendRuntimeMessage({
    type: contentCore.MESSAGE_TYPES.ANNOTATE_BATCH,
    texts: batch.map(function mapCandidate(candidate) {
      return candidate.serializedText;
    }),
  });

  if (runId !== activeRunId) {
    return batch.map(function cancelled() {
      return { status: 'cancelled' };
    });
  }

  if (!response || !response.ok || !Array.isArray(response.texts)) {
    return batch.map(function failed() {
      return {
        status: 'failed',
        error: response && response.error ? response.error : '未知错误',
      };
    });
  }

  if (response.texts.length !== batch.length) {
    return batch.map(function lengthMismatch() {
      return { status: 'failed', error: '模型返回的批量结果数量不匹配。' };
    });
  }

  return batch.map(function mapResult(candidate, index) {
    const translatedText = response.texts[index];
    if (!candidate.element.isConnected) {
      return { status: 'skipped' };
    }

    if (!contentCore.isSafeSerializedTranslation(candidate.serializedText, translatedText)) {
      return { status: 'failed', error: '模型破坏了占位符结构。' };
    }

    if (!translatedText || !translatedText.trim()) {
      return { status: 'failed', error: '模型返回空结果。' };
    }

    if (runId !== activeRunId) {
      return { status: 'cancelled' };
    }
    const restoredHtml = contentCore.restoreSerializedPlaceholders(translatedText, candidate.placeholderMap);
    writeCurrentHtml(candidate.element, restoredHtml);

    const trackedEntry = trackedBlocks.get(candidate.trackId);
    if (trackedEntry) {
      trackedEntry.annotatedHtml = restoredHtml;
    }

    return { status: 'success' };
  });
}

async function annotatePage() {
  activeRunId += 1;
  const runId = activeRunId;
  restoreTrackedBlocks();

  const candidates = collectBlockCandidates();
  if (!candidates.length) {
    return contentCore.createAnnotationSummary(0, []);
  }

  candidates.forEach(function trackCandidate(candidate, index) {
    const trackId = 'block-' + runId + '-' + index;
    candidate.trackId = trackId;
    trackedBlocks.set(trackId, {
      element: candidate.element,
      originalHtml: candidate.originalHtml,
      annotatedHtml: '',
    });
  });

  const batches = chunkCandidates(candidates);
  const batchResults = await runWithConcurrency(batches, function processBatch(batch) {
    return annotateBatch(batch, runId);
  }, MAX_CONCURRENT_BATCHES);

  return contentCore.createAnnotationSummary(candidates.length, batchResults.flat());
}

// ── Direct translation mode (bypasses placeholder/delimiter) ──
var TRANSLATE_CONCURRENCY = 6;

function collectTranslateTargets() {
  var all = document.querySelectorAll(CANDIDATE_SELECTOR);
  var targets = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.closest(BLOCKED_SELECTOR)) continue;
    if (!isElementVisible(el)) continue;
    if (isEditable(el)) continue;
    if (hasNestedCandidate(el)) continue;
    var text = (el.textContent || '').trim();
    if (text.length < 6) continue;
    if (!/[a-zA-Z]/.test(text)) continue;
    targets.push(el);
  }
  return targets;
}

async function translateElementDirect(element) {
  var text = (element.textContent || '').trim();
  if (text.length < 6) return { status: 'skipped' };

  var hasChildElements = element.querySelector('a, strong, em, b, i, span, sup, sub') !== null;
  var input = hasChildElements ? element.innerHTML : text;

  try {
    var response = await sendRuntimeMessage({
      type: 'NF_TRANSLATE_DIRECT',
      text: input,
      preserveHtml: hasChildElements
    });
    if (!response || !response.ok || !response.text) {
      return { status: 'failed', error: response && response.error || 'no response' };
    }
    var translated = response.text.trim();
    if (translated.length < 2) return { status: 'skipped' };

    if (hasChildElements) {
      element.insertAdjacentHTML('afterbegin', '');
      var temp = document.createElement('div');
      temp.insertAdjacentHTML('afterbegin', translated);
      if (temp.querySelector('a, strong, em, b, i')) {
        element.replaceChildren.apply(element, Array.from(temp.childNodes));
      } else {
        element.textContent = translated;
      }
    } else {
      element.textContent = translated;
    }
    return { status: 'success' };
  } catch (e) {
    return { status: 'failed', error: e.message || 'unknown' };
  }
}

async function translatePageDirect() {
  var targets = collectTranslateTargets();
  console.log('[breeze] translatePageDirect: ' + targets.length + ' targets');
  if (!targets.length) return { total: 0, success: 0, failed: 0 };

  var success = 0, failed = 0;
  var queue = targets.slice();
  var active = 0;

  await new Promise(function(resolve) {
    function next() {
      while (active < TRANSLATE_CONCURRENCY && queue.length > 0) {
        active++;
        var el = queue.shift();
        translateElementDirect(el).then(function(r) {
          if (r.status === 'success') success++;
          else if (r.status === 'failed') failed++;
          active--;
          if (queue.length === 0 && active === 0) resolve();
          else next();
        });
      }
      if (queue.length === 0 && active === 0) resolve();
    }
    next();
  });

  console.log('[breeze] translatePageDirect done: success=' + success + ' failed=' + failed + ' total=' + targets.length);
  return { total: targets.length, success: success, failed: failed };
}

console.log('[breeze] content.js message listener registered');

chrome.runtime.onMessage.addListener(function handleMessage(message, _sender, sendResponse) {
  console.log('[breeze] content.js received message:', message && message.type);
  if (!message || message.type !== contentCore.MESSAGE_TYPES.START_ANNOTATION) {
    return false;
  }

  if (message.dryRun) {
    sendResponse({ ok: true });
    return false;
  }

  if (message.directTranslate) {
    console.log('[breeze] starting translatePageDirect()');
    translatePageDirect()
      .then(function(summary) {
        sendResponse({ ok: true, summary: summary });
      })
      .catch(function(error) {
        sendResponse({ ok: false, error: error.message || '翻译失败' });
      });
    return true;
  }

  console.log('[breeze] starting annotatePage()');
  annotatePage()
    .then(function resolveSummary(summary) {
      sendResponse({ ok: true, summary: summary });
    })
    .catch(function handleError(error) {
      sendResponse({ ok: false, error: error && error.message ? error.message : '页面注词失败。' });
    });

  return true;
});

bindSelectionEvents();

// Debug: auto-translate on ?breeze=translate
if (location.search.includes('breeze=translate')) {
  setTimeout(function() {
    translatePageDirect().then(function(s) {
      console.log('[breeze] DIRECT TRANSLATE:', JSON.stringify(s));
    }).catch(function(e) {
      console.error('[breeze] DIRECT TRANSLATE FAILED:', e);
    });
  }, 1500);
}

// ── Audio subtitle overlay ──
var subtitleOverlay = null;
var subtitleHideTimer = 0;
var subtitleSubs = {};

function getSubtitleOverlay() {
  if (subtitleOverlay) return subtitleOverlay;
  subtitleOverlay = document.createElement('div');
  subtitleOverlay.id = 'nanfeng-subtitle-overlay';
  var s = subtitleOverlay.style;
  s.position = 'fixed';
  s.bottom = '80px';
  s.left = '50%';
  s.transform = 'translateX(-50%)';
  s.zIndex = '2147483647';
  s.background = 'rgba(0,0,0,0.85)';
  s.color = '#fff';
  s.padding = '10px 20px';
  s.borderRadius = '10px';
  s.fontSize = '20px';
  s.lineHeight = '1.5';
  s.maxWidth = '80%';
  s.textAlign = 'center';
  s.fontFamily = '-apple-system, BlinkMacSystemFont, sans-serif';
  s.transition = 'opacity 0.3s';
  s.pointerEvents = 'none';
  s.whiteSpace = 'pre-wrap';
  document.documentElement.appendChild(subtitleOverlay);
  return subtitleOverlay;
}

chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type === 'NF_SUBTITLE') {
    var p = msg.payload;
    if (p.type === 'subtitle') {
      subtitleSubs[p.seq] = p;
      renderSubtitle(p);
    } else if (p.type === 'update' && subtitleSubs[p.seq]) {
      subtitleSubs[p.seq].translated = p.translated;
      renderSubtitle(subtitleSubs[p.seq]);
    }
  }
  if (msg.type === 'NF_SUBTITLE_STATUS') {
    if (msg.status === 'stopped') {
      var el = document.getElementById('nanfeng-subtitle-overlay');
      if (el) { el.style.opacity = '0'; }
    }
  }
});

function renderSubtitle(sub) {
  var el = getSubtitleOverlay();
  var orig = sub.original || '';
  var trans = sub.translated || '';
  el.textContent = '';

  if (sub.lang === 'zh' || sub.lang === 'yue') {
    el.textContent = orig;
  } else if (trans) {
    el.textContent = trans;
    var br = document.createElement('br');
    el.appendChild(br);
    var small = document.createElement('span');
    small.textContent = orig;
    small.style.fontSize = '14px';
    small.style.opacity = '0.6';
    el.appendChild(small);
  } else {
    el.textContent = orig;
  }
  el.style.opacity = '1';
  clearTimeout(subtitleHideTimer);
  subtitleHideTimer = setTimeout(function() { el.style.opacity = '0'; }, 8000);
}
