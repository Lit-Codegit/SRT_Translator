# SRT Translator

SRT Translator 是一个基于 Electron 的本地字幕翻译工具，通过 OpenAI 兼容 API 批量翻译和校验 SRT 字幕。

## 主要功能

- 批量导入字幕和文本文件
- 流式显示 AI 回复与思考内容
- 按任务组设置模型、并发数、下载目录和系统提示词
- 自动校验并下载符合格式的 SRT 字幕
- 保存、导入和导出本地会话历史
- 导入提示词预设

## 技术栈

- Electron
- React
- TypeScript
- Zustand
- electron-vite

## 安装与运行

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

构建应用：

```bash
npm run build
```

## 使用

1. 在应用设置中填写 OpenAI 兼容 API 的 Base URL 和 API Key。
2. 查询或手动填写模型 ID。
3. 导入一个或多个字幕文件并发送翻译要求。
4. 在任务组设置中选择普通对话或自动字幕模式。

自动字幕模式会在回复完成后校验 SRT 格式，校验通过后自动保存到指定目录。

## 本地数据

API 配置、会话历史和下载结果仅保存在本地，并已通过 `.gitignore` 排除：

- `data/`
- `output/`
- `out/`

