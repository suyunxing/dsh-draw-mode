# dsh-draw-mode

Links a local **ComfyUI** server into DeepSeek Harness and gives the agent a drawing mode: five `draw_*` tools, a sidebar panel, and a settings form — all driven by **the workflows you export from ComfyUI yourself**.

The plugin ships **no workflows and no models**. Drop your own `Save (API Format)` JSON files into a folder, point the plugin at that folder, and it auto-discovers what each graph can do.

## What it does

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

## Requirements

- A local (or LAN) ComfyUI instance. Nothing in the plugin depends on a specific ComfyUI version: the workflows you export decide which nodes and models are needed.
- Node >= 22. No `@deepseek-ai/*` package is imported; the bundle only references host-provided services.
- Whatever custom nodes and model files your own workflows use.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-draw-mode
```

## Adding your workflows

1. In ComfyUI, build the graph you want.
2. Click **Save (API Format)** — *not* the plain `Save`. The API format is a flat map of node id → node object; the normal save is a UI graph this plugin cannot run.
3. Put the `.json` file into the workflow directory:
   - `<comfyRoot>/ComfyUI/user/default/workflows` when `comfyRoot` is set, or
   - any folder you set as `workflowsDir` (absolute, `~`, `%VAR%`, `${VAR}` all work).
4. Open the sidebar panel (or call `draw_workflows`) to confirm it was picked up.

Subdirectories are not scanned: keep the JSON files directly in that folder.

### What gets detected

| Slot | How it is found |
| --- | --- |
| `prompt` / `negative` | A text-encode node with a literal `text` input. The node titled `pos`/`neg` wins; otherwise the first two in id order. |
| `seed` | A sampler's literal `seed` or `noise_seed`. |
| `steps`, `cfg`, `denoise` | A sampler's literal inputs of those names. |
| `width`, `height` | A node with literal `width` and `height` (e.g. `EmptyLatentImage`). |
| `image` | `LoadImage.image`; a second `LoadImage` becomes `image2`. |
| `lora` | `LoraLoader.lora_name`, when the graph already has one. |

Only **literal** values are treated as slots — anything wired to another node is left alone, because overwriting it would break the link. If a value is a link and you want it editable, add a literal node in ComfyUI (or override the slot with a sidecar, below).

### Overriding detection: the sidecar file

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

### Model file names

Your exported JSON records the exact checkpoint filenames of the machine it was exported from. If they differ on the machine that runs it, use `modelMap` instead of editing JSON:

```yaml
modelMap:
  'their_model_Q4_K_M.gguf': 'my_model_Q8_0.gguf'
