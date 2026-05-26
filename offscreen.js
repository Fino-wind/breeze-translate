var ws = null;
var stream = null;
var ctx = null;
var proc = null;
var tabId = null;
var pendingStart = null;
var TARGET_RATE = 16000;

chrome.runtime.sendMessage({ type: 'NF_OFFSCREEN_READY' });

chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type === 'NF_AUDIO_START') doStart(msg.streamId, msg.serverUrl, msg.tabId);
  if (msg.type === 'NF_AUDIO_STOP') doStop();
});

function doStart(streamId, serverUrl, tid) {
  doStop();
  tabId = tid;
  navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
  }).then(function(s) {
    stream = s;
    var wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws/audio';
    ws = new WebSocket(wsUrl);
    ws.onmessage = function(e) {
      var data = JSON.parse(e.data);
      chrome.tabs.sendMessage(tabId, { type: 'NF_SUBTITLE', payload: data }).catch(function(){});
    };
    ws.onopen = function() {
      ctx = new AudioContext();
      var source = ctx.createMediaStreamSource(stream);
      var nativeRate = ctx.sampleRate;
      proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = function(e) {
        if (!ws || ws.readyState !== 1) return;
        var input = e.inputBuffer.getChannelData(0);
        var ratio = nativeRate / TARGET_RATE;
        var len = Math.round(input.length / ratio);
        var out = new Int16Array(len);
        for (var i = 0; i < len; i++) {
          var v = input[Math.round(i * ratio)];
          out[i] = v < 0 ? v * 32768 : v * 32767;
        }
        ws.send(out.buffer);
      };
      source.connect(proc);
      proc.connect(ctx.destination);
      chrome.runtime.sendMessage({ type: 'NF_AUDIO_ACTIVE', active: true });
      chrome.tabs.sendMessage(tabId, { type: 'NF_SUBTITLE_STATUS', status: 'running' }).catch(function(){});
    };
    ws.onerror = function() { doStop(); };
    ws.onclose = function() {
      chrome.runtime.sendMessage({ type: 'NF_AUDIO_ACTIVE', active: false });
      chrome.tabs.sendMessage(tabId, { type: 'NF_SUBTITLE_STATUS', status: 'stopped' }).catch(function(){});
    };
  }).catch(function(err) {
    chrome.runtime.sendMessage({ type: 'NF_AUDIO_ACTIVE', active: false });
    chrome.tabs.sendMessage(tabId, { type: 'NF_SUBTITLE_STATUS', status: 'error', error: err.message }).catch(function(){});
  });
}

function doStop() {
  if (proc) { proc.disconnect(); proc = null; }
  if (ctx) { ctx.close().catch(function(){}); ctx = null; }
  if (stream) { stream.getTracks().forEach(function(t){ t.stop(); }); stream = null; }
  if (ws) { ws.close(); ws = null; }
}
