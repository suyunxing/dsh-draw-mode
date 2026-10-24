# dsh-draw-mode

Links a local **ComfyUI** server into DeepSeek Harness and gives the agent a drawing mode: five `draw_*` tools, a curated workflow library, per-model prompt dialects, and a sidebar panel that shows the bridge state.

## What it does

- **Five tools**
  - `draw_status` — is ComfyUI reachable, what GPU/VRAM does it have, how deep is the queue; optionally start it headlessly.
  - `draw_workflows` — list the installed workflows with their default parameters.
  - `draw_models` — model families, checkpoints, default resolution/steps/CFG/sampler, and the LoRA files available for each family.
  - `draw_generate` — run a workflow: text-to-image, image-to-image, or edit, with LoRA injection and a seed reported back.
  - `draw_reverse` — reverse-engineer an image into a prompt written in the target family's dialect (WD14 tags for anime models, JoyCaption prose for the others).
- **A workflow library** for three families — Anima (anime / Danbooru tags), Krea 2 (photographic prose), Qwen-Image 2.1 (general and instruction editing) — including a hand-fix pass and two reverse-engineering graphs.
- **An agent preset** (`画图`) that wires a persona, the drawing tools and the shell tools together, so a session can be started directly in drawing mode.
- **A sidebar panel** listing the bridge state, the GPU, the workflow library and the latest thumbnails. Its data comes from the host half's read-only HTTP route, same origin as the Web GUI.
- **Optional auto-start / idle shutdown** — both **off by default**: start ComfyUI when a tool needs it, and stop it again after the queue has been idle to release VRAM. Idle shutdown only ends the process this plugin spawned itself; `idleShutdownScope: port` widens it to whatever listens on `comfyBaseUrl`'s port, including a ComfyUI you started by hand.

## Requirements

- A local (or LAN) ComfyUI instance, **v0.37.0 or newer**: the Qwen-Image 2.1 text encoder node (`TextEncodeQwenImage21`) is built in from that release on.
- Node >= 22. No `@deepseek-ai/*` package is imported; the bundle only references host-provided services.
- The checkpoints and custom nodes listed below. The bundled workflows name files **exactly**; a differently named file works after pointing `modelMap` at it (no JSON editing), or after editing the workflow JSON, or after renaming the file to match.

### Checkpoints the bundled workflows load

| Family | File | Folder under `ComfyUI/models/` |
| --- | --- | --- |
| Anima | `SilvermoonMix-Anima29B-Evolved-V2.3-INT8-ConvRot.safetensors` | `unet/` |
| Anima | `qwen_3_06b_base.safetensors` (CLIP type `stable_diffusion`) | `text_encoders/` |
| Anima, Krea 2 | `qwen_image_vae.safetensors` | `vae/` |
| Krea 2 | `Krea-2-Turbo-Q4_K_M.gguf` | `unet/` |
| Krea 2 | `qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors` (CLIP type `krea2`) | `text_encoders/` |
| Qwen-Image 2.1 | `qwen_image_2.1_turbo_Q4_K_M.gguf` | `unet/` |
| Qwen-Image 2.1 | `qwen3vl_8b_w4a8_heretic.safetensors` (CLIP type `qwen_image`) | `text_encoders/` |
| Qwen-Image 2.1 | `qwen_image_2.1_vae_bf16.safetensors` | `vae/` |
| hand-fix pass | `face_yolov9c.pt`, `hand_yolov9c.pt` | `ultralytics/bbox/` |
| reverse, WD14 | `wd-v1-4-moat-tagger-v2` (fetched by the node on first use) | `onnx/` |
| reverse, JoyCaption | `JoyCaption Beta One (IQ4_XS)` GGUF | `LLM/GGUF/` |

Several of these are personal quantisations or abliterated fine-tunes rather than upstream releases: the two `-heretic` text encoders, `SilvermoonMix-Anima29B-Evolved-V2.3-INT8-ConvRot`, and the two Q4_K_M GGUFs. Any equivalent file of the same family works once the workflow JSON points at it, and `draw_models` reports the names the workflows expect.

### Custom nodes the bundled workflows use

