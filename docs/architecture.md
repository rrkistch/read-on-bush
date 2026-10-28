# 架构设计文档

本文档描述 Read On Bush 的分层架构与模块职责，包括本地格式与微信读书在线书源。

## 目录结构总览

```
src/
├── config/             配置层：常量、命令 ID、设置读写
├── domain/             领域层：纯阅读模型与端口接口（零 VS Code 依赖）
│   └── books/            BookData、TxtBook、EpubBook、PdfBook、分页引擎
├── application/        应用层：服务编排与生命周期管理
├── infrastructure/     基础设施层：文件解析与持久化存储
│   ├── parsers/          TXT / EPUB / PDF 提取器
│   └── storage/          BookStore、ExtractionCache、EpubCache、PdfCache
├── formats/            格式层：连接领域模型与基础设施
│   ├── BookFormat.ts       格式提供者接口与 reader 服务契约
│   ├── BookFormatRegistry.ts  扩展名 → 提供者路由
│   ├── PaginatedReaderBase.ts EPUB / PDF 共用的分页阅读基类
│   ├── CachedExtractionLoader.ts  提取结果缓存加载器
│   ├── epub/             EPUB Provider + Reader
│   ├── pdf/              PDF Provider + Reader
│   └── txt/              TXT Provider + Controller
├── presentation/       表示层：UI 适配
│   ├── bookshelf/         书架树视图
│   ├── reader/            阅读显示（伪装终端渲染、状态栏）
│   ├── readerSurfaces/    显示载体抽象（集成终端 / Webview 面板）
│   ├── readerControls/    终端输入控制
│   ├── readerEditors/     自定义模板可视化编辑器
│   ├── readerTemplates/   伪装模板定义与构建
│   └── statusBar/         状态栏控件
├── utils/              通用工具
└── extension.ts        扩展入口
```

## 分层架构

### 依赖方向

```
presentation ──→ application ──→ domain
formats ────────┤               ↑
infrastructure ──┘               │（领域层不依赖任何外层）
config ─────────→（被各层引用）
```

核心原则：**领域层零外部依赖**。`src/domain/books/` 下的代码不导入 `vscode`、不导入 `application/`、不导入 `presentation/`、不导入 `infrastructure/`。外层通过注入端口接口（Port）来驱动领域模型。

---

### domain（领域层）

| 文件 | 职责 |
|------|------|
| `BookData.ts` | 书籍数据模型与进度类型（`EpubProgress` / `PdfProgress`） |
| `BookOutline.ts` | 目录大纲类型 |
| `TxtBook.ts` | TXT 阅读模型：扁平 `string[]`，保留整数片段游标，支持可选片段内字符位置 |
| `TxtPagination.ts` | TXT 视口分页：将文本片段适配到共享折行引擎，返回片段索引及字符偏移 |
| `EpubBook.ts` | EPUB 阅读模型：章节结构 + 跨章分页 |
| `PdfBook.ts` | PDF 阅读模型：按页分页（复用 EPUB 分页引擎） |
| `EpubPagination.ts` | 纯分页算法：折行、前/后翻页、进度百分比 |
| `ReadingPorts.ts` | 端口接口：`BookProgressPort`、`ReadingNotifier`、`TxtDisplayPort`、`ReadingPrivacyPort`、`TxtReadingPort` |
| `ReadingDisplayState.ts` | TXT 阅读显示状态 |
| `BookExtractions.ts` | EPUB / PDF 提取结果 DTO |
| `TextWidth.ts` | 字符宽度计算（CJK = 2，ASCII = 1） |

**端口注入模式：** 领域模型通过构造函数注入端口，而非直接依赖具体服务：

```typescript
// TxtBook 不依赖 ApplicationContext，只依赖窄接口
new TxtBook(book, contents, {
  display: txtDisplayPort,    // render / pause / 步进
  progress: progressPort,      // 持久化进度
  notifier: readingNotifier    // info / warn / error
});
```

---

### application（应用层）

| 文件 | 职责 |
|------|------|
| `ApplicationContext.ts` | 服务容器：组装所有子系统，提供 `ReaderServices` |
| `ReadingSession.ts` | 阅读会话：管理当前 Reader 的打开/关闭/导航，持有 `openGeneration` 防止过期异步覆盖 |
| `BookCatalog.ts` | 书架管理：增删改查、分类、排序、分组、隐私模式切换 |
| `PrivacyService.ts` | 隐私策略：书名/消息/图片标题脱敏，终端模板隐私化 |
| `ConfigurationCoordinator.ts` | 配置变更协调：监听设置变化，分发刷新到显示层和阅读会话 |
| `bootstrap.ts` | 启动入口：创建 `ApplicationContext`，注册状态栏、编辑器和格式变更事件 |
| `viewCommands.ts` | 书架命令注册：导入、刷新、自动刷新 |

