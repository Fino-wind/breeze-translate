console.log('[breeze] background.js starting...');
try {
  importScripts('shared.js');
} catch(e) {
  console.error('[breeze] importScripts FAILED:', e);
}

const core = self.NanFengCore;
console.log('[breeze] background.js loaded, core:', !!core);
const storage = chrome.storage.local;
const TEST_CONNECTION_TEXT = 'The ubiquitous network remains resilient.';
const TEST_CONNECTION_VOCABULARY = {
  knownWords: [],
  learningWords: ['ubiquitous', 'resilient'],
};
let logWriteQueue = Promise.resolve();
let stateWriteQueue = Promise.resolve();
const selectionTranslationCache = new Map();
const directTranslationCache = new Map();
const DIRECT_CACHE_MAX = 200;
const CONTEXT_MENU_KNOWN = 'nanfeng-add-known';
const CONTEXT_MENU_LEARNING = 'nanfeng-add-learning';

async function readStoredStateDirect() {
  const result = await storage.get(core.STORAGE_KEY);
  return core.mergeStoredState(result[core.STORAGE_KEY]);
}

async function getStoredState() {
  await stateWriteQueue.catch(function ignoreQueueError() { return null; });
  return readStoredStateDirect();
}

async function getStoredLogs() {
  const result = await storage.get(core.LOG_STORAGE_KEY);
  return Array.isArray(result[core.LOG_STORAGE_KEY]) ? result[core.LOG_STORAGE_KEY] : [];
}

async function saveStoredState(partialState) {
  const writeTask = stateWriteQueue.then(async function writeState() {
    const currentState = await readStoredStateDirect();
    const nextState = core.mergeStoredState({
      settings: partialState && partialState.settings ? partialState.settings : currentState.settings,
      vocabulary: partialState && partialState.vocabulary ? partialState.vocabulary : currentState.vocabulary,
      ui: partialState && partialState.ui ? partialState.ui : currentState.ui,
    });
    await storage.set({ [core.STORAGE_KEY]: nextState });
    return nextState;
  });
  stateWriteQueue = writeTask.catch(function swallowQueueError() { return null; });
  return writeTask;
}

async function initializeStorage() {
  await saveStoredState(await getStoredState());
}

function pruneSelectionCache() {
  if (selectionTranslationCache.size <= 50) return;
  const firstKey = selectionTranslationCache.keys().next();
  if (!firstKey.done) selectionTranslationCache.delete(firstKey.value);
}

function pruneDirectCache() {
  while (directTranslationCache.size > DIRECT_CACHE_MAX) {
    directTranslationCache.delete(directTranslationCache.keys().next().value);
  }
}

async function addWordToVocabulary(word, listKey) {
  selectionTranslationCache.clear();
  directTranslationCache.clear();
  const state = await getStoredState();
  const nextVocabulary = core.upsertWord(state.vocabulary, word, listKey);
  return saveStoredState({ vocabulary: nextVocabulary });
}

function createSelectionCacheKey(settings, text) {
  return [settings.baseUrl, settings.model, text].join('::');
}

async function translateSelection(rawText) {
  const text = core.normalizeSelectedText(rawText);
  if (!core.shouldTranslateSelection(text)) {
    return { ok: false, error: '当前只支持英文单词或短语划词翻译。' };
  }
  const state = await getStoredState();
  const cacheKey = createSelectionCacheKey(state.settings, text);
  if (selectionTranslationCache.has(cacheKey)) {
    return { ok: true, text: selectionTranslationCache.get(cacheKey) };
  }
  const result = await requestAnnotation(text, null, 'selection-translation-error');
  if (!result.ok) return result;
  selectionTranslationCache.set(cacheKey, result.text);
  pruneSelectionCache();
  return result;
}

