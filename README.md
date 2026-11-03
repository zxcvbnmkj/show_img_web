# showimg

在任意目录执行 `showimg dev`，浏览器里预览该目录（含所有子目录）下的全部图片。

```bash
cd ~/某个有图片的目录
showimg dev            # 默认 http://localhost:4690，被占用自动顺延
showimg dev ./assets   # 指定目录
showimg dev -p 8080    # 指定端口
```

## 功能

- 顶栏可粘贴本机任意目录路径回车切换，无需重启（支持 `~`、带引号、终端拖拽的 `\ ` 转义；记住最近 10 个目录）。
  目录记在地址栏 `?dir=`，浏览器后退可回上一个目录，不同标签页可各看各的
- 左侧一次显示一张图，点击两侧 ‹ › 翻页（键盘 ←/→ 亦可），底栏显示路径、原始尺寸、第几张
- 右侧目录树列出子文件夹和图片名：点图片名直接显示该图，点目录名跳到其下第一张，当前图高亮
- 翻页顺序与目录树自上而下的顺序一致（子目录在前、本目录图片在后）
- 按文件名 / 路径过滤，翻页只在匹配的图片间进行
- 地址栏记住当前图片，刷新页面不丢位置
- 目录里增删图片后页面自动更新；正在看的图被删则停在原位置顶上来的那张
- 支持 png / jpg / jpeg / gif / svg / webp / avif / bmp / ico
- 跳过隐藏目录（`.git` 等）与 `node_modules` / `dist` / `build`

## 实现

零依赖，只用 Node 内置模块（Node ≥ 20）。思路参考 fancy-book-maker 的 dev 服务：

| 文件 | 职责 |
| - | - |
| `bin/showimg.js` | 命令行入口（`node:util` parseArgs） |
| `src/scan.js` | 递归扫描图片，产出目录树 |
| `src/server.js` | HTTP 服务：页面资源、`/__showimg/tree` 目录树、`/img/*` 图片、`/__showimg/events` SSE 变更通知；`fs.watch` 递归监听 |
| `assets/` | 浏览器端页面，原生 JS + CSS，无框架 |

安全与兜底：默认只监听 127.0.0.1，且只接受 Host 为 localhost / 回环地址的请求（防 DNS 重绑定读本机图片）；
图片服务拒绝越出所选目录的路径；单次扫描最多进入 5000 个目录，误贴 `/`、`~` 这类大目录时只显示一部分并提示。

## 本地开发

```bash
cd ~/workspace/show_img
npm link        # 注册全局 showimg 命令（指向本目录，改代码即时生效）
npm unlink -g show-img   # 取消
```
