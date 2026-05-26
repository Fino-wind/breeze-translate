const popupCore = globalThis.NanFengCore;
const popupState = {
  state: popupCore.createDefaultState(),
  busy: false,
};

const elements = {
  annotateButton: document.getElementById('annotateButton'),
  knownCount: document.getElementById('knownCount'),
  knownWordsList: document.getElementById('knownWordsList'),
  learningCount: document.getElementById('learningCount'),
  learningWordsList: document.getElementById('learningWordsList'),
  openOptionsButton: document.getElementById('openOptionsButton'),
  statusBanner: document.getElementById('statusBanner'),
};

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

function queryActiveTab() {
  return new Promise(function resolveTab(resolve, reject) {
    chrome.tabs.query({ active: true, currentWindow: true }, function handleTabs(tabs) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise(function resolveMessage(resolve, reject) {
    chrome.tabs.sendMessage(tabId, message, function handleResponse(response) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

function executeScripts(tabId, files) {
  return new Promise(function resolveInjection(resolve, reject) {
    chrome.scripting.executeScript(
      {
        target: { tabId: tabId },
        files: files,
      },
      function handleInjection() {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve();
      }
    );
  });
}

async function ensureContentScript(tabId) {
  try {
    await sendMessageToTab(tabId, { type: popupCore.MESSAGE_TYPES.START_ANNOTATION, dryRun: true });
  } catch (error) {
    await executeScripts(tabId, ['shared.js', 'content.js']);
    await new Promise(function(r) { setTimeout(r, 200); });
  }
}

function setBusy(isBusy) {
  popupState.busy = isBusy;
  elements.annotateButton.disabled = isBusy;
  elements.openOptionsButton.disabled = isBusy;
  document.querySelectorAll('button, input').forEach(function toggleControl(control) {
    if (control.id === 'annotateButton' || control.id === 'openOptionsButton') {
      return;
    }

    control.disabled = isBusy;
  });
}

function setStatus(message, tone) {
  elements.statusBanner.textContent = message;
  elements.statusBanner.dataset.tone = tone || 'neutral';
}

function renderWordList(listKey, target) {
  const words = popupState.state.vocabulary[listKey];
  const fragment = document.createDocumentFragment();

  if (!words.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = listKey === 'knownWords' ? '这里留给你已经掌握的词。' : '这里放正在学习的生词。';
    fragment.appendChild(empty);
  } else {
    words.forEach(function createWordItem(word) {
      const item = document.createElement('li');
      item.className = 'word-item';

      const label = document.createElement('span');
      label.textContent = word;
      item.appendChild(label);

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.textContent = '×';
      removeButton.dataset.removeWord = word;
      removeButton.dataset.listKey = listKey;
      item.appendChild(removeButton);

      fragment.appendChild(item);
    });
  }

  target.replaceChildren(fragment);
}

function renderState() {
  const vocabulary = popupState.state.vocabulary;
  if (elements.knownCount) elements.knownCount.textContent = String(vocabulary.knownWords.length);
  if (elements.learningCount) elements.learningCount.textContent = String(vocabulary.learningWords.length);
  if (elements.knownWordsList) renderWordList('knownWords', elements.knownWordsList);
  if (elements.learningWordsList) renderWordList('learningWords', elements.learningWordsList);
}

async function refreshState() {
  const response = await sendRuntimeMessage({ type: popupCore.MESSAGE_TYPES.GET_STATE });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : '读取状态失败。');
  }

  popupState.state = response.state;
  renderState();
}

async function saveVocabulary(vocabulary) {
  const response = await sendRuntimeMessage({
    type: popupCore.MESSAGE_TYPES.SAVE_VOCABULARY,
    vocabulary: vocabulary,
  });

  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : '保存词库失败。');
  }

  popupState.state = response.state;
  renderState();
}

async function handleWordSubmit(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const listKey = form.dataset.listKey;
  const input = form.elements.word;
  const normalizedWord = popupCore.normalizeWord(input.value);

  if (!normalizedWord) {
    setStatus('请输入一个有效单词。', 'error');
    return;
  }

  const nextVocabulary = popupCore.upsertWord(popupState.state.vocabulary, normalizedWord, listKey);
  await saveVocabulary(nextVocabulary);
  input.value = '';
  setStatus('词库已更新：' + normalizedWord, 'success');
}

async function handleWordListClick(event) {
  const button = event.target.closest('button[data-remove-word]');
  if (!button) {
    return;
  }

  const nextVocabulary = popupCore.removeWord(
    popupState.state.vocabulary,
    button.dataset.removeWord,
    button.dataset.listKey
  );

  await saveVocabulary(nextVocabulary);
  setStatus('已移除词条：' + button.dataset.removeWord, 'success');
}

async function handleClearList(event) {
  const button = event.currentTarget;
  const listKey = button.dataset.clearList;
  const nextVocabulary = popupCore.clearWordList(popupState.state.vocabulary, listKey);

  await saveVocabulary(nextVocabulary);
  setStatus(listKey === 'knownWords' ? '已清空 Known Words。' : '已清空 Learning Words。', 'success');
}

async function handleAnnotateClick() {
  setBusy(true);
  setStatus('正在扫描当前页并请求模型注词...', 'neutral');

  try {
    const tab = await queryActiveTab();
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('没有找到可用的标签页。');
    }

    await ensureContentScript(tab.id);

    const response = await sendMessageToTab(tab.id, {
      type: popupCore.MESSAGE_TYPES.START_ANNOTATION,
      directTranslate: true,
    });

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : '当前页面无法注词。');
    }

    const summary = response.summary;
    const firstError = summary.errors && summary.errors.length ? ' 首个错误：' + summary.errors[0] : '';
    setStatus(
      '已完成：共扫描 ' + summary.total + ' 段，成功 ' + summary.success + '，跳过 ' + summary.skipped + '，失败 ' + summary.failed + '。' + firstError,
      summary.failed ? 'error' : 'success'
    );
  } catch (error) {
    setStatus(error && error.message ? error.message : '当前页面暂时无法注词。', 'error');
  } finally {
    setBusy(false);
  }
}

