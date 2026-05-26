(function attachNanFengCore(global) {
  const DEFAULT_STATE = Object.freeze({
    settings: {
      baseUrl: 'http://192.168.8.104:8000/v1',
      apiKey: '',
      model: 'qwen3.6',
    },
    vocabulary: {
      knownWords: [],
      learningWords: [],
    },
    ui: {
      theme: 'system',
      mode: 'full',
    },
  });

  const SKIP_TAGS = new Set([
    'script',
    'style',
    'code',
    'pre',
    'textarea',
    'input',
    'noscript',
  ]);

  const STORAGE_KEY = 'breezeTranslateState';
  const LOG_STORAGE_KEY = 'breezeTranslateLogs';
  const MAX_LOG_ENTRIES = 200;
  const BATCH_DELIMITER = '\n<<<NANFENG_BLOCK_SPLIT>>>\n';
  const PLACEHOLDER_PREFIX = '[[NF_INLINE_';
  const DEFAULT_BATCH_SIZE = 3;
  const DEFAULT_BATCH_CHARS = 900;
  const MESSAGE_TYPES = Object.freeze({
    ANNOTATE_TEXT: 'NF_ANNOTATE_TEXT',
    ANNOTATE_BATCH: 'NF_ANNOTATE_BATCH',
    ADD_WORD_TO_LIST: 'NF_ADD_WORD_TO_LIST',
    CLEAR_LOGS: 'NF_CLEAR_LOGS',
    GET_STATE: 'NF_GET_STATE',
    GET_LOGS: 'NF_GET_LOGS',
    SAVE_SETTINGS: 'NF_SAVE_SETTINGS',
    SAVE_VOCABULARY: 'NF_SAVE_VOCABULARY',
    START_ANNOTATION: 'NF_START_ANNOTATION',
    TEST_CONNECTION: 'NF_TEST_CONNECTION',
    TRANSLATE_SELECTION: 'NF_TRANSLATE_SELECTION',
  });

  function createDefaultState() {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }

  function normalizeWord(rawWord) {
    return String(rawWord || '').trim().toLowerCase();
  }

  function normalizeSelectedText(rawText) {
    return String(rawText || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeWordList(words) {
    const seen = new Set();
    const result = [];

    for (const word of Array.isArray(words) ? words : []) {
      const normalized = normalizeWord(word);
      if (!normalized || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      result.push(normalized);
    }

    return result;
  }

  function mergeStoredState(storedState) {
    const defaults = createDefaultState();
    const source = storedState && typeof storedState === 'object' ? storedState : {};
    const knownWords = normalizeWordList(source.vocabulary && source.vocabulary.knownWords);
    const learningWords = normalizeWordList(source.vocabulary && source.vocabulary.learningWords)
      .filter(function removeKnownDuplicates(word) {
        return !knownWords.includes(word);
      });

    return {
      settings: {
        baseUrl: String((source.settings && source.settings.baseUrl) || defaults.settings.baseUrl).trim() || defaults.settings.baseUrl,
        apiKey: String((source.settings && source.settings.apiKey) || defaults.settings.apiKey).trim(),
        model: String((source.settings && source.settings.model) || defaults.settings.model).trim() || defaults.settings.model,
      },
      vocabulary: {
        knownWords: knownWords,
        learningWords: learningWords,
      },
      ui: {
        theme: String((source.ui && source.ui.theme) || defaults.ui.theme).trim() || defaults.ui.theme,
      },
    };
  }

  function upsertWord(vocabulary, rawWord, targetListKey) {
    const safeVocabulary = mergeStoredState({ vocabulary: vocabulary }).vocabulary;
    const word = normalizeWord(rawWord);

    if (!word || (targetListKey !== 'knownWords' && targetListKey !== 'learningWords')) {
      return safeVocabulary;
    }

    const otherListKey = targetListKey === 'knownWords' ? 'learningWords' : 'knownWords';
    const nextTarget = safeVocabulary[targetListKey].filter(function keepUnique(item) {
      return item !== word;
    });

    nextTarget.push(word);

    return {
      knownWords: targetListKey === 'knownWords' ? nextTarget : safeVocabulary.knownWords.filter(function keepOut(item) {
        return item !== word;
      }),
      learningWords: targetListKey === 'learningWords' ? nextTarget : safeVocabulary.learningWords.filter(function keepOut(item) {
        return item !== word;
      }),
    };
  }

  function removeWord(vocabulary, rawWord, listKey) {
    const safeVocabulary = mergeStoredState({ vocabulary: vocabulary }).vocabulary;
    const word = normalizeWord(rawWord);

    if (!word || !safeVocabulary[listKey]) {
      return safeVocabulary;
    }

    return {
      knownWords: listKey === 'knownWords' ? safeVocabulary.knownWords.filter(function keep(item) {
        return item !== word;
      }) : safeVocabulary.knownWords.slice(),
      learningWords: listKey === 'learningWords' ? safeVocabulary.learningWords.filter(function keep(item) {
        return item !== word;
      }) : safeVocabulary.learningWords.slice(),
    };
  }

  function clearWordList(vocabulary, listKey) {
    const safeVocabulary = mergeStoredState({ vocabulary: vocabulary }).vocabulary;

    if (!safeVocabulary[listKey]) {
      return safeVocabulary;
    }

    return {
      knownWords: listKey === 'knownWords' ? [] : safeVocabulary.knownWords.slice(),
      learningWords: listKey === 'learningWords' ? [] : safeVocabulary.learningWords.slice(),
    };
  }

  function normalizeBaseUrl(baseUrl) {
    const trimmed = String(baseUrl || DEFAULT_STATE.settings.baseUrl)
      .trim()
      .replace(/\/chat\/completions\/?$/i, '')
      .replace(/\/+$/, '');
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      return DEFAULT_STATE.settings.baseUrl;
    }
    return trimmed;
  }

  function buildSystemPrompt(vocabulary, mode) {
    var m = mode || 'full';
    var delimiter = BATCH_DELIMITER.trim();

    if (m === 'full') {
      return '你是翻译工具。将以下英文文本翻译成简体中文。规则：1. 直接翻译全文为中文，保持段落结构。2. 如果输入中包含分隔符 ' + delimiter + '，必须原样保留每一个分隔符。3. 只输出翻译后的纯文本，不要任何解释。';
    }

    var safeVocabulary = mergeStoredState({ vocabulary: vocabulary }).vocabulary;
    var knownWords = safeVocabulary.knownWords;
    var wordList = knownWords.length ? knownWords.join(', ') : '无';

    if (!knownWords.length) {
      return '你是翻译工具。将以下英文文本翻译成简体中文。规则：1. 直接翻译全文为中文，保持段落结构。2. 如果输入中包含分隔符 ' + delimiter + '，必须原样保留每一个分隔符。3. 只输出翻译后的纯文本，不要任何解释。';
    }

    return '你是翻译工具。规则：\n1. 将英文翻译成简体中文。\n2. 重要例外：以下英文单词由用户标记为已掌握，必须保留英文原文不翻译：' + wordList + '\n3. 示例："The algorithm uses perception" → "这个 algorithm 使用 perception"\n4. 如果输入中包含分隔符 ' + delimiter + '，必须原样保留。\n5. 只输出翻译结果。';
  }

  function buildBatchText(blocks) {
    return (Array.isArray(blocks) ? blocks : []).join(BATCH_DELIMITER);
  }

  function parseBatchText(text, expectedCount) {
    const parts = String(text || '').split(BATCH_DELIMITER);
    return parts.length === expectedCount ? parts : null;
  }

  function buildPlaceholderToken(index) {
    return PLACEHOLDER_PREFIX + String(index) + ']]';
  }

  function restoreSerializedPlaceholders(text, placeholderMap) {
    let output = String(text || '');
    for (const [token, value] of placeholderMap.entries()) {
      output = output.split(token).join(value);
    }
    return output;
  }

  function buildChatRequest(params) {
    const state = mergeStoredState({
      settings: params && params.settings,
      vocabulary: params && params.vocabulary,
    });
    const text = String((params && params.text) || '');
    const headers = {
      'Content-Type': 'application/json',
    };

    if (state.settings.apiKey) {
      headers.Authorization = 'Bearer ' + state.settings.apiKey;
    }

    return {
      url: normalizeBaseUrl(state.settings.baseUrl) + '/chat/completions',
      options: {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          model: state.settings.model,
          temperature: 0,
          max_tokens: 4096,
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            {
              role: 'system',
              content: buildSystemPrompt(state.vocabulary, params && params.mode),
            },
            {
              role: 'user',
              content: text,
            },
          ],
        }),
      },
    };
  }

  function extractAssistantText(payload) {
    const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message;

    if (!message) {
      throw new Error('MODEL_RESPONSE_INVALID');
    }

    if (typeof message.content === 'string') {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .map(function pickText(part) {
          return part && typeof part.text === 'string' ? part.text : '';
        })
        .join('');
    }

    throw new Error('MODEL_RESPONSE_INVALID');
  }

  function shouldSkipTagName(tagName) {
    return SKIP_TAGS.has(String(tagName || '').toLowerCase());
  }

  function shouldProcessText(rawText) {
    const text = normalizeSelectedText(rawText);
    const wordTokens = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    const letters = text.match(/[A-Za-z]/g) || [];

    if (text.length < 6) {
      return false;
    }

    if (!/[A-Za-z]/.test(text)) {
      return false;
    }

    if (/^(https?:\/\/|www\.)/i.test(text)) {
      return false;
    }

    if (/^[\d\W_]+$/.test(text)) {
      return false;
    }

    if (/^[A-Z]{1,4}$/.test(text)) {
      return false;
    }

    if (letters.length < 4) {
      return false;
    }

    if (wordTokens.length >= 2) {
      return true;
    }

    return Boolean(wordTokens[0] && wordTokens[0].length >= 8 && /[aeiouy]/i.test(wordTokens[0]));
  }

  function hasUnbalancedBrackets(text) {
    const value = String(text || '');
    const roundBalance = (value.match(/\(/g) || []).length - (value.match(/\)/g) || []).length;
    const squareBalance = (value.match(/\[/g) || []).length - (value.match(/\]/g) || []).length;
    return roundBalance !== 0 || squareBalance !== 0;
  }

  function shouldProcessTextCandidate(rawText, context) {
    const source = String(rawText || '');
    const normalized = normalizeSelectedText(source);
    const hasElementSiblings = Boolean(context && context.hasElementSiblings);

    if (!shouldProcessText(source)) {
      return false;
    }

    if (hasUnbalancedBrackets(source)) {
      return false;
    }

    if (/\([^)]*[A-Za-z][^)]*\)/.test(normalized) && !/[.!?]$/.test(normalized)) {
      return false;
    }

    if (hasElementSiblings) {
      if (source !== source.trim()) {
        return false;
      }

      if (normalized.length < 32 && !/[.!?]$/.test(normalized)) {
        return false;
      }
    }

    return true;
  }

  function stripInlineAnnotations(text) {
    return String(text || '').replace(/\s*\((?=[^)]*[\u3400-\u9FFF])[^)]*\)/g, '');
  }

  function shouldTranslateSelection(rawText) {
    const text = normalizeSelectedText(rawText);
    if (!text) {
      return false;
    }

    if (!/[A-Za-z]/.test(text)) {
      return false;
    }

    const words = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    if (words.length === 0 || words.length > 6) {
      return false;
    }

    if (text.length > 80) {
      return false;
    }

    return true;
  }

  function normalizeComparableText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function extractPlaceholderTokens(text) {
    return String(text || '').match(/\[\[NF_INLINE_\d+\]\]/g) || [];
  }

  function getOriginPattern(baseUrl) {
    const url = new URL(normalizeBaseUrl(baseUrl));
    return url.origin + '/*';
  }

  function getSafeOriginPattern(baseUrl) {
    const raw = String(baseUrl || '').trim();
    if (!raw || !/^https?:\/\//i.test(raw)) {
      throw new Error('INVALID_PROTOCOL');
    }
    return getOriginPattern(raw);
  }

  function tryGetOriginPattern(baseUrl) {
    try {
      return getSafeOriginPattern(baseUrl);
    } catch (error) {
      return null;
    }
  }

  function createPreviewText(text, maxLength) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    const limit = Number(maxLength) > 0 ? Number(maxLength) : 120;

    if (normalized.length <= limit) {
      return normalized;
    }

    return normalized.slice(0, limit).trimEnd() + '...';
  }

  function extractApiErrorMessage(payload, fallbackMessage) {
    if (payload && payload.error && typeof payload.error.message === 'string') {
      return payload.error.message;
    }

    if (payload && typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }

    if (payload && payload.error && typeof payload.error.code === 'string') {
      return payload.error.code;
    }

    if (payload && typeof payload.detail === 'string' && payload.detail.trim()) {
      return payload.detail.trim();
    }

    if (payload && typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }

    if (typeof payload === 'string' && payload.trim()) {
      return payload.trim();
    }

    return fallbackMessage;
  }

  function shouldRestoreOriginalText(lastAnnotatedText, currentText) {
    return Boolean(lastAnnotatedText) && String(lastAnnotatedText) === String(currentText || '');
  }

  function createAnnotationSummary(total, results) {
    const summary = {
      total: Number(total) || 0,
      success: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };

    for (const result of Array.isArray(results) ? results : []) {
      if (!result || result.status === 'cancelled') {
        continue;
      }

      if (result.status === 'success') {
        summary.success += 1;
        continue;
      }

      if (result.status === 'failed') {
        summary.failed += 1;
        if (result.error && !summary.errors.includes(result.error)) {
          summary.errors.push(result.error);
        }
        continue;
      }

      summary.skipped += 1;
    }

    return summary;
  }

  function appendDebugLog(existingLogs, nextEntry, maxEntries) {
    const safeLogs = Array.isArray(existingLogs) ? existingLogs : [];
    const limit = Number(maxEntries) > 0 ? Number(maxEntries) : MAX_LOG_ENTRIES;
    return [nextEntry].concat(safeLogs).slice(0, limit);
  }

  function isSafeAnnotationResult(originalText, candidateText, mode) {
    var candidate = String(candidateText || '');

    if (!candidate.trim()) {
      return false;
    }

    if (/[*#`]{2,}|^\s*[-*]\s+/m.test(candidate)) {
      return false;
    }

    if (mode === 'full' || mode === 'learn') {
      return candidate.length >= 2;
    }

    var original = String(originalText || '');
    var strippedCandidate = stripInlineAnnotations(candidate);

    if (original && candidate.length < Math.max(3, Math.floor(original.length * 0.5))) {
      return false;
    }

    if (original && candidate.length > original.length * 8 + 120) {
      return false;
    }

    return normalizeComparableText(strippedCandidate) === normalizeComparableText(original);
  }

  function isSafeSerializedTranslation(originalText, candidateText) {
    const originalTokens = extractPlaceholderTokens(originalText);
    const candidateTokens = extractPlaceholderTokens(candidateText);
    return originalTokens.join('|') === candidateTokens.join('|');
  }

  global.NanFengCore = {
    clearWordList: clearWordList,
    buildChatRequest: buildChatRequest,
    buildBatchText: buildBatchText,
    buildPlaceholderToken: buildPlaceholderToken,
    buildSystemPrompt: buildSystemPrompt,
    createAnnotationSummary: createAnnotationSummary,
    createPreviewText: createPreviewText,
    createDefaultState: createDefaultState,
    extractApiErrorMessage: extractApiErrorMessage,
    extractAssistantText: extractAssistantText,
    parseBatchText: parseBatchText,
    getOriginPattern: getOriginPattern,
    isSafeAnnotationResult: isSafeAnnotationResult,
    isSafeSerializedTranslation: isSafeSerializedTranslation,
    BATCH_DELIMITER: BATCH_DELIMITER,
    DEFAULT_BATCH_CHARS: DEFAULT_BATCH_CHARS,
    DEFAULT_BATCH_SIZE: DEFAULT_BATCH_SIZE,
    LOG_STORAGE_KEY: LOG_STORAGE_KEY,
    MAX_LOG_ENTRIES: MAX_LOG_ENTRIES,
    MESSAGE_TYPES: MESSAGE_TYPES,
    mergeStoredState: mergeStoredState,
    normalizeBaseUrl: normalizeBaseUrl,
    normalizeComparableText: normalizeComparableText,
    normalizeSelectedText: normalizeSelectedText,
    normalizeWord: normalizeWord,
    normalizeWordList: normalizeWordList,
    removeWord: removeWord,
    shouldProcessText: shouldProcessText,
    shouldProcessTextCandidate: shouldProcessTextCandidate,
    shouldTranslateSelection: shouldTranslateSelection,
    shouldRestoreOriginalText: shouldRestoreOriginalText,
    shouldSkipTagName: shouldSkipTagName,
    STORAGE_KEY: STORAGE_KEY,
    stripInlineAnnotations: stripInlineAnnotations,
    tryGetOriginPattern: tryGetOriginPattern,
    appendDebugLog: appendDebugLog,
    restoreSerializedPlaceholders: restoreSerializedPlaceholders,
    PLACEHOLDER_PREFIX: PLACEHOLDER_PREFIX,
    upsertWord: upsertWord,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
console.log('[breeze] shared.js loaded, NanFengCore:', typeof (globalThis || self).NanFengCore);