| Node | Pack |
| --- | --- |
| `UnetLoaderGGUF` | [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) |
| `BboxDetectorSEGS`, `DetailerForEachDebugPipe`, `ToBasicPipe` | [ltdrdata/ComfyUI-Impact-Pack](https://github.com/ltdrdata/ComfyUI-Impact-Pack) |
| `UltralyticsDetectorProvider` | [ltdrdata/ComfyUI-Impact-Subpack](https://github.com/ltdrdata/ComfyUI-Impact-Subpack) |
| `WD14Tagger\|pysssss` | [pythongosssss/ComfyUI-WD14-Tagger](https://github.com/pythongosssss/ComfyUI-WD14-Tagger) |
| `ShowAnything\|Mie` | [MieMieeeee/ComfyUI-MieNodes](https://github.com/MieMieeeee/ComfyUI-MieNodes) |
| `JC_GGUF_adv` | [1038lab/ComfyUI-JoyCaption](https://github.com/1038lab/ComfyUI-JoyCaption) |

You only need the nodes of the workflows you actually call:

- `anima-t2i` / `anima-i2i` — nothing beyond a stock ComfyUI (`UNETLoader`, `CLIPLoader`, `VAELoader` are built in).
- `krea2-*` / `qwen21-*` — ComfyUI-GGUF, for `UnetLoaderGGUF`.
- `anima-t2i-handfix` — the two Impact packs, for the face/hand detector and the detailer.
- `reverse-wd14` — WD14-Tagger and MieNodes.
- `reverse-joycaption` — JoyCaption and MieNodes.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-draw-mode
```

## Pointing it at your own ComfyUI

Nothing is hard-coded to the author's machine. Every path is a configuration value, and **the plugin needs no local paths at all** when ComfyUI is already running somewhere reachable: images go in through `POST /upload/image` and come back through `GET /view`, so neither the ComfyUI `input/` nor `output/` directory has to be visible to this process.

Three ways to use it, from least to most configuration:

1. **ComfyUI already running** (any host, any port) — set `comfyBaseUrl` and nothing else.
2. **Let the plugin start it** — set `comfyRoot` (or `comfyMain` + `comfyPython`) and `autoStart: true`.
3. **Bring your own models / workflows** — add `modelsRoot`, `workflowsDir` and `modelMap` to check and swap files without editing the bundled JSON.

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
| `workflowsDir` | `''` | Extra workflow library (`manifest.json` + JSON graphs). Same `id` overrides a bundled one. |
| `modelMap` | `{}` | `{ 'bundled-name.gguf': 'my-name.gguf' }` — rewrite checkpoint names at load time instead of editing JSON. |
| `outputDir` | `''` | Fixed folder for generated images. When set, images are always written there. |
| `saveToWorkspace` | `true` | Otherwise: save into the session workspace under `workspaceFolder`. |
| `workspaceFolder` | `'draw-mode'` | Folder inside the session workspace (absolute paths are used as-is). |
| `idleShutdown` | *(unset)* | Explicit switch: `false` never shuts down, `true` always uses `idleShutdownMs` (15 min when unset). |
| `idleShutdownMs` | `0` | Idle delay before stopping ComfyUI. `0` = disabled. |
| `idlePollMs` | `30000` | How often the idle check runs. |
| `idleShutdownScope` | `'spawned'` | `spawned` stops only what this plugin started; `port` also stops whatever listens on `comfyBaseUrl`'s port. |

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
        workflowsDir: ''         # your own manifest.json + workflow JSON
        modelMap: {}             # { 'qwen_image_2.1_turbo_Q4_K_M.gguf': 'my_qwen.gguf' }
        # --- where images land ---
        outputDir: ''            # e.g. '~/Pictures/draw'
        saveToWorkspace: true
        workspaceFolder: 'draw-mode'
        # --- idle shutdown (off by default) ---
        idleShutdownMs: 0
        idlePollMs: 30000
        idleShutdownScope: 'spawned'
```

`draw_status` echoes the resolved values back — which `main.py`/`python` it will spawn, which `modelsRoot` it checks, which folder images go to, and which model files are missing — so you can verify the configuration without guessing.

## Notes

- The bundle also inserts an agent preset; delete that `insert` block if you only want the tools.
- Prompt dialects differ per family and the preset documents the rules — Anima takes Danbooru tags with a fixed quality prefix, Krea 2 and Qwen take natural-language prose.
- The panel does not require ComfyUI to be running: it reports the disconnected state instead of failing.

## 中文

把本机 ComfyUI 接进 DeepSeek Harness，并给 agent 一个「画图模式」：五个 `draw_*` 工具、一套策展好的工作流库、按模型族分化的提示词方言，以及一个显示桥接状态的侧栏面板。

- **五个工具**：`draw_status`（连通性 / GPU 显存 / 队列深度，可无头拉起）、`draw_workflows`（工作流清单与默认参数）、`draw_models`（模型族、检查点、默认参数、可用 LoRA）、`draw_generate`（文生图 / 图生图 / 改图，支持 LoRA 注入并回传 seed）、`draw_reverse`（把图片反推成目标族的提示词：动漫族出 Danbooru 标签，其余出自然语言长句）。
- **工作流库**覆盖三族：Anima（动漫 / Danbooru 标签）、Krea 2（摄影感自然语言）、Qwen-Image 2.1（通用与指令改图），另带手脸修复与两条反推图。
- **Agent 预设**「画图」把人格、绘图工具与 shell 工具串起来，可以直接用画图模式开会话。
- **侧栏面板**显示桥接状态、显卡、工作流库与最近出图缩略图，数据来自 host 半只读 HTTP 路由，与 Web GUI 同源。
- **可选自动启停**（两项都**默认关闭**）：需要时拉起 ComfyUI，队列空闲一段时间后自动关掉释放显存。空闲关闭默认只结束本插件自己拉起的那个进程；把 `idleShutdownScope` 设成 `port` 才会连你手动启动的 ComfyUI 一起关掉。

### 配置你自己的 ComfyUI

插件不预设任何人的本机路径。只要 ComfyUI 已经开着（任何机器、任何端口），**一个路径都不用配**：输入图走 `POST /upload/image` 上传，出图走 `GET /view` 取回，所以本进程不需要能看见 ComfyUI 的 `input/` 和 `output/` 目录。

三种用法，配置量从少到多：

1. **ComfyUI 已经开着**（远程也行）——只配 `comfyBaseUrl`。
2. **让插件自己拉起**——配 `comfyRoot`（或 `comfyMain` + `comfyPython`）并设 `autoStart: true`。
3. **换成你自己的模型 / 工作流**——配 `modelsRoot`、`workflowsDir`、`modelMap`，不用改内置 JSON。

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
| `workflowsDir` | `''` | 额外工作流库（`manifest.json` + JSON）；同 `id` 覆盖内置。 |
| `modelMap` | `{}` | `{ '内置名.gguf': '我的名.gguf' }`，加载时改名，不必改 JSON。 |
| `outputDir` | `''` | 固定出图目录；配了就一定存这里。 |
| `saveToWorkspace` | `true` | 否则存进会话工作区的 `workspaceFolder`。 |
| `workspaceFolder` | `'draw-mode'` | 会话工作区内的子目录。 |
| `idleShutdown` | *(未设)* | 显式开关：`false` 永不关，`true` 按 `idleShutdownMs`（未设时长则 15 分钟）。 |
| `idleShutdownMs` | `0` | 空闲多久后关闭；`0` = 关闭该功能。 |
| `idlePollMs` | `30000` | 空闲检查间隔。 |
| `idleShutdownScope` | `'spawned'` | `spawned` 只关本插件拉起的；`port` 连你手动启动的一起关。 |

所有路径都支持 `~`、`%VAR%`、`${VAR}` 和相对路径（按 `comfyRoot` 解析）。配置对不对不用猜——`draw_status` 会把解析结果回显出来：会 spawn 哪个 `main.py` / `python`、检查哪个 `modelsRoot`、出图存哪、以及还缺哪些模型文件。

依赖见上面的英文清单，要点：ComfyUI 需 **v0.37.0 以上**（Qwen-Image 2.1 的文本编码节点是内置的）；工作流写死了具体文件名，换文件得改工作流 JSON 或把文件改名；自定义节点按族区分——Anima 的文生图只要原版 ComfyUI，Krea 2 / Qwen 需要 ComfyUI-GGUF，手脸修复要两个 Impact 包，两条反推分别要 WD14-Tagger / JoyCaption 加 MieNodes。

## License

MIT