function createContextMenus() {
  chrome.contextMenus.removeAll(function clearMenus() {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_KNOWN, title: '加入认识词库', contexts: ['selection'],
    }, function() {
      if (chrome.runtime.lastError) appendLog('warn', 'context-menu', chrome.runtime.lastError.message, { id: CONTEXT_MENU_KNOWN });
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_LEARNING, title: '加入不认识词库', contexts: ['selection'],
    }, function() {
      if (chrome.runtime.lastError) appendLog('warn', 'context-menu', chrome.runtime.lastError.message, { id: CONTEXT_MENU_LEARNING });
    });
  });
}

async function appendLog(level, event, message, detail) {
  const writeTask = logWriteQueue.then(async function writeLog() {
    const logs = await getStoredLogs();
    const entry = {
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      timestamp: new Date().toISOString(),
      level: level, event: event, message: message, detail: detail || null,
    };
    await storage.set({ [core.LOG_STORAGE_KEY]: core.appendDebugLog(logs, entry, core.MAX_LOG_ENTRIES) });
    return entry;
  });
  logWriteQueue = writeTask.catch(function swallowQueueError() { return null; });
  return writeTask;
}

async function clearLogs() {
  const clearTask = logWriteQueue.then(function writeClear() {
    return storage.set({ [core.LOG_STORAGE_KEY]: [] });
  });
  logWriteQueue = clearTask.catch(function swallowQueueError() { return null; });
  await clearTask;
}

function readErrorMessage(payload, fallbackMessage) {
  return core.extractApiErrorMessage(payload, fallbackMessage);
}

async function requestAnnotation(text, overrides, logContext) {
  const storedState = await getStoredState();
  const state = core.mergeStoredState({
    settings: overrides && overrides.settings ? overrides.settings : storedState.settings,
    vocabulary: overrides && overrides.vocabulary ? overrides.vocabulary : storedState.vocabulary,
    ui: storedState.ui,
  });
  const mode = state.ui.mode || 'full';

  if (!state.settings.baseUrl || !state.settings.model) {
    const result = { ok: false, error: '请先在 Options 页面填写 Base URL 和 Model Name。' };
    await appendLog('error', logContext || 'annotation-error', result.error, {
      baseUrl: state.settings.baseUrl, model: state.settings.model,
    });
    return result;
  }

  const request = core.buildChatRequest({
    settings: state.settings, vocabulary: state.vocabulary, text: text, mode: mode,
  });

  let response;
  try {
    response = await fetch(request.url, request.options);
  } catch (error) {
    const result = { ok: false, error: '网络请求失败：' + (error && error.message ? error.message : '未知错误') };
    await appendLog('error', logContext || 'annotation-error', result.error, {
      baseUrl: state.settings.baseUrl, model: state.settings.model,
      textPreview: String(text || '').slice(0, 120),
    });
    return result;
  }

  const rawBody = await response.text();
  let payload = null;
  try { payload = rawBody ? JSON.parse(rawBody) : null; } catch (error) { payload = rawBody; }

  if (!response.ok) {
    const result = { ok: false, error: '模型请求失败：' + readErrorMessage(payload, 'HTTP ' + response.status) };
    await appendLog('error', logContext || 'annotation-error', result.error, {
      baseUrl: state.settings.baseUrl, model: state.settings.model,
      status: response.status, textPreview: String(text || '').slice(0, 120),
    });
    return result;
  }

  let annotatedText = '';
  try { annotatedText = core.extractAssistantText(payload); } catch (error) {
    const result = { ok: false, error: '模型返回内容格式无效。' };
    await appendLog('error', logContext || 'annotation-error', result.error, {
      baseUrl: state.settings.baseUrl, model: state.settings.model,
    });
    return result;
  }

  if (!annotatedText || !annotatedText.trim()) {
    const result = { ok: false, error: '模型返回空结果。' };
    await appendLog('error', logContext || 'annotation-error', result.error, {});
    return result;
  }

  return { ok: true, text: annotatedText };
}

