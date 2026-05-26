const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCore() {
  const filePath = path.join(__dirname, '..', 'shared.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const context = {
    globalThis: {},
    console,
    URL,
  };

  context.global = context.globalThis;
  vm.runInNewContext(source, context, { filename: filePath });

  return context.globalThis.NanFengCore;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('createDefaultState returns the expected storage shape', () => {
  const core = loadCore();
  const state = core.createDefaultState();

  assert.deepEqual(plain(state), {
    settings: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
    },
    vocabulary: {
      knownWords: [],
      learningWords: [],
    },
    ui: {
      theme: 'system',
    },
  });
});

test('mergeStoredState lowercases, deduplicates, and keeps defaults', () => {
  const core = loadCore();
  const merged = core.mergeStoredState({
    settings: {
      model: 'qwen-max',
    },
    vocabulary: {
      knownWords: ['Apple', 'apple', 'Banana'],
      learningWords: ['BANANA', 'Orbit'],
    },
  });

  assert.deepEqual(plain(merged.settings), {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'qwen-max',
  });
  assert.deepEqual(plain(merged.vocabulary), {
    knownWords: ['apple', 'banana'],
    learningWords: ['orbit'],
  });
});

test('upsertWord moves a word into the target list only once', () => {
  const core = loadCore();
  const nextVocabulary = core.upsertWord(
    {
      knownWords: ['focus'],
      learningWords: ['orbit'],
    },
    'Orbit',
    'knownWords'
  );

  assert.deepEqual(plain(nextVocabulary), {
    knownWords: ['focus', 'orbit'],
    learningWords: [],
  });
});

test('buildSystemPrompt injects both vocabulary lists into the fixed template', () => {
  const core = loadCore();
  const prompt = core.buildSystemPrompt({
    knownWords: ['known', 'clear'],
    learningWords: ['ubiquitous', 'resilient'],
  });

  assert.match(prompt, /已知词汇：known, clear/);
  assert.match(prompt, /重点生词：ubiquitous, resilient/);
  assert.match(prompt, /绝不要输出任何多余的解释/);
  assert.doesNotMatch(prompt, /无法 100% 保持原文语义与结构不变，请原样返回输入/);
});

test('batch limits favor smaller responsive chunks', () => {
  const core = loadCore();

  assert.equal(core.DEFAULT_BATCH_SIZE, 3);
  assert.equal(core.DEFAULT_BATCH_CHARS, 900);
});

