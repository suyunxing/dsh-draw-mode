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
- The checkpoints and custom nodes listed below. The bundled workflows name files **exactly**; a differently named file works only after editing the workflow JSON, or after renaming the file to match.

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
        idleShutdownMs: 0        # >0 enables idle shutdown, e.g. 900000 for 15 min
        idlePollMs: 30000
        idleShutdownScope: 'spawned'  # or 'port' to also stop a ComfyUI you started yourself
```

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

配置项同上，`comfyRoot` 默认留空，只有想用自动启动时才需要填你自己的 ComfyUI 路径；`idleShutdownMs` 默认 0，即不替你结束任何进程。

依赖见上面的英文清单，要点：ComfyUI 需 **v0.37.0 以上**（Qwen-Image 2.1 的文本编码节点是内置的）；工作流写死了具体文件名，换文件得改工作流 JSON 或把文件改名；自定义节点按族区分——Anima 的文生图只要原版 ComfyUI，Krea 2 / Qwen 需要 ComfyUI-GGUF，手脸修复要两个 Impact 包，两条反推分别要 WD14-Tagger / JoyCaption 加 MieNodes。

## License

MIT