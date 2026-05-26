# 南风极简注音 Design Doc

## Goal

构建一款可直接运行的 Chrome Manifest V3 插件，在不破坏网页原有 HTML 结构与排版的前提下，基于用户词汇记忆库和 OpenAI 兼容大模型接口，对当前页面英文文本做原地内联注词。

## Confirmed Constraints

- 从空项目开始搭建。
- 仅支持手动触发当前页注词。
- 重复执行时先还原原始文本，再按最新词库重新执行。
- 技术栈保持为原生 JavaScript、HTML、CSS、`chrome.storage.local` 和 `fetch`。
- UI 采用现代极简风格，支持浅色与暗色主题变量。

## Chosen Architecture

采用 `popup -> content -> background -> LLM API` 的职责分离架构。

- `popup` 负责词库管理、状态展示与触发当前页注词。
- `options` 负责 API 配置的增删改存。
- `background` 统一读取配置、构造 Prompt、发送 OpenAI 兼容请求并归一化错误。
- `content` 负责安全遍历 DOM、缓存原文本、原地替换文本节点。

这样可以在 MV3 约束下保持清晰的职责边界，降低跨域和状态管理复杂度，并为后续域名白名单、缓存或批量策略扩展保留空间。

## File Responsibilities

### `manifest.json`

- 声明 MV3 所需配置。
- 注册 `background.js` 作为 service worker。
- 配置 `popup.html` 与 `options.html`。
- 声明 `storage`、`activeTab`、`scripting` 权限与必要 `host_permissions`。

### `popup.html` / `popup.css` / `popup.js`

- 展示品牌标题与简短状态区。
- 管理 `Known Words` 和 `Learning Words` 两组词库。
- 提供添加、删除、清空、跳转设置页、启动当前页注词等交互。
- 通过消息通知当前标签页开始执行注词。

### `options.html` / `options.css` / `options.js`

- 展示 `Base URL`、`API Key`、`Model Name` 三个配置项。
- 提供保存和加载能力。
- 提供保存成功时的轻量状态动画与反馈。

### `background.js`

- 统一从 `chrome.storage.local` 读取配置与词库。
- 根据固定系统提示和用户文本构造 `chat/completions` 请求。
- 在 API Key 为空时兼容本地模型。
- 将网络错误、配置错误、响应解析错误转换成一致消息结构返回。

### `content.js`

- 遍历允许的容器并筛选可安全处理的文本节点。
- 避开 `script`、`style`、`code`、`pre`、`input`、`textarea`、`noscript` 和可编辑区域。
- 首次执行时缓存原文，重复执行时先还原再重跑。
- 只替换 `textNode.nodeValue`，不改 `innerHTML`，不新增包裹元素。

## DOM Safety Strategy

核心原则是“绝不重写 HTML，只替换文本节点值”。

- 仅处理 `Node.TEXT_NODE`。
- 仅处理包含英文字母的自然语言文本片段。
- 过滤掉过短文本、纯数字、纯符号、URL、邮箱、时间格式和明显导航文案。
- 对不可见区域和按钮式短文案做额外跳过，优先正文内容。
- 每个节点独立失败，不中断整页流程。

这样可以最大限度保证页面原有链接、粗体、斜体、监听器和布局结构不受影响。

## Re-run and Restore Strategy

- Content Script 在运行期维护原始文本快照表。
- 第一次处理时记录原始文本。
- 再次点击按钮时，先恢复原文，再以最新词库重新扫描与替换。
- 若节点已经被页面移除，则安全忽略。

## Storage Model

建议存储结构如下：

```json
{
  "settings": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "",
    "model": "gpt-4o-mini"
  },
  "vocabulary": {
    "knownWords": [],
    "learningWords": []
  },
  "ui": {
    "theme": "system"
  }
}
```

- 词汇统一按小写去重。
- 同一单词只允许存在于一个列表中，避免规则冲突。

## Prompt Contract

系统提示采用以下模板并做工程化插值：

```text
你是一个只输出处理后文本的代码工具。请读取以下英文文本和用户的词汇状态。已知词汇：{known_words}；重点生词：{learning_words}。规则：1. 找到 {learning_words} 中的词，在其后加上小括号和中文释义，格式如 'word (单词)'。2. 绝对不要翻译 {known_words} 中的词。3. 如果遇到不在以上两表但难度极高的雅思词汇，请自动添加 '(中文释义)'。4. 必须保持原文所有标点符号、空格和语序完全不变。5. 绝不要输出任何多余的解释、Markdown 格式或问候语，只返回处理后的纯文本。
```

用户正文作为独立 user message 发送，以提升模型对结构约束的遵守度。

## API Contract

- 默认请求：`POST {baseUrl}/chat/completions`
- 请求体核心字段：`model`、`messages`、`temperature`
- 有 API Key 时附带 `Authorization: Bearer <key>`
- API Key 为空时不发送 Authorization 头，以兼容本地模型
- 响应解析优先读取 `choices[0].message.content`

## UI Direction

### Popup

- 顶部品牌区，带轻度毛玻璃质感。
- 两张词库卡片：`Known Words` 与 `Learning Words`。
- 大尺寸主按钮：`启动当前页注词`。
- 底部次级入口跳转到设置页。

### Options

- 单张高质量设置卡承载 3 个输入框。
- 保存按钮具有 loading / success 状态反馈。
- 页面底部用简短文案说明兼容 OpenAI 接口与本地模型。

### Visual System

- 背景：高级浅灰白与深色模式变量。
- 主色：科技感蓝紫色。
- 圆角：12px 到 16px。
- 阴影：柔和弥散型现代阴影。
- 过渡：统一 `0.2s ease-in-out`。

## Validation Targets

- 配置可以保存、读取和覆盖默认值。
- 词库支持添加、删除、清空与去重。
- 当前页注词只改文本内容，不破坏 HTML 结构。
- 再次运行时会先还原再重跑。
- 接口异常和空配置时有可读反馈。
- Popup 与 Options 在 Chrome 扩展尺寸下保持完整布局与良好可读性。

## Notes

- 当前工作区不是 git 仓库，因此本次仅保存设计文档，不执行提交。