async function requestBatchAnnotation(texts, overrides, logContext) {
  const blocks = Array.isArray(texts) ? texts.filter(Boolean) : [];
  if (!blocks.length) return { ok: true, texts: [] };
  const combinedText = core.buildBatchText(blocks);
  const singleResult = await requestAnnotation(combinedText, overrides, logContext);
  if (!singleResult.ok) return singleResult;
  const parsed = core.parseBatchText(singleResult.text, blocks.length);
  if (!parsed) {
    const result = { ok: false, error: '模型返回的批量结果无法按分隔符拆分。' };
    await appendLog('error', logContext || 'annotation-batch-error', result.error, {
      count: blocks.length, preview: core.createPreviewText(singleResult.text, 160),
    });
    return result;
  }
  return { ok: true, texts: parsed };
}

async function testConnection(settings) {
  const state = core.mergeStoredState({ settings: settings, vocabulary: TEST_CONNECTION_VOCABULARY });
  if (!state.settings.baseUrl || !state.settings.model) {
    const missingConfig = { ok: false, error: '请先填写 Base URL 和 Model Name。' };
    await appendLog('error', 'test-connection-error', missingConfig.error, {
      baseUrl: state.settings.baseUrl, model: state.settings.model,
    });
    return missingConfig;
  }
  const request = core.buildChatRequest({
    settings: state.settings, vocabulary: state.vocabulary, text: TEST_CONNECTION_TEXT,
  });
  let response;
  try {
    response = await fetch(request.url, request.options);
  } catch (error) {
    const networkError = { ok: false, error: '网络请求失败：' + (error && error.message ? error.message : '未知错误') };
    await appendLog('error', 'test-connection-error', networkError.error, {
      baseUrl: state.settings.baseUrl, model: state.settings.model,
    });
    return networkError;
  }
  const rawBody = await response.text();
  let payload = null;
  try { payload = rawBody ? JSON.parse(rawBody) : null; } catch (error) { payload = rawBody; }
  if (!response.ok) {
    const httpError = { ok: false, error: '模型请求失败：' + readErrorMessage(payload, 'HTTP ' + response.status) };
    await appendLog('error', 'test-connection-error', httpError.error, {
      baseUrl: state.settings.baseUrl, model: state.settings.model, status: response.status,
    });
    return httpError;
  }
  let outputText = '';
  try { outputText = core.extractAssistantText(payload); } catch (error) {
    const parseError = { ok: false, error: '模型返回内容格式无效。' };
    await appendLog('error', 'test-connection-error', parseError.error, {
      baseUrl: state.settings.baseUrl, model: state.settings.model,
    });
    return parseError;
  }
  const preview = core.createPreviewText(outputText, 120);
  await appendLog('info', 'test-connection-success', '模型连接测试成功。', {
    baseUrl: state.settings.baseUrl, model: state.settings.model, preview: preview,
  });
  return { ok: true, text: preview };
}

// ── Batch direct translation with cache ──