function bindEvents() {
  document.querySelectorAll('.word-form').forEach(function bindForm(form) {
    form.addEventListener('submit', function onSubmit(event) {
      handleWordSubmit(event).catch(function handleError(error) {
        setStatus(error && error.message ? error.message : '保存词库失败。', 'error');
      });
    });
  });

  if (elements.knownWordsList) {
    elements.knownWordsList.addEventListener('click', function onListClick(event) {
      handleWordListClick(event).catch(function handleError(error) {
        setStatus(error && error.message ? error.message : '删除词条失败。', 'error');
      });
    });
  }

  if (elements.learningWordsList) {
    elements.learningWordsList.addEventListener('click', function onListClick(event) {
      handleWordListClick(event).catch(function handleError(error) {
        setStatus(error && error.message ? error.message : '删除词条失败。', 'error');
      });
    });
  }

  document.querySelectorAll('[data-clear-list]').forEach(function bindClearButton(button) {
    button.addEventListener('click', function onClearClick() {
      handleClearList({ currentTarget: button }).catch(function handleError(error) {
        setStatus(error && error.message ? error.message : '清空词库失败。', 'error');
      });
    });
  });

  elements.openOptionsButton.addEventListener('click', function openOptions() {
    chrome.runtime.openOptionsPage();
  });

  elements.annotateButton.addEventListener('click', function onAnnotateClick() {
    handleAnnotateClick();
  });
}

// ── Mode switching ──
var modeFullBtn = document.getElementById('modeFullBtn');
var modeLearnBtn = document.getElementById('modeLearnBtn');
var modeDesc = document.getElementById('modeDesc');
var vocabSection = document.getElementById('vocabSection');
var vocabList = document.getElementById('vocabList');
var vocabCount = document.getElementById('vocabCount');
var clearVocabBtn = document.getElementById('clearVocabBtn');
var currentMode = 'full';

