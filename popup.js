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

var translatingTabId = null;

function sendRuntimeMessage(message) {
  return new Promise(function(resolve, reject) {
    chrome.runtime.sendMessage(message, function(response) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(response);
    });
  });
}

function queryActiveTab() {
  return new Promise(function(resolve, reject) {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise(function(resolve, reject) {
    chrome.tabs.sendMessage(tabId, message, function(response) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(response);
    });
  });
}

function executeScripts(tabId, files) {
  return new Promise(function(resolve, reject) {
    chrome.scripting.executeScript(
      { target: { tabId: tabId }, files: files },
      function() {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
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
  elements.annotateButton.disabled = isBusy && !translatingTabId;
  elements.openOptionsButton.disabled = isBusy;
  document.querySelectorAll('button, input').forEach(function(control) {
    if (control.id === 'annotateButton' || control.id === 'openOptionsButton') return;
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
    words.forEach(function(word) {
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
  var result = await chrome.storage.local.get(popupCore.STORAGE_KEY);
  popupState.state = popupCore.mergeStoredState(result[popupCore.STORAGE_KEY]);
  renderState();
}

async function saveVocabulary(vocabulary) {
  const response = await sendRuntimeMessage({ type: popupCore.MESSAGE_TYPES.SAVE_VOCABULARY, vocabulary: vocabulary });
  if (!response || !response.ok) throw new Error(response && response.error ? response.error : '保存词库失败。');
  popupState.state = response.state;
  renderState();
}

async function handleWordSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const listKey = form.dataset.listKey;
  const input = form.elements.word;
  const normalizedWord = popupCore.normalizeWord(input.value);
  if (!normalizedWord) { setStatus('请输入一个有效单词。', 'error'); return; }
  const nextVocabulary = popupCore.upsertWord(popupState.state.vocabulary, normalizedWord, listKey);
  await saveVocabulary(nextVocabulary);
  input.value = '';
  setStatus('词库已更新：' + normalizedWord, 'success');
}

async function handleWordListClick(event) {
  const button = event.target.closest('button[data-remove-word]');
  if (!button) return;
  const nextVocabulary = popupCore.removeWord(popupState.state.vocabulary, button.dataset.removeWord, button.dataset.listKey);
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

function enterTranslatingUI(tabId) {
  translatingTabId = tabId;
  elements.annotateButton.textContent = '⏹ 停止翻译';
  elements.annotateButton.disabled = false;
  chrome.storage.session.set({ breezeTranslating: { tabId: tabId } });
}

function exitTranslatingUI() {
  translatingTabId = null;
  elements.annotateButton.textContent = '🚀 开始翻译当前页';
  chrome.storage.session.remove('breezeTranslating');
  setBusy(false);
}

async function handleAnnotateClick() {
  if (translatingTabId) {
    sendMessageToTab(translatingTabId, { type: 'NF_CANCEL_TRANSLATE' }).catch(function(){});
    setStatus('已停止', 'neutral');
    exitTranslatingUI();
    return;
  }

  setBusy(true);
  setStatus('正在翻译...', 'neutral');

  try {
    var tab = await queryActiveTab();
    if (!tab || typeof tab.id !== 'number') throw new Error('没有找到可用的标签页。');
    enterTranslatingUI(tab.id);
    await ensureContentScript(tab.id);
    var response = await sendMessageToTab(tab.id, {
      type: popupCore.MESSAGE_TYPES.START_ANNOTATION,
      directTranslate: true,
    });
    if (!response || !response.ok) throw new Error(response && response.error ? response.error : '翻译失败。');
    var summary = response.summary;
    setStatus(
      '完成：' + summary.success + ' 段成功' + (summary.failed ? '，' + summary.failed + ' 段失败' : ''),
      summary.failed ? 'error' : 'success'
    );
  } catch (error) {
    setStatus(error && error.message ? error.message : '翻译失败。', 'error');
  } finally {
    exitTranslatingUI();
  }
}

function bindEvents() {
  document.querySelectorAll('.word-form').forEach(function(form) {
    form.addEventListener('submit', function(event) {
      handleWordSubmit(event).catch(function(error) {
        setStatus(error && error.message ? error.message : '保存词库失败。', 'error');
      });
    });
  });

  if (elements.knownWordsList) {
    elements.knownWordsList.addEventListener('click', function(event) {
      handleWordListClick(event).catch(function(error) {
        setStatus(error && error.message ? error.message : '删除词条失败。', 'error');
      });
    });
  }

  if (elements.learningWordsList) {
    elements.learningWordsList.addEventListener('click', function(event) {
      handleWordListClick(event).catch(function(error) {
        setStatus(error && error.message ? error.message : '删除词条失败。', 'error');
      });
    });
  }

  document.querySelectorAll('[data-clear-list]').forEach(function(button) {
    button.addEventListener('click', function() {
      handleClearList({ currentTarget: button }).catch(function(error) {
        setStatus(error && error.message ? error.message : '清空词库失败。', 'error');
      });
    });
  });

  elements.openOptionsButton.addEventListener('click', function() {
    chrome.runtime.openOptionsPage();
  });

  elements.annotateButton.addEventListener('click', function() {
    handleAnnotateClick();
  });
}

// ── Mode switching (saves through background for consistency) ──

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
}

function saveModeToBackground(mode) {
  sendRuntimeMessage({ type: popupCore.MESSAGE_TYPES.SAVE_UI, ui: { mode: mode } }).catch(function() {});
}

function renderVocab() {
  var words = (popupState.state.vocabulary && popupState.state.vocabulary.knownWords) || [];
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
}

function removeVocabWord(word) {
  sendRuntimeMessage({ type: popupCore.MESSAGE_TYPES.GET_STATE })
    .then(function(r) {
      if (!r || !r.ok) return;
      var vocab = popupCore.removeWord(r.state.vocabulary, word, 'knownWords');
      return sendRuntimeMessage({ type: popupCore.MESSAGE_TYPES.SAVE_VOCABULARY, vocabulary: vocab });
    })
    .then(function() { renderVocab(); })
    .catch(function() {});
}

if (modeFullBtn) modeFullBtn.addEventListener('click', function() { setMode('full'); saveModeToBackground('full'); });
if (modeLearnBtn) modeLearnBtn.addEventListener('click', function() { setMode('learn'); saveModeToBackground('learn'); });
if (clearVocabBtn) clearVocabBtn.addEventListener('click', function() {
  var vocab = popupCore.clearWordList(popupState.state.vocabulary, 'knownWords');
  saveVocabulary(vocab).then(function() { renderVocab(); }).catch(function() {});
});

// ── Progress listener ──

chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type === 'NF_TRANSLATE_PROGRESS' && translatingTabId) {
    setStatus('翻译中... ' + msg.done + ' / ' + msg.total, 'neutral');
  }
});

// ── Audio ──

var audioBtn = document.getElementById('audioToggleButton');
var audioSt = document.getElementById('audioStatus');
var audioOn = false;

if (audioBtn) {
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

async function restoreTranslationState() {
  try {
    var session = await chrome.storage.session.get('breezeTranslating');
    if (session && session.breezeTranslating && session.breezeTranslating.tabId) {
      var tab = await queryActiveTab();
      if (tab && tab.id === session.breezeTranslating.tabId) {
        enterTranslatingUI(tab.id);
        setStatus('翻译进行中...', 'neutral');
      } else {
        chrome.storage.session.remove('breezeTranslating');
      }
    }
  } catch(e) {}
}

async function bootPopup() {
  bindEvents();

  var audioPromise = audioBtn
    ? new Promise(function(resolve) {
        chrome.runtime.sendMessage({ type: 'NF_AUDIO_STATE' }, function(r) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r);
        });
      })
    : Promise.resolve(null);

  var results = await Promise.all([
    refreshState(),
    restoreTranslationState(),
    audioPromise
  ]);

  var savedMode = (popupState.state.ui && popupState.state.ui.mode) || 'full';
  setMode(savedMode);

  var audioResult = results[2];
  if (audioResult && audioResult.capturing && audioBtn) {
    audioOn = true;
    audioBtn.textContent = '⏹ 停止语音翻译';
    audioBtn.style.background = '#f85149';
    if (audioSt) audioSt.textContent = '翻译中...';
  }
}

bootPopup().catch(function(error) {
  setStatus(error && error.message ? error.message : 'Popup 初始化失败。', 'error');
});