async function translateDirectBatch(texts, preserveHtml) {
  var state = await getStoredState();
  var mode = state.ui.mode || 'full';

  if (!state.settings.baseUrl || !state.settings.model) {
    return { ok: false, error: '请先配置 API。' };
  }

  var cachePrefix = mode + ':' + (preserveHtml ? 'h' : 't') + ':';
  var results = new Array(texts.length);
  var uncachedIndices = [];

  for (var i = 0; i < texts.length; i++) {
    var cached = directTranslationCache.get(cachePrefix + texts[i]);
    if (cached !== undefined) {
      results[i] = cached;
    } else {
      uncachedIndices.push(i);
    }
  }

  if (!uncachedIndices.length) {
    return { ok: true, texts: results };
  }

  var uncachedTexts = uncachedIndices.map(function(idx) { return texts[idx]; });
  var delimiter = core.BATCH_DELIMITER.trim();

  var systemPrompt;
  if (preserveHtml) {
    var knownWords = state.vocabulary.knownWords || [];
    systemPrompt = '翻译以下HTML片段为简体中文。保留所有HTML标签的位置和属性不变，只翻译文本内容。';
    if (mode === 'learn' && knownWords.length > 0) {
      systemPrompt += '已掌握的英文词保留不翻译：' + knownWords.join(', ') + '。';
    }
    if (uncachedTexts.length > 1) {
      systemPrompt += '输入中的分隔符 ' + delimiter + ' 必须原样保留每一个分隔符。';
    }
    systemPrompt += '只输出翻译后的HTML。';
  } else {
    systemPrompt = core.buildSystemPrompt(state.vocabulary, mode);
  }

  var combined = uncachedTexts.join(core.BATCH_DELIMITER);
  var headers = { 'Content-Type': 'application/json' };
  if (state.settings.apiKey) headers.Authorization = 'Bearer ' + state.settings.apiKey;

  var url = core.normalizeBaseUrl(state.settings.baseUrl) + '/chat/completions';
  var response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: state.settings.model,
        temperature: 0,
        max_tokens: 6144,
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: combined }
        ]
      })
    });
  } catch (e) {
    return { ok: false, error: '网络请求失败：' + (e.message || '未知错误') };
  }

  if (!response.ok) {
    var errBody = await response.text();
    var errParsed;
    try { errParsed = JSON.parse(errBody); } catch(e) { errParsed = errBody; }
    return { ok: false, error: '模型请求失败：' + readErrorMessage(errParsed, 'HTTP ' + response.status) };
  }

  var data;
  try { data = await response.json(); } catch(e) {
    return { ok: false, error: '响应解析失败' };
  }

  var content;
  try { content = core.extractAssistantText(data); } catch(e) {
    return { ok: false, error: '模型返回内容格式无效' };
  }

  if (!content || !content.trim()) {
    return { ok: false, error: '模型返回空结果' };
  }

  var parts;
  if (uncachedTexts.length === 1) {
    parts = [content.trim()];
  } else {
    parts = content.split(delimiter);
    if (parts.length !== uncachedTexts.length) {
      await appendLog('warn', 'batch-split-mismatch', '批量结果数量不匹配', {
        expected: uncachedTexts.length, actual: parts.length,
      });
      return { ok: false, error: '批量结果数量不匹配' };
    }
  }

  for (var j = 0; j < uncachedIndices.length; j++) {
    var translated = parts[j].trim();
    results[uncachedIndices[j]] = translated;
    directTranslationCache.set(cachePrefix + uncachedTexts[j], translated);
  }
  pruneDirectCache();

  return { ok: true, texts: results };
}

async function translateDirect(text, preserveHtml) {
  var r = await translateDirectBatch([text], preserveHtml);
  if (!r.ok) return r;
  return { ok: true, text: r.texts[0] };
}