test('buildChatRequest appends chat/completions and omits auth when apiKey is empty', () => {
  const core = loadCore();
  const request = core.buildChatRequest({
    settings: {
      baseUrl: 'http://127.0.0.1:1234/v1/',
      apiKey: '',
      model: 'qwen-max',
    },
    vocabulary: {
      knownWords: ['known'],
      learningWords: ['rare'],
    },
    text: ' A rare bird appeared. ',
  });

  assert.equal(request.url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.equal('Authorization' in request.options.headers, false);

  const payload = JSON.parse(request.options.body);
  assert.equal(payload.model, 'qwen-max');
  assert.equal(payload.messages[1].content, ' A rare bird appeared. ');
});

test('buildChatRequest normalizes full chat completions endpoints without duplicating the path', () => {
  const core = loadCore();
  const request = core.buildChatRequest({
    settings: {
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk-demo',
      model: 'gpt-4o-mini',
    },
    vocabulary: {
      knownWords: [],
      learningWords: [],
    },
    text: 'Hello world.',
  });

  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
});

test('extractAssistantText preserves the model returned spacing', () => {
  const core = loadCore();
  const output = core.extractAssistantText({
    choices: [
      {
        message: {
          content: ' ubiquitous (无处不在的) '
        }
      }
    ]
  });

  assert.equal(output, ' ubiquitous (无处不在的) ');
});

test('shouldProcessText accepts sentence-like English, titles, and rejects noisy fragments', () => {
  const core = loadCore();

  assert.equal(core.shouldProcessText('The resilient scientist kept writing.'), true);
  assert.equal(core.shouldProcessText('Elegant product roadmap'), true);
  assert.equal(core.shouldProcessText('Open systems thinking'), true);
  assert.equal(core.shouldProcessText('12345'), false);
  assert.equal(core.shouldProcessText('https://example.com'), false);
  assert.equal(core.shouldProcessText('OK'), false);
});

test('shouldProcessTextCandidate rejects risky inline fragments but keeps stable text blocks', () => {
  const core = loadCore();

  assert.equal(core.shouldProcessTextCandidate('Config lives at ', { hasElementSiblings: true }), false);
  assert.equal(core.shouldProcessTextCandidate(' home page', { hasElementSiblings: true }), false);
  assert.equal(core.shouldProcessTextCandidate('Or connect a channel (', { hasElementSiblings: true }), false);
  assert.equal(core.shouldProcessTextCandidate('Configuration (optional)', { hasElementSiblings: false }), false);
  assert.equal(core.shouldProcessTextCandidate('OpenClaw is a local-first AI bridge for your chat apps.', { hasElementSiblings: false }), true);
});

test('isSafeAnnotationResult rejects markdown-like output and blank text', () => {
  const core = loadCore();

  assert.equal(core.isSafeAnnotationResult('The bird appears.', 'The bird (鸟) appears.'), true);
  assert.equal(core.isSafeAnnotationResult('The bird appears.', 'A bird appears.'), false);
  assert.equal(core.isSafeAnnotationResult('Plain text', ''), false);
  assert.equal(core.isSafeAnnotationResult('Plain text', '**Plain text**'), false);
});

test('shouldSkipTagName ignores code-like and editable containers', () => {
  const core = loadCore();

  assert.equal(core.shouldSkipTagName('pre'), true);
  assert.equal(core.shouldSkipTagName('code'), true);
  assert.equal(core.shouldSkipTagName('div'), false);
});

test('getOriginPattern converts an endpoint into a minimal host permission pattern', () => {
  const core = loadCore();

  assert.equal(core.getOriginPattern('https://api.openai.com/v1'), 'https://api.openai.com/*');
  assert.equal(core.getOriginPattern('http://127.0.0.1:1234/v1/chat/completions'), 'http://127.0.0.1:1234/*');
});

test('shouldRestoreOriginalText only restores nodes still holding the last annotation', () => {
  const core = loadCore();

  assert.equal(core.shouldRestoreOriginalText('word (单词)', 'word (单词)'), true);
  assert.equal(core.shouldRestoreOriginalText('word (单词)', 'word (单词) updated by site'), false);
});

test('createAnnotationSummary keeps counts and first error details', () => {
  const core = loadCore();
  const summary = core.createAnnotationSummary(4, [
    { status: 'failed', error: '401 Unauthorized' },
    { status: 'success' },
    { status: 'failed', error: '429 Too Many Requests' },
    { status: 'skipped' },
  ]);

  assert.deepEqual(plain(summary), {
    total: 4,
    success: 1,
    failed: 2,
    skipped: 1,
    errors: ['401 Unauthorized', '429 Too Many Requests'],
  });
});

test('appendDebugLog prepends latest entries and caps storage length', () => {
  const core = loadCore();
  const nextLogs = core.appendDebugLog(
    [
      { id: 'older-1', message: 'older 1' },
      { id: 'older-2', message: 'older 2' },
    ],
    { id: 'latest', message: 'latest' },
    2
  );

  assert.deepEqual(plain(nextLogs), [
    { id: 'latest', message: 'latest' },
    { id: 'older-1', message: 'older 1' },
  ]);
});

test('tryGetOriginPattern returns null for invalid urls', () => {
  const core = loadCore();

  assert.equal(core.tryGetOriginPattern('https://api.openai.com/v1'), 'https://api.openai.com/*');
  assert.equal(core.tryGetOriginPattern('not-a-url'), null);
  assert.equal(core.tryGetOriginPattern('file:///tmp/demo'), null);
});

test('createPreviewText truncates long multiline model output for UI display', () => {
  const core = loadCore();
  const preview = core.createPreviewText('line one\nline two\nline three', 12);

  assert.equal(preview, 'line one lin...');
});

test('extractApiErrorMessage reads common OpenAI-compatible error payload shapes', () => {
  const core = loadCore();

  assert.equal(core.extractApiErrorMessage({ error: 'bad key' }, 'fallback'), 'bad key');
  assert.equal(core.extractApiErrorMessage({ detail: 'service offline' }, 'fallback'), 'service offline');
  assert.equal(core.extractApiErrorMessage({ error: { code: 'model_not_found' } }, 'fallback'), 'model_not_found');
});

test('buildBatchText joins blocks with a stable delimiter and parseBatchText restores them', () => {
  const core = loadCore();
  const joined = core.buildBatchText(['First block', 'Second block', 'Third block']);
  const restored = core.parseBatchText(joined, 3);

  assert.equal(joined.includes(core.BATCH_DELIMITER), true);
  assert.deepEqual(plain(restored), ['First block', 'Second block', 'Third block']);
});

test('isSafeAnnotationResult allows normalized whitespace differences after removing inline annotations', () => {
  const core = loadCore();

  assert.equal(
    core.isSafeAnnotationResult('Config lives at ', 'Config lives at'),
    true
  );
  assert.equal(
    core.isSafeAnnotationResult('Remote access: ', 'Remote (远程的) access (访问):'),
    true
  );
});

test('buildPlaceholderToken and restoreSerializedPlaceholders keep inline placeholders stable', () => {
  const core = loadCore();
  const token0 = core.buildPlaceholderToken(0);
  const token1 = core.buildPlaceholderToken(1);
  const restored = core.restoreSerializedPlaceholders(
    'Read ' + token0 + ' and ' + token1,
    new Map([
      [token0, '<a href="/docs">the docs</a>'],
      [token1, '<strong>examples</strong>'],
    ])
  );

  assert.equal(restored, 'Read <a href="/docs">the docs</a> and <strong>examples</strong>');
});

test('isSafeSerializedTranslation accepts placeholder-preserving translations', () => {
  const core = loadCore();
  const token = core.buildPlaceholderToken(0);

  assert.equal(
    core.isSafeSerializedTranslation('Read ' + token + ' today.', 'Read ' + token + ' (今天) today.'),
    true
  );
  assert.equal(
    core.isSafeSerializedTranslation('Read ' + token + ' today.', 'Read the docs today.'),
    false
  );
});

test('manifest does not declare unknown permissions', () => {
  const manifestPath = path.join(__dirname, '..', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.permissions.includes('permissions'), false);
});

test('normalizeSelectedText trims and collapses whitespace for selection text', () => {
  const core = loadCore();

  assert.equal(core.normalizeSelectedText('  OpenClaw   agent \n bridge  '), 'OpenClaw agent bridge');
});

test('shouldTranslateSelection accepts short english phrases and rejects long or non-english ones', () => {
  const core = loadCore();

  assert.equal(core.shouldTranslateSelection('OpenClaw agent'), true);
  assert.equal(core.shouldTranslateSelection('这是中文'), false);
  assert.equal(core.shouldTranslateSelection('one two three four five six seven'), false);
  assert.equal(core.shouldTranslateSelection(''), false);
});

test('selection message types exist for translate and vocabulary writes', () => {
  const core = loadCore();

  assert.equal(core.MESSAGE_TYPES.TRANSLATE_SELECTION, 'NF_TRANSLATE_SELECTION');
  assert.equal(core.MESSAGE_TYPES.ADD_WORD_TO_LIST, 'NF_ADD_WORD_TO_LIST');
});
