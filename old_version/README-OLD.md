# 旧版：code-first（DSL 改造前）

这是启用“绘图 DSL + 编译器”之前的版本，保留下来用于对比：

- 模型直接输出 `img\`...\`` 逐行网格代码（或 16×16 tile + `CombinedTiles`）；
- 程序负责解析、校验、本地维度修复与渲染；
- 支持三档思考模式、失败重试按钮、折叠代码/思维链/介绍等界面功能；
- **不包含** DSL 编译器。

## 运行

### 快速运行（复用上级依赖和 .env）

在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\old_version\run.ps1
```

脚本会切换到 `old_version/`、使用上级 `node_modules` 里的 `tsx`、读取上级 `.env`，并监听 **3001**。不会复制或打印 Key。

### 手动运行（独立依赖）

旧版代码已复制，但为了安全**没有复制**以下内容：

- `.env`（API Key）
- `node_modules/`
- `sessions/`、`preview/`、`logs/`

因此需要先准备依赖和 Key：

```powershell
cd old_version
npm install

# 方式一：把上级目录的 .env 复制到 old_version/.env
# 方式二：直接设置环境变量
$env:DEEPSEEK_API_KEY = "sk-..."
$env:PORT = "3001"

npm run dev
```

然后打开 **http://localhost:3001**，新版本仍在 **http://localhost:3000**，可以并排对比。

> 依赖也可以复用上级的 `node_modules`（Node 会向上查找），但旧版的 `prompt.md` 会按当前工作目录读取；请务必在 `old_version/` 目录内启动，才能使用旧版提示词。