async function translateDirectBatchStream(texts, preserveHtml, batchId, tabId) {
  var state = await getStoredState();
  var mode = state.ui.mode || 'full';

  if (!state.settings.baseUrl || !state.settings.model) {
    return { ok: false, error: '请先配置 API。' };
  }

  var delimiter = core.BATCH_DELIMITER.trim();
  var systemPrompt;
  if (preserveHtml) {
    var knownWords = state.vocabulary.knownWords || [];
    systemPrompt = '翻译以下HTML片段为简体中文。保留所有HTML标签的位置和属性不变，只翻译文本内容。';
    if (mode === 'learn' && knownWords.length > 0) {
      systemPrompt += '已掌握的英文词保留不翻译：' + knownWords.join(', ') + '。';
    }
    if (texts.length > 1) {
      systemPrompt += '输入中的分隔符 ' + delimiter + ' 必须原样保留每一个分隔符。';
    }
    systemPrompt += '只输出翻译后的HTML。';
  } else {
    systemPrompt = core.buildSystemPrompt(state.vocabulary, mode);
  }

  var combined = texts.join(core.BATCH_DELIMITER);
  var headers = { 'Content-Type': 'application/json' };
  if (state.settings.apiKey) headers.Authorization = 'Bearer ' + state.settings.apiKey;

  var url = core.normalizeBaseUrl(state.settings.baseUrl) + '/chat/completions';
  var response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: state.settings.model,
        temperature: 0,
        max_tokens: 6144,
        stream: true,
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: combined }
        ]
      })
    });
  } catch (e) {
    return { ok: false, error: '网络请求失败：' + (e.message || '未知错误') };
  }

  if (!response.ok) {
    var errBody = await response.text();
    var errParsed;
    try { errParsed = JSON.parse(errBody); } catch(e) { errParsed = errBody; }
    return { ok: false, error: '模型请求失败：' + readErrorMessage(errParsed, 'HTTP ' + response.status) };
  }

  var reader = response.body.getReader();
  var decoder = new TextDecoder();
  var sseBuffer = '';
  var accumulated = '';
  var segmentIndex = 0;
  var cachePrefix = mode + ':' + (preserveHtml ? 'h' : 't') + ':';

  try {
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;

      sseBuffer += decoder.decode(chunk.value, { stream: true });
      var lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (!line.startsWith('data: ')) continue;
        var data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          var json = JSON.parse(data);
          var delta = '';
          if (json.choices && json.choices[0] && json.choices[0].delta) {
            delta = json.choices[0].delta.content || '';
          }
          accumulated += delta;

          if (texts.length === 1) continue;

          while (accumulated.indexOf(delimiter) !== -1) {
            var splitPos = accumulated.indexOf(delimiter);
            var segment = accumulated.substring(0, splitPos).trim();
            accumulated = accumulated.substring(splitPos + delimiter.length);

            if (segment && segmentIndex < texts.length) {
              directTranslationCache.set(cachePrefix + texts[segmentIndex], segment);
              try {
                chrome.tabs.sendMessage(tabId, {
                  type: 'NF_STREAM_SEGMENT',
                  batchId: batchId,
                  index: segmentIndex,
                  text: segment
                });
              } catch(e) {}
              segmentIndex++;
            }
          }
        } catch(e) {}
      }
    }
  } catch(e) {
    return { ok: false, error: '流式读取失败：' + (e.message || '未知错误') };
  }

  if (texts.length === 1) {
    var finalText = accumulated.trim();
    if (finalText) {
      directTranslationCache.set(cachePrefix + texts[0], finalText);
      try {
        chrome.tabs.sendMessage(tabId, {
          type: 'NF_STREAM_SEGMENT',
          batchId: batchId,
          index: 0,
          text: finalText
        });
      } catch(e) {}
      segmentIndex = 1;
    }
  } else if (accumulated.trim()) {
    var lastSegment = accumulated.trim();
    if (segmentIndex < texts.length) {
      directTranslationCache.set(cachePrefix + texts[segmentIndex], lastSegment);
      try {
        chrome.tabs.sendMessage(tabId, {
          type: 'NF_STREAM_SEGMENT',
          batchId: batchId,
          index: segmentIndex,
          text: lastSegment
        });
      } catch(e) {}
      segmentIndex++;
    }
  }

  pruneDirectCache();
  return { ok: true, streamed: true, count: segmentIndex };
}

// ── Event listeners ──

chrome.runtime.onInstalled.addListener(function handleInstalled() {
  initializeStorage().catch(function() { return null; });
  createContextMenus();
});

chrome.runtime.onStartup.addListener(function handleStartup() {
  createContextMenus();
});

chrome.contextMenus.onClicked.addListener(function handleContextMenu(info) {
  const selectedText = core.normalizeSelectedText(info.selectionText || '');
  if (!selectedText) return;
  if (info.menuItemId === CONTEXT_MENU_KNOWN) {
    addWordToVocabulary(selectedText, 'knownWords').catch(function() { return null; });
    return;
  }
  if (info.menuItemId === CONTEXT_MENU_LEARNING) {
    addWordToVocabulary(selectedText, 'learningWords').catch(function() { return null; });
  }
});

