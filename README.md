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
- **Optional auto-start / idle shutdown**: start ComfyUI when a tool needs it and stop it again after the queue has been idle, releasing VRAM — but only the instance the plugin started itself; a ComfyUI you launched by hand is never touched.

## Requirements

- A local (or LAN) ComfyUI instance with the models you intend to use.
- Node >= 22. No `@deepseek-ai/*` package is imported; the bundle only references host-provided services.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-draw-mode
```

## Configuration

Set these in your profile's `cordis.patch.yml`. **`comfyRoot` ships empty on purpose** — point it at your own ComfyUI installation if you want auto-start:

```yaml
- insert:
    - id: dsh-draw
      name: 'dsh-draw-mode'
      config:
        comfyBaseUrl: 'http://127.0.0.1:8188'
        comfyRoot: ''            # e.g. 'D:/ComfyUI' — needed only for autoStart
        autoStart: false         # start ComfyUI on demand
        startTimeoutMs: 240000
        timeoutMs: 900000        # per-generation timeout
        saveToWorkspace: true
        workspaceFolder: 'draw-mode'
        idleShutdownMs: 900000   # 0 disables idle shutdown
        idlePollMs: 30000
```

### Which ComfyUI gets stopped

Idle shutdown only ever touches the instance this plugin started itself. Every headless start is written to a small state file — `%LOCALAPPDATA%\dsh-draw-mode\owned-comfy.json` on Windows, `$DSH_HOME/storages/dsh-draw-mode/owned-comfy.json` when `DSH_HOME` is set, `$XDG_STATE_HOME/dsh-draw-mode/owned-comfy.json` elsewhere — and the record survives a harness restart.

Before anything is killed, the pid is re-checked: it must still be alive, still be a `python*.exe` process, still run that exact `main.py`, and its creation time must be within two minutes of the recorded start. A recycled pid therefore fails the check instead of being killed. A listener on `comfyBaseUrl` that fails it — the instance you started by hand — is never touched; the idle loop logs one line and keeps going. If the process table cannot be read at all, nothing is killed.

Upgrade note: an instance started by an older build carries no record, so it is treated as foreign and stays up. Close that one by hand once.

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
- **可选自动启停**：需要时拉起 ComfyUI，队列空闲一段时间后自动关掉释放显存——但只关插件自己拉起的那个实例，你手动打开的 ComfyUI 不会被碰。
- **关哪个实例有据可查**：每次无头启动都记下 pid、启动时间、端口、安装目录与 ¤main.py¤ 路径（Windows 存在 ¤%LOCALAPPDATA%\dsh-draw-mode\owned-comfy.json¤，设了 ¤DSH_HOME¤ 则存 ¤$DSH_HOME/storages/dsh-draw-mode/owned-comfy.json¤），重启 harness 也不丢。关之前逐个复核：pid 还活着、还是 python 进程、命令行还是那个 ¤main.py¤、创建时间对得上；pid 被复用就只清记录不杀进程。端口上对不上的一律按外部实例放过，只记一行日志。拿不到进程表时宁可不关，也不猜。升级说明：旧版本拉起的实例没有记录，会被当成外部实例留着，需要手动关一次。

配置项同上，`comfyRoot` 默认留空，只有想用自动启动时才需要填你自己的 ComfyUI 路径。

## License

MIT