**Reader 生命周期：** `ReadingSession` 是当前 Reader 的唯一所有者。每次打开书籍时：

1. 关闭旧 Reader（`close()` + `dispose()`）
2. 通过 Provider 创建新 Reader 实例
3. 调用 `reader.open()`，返回 `boolean` 表示是否成功
4. 成功后发射格式变更事件；失败则清理并显示空闲提示

---

### infrastructure（基础设施层）

| 模块 | 职责 |
|------|------|
| `parsers/TxtParser.ts` | TXT 文件读取：BOM 检测、UTF-16 端序检测、GB18030 |
| `parsers/EpubExtractor.ts` | EPUB 解压与章节/图片提取 |
| `parsers/PdfExtractor.ts` | PDF 文本/图片提取（pdfjs-dist） |
| `storage/BookStore.ts` | 书籍数据持久化（VS Code globalState） |
| `storage/ExtractionCache.ts` | 通用提取缓存：mtime 失效、JSON envelope、写入序列化 |
| `storage/EpubCache.ts` | EPUB 缓存适配器（版本 + 校验） |
| `storage/PdfCache.ts` | PDF 缓存适配器（版本 + 结构校验） |

**缓存设计：**

- `ExtractionCache<T>` 是格式无关的通用缓存引擎
- 文件名使用 `encodeURIComponent(bookId)` 避免碰撞
- 缓存记录包含 `bookId` / `version` / `fileMtime`，读取时三者均校验
- 写入操作按 bookId 序列化，避免并发撕裂
- `CachedExtractionLoader<T>` 在 Provider 层持有，提供 in-flight 去重

---

### formats（格式层）

格式层是连接领域模型与基础设施的适配层，每种格式注册一个 `BookFormatProvider`。

| 文件 | 职责 |
|------|------|
| `BookFormat.ts` | 提供者接口、`ReaderServices`、`BookReaderController` |
| `BookFormatRegistry.ts` | 扩展名 → 提供者路由，支持 supported / convertible / unknown 分类 |
| `PaginatedReaderBase.ts` | EPUB / PDF 共用的分页阅读基类：打开/关闭/翻页/图片预览/生命周期 |
| `CachedExtractionLoader.ts` | 提取缓存加载器：缓存命中 → 提取 → 后台写入 |
| `FormatProviderHelpers.ts` | 导入与目录生成的共享工具 |

**Provider 契约：**

```typescript
interface BookFormatProvider {
  readonly format: BookFormat;
  readonly supportedExtensions: readonly string[];
  importBook(input: ImportBookInput): Promise<BookData>;
  createReader(input: CreateReaderInput): BookReaderController;
  getOutline?(book: BookData): Promise<BookOutlineItem[]>;
  deleteCache?(book: BookData): Promise<void>;
}
```

新增本地格式实现 Provider 并在 `createDefaultBookFormatRegistry` 中注册。微信读书通过 `WeReadService` 注册不声明本地扩展名的 Provider；Registry 对明确的微信来源使用在线路由，本地导入和已有书籍仍按路径扩展名路由。

### 微信读书是在线书源，不是本地 EPUB

- `application/WeReadService.ts` 编排扫码、Cookie、账号切换和书架同步；凭据通过 `ExtensionContext.secrets` 保存，书籍元数据和阅读位置继续由 BookCatalog / BookStore 持久化。
- `infrastructure/weread/` 隔离 HTTPS、认证续期、协议签名、正文分片还原和内存章节缓存。凭据只发往 `weread.qq.com`，请求不跟随重定向，远端脚本不执行。
- `BookData.source` 标识账号和远端 bookId，`wereadProgress` 用真实 chapterUid 与本地文本偏移定位。`weread://` 地址不进入本地文件存在检查或目录分组。
- `WeReadReader` 单独管理异步章节切换，不继承假定全书已加载的 `PaginatedReaderBase`；章内复用纯分页工具，显示复用 `PaginatedReaderDisplay` 和 `SurfaceRouter`。替换章节不重置隐蔽状态。
- 首开目录、阅读会话和云进度并发准备；正文格式来自阅读页元数据，缺省时通过首分片的明确协议类型识别，不再逐章请求 `book/info`。必要元数据或分片失败时取消同组剩余请求。
- 刷新令牌支持主动后台续期和并发合并；无刷新令牌的手动 Cookie 保留原请求契约。续期检查不作为正文加载的阻塞前置步骤。
- 正文最多缓存三章，且只驻留内存。云端进度按章同步，回传默认关闭；本地进度先写入，网络回传串行合并最新章节，失败状态可重试。
- `ReadingSession` 在任何异步等待前分离旧 Reader，新的打开等待旧会话收尾；账号及阅读版本标识阻止迟到响应覆盖当前状态。