function setMode(mode) {
  currentMode = mode;
  if (mode === 'full') {
    modeFullBtn.className = 'primary-button';
    modeLearnBtn.className = 'secondary-button';
    modeDesc.textContent = '全文翻译：所有英文翻译成中文。';
    if (vocabSection) vocabSection.style.display = 'none';
  } else {
    modeFullBtn.className = 'secondary-button';
    modeLearnBtn.className = 'primary-button';
    modeDesc.textContent = '学习模式：全文翻译，但你划词标记的单词保留英文。';
    if (vocabSection) vocabSection.style.display = '';
    renderVocab();
  }
  chrome.storage.local.get(popupCore.STORAGE_KEY, function(r) {
    var state = r[popupCore.STORAGE_KEY] || {};
    if (!state.ui) state.ui = {};
    state.ui.mode = mode;
    chrome.storage.local.set({ [popupCore.STORAGE_KEY]: state });
  });
}

function renderVocab() {
  chrome.storage.local.get(popupCore.STORAGE_KEY, function(r) {
    var state = r[popupCore.STORAGE_KEY] || {};
    var words = (state.vocabulary && state.vocabulary.knownWords) || [];
    if (vocabCount) vocabCount.textContent = words.length;
    if (!vocabList) return;
    vocabList.textContent = '';
    words.forEach(function(w) {
      var li = document.createElement('li');
      li.textContent = w;
      var del = document.createElement('button');
      del.textContent = '×';
      del.className = 'ghost-button';
      del.style.marginLeft = '8px';
      del.addEventListener('click', function() { removeVocabWord(w); });
      li.appendChild(del);
      vocabList.appendChild(li);
    });
  });
}

function removeVocabWord(word) {
  chrome.storage.local.get(popupCore.STORAGE_KEY, function(r) {
    var state = r[popupCore.STORAGE_KEY] || {};
    if (state.vocabulary && state.vocabulary.knownWords) {
      state.vocabulary.knownWords = state.vocabulary.knownWords.filter(function(w) { return w !== word; });
      chrome.storage.local.set({ [popupCore.STORAGE_KEY]: state }, renderVocab);
    }
  });
}

if (modeFullBtn) modeFullBtn.addEventListener('click', function() { setMode('full'); });
if (modeLearnBtn) modeLearnBtn.addEventListener('click', function() { setMode('learn'); });
if (clearVocabBtn) clearVocabBtn.addEventListener('click', function() {
  chrome.storage.local.get(popupCore.STORAGE_KEY, function(r) {
    var state = r[popupCore.STORAGE_KEY] || {};
    if (state.vocabulary) state.vocabulary.knownWords = [];
    chrome.storage.local.set({ [popupCore.STORAGE_KEY]: state }, renderVocab);
  });
});

chrome.storage.local.get(popupCore.STORAGE_KEY, function(r) {
  var state = r[popupCore.STORAGE_KEY] || {};
  var savedMode = (state.ui && state.ui.mode) || 'full';
  setMode(savedMode);
});

// ── Audio ──
var audioBtn = document.getElementById('audioToggleButton');
var audioSt = document.getElementById('audioStatus');
var audioOn = false;

if (audioBtn) {
  chrome.runtime.sendMessage({ type: 'NF_AUDIO_STATE' }, function(r) {
    if (r && r.capturing) {
      audioOn = true;
      audioBtn.textContent = '⏹ 停止语音翻译';
      audioBtn.style.background = '#f85149';
      audioSt.textContent = '翻译中...';
    }
  });

  audioBtn.addEventListener('click', function() {
    var serverUrl = 'http://192.168.8.104:9090';
    chrome.storage.local.get('nanfengAudioServer', function(r) {
      var url = (r && r.nanfengAudioServer) || serverUrl;
      chrome.runtime.sendMessage({ type: 'NF_AUDIO_TOGGLE', serverUrl: url }, function(res) {
        if (res && res.ok) {
          audioOn = res.capturing;
          audioBtn.textContent = audioOn ? '⏹ 停止语音翻译' : '🎧 开始语音翻译';
          audioBtn.style.background = audioOn ? '#f85149' : '#58a6ff';
          audioSt.textContent = audioOn ? '翻译中...' : '已停止';
        } else {
          audioSt.textContent = '失败: ' + (res && res.error || '');
        }
      });
    });
  });
}

async function bootPopup() {
  bindEvents();
  await refreshState();
}

bootPopup().catch(function handleBootError(error) {
  setStatus(error && error.message ? error.message : 'Popup 初始化失败。', 'error');
});
