# SyncFromNotion — Figma Plugin

從 Notion (透過 Make.com Webhook) 同步數據到 Figma 畫布的插件。

## ✨ 功能特色

- **一鍵同步** — 輸入 Make.com Webhook URL，即可將 Notion 數據批量匯入
- **智能 Upsert** — 利用 Plugin Data 追蹤 Notion ID，再次同步時：
  - 已存在的卡片：**保留位置**，僅更新內容
  - 新增的數據：自動在空白區域生成新卡片
- **圖片嵌入** — 自動下載 Notion 圖片並嵌入到卡片中
- **排版友好** — 卡片可 Detach 後自由移動，不影響後續同步

## 📦 數據格式

插件接受如下結構的 JSON 陣列：

```json
[
  {
    "id": "uuid-from-notion",
    "活動名稱": "活動標題",
    "地點": "活動地點",
    "對象": "目標對象",
    "費用(會員)": 600,
    "圖片": "https://...",
    "顯示系列名稱": true
  }
]
```

## 🛠️ 開發指南

### 安裝依賴

```bash
npm install
```

### 編譯 TypeScript

```bash
npm run build
```

### 實時監聽 (開發模式)

```bash
npm run watch
```

### 在 Figma 中載入

1. 打開 Figma Desktop App
2. Plugins → Development → Import plugin from manifest...
3. 選擇本目錄中的 `manifest.json`

## 📝 Changelog

### v1.0.0 (2026-02-13)
- 初版發布
- 支援 Webhook 數據獲取
- Plugin Data Upsert 機制
- 卡片自動佈局 (Auto Layout)
- 圖片嵌入支援
- 深色主題 UI
