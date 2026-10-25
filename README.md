# dsh-draw-mode

把本地 **ComfyUI** 接进 DeepSeek Harness 的绘图插件 —— 由你自己从 ComfyUI 导出的工作流驱动。
Links a local **ComfyUI** server into DeepSeek Harness — driven by the workflows you export from ComfyUI yourself.

[中文](#中文) · [English](#english)

## 中文

把 **ComfyUI** 接进 DeepSeek Harness，给 agent 一个「画图模式」：五个 `draw_*` 工具、一个侧栏面板、一个配置表单——全部由**你自己从 ComfyUI 导出的工作流**驱动。

插件**不自带任何工作流，也不带任何模型**。把你自己的 `Save (API Format)` JSON 放进一个目录，把插件指过去，它就会自动识别每个图能干什么。

### 功能

- **空框架，用你自己的图** —— 没有内置工作流库，不写死检查点，也没有「模型族」清单。你导出什么，agent 就能跑什么。
- **自动识别输入位置** —— 逐个分析工作流，找出提示词、负向词、宽、高、步数、CFG、seed、denoise、输入图和 LoRA 分别落在哪。不用改 JSON，不用维护 manifest。
- **五个工具**
  - `draw_status` —— ComfyUI 通不通、什么显卡多少显存、插件当前配置、找到哪些工作流、缺哪些模型文件；可以顺带无头拉起。
  - `draw_workflows` —— 列出识别到的工作流，含任务类型、默认参数、可替换的输入。
  - `draw_models` —— 正在跑的 ComfyUI 实际装了哪些模型文件，从 `/object_info` 读（checkpoint、diffusion model、文本编码器、VAE、LoRA）。
  - `draw_generate` —— 跑工作流：文生图、图生图或改图，支持 LoRA 注入，并回传这次用的 seed。
  - `draw_reverse` —— 对一张图跑打标/反推工作流，返回文本。
- **侧栏设置面板** —— 连通性、显卡、工作流目录与清单、最近出图缩略图，以及一个能改所有配置项的表单（存到 `~/.dsh/draw-mode/settings.json`，保存即生效，不用重启）。
- **可选自动启停** —— 两项都**默认关闭**：工具需要时拉起 ComfyUI，队列空闲一段时间后关掉释放显存。空闲关闭默认只结束本插件自己拉起的进程；`idleShutdownScope: port` 才会扩大到 `comfyBaseUrl` 端口上的任何进程，包括你手动启动的 ComfyUI。

### 环境要求

- 一个本地（或局域网）ComfyUI 实例。插件不依赖特定 ComfyUI 版本：需要哪些节点和模型，由你导出的工作流决定。
- Node >= 22。不 import 任何 `@deepseek-ai/*` 包，只引用宿主提供的服务。
- 你自己的那些工作流所需要的自定义节点和模型文件。

### 安装

```sh
dsh plugin --profile <你的 profile> add dsh-draw-mode
```

### 加工作流

1. 在 ComfyUI 里搭好你要的图。
2. 点 **Save (API Format)**——**不是**普通的 Save。API 格式是「节点 id → 节点对象」的扁平结构；普通保存是 UI 图，本插件跑不了。
3. 把 `.json` 放进工作流目录：
   - 设了 `comfyRoot` 时是 `<comfyRoot>/ComfyUI/user/default/workflows`，或
   - 你设成 `workflowsDir` 的任何目录（绝对路径、`~`、`%VAR%`、`${VAR}` 都行）。
4. 打开侧栏面板（或调 `draw_workflows`）确认已被识别。

不会扫描子目录：JSON 直接放在该目录下。

#### 自动识别规则

| 输入位置 | 怎么找 |
| --- | --- |
| `prompt` / `negative` | 带字面量 `text` 输入的文本编码节点。标题为 `pos`/`neg` 的优先，否则按 id 顺序取前两个。 |
| `seed` | 采样器的字面量 `seed` 或 `noise_seed`。 |
| `steps`、`cfg`、`denoise` | 采样器上同名的字面量输入。 |
| `width`、`height` | 同时带字面量 `width` 和 `height` 的节点（如 `EmptyLatentImage`）。 |
| `image` | `LoadImage.image`；第二个 `LoadImage` 变成 `image2`。 |
| `lora` | 图里已有 `LoraLoader` 时取它的 `lora_name`。 |

只有**字面量**才算输入位置——连到别的节点的值一律不动，改了会断链。某个值如果是指向其他节点的连线、但你想让它可改，在 ComfyUI 里补一个字面量节点，或者用下面的 sidecar 覆盖。

#### 覆盖识别结果：sidecar 文件

在工作流同目录放一个 `<工作流名>.draw.json`（即 `my-flow.json` → `my-flow.draw.json`）：

```json
{
  "label": "我的肖像流程",
  "task": "img2img",
  "slots": {
    "prompt": { "node": "6", "input": "text" },
    "negative": { "node": "7", "input": "text" },
    "image": { "node": "10", "input": "image" },
    "seed": { "node": "3", "input": "seed" }
  },
  "defaults": { "steps": 8, "cfg": 1 },
  "notes": "两段放大，第二遍可选"
}
```

每个键都是可选的，没写的回落到自动识别。`task` 取值 `t2i`、`img2img`、`edit`、`reverse`，只影响过滤和展示。

扫描时会跳过 sidecar 本身，不会被当成工作流。

#### 模型文件名

你导出的 JSON 记录的是导出那台机器上的检查点文件名。如果运行机器上的名字不一样，用 `modelMap`，不要改 JSON：

```yaml
modelMap:
  'their_model_Q4_K_M.gguf': 'my_model_Q8_0.gguf'
```

改写发生在加载工作流时。`draw_models` 显示的是实际装了哪些。

### 指向你的 ComfyUI

没有任何东西写死在某台机器上。每个路径都是配置项，而且**当 ComfyUI 已经在别处跑着时，插件完全不需要本地路径**：图通过 `POST /upload/image` 传进去、通过 `GET /view` 取回来，所以 ComfyUI 的 `input/` 和 `output/` 都不必对本进程可见。

三种用法，从最少配置到最多：

1. **ComfyUI 已经在跑**（任意主机、任意端口）——只设 `comfyBaseUrl`。
2. **让插件自己拉起来**——设 `comfyRoot`（或 `comfyMain` + `comfyPython`）并把 `autoStart: true`。
3. **指到你的工作流**——设 `workflowsDir`；想要离线的「文件在不在」检查再加 `modelsRoot`。

#### 面板

侧栏的 **画图** 条目打开一个面板，含：

- 连通性、显卡名与空闲/总显存、空闲倒计时；
- 解析后的配置（只读摘要），**编辑** 按钮把它变成表单；
- **测试连接** —— 用当前值重新检查 ComfyUI，但不保存；
- 工作流目录、识别到的工作流（任务类型、默认参数、可替换输入），以及解析失败的文件；
- 最近出图缩略图，带灯箱。

保存会写 `~/.dsh/draw-mode/settings.json` 并立刻重新读取：**文本框留空表示「不覆盖」，该项回落到插件配置**。这就是不动 YAML 撤销单项设置的办法。

勾选框和数字框没法留空，保存就会把它们钉成表单当前显示的值。想把全部设置一次性还原成插件配置，点 **清除覆盖** —— 它直接删掉设置文件。

优先级：内置默认 < 插件配置（`cordis.patch.yml`）< `settings.json`（面板）。

### 配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `comfyBaseUrl` | `http://127.0.0.1:8188` | ComfyUI 监听地址；远程、局域网、非默认端口都改这里。 |
| `comfyRoot` | `''` | ComfyUI 安装目录，只用于无头启动和路径推导。 |
| `comfyPython` | `''` | python 可执行文件，覆盖 `comfyRoot` 的推导；只写命令名（如 `python3`）则从 `PATH` 找。 |
| `comfyMain` | `''` | ComfyUI 的 `main.py`，覆盖推导。 |
| `comfyWorkdir` | `''` | 启动进程的工作目录，默认 `main.py` 所在目录。 |
| `comfyArgs` | `[]` | 额外命令行参数，如 `['--lowvram']`。 |
| `autoStart` | `false` | 工具连不上时无头拉起 ComfyUI，需要上面那几个路径。 |
| `startTimeoutMs` | `240000` | 等拉起的 ComfyUI 响应的最长时间。 |
| `timeoutMs` | `900000` | 单次生成超时。 |
| `modelsRoot` | `''` | `ComfyUI/models`；用于本地检查「工作流要的模型在不在」，留空按 `comfyRoot` 推导。 |
| `workflowsDir` | `''` | 放你导出的 API 格式工作流的目录，留空按 `comfyRoot` 推导。 |
| `modelMap` | `{}` | `{ 'JSON 里的名字.gguf': '你本机的名字.gguf' }`，加载时改名，不必改 JSON。 |
| `outputDir` | `''` | 固定出图目录；配了就一定存这里。 |
| `saveToWorkspace` | `true` | 否则存进会话工作区的 `workspaceFolder`。 |
| `workspaceFolder` | `'draw-mode'` | 会话工作区内的子目录（绝对路径则原样使用）。 |
| `idleShutdown` | *(未设)* | 显式开关：`false` 永不关，`true` 按 `idleShutdownMs`（未设时长则 15 分钟）。 |
| `idleShutdownMs` | `0` | 空闲多久后关闭 ComfyUI；`0` = 关闭该功能。 |
| `idlePollMs` | `30000` | 空闲检查的间隔。 |
| `idleShutdownScope` | `'spawned'` | `spawned` 只关本插件拉起的；`port` 连你手动启动的也一起关。 |
| `settingsPath` | `''` | 面板保存的位置，`''` = `~/.dsh/draw-mode/settings.json`；只能由插件配置指定，设置文件改不了自己。 |

所有路径值都接受 `~`、`%VAR%`、`${VAR}` 和相对路径（按 `comfyRoot` 解析）。

```yaml
- insert:
    - id: dsh-draw
      name: 'dsh-draw-mode'
      config:
        comfyBaseUrl: 'http://127.0.0.1:8188'
        # --- 自己拉起 ComfyUI（可选）---
        comfyRoot: ''            # 如 'D:/ComfyUI_windows_portable' 或 '/opt/ComfyUI'
        comfyPython: ''          # 如 'D:/ComfyUI_windows_portable/python_embeded/python.exe'
        comfyMain: ''            # 如 'D:/ComfyUI_windows_portable/ComfyUI/main.py'
        comfyWorkdir: ''
        comfyArgs: []
        autoStart: false
        startTimeoutMs: 240000
        timeoutMs: 900000
        # --- 模型与工作流（可选）---
        modelsRoot: ''           # 如 'D:/ComfyUI_windows_portable/ComfyUI/models'
        workflowsDir: ''         # 放你导出的 API 格式 JSON 的目录
        modelMap: {}             # { '他们的名字.gguf': '我的名字.gguf' }
        # --- 出图存哪 ---
        outputDir: ''            # 如 '~/Pictures/draw'
        saveToWorkspace: true
        workspaceFolder: 'draw-mode'
        # --- 空闲关闭（默认关闭）---
        idleShutdownMs: 0
        idlePollMs: 30000
        idleShutdownScope: 'spawned'
```

`draw_status` 会把解析结果回显出来——会 spawn 哪个 `main.py`/`python`、扫的是哪个 `workflowsDir`、图存到哪、还缺哪些模型文件——配置对不对不用猜。

### 备注

- 这个 bundle 还会插入一个 agent preset；如果你只想要工具，删掉那段 `insert`。
- 提示词风格不由插件固定：取决于你选的工作流用的是什么基座模型。preset 会让 agent 对动漫检查点写 Danbooru 标签、对写实模型写自然语言长句、对通用模型两种都行。
- 面板不要求 ComfyUI 正在运行：连不上时它报「未连接」，而不是报错。
- 解析失败的工作流会列在面板和 `draw_status` 里，不会把整个目录一起带崩。

---

## English

Links a local **ComfyUI** server into DeepSeek Harness and gives the agent a drawing mode: five `draw_*` tools, a sidebar panel, and a settings form — all driven by **the workflows you export from ComfyUI yourself**.

The plugin ships **no workflows and no models**. Drop your own `Save (API Format)` JSON files into a folder, point the plugin at that folder, and it auto-discovers what each graph can do.

### What it does

- **Empty framework, your graphs** — no bundled workflow library, no hard-coded checkpoints, no per-model family list. Whatever you export is what the agent can run.
- **Automatic slot detection** — each workflow is inspected to find where the prompt, negative prompt, width, height, steps, CFG, seed, denoise, input image(s) and LoRA go. No JSON editing, no manifest to maintain.
- **Five tools**
  - `draw_status` — is ComfyUI reachable, what GPU/VRAM does it have, how is the plugin configured, which workflows were found and which model files are missing; optionally start it headlessly.
  - `draw_workflows` — list the discovered workflows with their task type, default parameters and replaceable inputs.
  - `draw_models` — the model files the running ComfyUI actually has, read from `/object_info` (checkpoints, diffusion models, text encoders, VAEs, LoRAs).
  - `draw_generate` — run a workflow: text-to-image, image-to-image or edit, with LoRA injection and the used seed reported back.
  - `draw_reverse` — run a tagger/captioner workflow on an image and return its text.
- **A settings panel** in the sidebar: connectivity, GPU, workflow directory and list, recent thumbnails, and a form for every configuration value (saved to `~/.dsh/draw-mode/settings.json`, effective immediately, no restart).
- **Optional auto-start / idle shutdown** — both **off by default**: start ComfyUI when a tool needs it, and stop it again after the queue has been idle to release VRAM. Idle shutdown only ends the process this plugin spawned itself; `idleShutdownScope: port` widens it to whatever listens on `comfyBaseUrl`'s port, including a ComfyUI you started by hand.

### Requirements

- A local (or LAN) ComfyUI instance. Nothing in the plugin depends on a specific ComfyUI version: the workflows you export decide which nodes and models are needed.
- Node >= 22. No `@deepseek-ai/*` package is imported; the bundle only references host-provided services.
- Whatever custom nodes and model files your own workflows use.

### Install

```sh
dsh plugin --profile <your-profile> add dsh-draw-mode
```

### Adding your workflows

1. In ComfyUI, build the graph you want.
2. Click **Save (API Format)** — *not* the plain `Save`. The API format is a flat map of node id → node object; the normal save is a UI graph this plugin cannot run.
3. Put the `.json` file into the workflow directory:
   - `<comfyRoot>/ComfyUI/user/default/workflows` when `comfyRoot` is set, or
   - any folder you set as `workflowsDir` (absolute, `~`, `%VAR%`, `${VAR}` all work).
4. Open the sidebar panel (or call `draw_workflows`) to confirm it was picked up.

Subdirectories are not scanned: keep the JSON files directly in that folder.

#### What gets detected

| Slot | How it is found |
| --- | --- |
| `prompt` / `negative` | A text-encode node with a literal `text` input. The node titled `pos`/`neg` wins; otherwise the first two in id order. |
| `seed` | A sampler's literal `seed` or `noise_seed`. |
| `steps`, `cfg`, `denoise` | A sampler's literal inputs of those names. |
| `width`, `height` | A node with literal `width` and `height` (e.g. `EmptyLatentImage`). |
| `image` | `LoadImage.image`; a second `LoadImage` becomes `image2`. |
| `lora` | `LoraLoader.lora_name`, when the graph already has one. |

Only **literal** values are treated as slots — anything wired to another node is left alone, because overwriting it would break the link. If a value is a link and you want it editable, add a literal node in ComfyUI (or override the slot with a sidecar, below).

#### Overriding detection: the sidecar file

Put a file next to the workflow, named `<workflow name>.draw.json` (so `my-flow.json` → `my-flow.draw.json`):

```json
{
  "label": "My portrait flow",
  "task": "img2img",
  "slots": {
    "prompt": { "node": "6", "input": "text" },
    "negative": { "node": "7", "input": "text" },
    "image": { "node": "10", "input": "image" },
    "seed": { "node": "3", "input": "seed" }
  },
  "defaults": { "steps": 8, "cfg": 1 },
  "notes": "Two-stage upscale, second pass is optional"
}
```

Every key is optional; whatever you leave out falls back to auto-detection. `task` is one of `t2i`, `img2img`, `edit`, `reverse` and only affects filtering and display.

Sidecars are skipped by the scanner itself, so they are never mistaken for workflows.

#### Model file names

Your exported JSON records the exact checkpoint filenames of the machine it was exported from. If they differ on the machine that runs it, use `modelMap` instead of editing JSON:

```yaml
modelMap:
  'their_model_Q4_K_M.gguf': 'my_model_Q8_0.gguf'
```

The rewrite is applied when the workflow is loaded. `draw_models` shows what is actually installed.

### Pointing it at your ComfyUI

Nothing is hard-coded to any machine. Every path is a configuration value, and **the plugin needs no local paths at all** when ComfyUI is already running somewhere reachable: images go in through `POST /upload/image` and come back through `GET /view`, so neither the ComfyUI `input/` nor `output/` directory has to be visible to this process.

Three ways to use it, from least to most configuration:

1. **ComfyUI already running** (any host, any port) — set `comfyBaseUrl` and nothing else.
2. **Let the plugin start it** — set `comfyRoot` (or `comfyMain` + `comfyPython`) and `autoStart: true`.
3. **Point it at your workflows** — set `workflowsDir`; add `modelsRoot` if you want the offline "is the file there?" check.

#### The panel

The sidebar entry **画图** opens a panel with:

- connectivity, GPU name and free/total VRAM, and the idle countdown;
- the resolved configuration as a read-only summary, with an **编辑** button that turns it into a form;
- **测试连接** — re-checks ComfyUI with the current values without saving;
- the workflow directory, the discovered workflows (task, defaults, replaceable inputs) and any file that failed to parse;
- thumbnails of recent output with a lightbox.

Saving writes `~/.dsh/draw-mode/settings.json` and re-reads it immediately: **an empty text field means "no override", so the value falls back to the plugin config**. That is how you revert a single setting without editing YAML.

Checkboxes and numbers cannot be empty, so saving pins whatever the form shows for them. To get everything back to the plugin config in one go, use **清除覆盖** — it deletes the settings file outright.

Precedence: built-in defaults < plugin config (`cordis.patch.yml`) < `settings.json` (the panel).

#### Options

| Key | Default | Meaning |
| --- | --- | --- |
| `comfyBaseUrl` | `http://127.0.0.1:8188` | Where ComfyUI listens. Remote/LAN and non-default ports go here. |
| `comfyRoot` | `''` | ComfyUI install directory. Only used for headless start and path derivation. |
| `comfyPython` | `''` | Python executable. Overrides `comfyRoot` derivation; a bare command name (`python3`) is taken from `PATH`. |
| `comfyMain` | `''` | `main.py` of ComfyUI. Overrides derivation. |
| `comfyWorkdir` | `''` | Working directory for the spawned process; defaults to `main.py`'s folder. |
| `comfyArgs` | `[]` | Extra CLI args, e.g. `['--lowvram']`. |
| `autoStart` | `false` | Start ComfyUI headlessly when a tool cannot reach it. Needs the paths above. |
| `startTimeoutMs` | `240000` | How long to wait for a spawned ComfyUI to answer. |
| `timeoutMs` | `900000` | Per-generation timeout. |
| `modelsRoot` | `''` | `ComfyUI/models`. Used for a local "is the file there?" check; `''` derives it from `comfyRoot`. |
| `workflowsDir` | `''` | Folder holding your exported API-format workflows. `''` derives it from `comfyRoot`. |
| `modelMap` | `{}` | `{ 'name-in-json.gguf': 'name-on-disk.gguf' }` — rewrite checkpoint names at load time instead of editing JSON. |
| `outputDir` | `''` | Fixed folder for generated images. When set, images are always written there. |
| `saveToWorkspace` | `true` | Otherwise: save into the session workspace under `workspaceFolder`. |
| `workspaceFolder` | `'draw-mode'` | Folder inside the session workspace (absolute paths are used as-is). |
| `idleShutdown` | *(unset)* | Explicit switch: `false` never shuts down, `true` always uses `idleShutdownMs` (15 min when unset). |
| `idleShutdownMs` | `0` | Idle delay before stopping ComfyUI. `0` = disabled. |
| `idlePollMs` | `30000` | How often the idle check runs. |
| `idleShutdownScope` | `'spawned'` | `spawned` stops only what this plugin started; `port` also stops whatever listens on `comfyBaseUrl`'s port. |
| `settingsPath` | `''` | Where the panel saves. `''` = `~/.dsh/draw-mode/settings.json`. Read from the plugin config only; the settings file cannot move itself. |

All path values accept `~`, `%VAR%`, `${VAR}` and relative paths (resolved against `comfyRoot`).

```yaml
- insert:
    - id: dsh-draw
      name: 'dsh-draw-mode'
      config:
        comfyBaseUrl: 'http://127.0.0.1:8188'
        # --- start ComfyUI ourselves (optional) ---
        comfyRoot: ''            # e.g. 'D:/ComfyUI_windows_portable' or '/opt/ComfyUI'
        comfyPython: ''          # e.g. 'D:/ComfyUI_windows_portable/python_embeded/python.exe'
        comfyMain: ''            # e.g. 'D:/ComfyUI_windows_portable/ComfyUI/main.py'
        comfyWorkdir: ''
        comfyArgs: []
        autoStart: false
        startTimeoutMs: 240000
        timeoutMs: 900000
        # --- models / workflows (optional) ---
        modelsRoot: ''           # e.g. 'D:/ComfyUI_windows_portable/ComfyUI/models'
        workflowsDir: ''         # folder with your exported API-format JSON
        modelMap: {}             # { 'their_model.gguf': 'my_model.gguf' }
        # --- where images land ---
        outputDir: ''            # e.g. '~/Pictures/draw'
        saveToWorkspace: true
        workspaceFolder: 'draw-mode'
        # --- idle shutdown (off by default) ---
        idleShutdownMs: 0
        idlePollMs: 30000
        idleShutdownScope: 'spawned'
```

`draw_status` echoes the resolved values back — which `main.py`/`python` it will spawn, which `workflowsDir` it scanned, which folder images go to, and which model files are missing — so you can verify the configuration without guessing.

### Notes

- The bundle also inserts an agent preset; delete that `insert` block if you only want the tools.
- Prompt style is not fixed by the plugin: it depends on the base model of the workflow you pick. The preset tells the agent to write Danbooru tags for anime checkpoints, natural-language prose for photographic ones, and either for general models.
- The panel does not require ComfyUI to be running: it reports the disconnected state instead of failing.
- A workflow that fails to parse is listed in the panel and in `draw_status`; it does not take the rest of the folder down with it.

## License

MIT
