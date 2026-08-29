# 重大突发事件监测简报

面向个人的重大突发事件（火灾 / 爆炸 / 地质灾害 / 坍塌等）监测网页：

- **功能一**：重大突发事件综合简报 —— 汇总国内外重大火灾、爆炸、人员伤亡事件及中央领导批示，网页内推送
- **功能二**：全国地图 —— 腾讯地图标记国内事故发生地点，点击新闻卡片自动定位

## 架构（长期免费方案）

| 组件 | 方案 | 费用 |
|---|---|---|
| 网页托管 | GitHub Pages | 免费（永久） |
| 定时数据抓取 | GitHub Actions（每 10 分钟） | 免费（公开仓库） |
| 新闻数据源 | Google News RSS（无需 API Key） | 免费 |
| 前端实时补充 | 浏览器直接抓取 RSS 快讯 | 免费 |

## 目录结构

```
├── index.html                  # 网页本体（核心事件库 INCIDENTS 在此手工维护）
├── scripts/
│   └── fetch-news.mjs          # 快讯抓取脚本（Actions 定时运行）
├── data/
│   └── flashes.json            # 自动生成的在线快讯（勿手工修改）
└── .github/workflows/
    └── update-data.yml         # 每 10 分钟自动抓取并提交数据
```

## 维护指南

### 新增重大事件（核心库）
编辑 `index.html` 顶部 `INCIDENTS` 数组，追加一条事件（含日期、伤亡、批示、坐标 GCJ-02），
简报统计、筛选、地图标记自动更新。

### 手动触发一次数据抓取
仓库 Actions 页面 → Update Incident Flash Data → Run workflow。

### 修改抓取频率
编辑 `.github/workflows/update-data.yml` 中 `cron` 表达式
（GitHub 最小间隔 5 分钟；免费公开仓库无次数限制）。

## 部署

推送 main 分支后，在仓库 Settings → Pages 中设置：
Source = Deploy from a branch，Branch = main，路径 = /（根目录）。
