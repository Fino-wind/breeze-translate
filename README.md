# 南风译 Breeze Translate

Local AI-powered bilingual Chrome extension — inline annotation, selection translation, and real-time audio translation.

## Features

- **Inline Annotation** — Automatically annotates unfamiliar English words with Chinese translations, right in the original text flow
- **Selection Translation** — Select any text to see instant translation in a popup card
- **Vocabulary Management** — Track known and learning words; annotated words adapt to your level
- **Real-time Audio Translation** — Capture tab audio (YouTube, Bilibili, etc.), transcribe with Whisper, translate with LLM, display subtitles as overlay
- **Any OpenAI-compatible Backend** — Works with local models (Qwen, Gemma, LLaMA via vLLM/Ollama) or cloud APIs (OpenAI, DeepSeek, etc.)

## Quick Start

1. Clone this repo
2. Open `chrome://extensions/` → Enable Developer Mode → Load Unpacked → Select this folder
3. Click the extension icon → API Settings → Set your Base URL and Model
4. Navigate to any English page → Click "Start Annotation"

### Default Configuration

| Setting | Default |
|---------|---------|
| Base URL | `http://localhost:8000/v1` |
| Model | `qwen3.6` |

For cloud APIs, set Base URL to `https://api.openai.com/v1` and add your API key.

### Audio Translation

Requires a translation server running Whisper + LLM (see [server/](server/) for setup). Click "Start Audio Translation" in the popup to capture current tab's audio and display real-time subtitles.

## Architecture

```
Chrome Extension (MV3)
├── content.js      — DOM annotation, selection popup, subtitle overlay
├── background.js   — API routing, tab capture management
├── offscreen.js    — Audio capture & WebSocket streaming
├── shared.js       — Core logic, API builder, vocabulary management
├── popup.html/js   — Extension popup UI
└── options.html/js — Settings page
```

## License

MIT

## Author

[Fino-wind](https://github.com/Fino-wind)
