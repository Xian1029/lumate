# OpenTutor 界面中文化改造说明

## 本次做了什么

项目（github: zijinz456/OpenTutor）原本就内置了完整 i18n 框架（`src/lib/i18n.ts`、`i18n-context.tsx`、`src/locales/{en,zh}.json`），且 `zh.json` 早就是一份完整的中文翻译，与 `en.json` 的 922 个 key 完全对齐。界面之前全是英文，**唯一原因**是默认语言被硬编码成了 `"en"`。

改造内容：

1. **默认语言切中文**（3 处）
   - `src/lib/i18n.ts`：模块级 `currentLocale` 默认 `"zh"`
   - `src/lib/i18n.ts`：`initLocale()` 无 localStorage 时的回退值 `"zh"`
   - `src/lib/i18n-context.tsx`：`useState` 初始值 `"zh"`

2. **补齐缺失翻译 key**（10 个）
   代码里 `t("...")` 调用了但 `en.json`/`zh.json` 都缺失的 key（`chapter.navLabel`、`chat.retryLabel`、`nav.back`、`quiz.prerequisiteGaps`、`quiz.prerequisiteHint`、`settings.ollamaBaseUrl`、`url.add`、`url.addUrl`、`url.addUrlToCourse`、`url.helpText`），全部补全中英双语。

3. **批量本地化硬编码英文文案**（142 处）
   `analytics` / `chat` / `blocks` / `practice` / `notes` 等子模块里大量未走 i18n 的硬编码英文标题、按钮、空状态、aria-label，统一改为 `t("ui.xxx")` 调用，并在双语词典新增 `ui.*` key。词典规模 932 → 1073 个 key。

## 踩坑与修复

- `global-error.tsx` 与 `streaming-indicator.tsx` 原本是 `"use client"` 开头、且无 import 语句。批量脚本给文件补 `import { t }` 时把它顶到了文件首行，盖过了 `"use client"` 指令，导致 **Next.js 整站 500**。
- 修复：`global-error.tsx` 改为直接硬编码中文（错误兜底页不应依赖运行时 i18n）；`streaming-indicator.tsx` 把 `"use client"` 调回首行。
- 经验：给文件插入 import 时，若文件已有 `"use client"`，新 import 必须插在它**之后**。

## 验证结果

- 前端 `npm run dev` 编译**零错误**，首页 HTTP 200。
- 首页 SSR 输出直接包含中文「学习空间 / 新建空间 / 首页 / 设置 / AI 驱动」等，且**无任何残留英文导航词**（`Home`/`Settings`/`Analytics`/`My Spaces` 命中数均为 0）。
- 后端 FastAPI（`:8000`）、API 文档（`:8000/docs`）、前端（`:3001`）均正常，DeepSeek AI 功能不受影响。

## 你需要注意

- **如何看到中文**：你之前访问时浏览器缓存了英文 locale。打开预览若仍是英文，请清一下 localStorage（浏览器控制台执行 `localStorage.removeItem('opentutor-locale')`）或开无痕窗口即可。项目本身也自带语言切换器，可随时在中英文间切换。
- 所有改动均已落盘（词典 + 源码），`.env` 里的真实 API Key 请勿提交到 git（`.gitignore` 已忽略 `.env`）。

## 续：彻底清除剩余英文（第二批，同日）

用户要求把**剩余英文**（标签 / 按钮 / 错误提示等）也全部中文化。第一批只覆盖了主界面与部分子模块，深层模块（课程同步、错题分析、笔记、block-system 模板/注册表、API 错误文案、设置区等）仍有约 130 处硬编码英文。

改动：

1. **全量扫描**：`tmp/scan_full.py` 扫描源码全部单/双引号字面量，排除 CSS 类名、i18n key、SVG、单位、import 路径后，得 282 条候选。区分出三类——真正要改的硬编码自然语言 UI（~130 条）、已是 `t()` 多段 key 的误报、以及 CSS/单位/路径类误报。
2. **批量替换**：`tmp/localize_full.py` 建立 130 条「英文 → (ui.* key, 中文)」映射，写入 `en.json` / `zh.json`（词典 1073 → **1218** 个 key），源码改为 `t("ui.*")` 调用，并为缺少导入的 21 个文件补 `import { t } from "@/lib/i18n"`（严格遵守 `"use client"` 在后规则）。共 36 个文件被替换。
3. **刻意保留**：`study-notifications.ts` 的 `"Time to study!"` 只是 fallback（zh 分支已输出「该学习了！」）；`B/KB/MB` 为通用单位符号——两者均不视作用户可见英文文案，未改。

验证：

- `"use client"` 顺序违规 **0 个**；894 个静态 i18n key 全部存在于中英词典（唯一"缺失" `nonexistent.key.xyz` 是测试占位）。
- 动态模板 key（`mode.${id}`、`unit.difficulty.${level}` 等）所属命名空间在 `zh.json` 均齐备。
- 路由编译：`/` `/settings` `/new` `/setup` `/analytics` 及 `/course/[真实id]` 全部 **HTTP 200，无 500**。
- 首页 SSR 含 142 个中文字符，命中「学习空间 / 首页 / 设置 / AI 驱动」，英文导航残留全部为 False。
- 复跑扫描：残留项仅为 B/KB/MB 单位、import 路径、CSS 类名、i18n key 字符串——均非需翻译的 UI 文案。

**结论**：硬编码英文 UI 已基本清零，OpenTutor 界面全面中文化完成。
