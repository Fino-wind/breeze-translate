const optionsCore = globalThis.NanFengCore;
const form = document.getElementById('settingsForm');
const saveButton = document.getElementById('saveButton');
const savePill = document.getElementById('savePill');
const testConnectionButton = document.getElementById('testConnectionButton');
const connectionBanner = document.getElementById('connectionBanner');
const refreshLogsButton = document.getElementById('refreshLogsButton');
const clearLogsButton = document.getElementById('clearLogsButton');
const logsOutput = document.getElementById('logsOutput');
const fields = {
  baseUrl: document.getElementById('baseUrlInput'),
  apiKey: document.getElementById('apiKeyInput'),
  model: document.getElementById('modelInput'),
};
let currentBaseUrl = '';
let resetStateTimer = 0;

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

function requestOriginPermission(originPattern) {
  return new Promise(function resolvePermission(resolve, reject) {
    chrome.permissions.request({ origins: [originPattern] }, function handlePermission(granted) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(Boolean(granted));
    });
  });
}

function removeOriginPermission(originPattern) {
  return new Promise(function resolvePermission(resolve, reject) {
    chrome.permissions.remove({ origins: [originPattern] }, function handlePermission(removed) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(Boolean(removed));
    });
  });
}

function setSaveState(state, label) {
  saveButton.dataset.state = state;
  savePill.dataset.state = state;
  savePill.textContent = label;

  if (state === 'saving') {
    saveButton.textContent = '保存中...';
    saveButton.disabled = true;
    return;
  }

  saveButton.disabled = false;
  saveButton.textContent = state === 'success' ? '已保存' : '保存配置';
}

function setConnectionState(message, tone) {
  connectionBanner.textContent = message;
  connectionBanner.dataset.tone = tone || 'neutral';
}

function buildSettingsPayload() {
  return {
    baseUrl: fields.baseUrl.value,
    apiKey: fields.apiKey.value,
    model: fields.model.value,
  };
}

function renderLogs(logs) {
  if (!Array.isArray(logs) || !logs.length) {
    logsOutput.textContent = '暂无日志。';
    return;
  }

  logsOutput.textContent = logs
    .map(function formatLog(log) {
      const detail = log.detail ? '\n' + JSON.stringify(log.detail, null, 2) : '';
      return '[' + log.timestamp + '] ' + log.level.toUpperCase() + ' ' + log.event + '\n' + log.message + detail;
    })
    .join('\n\n');
}

function scheduleIdleState() {
  window.clearTimeout(resetStateTimer);
  resetStateTimer = window.setTimeout(function restoreIdleState() {
    setSaveState('idle', '未保存');
  }, 1600);
}

function fillForm(state) {
  currentBaseUrl = state.settings.baseUrl;
  fields.baseUrl.value = state.settings.baseUrl;
  fields.apiKey.value = state.settings.apiKey;
  fields.model.value = state.settings.model;
}

async function loadState() {
  const response = await sendRuntimeMessage({ type: optionsCore.MESSAGE_TYPES.GET_STATE });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : '读取配置失败。');
  }

  fillForm(response.state);
  await refreshLogs();
}

async function refreshLogs() {
  const response = await sendRuntimeMessage({ type: optionsCore.MESSAGE_TYPES.GET_LOGS });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : '读取日志失败。');
  }

  renderLogs(response.logs);
}

async function handleTestConnection() {
  const settings = buildSettingsPayload();
  const originPattern = optionsCore.tryGetOriginPattern(settings.baseUrl || optionsCore.createDefaultState().settings.baseUrl);
  setConnectionState('正在测试模型连接...', 'neutral');
  testConnectionButton.disabled = true;

  try {
    if (!originPattern) {
      throw new Error('Base URL 格式不正确。');
    }

    const granted = await requestOriginPermission(originPattern);
    if (!granted) {
      throw new Error('需要先允许当前 API 域名权限。');
    }

    const response = await sendRuntimeMessage({
      type: optionsCore.MESSAGE_TYPES.TEST_CONNECTION,
      settings: settings,
    });

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : '连接测试失败。');
    }

    setConnectionState('连接成功，模型已返回结果：' + optionsCore.createPreviewText(response.text, 120), 'success');
    await refreshLogs();
  } catch (error) {
    setConnectionState(error && error.message ? error.message : '连接测试失败。', 'error');
    await refreshLogs().catch(function ignoreLogError() {
      return null;
    });
  } finally {
    testConnectionButton.disabled = false;
  }
}

async function handleClearLogs() {
  const response = await sendRuntimeMessage({ type: optionsCore.MESSAGE_TYPES.CLEAR_LOGS });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : '清空日志失败。');
  }

  renderLogs([]);
}

async function handleSubmit(event) {
  event.preventDefault();
  setSaveState('saving', '正在保存');

  try {
    const originPattern = optionsCore.tryGetOriginPattern(fields.baseUrl.value || optionsCore.createDefaultState().settings.baseUrl);
    const previousOriginPattern = currentBaseUrl ? optionsCore.tryGetOriginPattern(currentBaseUrl) : null;
    if (!originPattern) {
      throw new Error('Base URL 格式不正确。');
    }

    const granted = await requestOriginPermission(originPattern);
    if (!granted) {
      throw new Error('需要允许当前 API 域名权限后才能保存。');
    }

    const response = await sendRuntimeMessage({
      type: optionsCore.MESSAGE_TYPES.SAVE_SETTINGS,
      settings: {
        baseUrl: fields.baseUrl.value,
        apiKey: fields.apiKey.value,
        model: fields.model.value,
      },
    });

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : '保存配置失败。');
    }

    if (previousOriginPattern && previousOriginPattern !== originPattern) {
      await removeOriginPermission(previousOriginPattern).catch(function ignoreRemovalError() {
        return false;
      });
    }

    fillForm(response.state);
    setSaveState('success', '保存成功');
    setConnectionState('配置已保存。建议先点一次“测试连接”确认模型可用。', 'success');
    await refreshLogs().catch(function ignoreLogError() {
      return null;
    });
    scheduleIdleState();
  } catch (error) {
    setSaveState('idle', '未保存');
    setConnectionState(error && error.message ? error.message : '保存失败', 'error');
  }
}

form.addEventListener('submit', function onSubmit(event) {
  handleSubmit(event);
});

testConnectionButton.addEventListener('click', function onTestClick() {
  handleTestConnection().catch(function handleError(error) {
    setConnectionState(error && error.message ? error.message : '连接测试失败。', 'error');
  });
});

refreshLogsButton.addEventListener('click', function onRefreshLogs() {
  refreshLogs().catch(function handleError(error) {
    setConnectionState(error && error.message ? error.message : '读取日志失败。', 'error');
  });
});

clearLogsButton.addEventListener('click', function onClearLogs() {
  handleClearLogs().catch(function handleError(error) {
    setConnectionState(error && error.message ? error.message : '清空日志失败。', 'error');
  });
});

loadState().catch(function handleError(error) {
  setSaveState('idle', error && error.message ? error.message : '读取配置失败');
  setConnectionState(error && error.message ? error.message : '读取配置失败。', 'error');
});