chrome.runtime.onMessage.addListener(function handleMessage(message, _sender, sendResponse) {
  if (!message || !message.type) return false;

  if (message.type === core.MESSAGE_TYPES.GET_STATE) {
    getStoredState()
      .then(function(state) { sendResponse({ ok: true, state: state }); })
      .catch(function(error) { sendResponse({ ok: false, error: error && error.message ? error.message : '读取数据失败。' }); });
    return true;
  }

  if (message.type === core.MESSAGE_TYPES.GET_LOGS) {
    getStoredLogs()
      .then(function(logs) { sendResponse({ ok: true, logs: logs }); })
      .catch(function(error) { sendResponse({ ok: false, error: error && error.message ? error.message : '读取日志失败。' }); });
    return true;
  }

  if (message.type === core.MESSAGE_TYPES.SAVE_SETTINGS) {
    saveStoredState({ settings: message.settings })
      .then(function(state) { sendResponse({ ok: true, state: state }); })
      .catch(function(error) { sendResponse({ ok: false, error: error && error.message ? error.message : '保存配置失败。' }); });
    return true;
  }

  if (message.type === core.MESSAGE_TYPES.TEST_CONNECTION) {
    testConnection(message.settings)
      .then(function(result) { sendResponse(result); })
      .catch(function(error) { sendResponse({ ok: false, error: error && error.message ? error.message : '连接测试失败。' }); });
    return true;
  }

  if (message.type === core.MESSAGE_TYPES.SAVE_VOCABULARY) {
    saveStoredState({ vocabulary: message.vocabulary })
      .then(function(state) { sendResponse({ ok: true, state: state }); })
      .catch(function(error) { sendResponse({ ok: false, error: error && error.message ? error.message : '保存词库失败。' }); });
    return true;
  }

  if (message.type === core.MESSAGE_TYPES.ADD_WORD_TO_LIST) {
    addWordToVocabulary(message.word, message.listKey)
      .then(function(state) { sendResponse({ ok: true, state: state }); })
      .catch(function(error) { sendResponse({ ok: false, error: error && error.message ? error.message : '写入词库失败。' }); });
    return true;
  }

  if (message.type === core.MESSAGE_TYPES.TRANSLATE_SELECTION) {
    translateSelection(message.text)
      .then(function(result) { sendResponse(result); })
      .catch(function(error) { sendResponse({ ok: false, error: error && error.message ? error.message : '划词翻译失败。' }); });
    return true;
  }

  if (message.type === core.MESSAGE_TYPES.ANNOTATE_TEXT) {
    requestAnnotation(message.text)
      .then(function(result) { sendResponse(result); })
      .catch(function(error) { sendResponse({ ok: false, error: error && error.message ? error.message : '注词失败。' }); });
    return true;
  }

  if (message.type === core.MESSAGE_TYPES.ANNOTATE_BATCH) {
    requestBatchAnnotation(message.texts, message.overrides, 'annotation-batch-error')
      .then(function(result) { sendResponse(result); })
      .catch(function(error) { sendResponse({ ok: false, error: error && error.message ? error.message : '批量注词失败。' }); });
    return true;
  }

  if (message.type === core.MESSAGE_TYPES.TRANSLATE_DIRECT_BATCH) {
    if (message.stream && _sender && _sender.tab && _sender.tab.id) {
      translateDirectBatchStream(message.texts, message.preserveHtml, message.batchId, _sender.tab.id)
        .then(function(result) { sendResponse(result); })
        .catch(function(error) { sendResponse({ ok: false, error: error && error.message ? error.message : '流式翻译失败。' }); });
    } else {
      translateDirectBatch(message.texts, message.preserveHtml)
        .then(function(result) { sendResponse(result); })
        .catch(function(error) { sendResponse({ ok: false, error: error && error.message ? error.message : '批量翻译失败。' }); });
    }
    return true;
  }

  if (message.type === 'NF_TRANSLATE_DIRECT') {
    translateDirect(message.text, message.preserveHtml)
      .then(function(result) { sendResponse(result); })
      .catch(function(error) { sendResponse({ ok: false, error: error.message || '翻译失败' }); });
    return true;
  }

  if (message.type === core.MESSAGE_TYPES.SAVE_UI) {
    getStoredState().then(function(currentState) {
      var mergedUi = {};
      if (currentState.ui) { for (var k in currentState.ui) mergedUi[k] = currentState.ui[k]; }
      if (message.ui) { for (var k in message.ui) mergedUi[k] = message.ui[k]; }
      return saveStoredState({ ui: mergedUi });
    })
    .then(function(state) { sendResponse({ ok: true, state: state }); })
    .catch(function(error) { sendResponse({ ok: false, error: error && error.message ? error.message : '保存 UI 设置失败。' }); });
    return true;
  }

  if (message.type === core.MESSAGE_TYPES.CLEAR_LOGS) {
    clearLogs()
      .then(function() { sendResponse({ ok: true }); })
      .catch(function(error) { sendResponse({ ok: false, error: error && error.message ? error.message : '清空日志失败。' }); });
    return true;
  }

  if (message.type === 'NF_AUDIO_TOGGLE') {
    toggleAudioCapture(message.serverUrl)
      .then(function(result) { sendResponse(result); })
      .catch(function(error) { sendResponse({ ok: false, error: error.message }); });
    return true;
  }

  if (message.type === 'NF_AUDIO_STATE') {
    chrome.storage.local.get('breezeAudioActive', function(r) {
      sendResponse({ capturing: !!(r && r.breezeAudioActive) });
    });
    return true;
  }

  if (message.type === 'NF_OFFSCREEN_READY') {
    chrome.storage.session.get('pendingAudioStart', function(r) {
      if (r && r.pendingAudioStart) {
        chrome.runtime.sendMessage(r.pendingAudioStart);
        chrome.storage.session.remove('pendingAudioStart');
      }
    });
    return false;
  }

  if (message.type === 'NF_AUDIO_ACTIVE') {
    chrome.storage.local.set({ breezeAudioActive: message.active });
    return false;
  }

  return false;
});