```

The rewrite is applied when the workflow is loaded. `draw_models` shows what is actually installed.

## Pointing it at your ComfyUI

Nothing is hard-coded to any machine. Every path is a configuration value, and **the plugin needs no local paths at all** when ComfyUI is already running somewhere reachable: images go in through `POST /upload/image` and come back through `GET /view`, so neither the ComfyUI `input/` nor `output/` directory has to be visible to this process.

Three ways to use it, from least to most configuration:

1. **ComfyUI already running** (any host, any port) — set `comfyBaseUrl` and nothing else.
2. **Let the plugin start it** — set `comfyRoot` (or `comfyMain` + `comfyPython`) and `autoStart: true`.
3. **Point it at your workflows** — set `workflowsDir`; add `modelsRoot` if you want the offline "is the file there?" check.

### The panel

The sidebar entry **画图** opens a panel with:

- connectivity, GPU name and free/total VRAM, and the idle countdown;
- the resolved configuration as a read-only summary, with an **编辑** button that turns it into a form;
- **测试连接** — re-checks ComfyUI with the current values without saving;
- the workflow directory, the discovered workflows (task, defaults, replaceable inputs) and any file that failed to parse;
- thumbnails of recent output with a lightbox.

Saving writes `~/.dsh/draw-mode/settings.json` and re-reads it immediately: **an empty text field means "no override", so the value falls back to the plugin config**. That is how you revert a single setting without editing YAML.

Checkboxes and numbers cannot be empty, so saving pins whatever the form shows for them. To get everything back to the plugin config in one go, use **清除覆盖** — it deletes the settings file outright.

Precedence: built-in defaults < plugin config (`cordis.patch.yml`) < `settings.json` (the panel).

### Options

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

## Notes

- The bundle also inserts an agent preset; delete that `insert` block if you only want the tools.
- Prompt style is not fixed by the plugin: it depends on the base model of the workflow you pick. The preset tells the agent to write Danbooru tags for anime checkpoints, natural-language prose for photographic ones, and either for general models.
- The panel does not require ComfyUI to be running: it reports the disconnected state instead of failing.
- A workflow that fails to parse is listed in the panel and in `draw_status`; it does not take the rest of the folder down with it.

## 中文

把本机 ComfyUI 接进 DeepSeek Harness，并给 agent 一个「画图模式」：五个 `draw_*` 工具、一个侧栏面板、一个配置表单——全部由**你自己从 ComfyUI 导出的工作流**驱动。

插件**不自带任何工作流与模型**，装好是个空框架：把你自己的 `Save (API Format)` JSON 放进一个目录，告诉插件目录在哪，它就会自动识别每个图能干什么。

- **空框架**：没有内置工作流库，不写死任何检查点，也没有「模型族」清单。你导出什么，agent 就能跑什么。
- **自动识别输入位置**：逐个工作流分析提示词、负向词、宽高、步数、CFG、seed、denoise、输入图、LoRA 分别落在哪个节点哪个输入上。不用改 JSON，不用维护 manifest。
- **五个工具**：`draw_status`（连通性 / GPU 显存 / 当前配置 / 找到几个工作流 / 缺哪些模型，可无头拉起）、`draw_workflows`（工作流清单与默认参数、可传输入）、`draw_models`（从 `/object_info` 读 ComfyUI 实际装了的模型文件）、`draw_generate`（文生图 / 图生图 / 改图，支持 LoRA 注入并回传 seed）、`draw_reverse`（跑反推工作流把图变成文本）。
- **侧栏面板**：连通状态、显卡、工作流目录与清单、最近出图缩略图，以及一个能改所有配置的表单（存到 `~/.dsh/draw-mode/settings.json`，保存即生效，不用重启）。
- **可选自动启停**（两项都**默认关闭**）：需要时拉起 ComfyUI，队列空闲一段时间后自动关掉释放显存。空闲关闭默认只结束本插件自己拉起的那个进程；把 `idleShutdownScope` 设成 `port` 才会连你手动启动的 ComfyUI 一起关掉。

### 怎么加工作流

1. 在 ComfyUI 里搭好图。
2. 点 **Save (API Format)**——不是普通的 Save。API 格式是「节点 id → 节点对象」的扁平结构，普通保存是 UI 图，本插件跑不了。
3. 把 `.json` 放进工作流目录：设了 `comfyRoot` 时默认是 `<comfyRoot>/ComfyUI/user/default/workflows`，或者你把 `workflowsDir` 指到任何目录（绝对路径、`~`、`%VAR%`、`${VAR}` 都行）。
4. 打开侧栏面板（或调 `draw_workflows`）确认已经识别到。

不会递归子目录，JSON 直接放在该目录下。

自动识别规则、以及识别不准时怎么用同目录的 `<同名>.draw.json` 精确指定 slots，见上面英文小节 **What gets detected** / **Overriding detection**。

### 配置说明

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `comfyBaseUrl` | `http://127.0.0.1:8188` | ComfyUI 地址；远程、非默认端口都改这里。 |
| `comfyRoot` | `''` | ComfyUI 安装目录，只用于无头启动和路径推导。 |
| `comfyPython` | `''` | python 可执行文件；只写命令名（如 `python3`）则从 `PATH` 找。 |
| `comfyMain` | `''` | ComfyUI 的 `main.py`。 |
| `comfyWorkdir` | `''` | 启动进程的工作目录，默认 `main.py` 所在目录。 |
| `comfyArgs` | `[]` | 额外命令行参数，如 `['--lowvram']`。 |
| `autoStart` | `false` | 连不上时是否无头拉起。 |
| `modelsRoot` | `''` | `ComfyUI/models`；用于本地检查「工作流要的模型在不在」，留空按 `comfyRoot` 推导。 |
| `workflowsDir` | `''` | 放你导出的 API 格式工作流的目录，留空按 `comfyRoot` 推导。 |
| `modelMap` | `{}` | `{ 'JSON 里的名字': '你本机的名字' }`，加载时改名，不必改 JSON。 |
| `outputDir` | `''` | 固定出图目录；配了就一定存这里。 |
| `saveToWorkspace` | `true` | 否则存进会话工作区的 `workspaceFolder`。 |
| `workspaceFolder` | `'draw-mode'` | 会话工作区内的子目录。 |
| `idleShutdown` | *(未设)* | 显式开关：`false` 永不关，`true` 按 `idleShutdownMs`（未设时长则 15 分钟）。 |
| `idleShutdownMs` | `0` | 空闲多久后关闭；`0` = 关闭该功能。 |
| `idlePollMs` | `30000` | 空闲检查间隔。 |
| `idleShutdownScope` | `'spawned'` | `spawned` 只关本插件拉起的；`port` 连你手动启动的一起关。 |
| `settingsPath` | `''` | 面板保存的位置，`''` = `~/.dsh/draw-mode/settings.json`；只能由插件配置指定，设置文件改不了自己。 |

所有路径都支持 `~`、`%VAR%`、`${VAR}` 和相对路径（按 `comfyRoot` 解析）。

面板保存时**文本框留空表示「这一项不覆盖」**，会回落到插件配置里的值——想撤销某一项改动，把输入框清空保存即可。勾选框和数字框没法留空，保存就会把它们钉成当前显示的值；想把全部设置一次性还原成插件配置，点「清除覆盖」，它会直接删掉设置文件。

优先级：内置默认 < 插件配置（`cordis.patch.yml`）< `settings.json`（面板）。

配置对不对不用猜——`draw_status` 会把解析结果回显出来：会 spawn 哪个 `main.py` / `python`、扫的是哪个 `workflowsDir`、出图存哪、以及还缺哪些模型文件。

## License

MIT
