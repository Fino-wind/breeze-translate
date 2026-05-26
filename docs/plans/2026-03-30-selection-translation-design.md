# 划词翻译与右键词库 Design Doc

## Goal

为南风极简注音增加两类轻交互能力：

- 用户在网页上选中英文单词或短语后，出现一个悬浮小卡片，显示简短翻译，并可直接加入“认识词库”或“不认识词库”。
- 用户在网页中选中文本后，可通过浏览器右键菜单直接加入对应词库。

## Confirmed Direction

采用“悬浮小卡片 + 右键菜单”的双入口方案。

- 悬浮卡片承担即时反馈和快捷操作。
- 右键菜单承担无界面兜底和系统级快捷入口。
- 两者统一复用 background 的词库写入和配置读取逻辑，避免状态分叉。

## Interaction Design

### Selection Card

- 触发：用户选中英文文本后，在鼠标抬起或 selection 稳定时出现。
- 条件：只处理 `1-6` 个单词、总长度不超过 `80` 字符的英文选择。
- 内容：
  - 原文
  - 中文释义
  - `加入认识词库`
  - `加入不认识词库`
  - `复制释义`
- 消失：点击空白、按 `Esc`、重新选择其他内容、页面大幅滚动。

### Context Menu

- 仅在有选中文本时展示。
- 提供两个菜单项：
  - `加入认识词库`
  - `加入不认识词库`
- 点击后直接写入词库，并在页面上给出简短状态提示。

## Architecture Changes

### `content.js`

- 增加 selection 监听。
- 维护轻量悬浮卡片 DOM。
- 负责选中文本提取、定位、显示、关闭、卡片按钮消息发送。
- 不复用整页注词流程，单独走轻量短文本翻译消息。

### `background.js`

- 新增消息：
  - `TRANSLATE_SELECTION`
  - `ADD_WORD_TO_LIST`
- 增加 context menu 注册和点击处理。
- 增加短文本翻译缓存，减少重复请求。

### `shared.js`

- 增加选择文本清洗、候选合法性判断、词条规范化复用逻辑。
- 增加消息类型常量。

### `popup.js`

- 不改主结构，只继续读取现有词库。
- 词库更新后自动反映 context menu / 悬浮卡片写入结果。

## Data Flow

### Selection Translation

- 用户选中文本
- `content.js` 过滤和规范化
- `content.js -> background.js` 发送 `TRANSLATE_SELECTION`
- `background.js` 调用模型，返回短文本翻译
- `content.js` 渲染悬浮卡片

### Add To Vocabulary

- 用户点击卡片按钮或右键菜单
- `content.js / background.js` 统一调用词库写入逻辑
- `chrome.storage.local` 更新 `knownWords` 或 `learningWords`
- Popup 下次打开时显示最新状态

## Validation Targets

- 选中英文短词/短语时，悬浮卡片能出现。
- 选中中文、超长文本、空白文本时，不出现卡片。
- 卡片中点击加入词库后，词库状态正确更新且不重复。
- 右键菜单可直接写入两个词库。
- 相同文本短时间重复选择时，优先使用缓存结果。

## Notes

- 当前工作区不是 git 仓库，本次只保存设计文档，不执行提交。