设计依据及取舍见 [微信读书接入设计](superpowers/specs/2026-10-26-weread-design.md)，实施和验证记录见 [实施记录](superpowers/plans/2026-10-26-weread-implementation.md)。

---

### presentation（表示层）

| 模块 | 职责 |
|------|------|
| `bookshelf/` | 书架树视图、分组逻辑、隐私脱敏渲染 |
| `reader/` | 阅读显示管理、伪装终端渲染、状态栏适配、图片预览面板 |
| `readerSurfaces/` | 显示载体抽象：`TerminalSurface`（集成终端）与 `ReaderViewSurface`（Webview 面板） |
| `readerControls/` | 终端键盘输入解析与隐蔽控制 |
| `readerEditors/` | 自定义模板可视化编辑器 |
| `readerTemplates/` | 伪装模板定义（Claude CLI / 构建日志 / 服务日志 / Vite / Docker / 自定义） |
| `statusBar/` | 状态栏控件（内容、翻页、进度、模式切换） |

**显示载体抽象（`ReaderSurface`）：**

```
ReaderSurface（接口）
├── TerminalSurface     → 集成终端 + Pseudoterminal
└── ReaderViewSurface   → Webview 面板（readerPanel 模式）
      └── SurfaceRouter  → 运行时热切换，显示类不感知底层载体
```

状态栏控件依赖 `TxtReadingPort` 窄接口而非 `ApplicationContext`，通过 `ReadingSession` 暴露 TXT 能力。

#### 小窗布局与分页共享一份容量

`CamouflageLayout.ts` 根据模板、窗口列／行数、配置行宽及最大正文行数生成布局。默认 `auto` 在完整装饰无法容纳时切换紧凑；`compact` 始终精简，`full` 保留旧的完整输出。全部内置模板和自定义模板走同一规则，布局不修改用户的模板配置。

紧凑模式先分配正文，剩余空间才保留短进度和单行标题，去掉尾部日志及常驻长快捷键提示；模板装饰可以按宽度裁剪，正文只能重新分页。渲染和下一页／上一页共同使用布局返回的 `lineWidth`、`lineCount`，不能仅在渲染后裁掉多余正文。短尾页填空行保持脚注位置稳定，隐藏模式使用同一容量。

终端的初始 `open(dimensions)` 在输出前重新计算帧，缓冲只保留最新完整帧，标题独立缓冲。显示载体提供可选 `getDimensions()`，新 Reader 能读取已有尺寸，路由切换时不会使用另一个载体的旧尺寸。Webview 外壳采用固定视口高度和内部滚动，不再用内容撑大的 min-height 测量行数。

TXT 的 `process` 仍表示原片段索引，新增可选 `txtCharOffset` 保存片段内位置。显示端的精确前后位置能力是可选的，旧端口仍可按整数步长使用。状态栏维持片段级导航；伪装阅读、自动翻页及位置返回使用实际可见文本和源位置，避免小窗只显示半段却跳过整段。

**取舍：** 仅保持滚动条位置无法让超高的伪装日志装进小窗；新增单独的小窗皮肤又会让其他样式继续溢出。因此采用共享宽高预算，保留显式 `full` 供需要完整日志的用户选择。小窗会隐藏部分装饰，字体大小不变；窗口增大时自动恢复能容纳的完整结构。

**验证：** 相关 61 项测试通过，覆盖全部样式与自定义模板的行列限制、初始终端帧、缩放／隐藏、TXT 逐字完整性及既有导航；使用生产渲染器和阅读面板脚本检查了六种 430×180 预览及进一步缩小后的表现，并操作前后翻页和隐藏／恢复。用户已登录窗口仍由用户自行验收。

---

### config（配置层）

| 文件 | 职责 |
|------|------|
| `constants.ts` | 应用名、行宽限制、状态栏优先级 |
| `commands.ts` | 命令 ID 枚举、when 子句上下文键 |
| `settings.ts` | 配置读写与规范化（类型安全的 getter） |
| `bookGroups.ts` | 书架分组名称生成 |
| `convertGuide.ts` | 格式转换引导（CloudConvert URL） |