// ── Audio capture ──

chrome.commands.onCommand.addListener(function(command) {
  if (command === 'translate-page') {
    chrome.tabs.query({ active: true, currentWindow: true }, async function(tabs) {
      if (!tabs || !tabs[0] || !tabs[0].id) return;
      var tabId = tabs[0].id;
      try {
        await chrome.tabs.sendMessage(tabId, { type: core.MESSAGE_TYPES.START_ANNOTATION, dryRun: true });
      } catch(e) {
        await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['shared.js', 'content.js'] });
        await new Promise(function(r) { setTimeout(r, 200); });
      }
      chrome.tabs.sendMessage(tabId, {
        type: core.MESSAGE_TYPES.START_ANNOTATION,
        directTranslate: true
      }).catch(function() {});
    });
  }
});

async function toggleAudioCapture(serverUrl) {
  var state = await chrome.storage.local.get('breezeAudioActive');
  if (state && state.breezeAudioActive) {
    chrome.runtime.sendMessage({ type: 'NF_AUDIO_STOP' });
    chrome.storage.local.set({ breezeAudioActive: false });
    return { ok: true, capturing: false };
  }

  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error('No active tab');
  var tab = tabs[0];

  var streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  var startMsg = {
    type: 'NF_AUDIO_START',
    streamId: streamId,
    serverUrl: serverUrl,
    tabId: tab.id
  };

  var exists = false;
  try { exists = await chrome.offscreen.hasDocument(); } catch(e) { exists = false; }
  if (!exists) {
    await chrome.storage.session.set({ pendingAudioStart: startMsg });
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Tab audio capture for real-time translation'
      });
    } catch(e) {
      await chrome.storage.session.remove('pendingAudioStart');
      chrome.storage.local.set({ breezeAudioActive: false });
      throw new Error('无法创建音频文档：' + (e.message || '未知错误'));
    }
  } else {
    chrome.runtime.sendMessage(startMsg);
  }

  chrome.storage.local.set({ breezeAudioActive: true });
  return { ok: true, capturing: true };
}
