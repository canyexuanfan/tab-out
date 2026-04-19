# Tab Out

**把你的标签页重新管理起来。**

Tab Out 是一个 Chrome 新标签页扩展。它会把你当前打开的所有标签页整理成一个可视化面板，按域名分组展示，并把 Gmail、X、LinkedIn、GitHub、YouTube 等首页类页面单独归组，方便你快速切换、批量整理和关闭。

这是一个纯前端 Chrome 扩展：

- 不需要服务端
- 不需要账号
- 不调用外部 API
- 数据默认保存在本地 `chrome.storage.local`

---

## 项目说明

本仓库是基于原项目分叉并继续维护的中文增强版本：

- 原项目地址：`https://github.com/zarazhangrui/tab-out`
- 当前分叉仓库：`https://github.com/canyexuanfan/tab-out`
- 开源协议：MIT

在保留原作者版权和许可证的前提下，本分叉版本增加了更适合中文用户的说明文档，以及一系列交互与体验增强。

---

## 主要功能

- **按域名总览全部标签页**，用网格方式统一展示
- **首页类页面单独分组**，更适合快速清理 Gmail、GitHub、X、YouTube 等常驻页面
- **标签卡片支持折叠/展开**，也支持顶部一键全部折叠或全部展开
- **重复标签检测**，同一页面重复打开时可快速清理
- **点击标签直接跳转**，跨窗口也能快速定位，不会新开页面
- **稍后处理**，可先保存网页再关闭标签，后续继续处理
- **归档区**，把已处理内容单独归档管理
- **右侧文件树式分组**，支持折叠、批量展开、搜索、关键词高亮
- **整组打开模式**，支持后台静默打开、当前窗口打开、新窗口打开
- **中英文切换**，支持界面语言切换并记住偏好
- **100% 本地运行**，数据不离开你的浏览器

---

## 安装方式

### 1. 克隆仓库

```bash
git clone https://github.com/canyexuanfan/tab-out.git
cd tab-out
```

### 2. 加载 Chrome 扩展

1. 打开 Chrome，进入 `chrome://extensions`
2. 打开右上角的 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择仓库中的 `extension/` 目录

### 3. 打开新标签页

安装完成后，打开一个新的标签页，就能看到 Tab Out 面板。

---

## 使用方式

```text
打开一个新标签页
  -> Tab Out 自动读取当前所有网页标签
  -> 按域名进行分组
  -> 首页类页面会被单独提取
  -> 你可以点击标题直接跳转
  -> 可以关闭单个标签或整组标签
  -> 可以先移到“稍后处理”再继续整理
  -> 已处理内容可以归档保存
```

---

## 本分叉版本增强内容

相较于上游版本，本仓库额外包含以下增强：

- 中文化 README、AGENTS 和使用说明
- 标签卡片折叠/展开与顶部批量控制
- 顶部语言切换与界面文案持久化
- 稍后处理 / 归档 分组化、文件树化
- 分组批量操作、整组打开策略和模式记忆
- 搜索框、关键词高亮、清空按钮、分组名搜索
- 搜索结果支持按分组名匹配，并可按 `Enter` 跳转到首个高亮结果
- 当前标签区与稍后处理区增加实时同步刷新，避免手动刷新页面
- 公开仓库仅保留对外代码与说明文档，私有排查资料不随仓库公开

---

## 技术栈

| 项目 | 说明 |
|------|------|
| Extension | Chrome Manifest V3 |
| Storage | `chrome.storage.local` |
| Sound | Web Audio API（运行时合成，无独立音频文件） |
| Animation | CSS transition + JS confetti particle |

---

## 许可证

本项目继续使用 **MIT License**。

- 保留原作者版权信息
- 保留原 MIT 许可条款
- 分叉版本新增内容同样以 MIT 协议开源

正式许可证原文见 [LICENSE](file:///f:/Trae%20AI/tab-out/LICENSE)。

中文参考译文见 [LICENSE.zh-CN.md](file:///f:/Trae%20AI/tab-out/LICENSE.zh-CN.md)。

说明：

- `LICENSE` 英文原文是正式法律文本
- `LICENSE.zh-CN.md` 仅供中文阅读理解
- 如中英文文本存在差异，以英文原文为准

---

## 版权与署名

- Original author: Zara Zhang
- Fork maintainer: canyexuanfan

如果你从本仓库继续分叉或二次分发，请保留原始 MIT 许可证与版权声明。

---

## 仓库维护说明

公开仓库建议保留以下内容：

- `extension/` 扩展代码
- `README.md`、`AGENTS.md`
- `LICENSE` 与 `LICENSE.zh-CN.md
