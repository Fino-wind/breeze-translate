(function() {
if (globalThis.__breezeTranslateLoaded) return;
globalThis.__breezeTranslateLoaded = true;

var contentCore = globalThis.NanFengCore;

var CANDIDATE_SELECTOR = 'article, main, section, blockquote, p, li, td, th, figcaption, h1, h2, h3, h4, h5, h6, div, dd, dt, details, summary';
var BLOCKED_SELECTOR = 'script, style, code, pre, textarea, input, noscript, button, nav, svg, canvas, video, audio';
var SELECTION_CARD_ID = 'nanfeng-selection-card';
var TRANSLATE_BATCH_SIZE = 8;
var TRANSLATE_BATCH_CHARS = 3000;
var TRANSLATE_CONCURRENCY = 6;

var selectionCard = null;
var selectionHideTimer = 0;
var lastSelectionText = '';
var activeDirectRunId = 0;
var streamBatchCounter = 0;
var streamBatchMap = {};

function isElementVisible(element) {
  if (!element || !(element instanceof Element)) return false;
  var style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return element.getClientRects().length > 0;
}

function isEditable(element) {
  return Boolean(element && element.closest('[contenteditable="true"], [contenteditable=""], [role="textbox"]'));
}

function isInViewport(element) {
  var rect = element.getBoundingClientRect();
  var vh = window.innerHeight || document.documentElement.clientHeight;
  return rect.bottom >= 0 && rect.top <= vh;
}

function hasNestedCandidate(element) {
  return Array.from(element.children).some(function(child) {
    return child.matches && child.matches(CANDIDATE_SELECTOR);
  });
}

function sendRuntimeMessage(message) {
  return new Promise(function(resolve, reject) {
    chrome.runtime.sendMessage(message, function(response) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(response);
    });
  });
}

// ── Selection Card ──

function ensureSelectionCard() {
  if (selectionCard) return selectionCard;
  var card = document.createElement('div');
  card.id = SELECTION_CARD_ID;
  card.style.cssText = 'position:fixed;z-index:2147483647;min-width:240px;max-width:320px;padding:14px;border-radius:14px;background:rgba(255,255,255,0.96);color:#0f172a;box-shadow:0 18px 40px -20px rgba(15,23,42,.45);border:1px solid rgba(148,163,184,.22);backdrop-filter:blur(14px);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:none;';

  var header = document.createElement('div');
  header.style.cssText = 'font-size:12px;color:#64748b;letter-spacing:.08em;text-transform:uppercase;';
  header.textContent = 'Selection';
  card.appendChild(header);

  var sourceDiv = document.createElement('div');
  sourceDiv.setAttribute('data-role', 'source');
  sourceDiv.style.cssText = 'margin-top:6px;font-size:15px;font-weight:600;line-height:1.45;';
  card.appendChild(sourceDiv);

  var translationDiv = document.createElement('div');
  translationDiv.setAttribute('data-role', 'translation');
  translationDiv.style.cssText = 'margin-top:8px;font-size:14px;line-height:1.6;color:#334155;';
  card.appendChild(translationDiv);

  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;';
  var knownBtn = document.createElement('button');
  knownBtn.setAttribute('data-action', 'known');
  knownBtn.style.cssText = 'border:0;border-radius:10px;padding:9px 12px;background:#e0e7ff;color:#3730a3;cursor:pointer;font-size:13px;';
  knownBtn.textContent = '已掌握，不翻译';
  var copyBtn = document.createElement('button');
  copyBtn.setAttribute('data-action', 'copy');
  copyBtn.style.cssText = 'border:0;border-radius:10px;padding:9px 12px;background:#f1f5f9;color:#334155;cursor:pointer;font-size:13px;';
  copyBtn.textContent = '复制释义';
  btnRow.appendChild(knownBtn);
  btnRow.appendChild(copyBtn);
  card.appendChild(btnRow);

  var statusDiv = document.createElement('div');
  statusDiv.setAttribute('data-role', 'status');
  statusDiv.style.cssText = 'margin-top:10px;font-size:12px;color:#64748b;';
  card.appendChild(statusDiv);

  card.addEventListener('mousedown', function(e) { e.stopPropagation(); });
  card.addEventListener('click', function(e) {
    var button = e.target.closest('button[data-action]');
    if (!button) return;
    handleSelectionAction(button.dataset.action).catch(function(err) {
      setSelectionCardStatus(err && err.message ? err.message : '操作失败。');
    });
  });
  document.documentElement.appendChild(card);
  selectionCard = card;
  return card;
}

function setSelectionCardStatus(message) {
  ensureSelectionCard().querySelector('[data-role="status"]').textContent = message || '';
}

function hideSelectionCard() {
  if (!selectionCard) return;
  selectionCard.style.display = 'none';
  lastSelectionText = '';
}

function positionSelectionCard(rect) {
  var card = ensureSelectionCard();
  var margin = 10;
  card.style.display = 'block';
  card.style.left = '-9999px';
  card.style.top = '-9999px';
  var cardRect = card.getBoundingClientRect();
  var left = rect.left;
  var top = rect.bottom + margin;
  if (left + cardRect.width > window.innerWidth - margin) left = window.innerWidth - cardRect.width - margin;
  if (left < margin) left = margin;
  if (top + cardRect.height > window.innerHeight - margin) top = rect.top - cardRect.height - margin;
  if (top < margin) top = margin;
  card.style.left = Math.round(left) + 'px';
  card.style.top = Math.round(top) + 'px';
}

function getSelectionInfo() {
  var selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  var text = contentCore.normalizeSelectedText(selection.toString());
  if (!contentCore.shouldTranslateSelection(text)) return null;
  var rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return null;
  return { text: text, rect: rect };
}

async function handleSelectionAction(action) {
  if (!lastSelectionText) return;
  if (action === 'copy') {
    var translation = ensureSelectionCard().querySelector('[data-role="translation"]').textContent || '';
    await navigator.clipboard.writeText(translation);
    setSelectionCardStatus('已复制释义。');
    return;
  }
  var listKey = action === 'known' ? 'knownWords' : 'learningWords';
  var response = await sendRuntimeMessage({
    type: contentCore.MESSAGE_TYPES.ADD_WORD_TO_LIST,
    word: lastSelectionText,
    listKey: listKey,
  });
  if (!response || !response.ok) throw new Error(response && response.error ? response.error : '写入词库失败。');
  setSelectionCardStatus(listKey === 'knownWords' ? '已加入认识词库。' : '已加入不认识词库。');
}

async function showSelectionCard() {
  var info = getSelectionInfo();
  if (!info) { hideSelectionCard(); return; }
  var card = ensureSelectionCard();
  card.querySelector('[data-role="source"]').textContent = info.text;
  card.querySelector('[data-role="translation"]').textContent = '翻译中...';
  setSelectionCardStatus('');
  positionSelectionCard(info.rect);
  lastSelectionText = info.text;
  var response = await sendRuntimeMessage({
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
  selectionHideTimer = window.setTimeout(function() {
    showSelectionCard().catch(function() { hideSelectionCard(); });
  }, 220);
}

function bindSelectionEvents() {
  document.addEventListener('mouseup', function() { scheduleSelectionCard(); });
  document.addEventListener('mousedown', function(e) {
    if (selectionCard && selectionCard.contains(e.target)) return;
    setTimeout(function() {
      var selection = window.getSelection();
      if (!selection || selection.isCollapsed) hideSelectionCard();
    }, 80);
  });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') hideSelectionCard(); });
  window.addEventListener('scroll', function() { hideSelectionCard(); }, true);
}

// ── Page Translation (batched, viewport-first, progress + cancel) ──

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
    var cjk = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
    if (cjk / text.length > 0.5) continue;
    targets.push(el);
  }
  return targets;
}

function buildDirectBatches(items) {
  var textItems = items.filter(function(i) { return !i.preserveHtml; });
  var htmlItems = items.filter(function(i) { return i.preserveHtml; });
  function chunk(arr) {
    var batches = [], current = [], chars = 0;
    for (var i = 0; i < arr.length; i++) {
      var len = arr[i].text.length;
      if (current.length >= TRANSLATE_BATCH_SIZE || (current.length > 0 && chars + len > TRANSLATE_BATCH_CHARS)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(arr[i]);
      chars += len;
    }
    if (current.length) batches.push(current);
    return batches;
  }
  return chunk(textItems).concat(chunk(htmlItems));
}

async function runBatchesConcurrently(batches, worker, limit) {
  var results = [];
  var index = 0;
  async function consume() {
    while (index < batches.length) {
      var i = index++;
      results[i] = await worker(batches[i], i);
    }
  }
  var workers = [];
  for (var w = 0; w < Math.min(limit, batches.length); w++) workers.push(consume());
  await Promise.all(workers);
  return results;
}

async function translatePageDirect() {
  activeDirectRunId++;
  var runId = activeDirectRunId;
  var targets = collectTranslateTargets();
  console.log('[breeze] translatePageDirect: ' + targets.length + ' targets');
  if (!targets.length) return { total: 0, success: 0, failed: 0, skipped: 0 };

  targets.sort(function(a, b) {
    return (isInViewport(a) ? 0 : 1) - (isInViewport(b) ? 0 : 1);
  });

  var items = [];
  for (var i = 0; i < targets.length; i++) {
    var hasChildren = targets[i].children.length > 0;
    var sourceText = hasChildren ? targets[i].innerHTML : targets[i].textContent.trim();
    targets[i].setAttribute('data-breeze-original', sourceText);
    targets[i].setAttribute('data-breeze-html', hasChildren ? '1' : '0');
    items.push({
      el: targets[i],
      text: sourceText,
      preserveHtml: hasChildren
    });
  }

  var batches = buildDirectBatches(items);
  var success = 0, failed = 0;
  var total = items.length;

  await runBatchesConcurrently(batches, async function(batch) {
    if (runId !== activeDirectRunId) return;
    var texts = batch.map(function(item) { return item.text; });
    var batchId = ++streamBatchCounter;
    streamBatchMap[batchId] = batch;

    var attempt = 0;
    var maxRetries = 1;
    while (attempt <= maxRetries) {
      try {
        var response = await sendRuntimeMessage({
          type: contentCore.MESSAGE_TYPES.TRANSLATE_DIRECT_BATCH,
          texts: texts,
          preserveHtml: batch[0].preserveHtml,
          stream: true,
          batchId: batchId
        });
        if (runId !== activeDirectRunId) return;
        if (response && response.ok) {
          if (response.streamed) {
            success += response.count || 0;
            var streamMissed = batch.length - (response.count || 0);
            if (streamMissed > 0) failed += streamMissed;
          } else if (Array.isArray(response.texts)) {
            for (var j = 0; j < batch.length; j++) {
              if (runId !== activeDirectRunId) return;
              var translated = response.texts[j];
              if (!translated || !translated.trim()) { failed++; continue; }
              if (batch[j].preserveHtml) {
                batch[j].el.innerHTML = translated.trim();
              } else {
                batch[j].el.textContent = translated.trim();
              }
              success++;
            }
          } else {
            failed += batch.length;
          }
        } else {
          failed += batch.length;
        }
        break;
      } catch (e) {
        if (attempt < maxRetries) { attempt++; continue; }
        failed += batch.length;
      }
    }
    delete streamBatchMap[batchId];
    try {
      chrome.runtime.sendMessage({ type: 'NF_TRANSLATE_PROGRESS', done: success + failed, total: total });
    } catch(e) {}
  }, TRANSLATE_CONCURRENCY);

  console.log('[breeze] translatePageDirect done: success=' + success + ' failed=' + failed + ' total=' + total);
  return { total: total, success: success, failed: failed, skipped: 0 };
}

// ── Message Handler ──

chrome.runtime.onMessage.addListener(function(msg) {
  if (msg && msg.type === 'NF_STREAM_SEGMENT') {
    var batch = streamBatchMap[msg.batchId];
    if (batch && batch[msg.index]) {
      if (batch[msg.index].preserveHtml) {
        batch[msg.index].el.innerHTML = msg.text;
      } else {
        batch[msg.index].el.textContent = msg.text;
      }
    }
  }
});

function toggleTranslation() {
  var elements = document.querySelectorAll('[data-breeze-original]');
  elements.forEach(function(el) {
    var original = el.getAttribute('data-breeze-original');
    var isHtml = el.getAttribute('data-breeze-html') === '1';
    var current = isHtml ? el.innerHTML : el.textContent;
    el.setAttribute('data-breeze-original', current);
    if (isHtml) {
      el.innerHTML = original;
    } else {
      el.textContent = original;
    }
  });
  return elements.length;
}

async function translateInputBox() {
  var el = document.activeElement;
  if (!el) return { ok: false, error: '没有聚焦的输入框' };
  var isContentEditable = el.isContentEditable;
  var isInput = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text');
  if (!isContentEditable && !isInput) return { ok: false, error: '当前聚焦元素不是输入框' };

  var text = isContentEditable ? el.innerText : el.value;
  if (!text || !text.trim()) return { ok: false, error: '输入框为空' };

  var response = await sendRuntimeMessage({
    type: 'NF_TRANSLATE_DIRECT',
    text: text.trim(),
    preserveHtml: false
  });

  if (response && response.ok && response.text) {
    if (isContentEditable) {
      el.innerText = response.text;
    } else {
      el.value = response.text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { ok: true };
  }
  return { ok: false, error: (response && response.error) || '翻译失败' };
}

chrome.runtime.onMessage.addListener(function(message, _sender, sendResponse) {
  if (!message) return false;

  if (message.type === 'NF_CANCEL_TRANSLATE') {
    activeDirectRunId++;
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'NF_TOGGLE_TRANSLATE') {
    var count = toggleTranslation();
    sendResponse({ ok: true, count: count });
    return false;
  }

  if (message.type === 'NF_INPUT_TRANSLATE') {
    translateInputBox()
      .then(function(result) { sendResponse(result); })
      .catch(function(e) { sendResponse({ ok: false, error: e.message || '输入框翻译失败' }); });
    return true;
  }

  if (message.type === contentCore.MESSAGE_TYPES.START_ANNOTATION) {
    if (message.dryRun) {
      sendResponse({ ok: true });
      return false;
    }
    translatePageDirect()
      .then(function(summary) { sendResponse({ ok: true, summary: summary }); })
      .catch(function(error) { sendResponse({ ok: false, error: error.message || '翻译失败' }); });
    return true;
  }

  return false;
});

bindSelectionEvents();

// ── Audio Subtitle Overlay ──

var subtitleOverlay = null;
var subtitleHideTimer = 0;
var subtitleSubs = {};

function getSubtitleOverlay() {
  if (subtitleOverlay) return subtitleOverlay;
  subtitleOverlay = document.createElement('div');
  subtitleOverlay.id = 'nanfeng-subtitle-overlay';
  var s = subtitleOverlay.style;
  s.position = 'fixed'; s.bottom = '80px'; s.left = '50%'; s.transform = 'translateX(-50%)';
  s.zIndex = '2147483647'; s.background = 'rgba(0,0,0,0.85)'; s.color = '#fff';
  s.padding = '10px 20px'; s.borderRadius = '10px'; s.fontSize = '20px'; s.lineHeight = '1.5';
  s.maxWidth = '80%'; s.textAlign = 'center';
  s.fontFamily = '-apple-system, BlinkMacSystemFont, sans-serif';
  s.transition = 'opacity 0.3s'; s.pointerEvents = 'none'; s.whiteSpace = 'pre-wrap';
  document.documentElement.appendChild(subtitleOverlay);
  return subtitleOverlay;
}

chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type === 'NF_SUBTITLE') {
    var p = msg.payload;
    if (p.type === 'subtitle') { subtitleSubs[p.seq] = p; renderSubtitle(p); }
    else if (p.type === 'update' && subtitleSubs[p.seq]) { subtitleSubs[p.seq].translated = p.translated; renderSubtitle(subtitleSubs[p.seq]); }
  }
  if (msg.type === 'NF_SUBTITLE_STATUS') {
    if (msg.status === 'stopped') {
      var el = document.getElementById('nanfeng-subtitle-overlay');
      if (el) el.style.opacity = '0';
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
    el.appendChild(document.createElement('br'));
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

if (location.search.includes('breeze=translate')) {
  setTimeout(function() {
    translatePageDirect().then(function(s) {
      console.log('[breeze] DIRECT TRANSLATE:', JSON.stringify(s));
    }).catch(function(e) {
      console.error('[breeze] DIRECT TRANSLATE FAILED:', e);
    });
  }, 1500);
}

})();
