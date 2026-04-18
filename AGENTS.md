# AGENTS.md -- Tab Out 中文安装与引导说明

你正在为用户安装 **Tab Out**。你的目标不只是完成安装，还要让用户快速理解这个扩展能解决什么问题，并愿意马上开始使用。

本仓库是基于原项目继续维护的中文增强分叉版本：

- 原项目：`https://github.com/zarazhangrui/tab-out`
- 当前仓库：`https://github.com/canyexuanfan/tab-out`

请在说明时保留对原作者的署名，并明确当前仓库继续以 **MIT License** 开源。

---

## 第 0 步：先介绍产品

在做任何技术操作前，先用简洁、能激发兴趣的方式告诉用户他们将获得什么：

> **Tab Out** 会把你的新标签页替换成一个可视化控制台，把你当前打开的所有标签页按域名整理出来。
>
> 它适合经常开很多网页、但又不想丢失上下文的人。
>
> 主要特点：
> - **按域名总览所有标签页**
> - **常见首页自动单独归组**
> - **支持单个或整组关闭标签**
> - **重复标签检测与清理**
> - **点击标题即可跳转到已打开的标签**
> - **支持“稍后处理”和归档管理**
> - **完全本地运行**，不依赖服务端、不上传数据
>
> 它只是一个 Chrome 扩展，通常 1 分钟左右就能装好。

---

## 第 1 步：克隆仓库

优先使用当前分叉仓库地址：

```bash
git clone https://github.com/canyexuanfan/tab-out.git
cd tab-out
```

---

## 第 2 步：安装 Chrome 扩展

这是唯一需要用户手动完成的步骤，请尽量把路径和点击步骤说明得非常清楚。

### 先输出 `extension/` 目录完整路径

```bash
echo "Extension folder: $(cd extension && pwd)"
```

### 再把 `extension/` 路径复制到剪贴板

- macOS: `cd extension && pwd | pbcopy && echo "Path copied to clipboard"`
- Linux: `cd extension && pwd | xclip -selection clipboard 2>/dev/null || echo "Path: $(pwd)"`
- Windows: `cd extension && echo %CD% | clip`

### 再打开扩展管理页

```bash
open "chrome://extensions"
```

### 然后按下面的话术引导用户

> 我已经把扩展目录路径复制到你的剪贴板了，接下来这样做：
>
> 1. 打开 Chrome 扩展页面后，在**右上角**打开 **Developer mode / 开发者模式**
> 2. 打开后，左上角会出现 **Load unpacked / 加载已解压的扩展程序**
> 3. 点击它，打开文件选择器
> 4. 通过文件选择器定位到我刚刚复制的 `extension/` 目录路径
> 5. 选择该目录并确认
>
> 安装完成后，你会在扩展列表里看到 **Tab Out**

### 作为兜底方案，也可以直接打开 `extension/` 文件夹

- macOS: `open extension/`
- Linux: `xdg-open extension/`
- Windows: `explorer extension\\`

---

## 第 3 步：安装后带用户快速上手

加载完成后，请继续引导：

> 现在已经安装好了。你只要打开一个**新标签页**，就会进入 Tab Out。
>
> 你可以这样理解它：
> 1. 当前所有标签页会被**按域名分组**
> 2. Gmail、GitHub、YouTube、X 这类首页会被单独归类
> 3. 点击任意标题可以直接跳回原标签
> 4. 点击单个关闭按钮可以关掉一个标签
> 5. 点击分组的关闭按钮可以整组清理
> 6. 重复页面会被标出来，方便去重
> 7. 也可以先移到“稍后处理”，以后再继续看

如果当前分叉版本包含新增功能，也应一并介绍，例如：

- 标签卡片折叠/展开
- 顶部批量折叠与语言切换
- 右侧文件树式的“稍后处理 / 归档”
- 搜索、高亮、批量操作、整组打开模式

---

## 关键事实

- Tab Out 是纯 Chrome 扩展，不需要服务端、Node.js 或 npm
- 保存内容存储在 `chrome.storage.local`
- 数据默认只存在本地浏览器环境
- 更新方式通常是：

```bash
cd tab-out
git pull
```

然后回到 `chrome://extensions` 刷新扩展

---

## 版权与开源说明

- 原作者版权信息必须保留
- 当前分叉版本新增内容同样以 **MIT License** 开源
- 在介绍仓库时，优先使用当前分叉仓库地址，但不要抹去原项目来源
