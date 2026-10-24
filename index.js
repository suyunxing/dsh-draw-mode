/**
 * @local/dsh-draw — 画图模式 Host 插件
 *
 * 把本地 ComfyUI 接进 DSH：工作流自动发现、参数落位、LoRA 注入、无头启动、
 * 出图回传（内联附件）、图片反推。插件本身不带任何工作流与模型，是个空框架：
 * 用户把自己从 ComfyUI 导出的 API 格式工作流放进 workflowsDir 即可。
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/* 面板里保存的配置写在这里；优先级：内置默认 < 插件 patch 里的 config < 这个文件。 */
const DEFAULT_SETTINGS_PATH = path.join(homedir(), '.dsh', 'draw-mode', 'settings.json');

const DEFAULTS = {
	/* ---------------------------------------------------------- 连接 */
	comfyBaseUrl: 'http://127.0.0.1:8188',
	/* ComfyUI 安装目录。只用于「无头启动」和路径推导；连远程/已手动启动的
	   ComfyUI 时留空即可，出图与传图都走 HTTP，不读本机目录。 */
	comfyRoot: '',
	/* 无头启动的三个具体路径。留空则按 comfyRoot 推导常见布局
	   （便携包 python/python.exe + ComfyUI/main.py，源码安装 venv/bin/python），
	   推导不出来再退回 PATH 里的 python。任何一项都能单独覆盖。 */
	comfyPython: '',
	comfyMain: '',
	comfyWorkdir: '',
	/* 额外传给 ComfyUI 的命令行参数，例如 ['--lowvram', '--preview-method', 'auto']。 */
	comfyArgs: [],
	autoStart: false,
	startTimeoutMs: 240000,
	timeoutMs: 900000,

	/* ------------------------------------------------------ 模型 / 工作流 */
	/* 模型根目录，用于「离线检查工作流要的文件在不在」。留空则按 comfyRoot 推导
	   <comfyRoot>/ComfyUI/models。ComfyUI 在线时以它的 /object_info 为准。 */
	modelsRoot: '',
	/* 工作流目录：把 ComfyUI 里「Save (API Format)」导出的 JSON 丢进这里就行。
	   插件不自带任何工作流，装好是空的。留空则按 comfyRoot 推导
	   <comfyRoot>/ComfyUI/user/default/workflows。 */
	workflowsDir: '',
	/* 模型文件名映射：工作流里写的名字 → 你本机的名字。
	   例如 { 'xxx_Q4_K_M.gguf': 'xxx_Q8_0.gguf' } */
	modelMap: {},
	/* 面板保存的配置文件路径。留空 = ~/.dsh/draw-mode/settings.json。
	   这个键只从 patch 配置读，不能由设置文件自己改。 */
	settingsPath: '',

	/* ---------------------------------------------------------- 出图保存 */
	/* 固定保存目录（绝对路径，支持 ~ 与 %VAR%）。设置后优先于 workspaceFolder。 */
	outputDir: '',
	saveToWorkspace: true,
	workspaceFolder: 'draw-mode',
	/* 空闲自动关闭的显式开关：false 强制关闭，true 强制开启（用下面的时长）。
	   不设（默认）则看 idleShutdownMs：>0 才开启。 */
	idleShutdown: undefined,
	/* 空闲多久后关闭（毫秒）。默认 0 = 不开启：不显式配置就不会替你结束任何进程。 */
	idleShutdownMs: 0,
	idlePollMs: 30000,
	/* 空闲关闭的作用范围。'spawned'（默认）只结束本插件自己无头拉起的那个进程；
	   'port' 会结束 comfyBaseUrl 端口上监听的任何进程——包括你手动启动的 ComfyUI
	   和占用同一端口的其他服务，只在独占该端口时才用。 */
	idleShutdownScope: 'spawned',
};

/** 最近一次绘图活动（工具调用 / 队列里有任务）。空闲判定只看这个时间戳。 */
const ACTIVITY = {
	last: Date.now(),
	lastShutdownAt: 0,
	lastStopPids: [],
	/* 最近一次真正落盘的目录，面板据此列图；没有固定 outputDir 时用它兜底。 */
	lastSaveDir: '',
};

/** 本插件自己无头启动的 ComfyUI 进程。 */
const LAST_SPAWN = { pid: undefined };

const MEDIA_EXT = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/webp': '.webp',
	'image/gif': '.gif',
};

/* ------------------------------------------------------------------ 路径 */

/** 展开 ~、%VAR%、${VAR}；相对路径按 base 解析。空值返回空串表示「未配置」。 */
function expandPath(value, base) {
	if (typeof value !== 'string') return '';
	let v = value.trim();
	if (v === '') return '';
	if (v === '~' || v.startsWith('~/') || v.startsWith('~\\')) v = path.join(homedir(), v.slice(1));
	v = v.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
	v = v.replace(/\$\{([^}]+)\}/g, (m, name) => process.env[name] ?? m);
	if (path.isAbsolute(v)) return path.normalize(v);
	return base ? path.resolve(base, v) : path.resolve(v);
}

function configRoot(cfg) {
	return expandPath(cfg?.comfyRoot, process.cwd());
}

/**
 * python 这类「可能是路径、也可能是 PATH 里的命令名」的配置：
 * 像路径就展开，像命令名（python3）就原样保留，别把它拼成绝对路径。
 */
function commandOrPath(value, base) {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (raw === '') return '';
	const looksLikePath = raw.includes('/') || raw.includes('\\') || raw.startsWith('~')
		|| raw.includes('%') || raw.includes('${') || raw === '.' || raw === '..';
	return looksLikePath ? expandPath(raw, base) : raw;
}

/**
 * 无头启动需要的路径。优先级：显式配置 > comfyRoot 下的常见布局 > PATH。
 * 覆盖便携包（python/python.exe + ComfyUI/main.py）、源码安装（venv/bin/python + main.py）、
 * 以及 ComfyUI Desktop 那种直接给 main.py 的情况。
 */
function spawnPaths(cfg) {
	const root = configRoot(cfg);
	const first = (list) => {
		const paths = list.filter(Boolean);
		return paths.find((p) => existsSync(p)) ?? paths[0] ?? '';
	};
	const main = expandPath(cfg.comfyMain, root) || first([
		root && path.join(root, 'ComfyUI', 'main.py'),
		root && path.join(root, 'main.py'),
	]);
	const python = commandOrPath(cfg.comfyPython, root) || first([
		root && path.join(root, 'python', 'python.exe'),
		root && path.join(root, 'python_embeded', 'python.exe'),
		root && path.join(root, 'venv', 'bin', 'python'),
		root && path.join(root, '.venv', 'bin', 'python'),
	]) || (process.platform === 'win32' ? 'python.exe' : 'python3');
	const cwd = expandPath(cfg.comfyWorkdir, root) || (main ? path.dirname(main) : root);
	return { root, main, python, cwd };
}

/** 模型根目录：显式配置优先，否则按 comfyRoot 推导。 */
function modelsRoot(cfg) {
	const root = configRoot(cfg);
	return expandPath(cfg.modelsRoot, root) || (root ? path.join(root, 'ComfyUI', 'models') : '');
}

/** 固定保存目录；未配置返回空串，表示按 workspaceFolder 存进会话工作区。 */
function fixedOutputDir(cfg) {
	return expandPath(cfg.outputDir, configRoot(cfg));
}

/* ------------------------------------------------------------------ HTTP */

async function httpJson(url, options, timeoutMs = 30000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { ...options, signal: controller.signal });
		const text = await res.text();
		let body;
		try { body = text.length > 0 ? JSON.parse(text) : null; } catch { body = text; }
		return { ok: res.ok, status: res.status, body };
	} finally {
		clearTimeout(timer);
	}
}

async function systemStats(cfg) {
	try {
		const res = await httpJson(cfg.comfyBaseUrl.replace(/\/+$/, '') + '/system_stats', { method: 'GET' }, 4000);
		if (!res.ok || !res.body) return null;
		return res.body;
	} catch {
		return null;
	}
}

async function comfyUp(cfg) {
	return (await systemStats(cfg)) !== null;
}

/* --------------------------------------------------------------- 启动 */

function startComfy(cfg) {
	const p = spawnPaths(cfg);
	if (!p.main) {
		throw new Error('没有配置 ComfyUI 的启动路径：请设置 comfyRoot（安装目录）或 comfyMain（main.py 的完整路径）');
	}
	if (!existsSync(p.main)) {
		throw new Error(`找不到 ComfyUI 的 main.py：${p.main}。请检查 comfyRoot / comfyMain 配置`);
	}
	/* python 允许是 PATH 里的命令名（python3），只有像路径时才做存在性检查。 */
	const pathLike = p.python.includes('/') || p.python.includes('\\');
	if (pathLike && !existsSync(p.python)) {
		throw new Error(`找不到 ComfyUI 使用的 python：${p.python}。请检查 comfyRoot / comfyPython 配置`);
	}
	let url;
	try {
		url = new URL(cfg.comfyBaseUrl);
	} catch {
		throw new Error(`comfyBaseUrl 不是合法地址：${cfg.comfyBaseUrl}`);
	}
	const host = url.hostname || '127.0.0.1';
	const port = url.port || '8188';
	const extra = Array.isArray(cfg.comfyArgs) ? cfg.comfyArgs.map(String) : [];
	const child = spawn(p.python, [p.main, '--listen', host, '--port', String(port), '--disable-auto-launch', ...extra], {
		cwd: p.cwd || path.dirname(p.main),
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
	});
	child.unref();
	LAST_SPAWN.pid = child.pid;
	return child.pid;
}

async function ensureComfy(cfg, log) {
	ACTIVITY.last = Date.now();
	const stats = await systemStats(cfg);
	if (stats) return { started: false, stats };
	if (!cfg.autoStart) throw new Error(`ComfyUI 未在 ${cfg.comfyBaseUrl} 上响应，且 autoStart 已关闭（可以手动启动 ComfyUI，或把 comfyBaseUrl 改成实际地址）`);
	const pid = startComfy(cfg);
	if (log) log(`ComfyUI 未运行，已无头启动（pid ${pid}），等待就绪…`);
	const deadline = Date.now() + cfg.startTimeoutMs;
	while (Date.now() < deadline) {
		await sleep(2000);
		const s = await systemStats(cfg);
		if (s) return { started: true, stats: s };
	}
	throw new Error(`ComfyUI 启动超时（${Math.round(cfg.startTimeoutMs / 1000)}s）。请手动检查 comfyRoot/comfyMain 配置，或先用 draw_status 看解析出的路径`);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------- 空闲关闭 */

/** 队列里还有任务吗（运行中或排队中都算忙）。 */
async function comfyBusy(cfg) {
	let body = null;
	try {
		const res = await httpJson(cfg.comfyBaseUrl.replace(/\/+$/, '') + '/queue', { method: 'GET' }, 4000);
		body = res.ok ? res.body : null;
	} catch {
		return false;
	}
	const running = Array.isArray(body?.queue_running) ? body.queue_running.length : 0;
	const pending = Array.isArray(body?.queue_pending) ? body.queue_pending.length : 0;
	return running + pending > 0;
}

/** 端口上处于 LISTENING 的进程 pid 列表。 */
async function listenerPids(port) {
	const out = await new Promise((resolve) => {
		execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (error, stdout) => {
			resolve(error ? '' : String(stdout));
		});
	});
	const pids = new Set();
	for (const line of out.split(/\r?\n/)) {
		if (!line.includes('LISTENING')) continue;
		const cols = line.trim().split(/\s+/);
		const local = cols[1] ?? '';
		if (!local.endsWith(`:${port}`)) continue;
		const pid = Number(cols[cols.length - 1]);
		if (Number.isInteger(pid) && pid > 0) pids.add(pid);
	}
	return [...pids];
}

function killTree(pid) {
	return new Promise((resolve) => {
		if (process.platform === 'win32') {
			execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve(true));
			return;
		}
		try {
			process.kill(pid, 'SIGTERM');
		} catch {
			/* 进程可能已经退出 */
		}
		resolve(true);
	});
}

/** 空闲关闭的作用范围：默认只碰本插件自己拉起的进程。 */
function idleShutdownScope(cfg) {
	return cfg.idleShutdownScope === 'port' ? 'port' : 'spawned';
}

/** 关掉 ComfyUI（连同子进程），并等到端口不再响应。 */
async function stopComfy(cfg, log) {
	const port = new URL(cfg.comfyBaseUrl).port || '8188';
	const scope = idleShutdownScope(cfg);
	const pids = new Set();
	/* 'port' 是破坏性的：端口上任何监听进程都会被算进来，包括不是本插件启动的。 */
	if (scope === 'port') for (const pid of await listenerPids(port)) pids.add(pid);
	if (LAST_SPAWN.pid) pids.add(LAST_SPAWN.pid);
	if (pids.size === 0) {
		log?.(scope === 'port'
			? `空闲关闭：${port} 端口上没有监听进程，无需处理`
			: `空闲关闭：没有本插件启动的 ComfyUI 可关（${port} 端口上的其他进程不动）`);
		ACTIVITY.lastStopPids = [];
		return { stopped: false, pids: [] };
	}
	for (const pid of pids) await killTree(pid);
	LAST_SPAWN.pid = undefined;
	const list = [...pids];
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		await sleep(1000);
		if (!(await comfyUp(cfg))) {
			log?.(`空闲关闭：已终止 ComfyUI（pid ${list.join(', ')}），显存已释放`);
			ACTIVITY.lastStopPids = list;
			return { stopped: true, pids: list };
		}
	}
	const still = await comfyUp(cfg);
	log?.(still ? `空闲关闭：已发终止信号（pid ${list.join(', ')}），但 ComfyUI 仍在响应` : `空闲关闭：已终止 ComfyUI（pid ${list.join(', ')}）`);
	ACTIVITY.lastStopPids = list;
	return { stopped: !still, pids: list };
}

/* --------------------------------------------------------- 工作流库 */

/**
 * 工作流库 = workflowsDir 下所有 *.json。插件本身不带任何工作流：装好是空的，
 * 用户把 ComfyUI 里「Save (API Format)」导出的文件丢进去就行。
 *
 * 输入位置靠启发式检测（detectSlots），不要求用户改工作流。需要更精确的控制时，
 * 可以在同目录放一个 sidecar：<文件名去 .json>.draw.json，形如
 * { "label": "我的出图流", "task": "t2i", "slots": {...}, "defaults": {...}, "notes": "..." }
 */

const TEXT_CLASS = /textencode/i;

function isLiteral(value) {
	return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function nodesWhere(wf, predicate) {
	return Object.entries(wf).filter(([, node]) => node && typeof node === 'object' && predicate(node));
}

/** 从一份 ComfyUI API 格式工作流里猜出可替换的输入位置。 */
function detectSlots(wf) {
	const slots = {};

	/* 正向 / 负向提示词：文本编码节点里写死的字符串 text。
	   先看节点标题里的 pos/neg，没有就按节点 id 顺序取前两个。 */
	const textNodes = nodesWhere(wf, (n) => TEXT_CLASS.test(String(n.class_type ?? '')) && typeof n.inputs?.text === 'string');
	const byTitle = (re) => textNodes.find(([, n]) => re.test(String(n._meta?.title ?? '')))?.[0];
	const positive = byTitle(/pos|正/i) ?? textNodes[0]?.[0];
	const negative = byTitle(/neg|负/i) ?? textNodes.find(([id]) => id !== positive)?.[0];
	if (positive) slots.prompt = { node: positive, input: 'text' };
	if (negative) slots.negative = { node: negative, input: 'text' };

	/* 采样参数：KSampler / KSamplerAdvanced / SamplerCustom。只认写死的字面量，
	   连到别的节点的（link）不动，改了会断开连线。 */
	const sampler = nodesWhere(wf, (n) => /ksampler|sampler/i.test(String(n.class_type ?? '')))[0];
	if (sampler) {
		const [id, node] = sampler;
		const inputs = node.inputs ?? {};
		for (const key of ['seed', 'noise_seed']) {
			if (isLiteral(inputs[key])) {
				slots.seed = { node: id, input: key };
				break;
			}
		}
		for (const key of ['steps', 'cfg', 'denoise']) {
			if (isLiteral(inputs[key])) slots[key] = { node: id, input: key };
		}
	}

	/* 画幅：同时有 width/height 字面量的节点（EmptyLatentImage 一类）。 */
	const latent = nodesWhere(wf, (n) => isLiteral(n.inputs?.width) && isLiteral(n.inputs?.height))[0];
	if (latent) {
		slots.width = { node: latent[0], input: 'width' };
		slots.height = { node: latent[0], input: 'height' };
	}

	/* 输入图：LoadImage 的 image。第一张是 image，第二张是 image2。 */
	const loaders = nodesWhere(wf, (n) => /loadimage/i.test(String(n.class_type ?? '')) && isLiteral(n.inputs?.image));
	if (loaders[0]) slots.image = { node: loaders[0][0], input: 'image' };
	if (loaders[1]) slots.image2 = { node: loaders[1][0], input: 'image' };

	/* LoRA：工作流里已经有 LoraLoader 就直接改它的 lora_name；
	   没有的话 applyLora 会临时插一个。 */
	const loraNode = nodesWhere(wf, (n) => /lora/i.test(String(n.class_type ?? '')) && isLiteral(n.inputs?.lora_name))[0];
	if (loraNode) slots.lora = { node: loraNode[0], input: 'lora_name' };

	return slots;
}

/** 工作流的默认参数 = 检测到的字面量值，让 draw_workflows 能报出来。 */
function detectDefaults(wf, slots) {
	const defaults = {};
	const skip = new Set(['prompt', 'negative', 'image', 'image2', 'lora']);
	for (const [name, slot] of Object.entries(slots)) {
		if (skip.has(name)) continue;
		const value = wf[slot.node]?.inputs?.[slot.input];
		if (isLiteral(value)) defaults[name] = value;
	}
	return defaults;
}

function workflowIdOf(file) {
	return file.replace(/\.json$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-');
}

async function readSidecar(file) {
	try {
		const parsed = JSON.parse(await readFile(file.replace(/\.json$/i, '.draw.json'), 'utf8'));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 扫 workflowsDir，逐个文件解析并检测输入位置。单个文件坏了不影响整库，
 * 只在 errors 里记一条，面板和工具都会显示出来。
 */
async function discoverWorkflows(cfg) {
	const dir = expandPath(cfg?.workflowsDir, configRoot(cfg));
	const workflows = [];
	const errors = [];
	if (!dir) return { dir: '', workflows, errors };
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return { dir, workflows, errors: [{ file: dir, error: '目录不存在或不可读' }] };
	}
	for (const name of names.filter((n) => n.toLowerCase().endsWith('.json') && !/\.draw\.json$/i.test(n)).sort()) {
		const file = path.join(dir, name);
		let wf;
		try {
			wf = JSON.parse(await readFile(file, 'utf8'));
		} catch (error) {
			errors.push({ file: name, error: 'JSON 解析失败：' + (error?.message ?? error) });
			continue;
		}
		if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
			errors.push({ file: name, error: '不是 ComfyUI API 格式（应是节点 id → 节点对象）' });
			continue;
		}
		const sidecar = await readSidecar(file);
		const detected = detectSlots(wf);
		workflows.push({
			id: workflowIdOf(name),
			label: sidecar?.label ?? workflowIdOf(name),
			task: sidecar?.task ?? (detected.image ? 'img2img' : 't2i'),
			file: name,
			dir,
			slots: { ...detected, ...(sidecar?.slots ?? {}) },
			defaults: { ...detectDefaults(wf, detected), ...(sidecar?.defaults ?? {}) },
			notes: sidecar?.notes ?? '',
		});
	}
	return { dir, workflows, errors };
}

/** 把工作流里写死的模型文件名换成用户本机的文件名（modelMap）。 */
function applyModelMap(wf, cfg) {
	const map = cfg?.modelMap;
	if (!map || typeof map !== 'object' || Array.isArray(map)) return;
	const pairs = Object.entries(map).filter(([from, to]) => typeof from === 'string' && from && typeof to === 'string' && to);
	if (pairs.length === 0) return;
	for (const node of Object.values(wf)) {
		if (!node?.inputs) continue;
		for (const [key, value] of Object.entries(node.inputs)) {
			if (typeof value !== 'string') continue;
			const hit = pairs.find(([from]) => from === value);
			if (hit) node.inputs[key] = hit[1];
		}
	}
}

async function loadWorkflow(cfg, entry) {
	const wf = JSON.parse(await readFile(path.join(entry.dir, entry.file), 'utf8'));
	applyModelMap(wf, cfg);
	return wf;
}

/* --------------------------------------------------- 参数落位 / LoRA */

function setSlot(wf, entry, name, value) {
	if (value === undefined || value === null) return false;
	const slot = entry.slots?.[name];
	if (!slot || Array.isArray(slot)) return false;
	const node = wf[slot.node];
	if (!node?.inputs) return false;
	node.inputs[slot.input] = value;
	return true;
}

/**
 * 删掉一个节点，并把所有指向它的输入键一起摘掉。
 * 用于「可选输入」：工作流里那个节点是必填的，但用户没给图时不能留着。
 */
function dropNode(wf, nodeId) {
	const id = String(nodeId);
	for (const node of Object.values(wf)) {
		if (!node?.inputs) continue;
		for (const [key, val] of Object.entries(node.inputs)) {
			if (Array.isArray(val) && String(val[0]) === id) delete node.inputs[key];
		}
	}
	delete wf[id];
}

/**
 * 注入 LoRA。工作流里已经有 LoraLoader 就改它的文件名与强度；没有就临时插一个，
 * 接在「谁产出 model」和「谁消费 model」之间，并把原本直连 CLIP 的输入改接到 LoRA 的 CLIP 输出。
 * 完全通用：不假设任何固定节点 id。
 */
function applyLora(wf, entry, name, strengthModel, strengthClip) {
	if (!name) return false;
	const slot = entry.slots?.lora;
	if (slot) {
		const node = wf[slot.node];
		if (!node?.inputs) return false;
		node.inputs[slot.input] = name;
		node.inputs.strength_model = strengthModel ?? 1;
		node.inputs.strength_clip = strengthClip ?? 1;
		return true;
	}

	const sampler = Object.entries(wf).find(([, n]) => /ksampler|sampler/i.test(String(n?.class_type ?? '')) && Array.isArray(n?.inputs?.model));
	if (!sampler) return false;
	const [samplerId, samplerNode] = sampler;

	/* 找一条现成的 clip 连线：LoRA 节点必须接上它才有效。 */
	let clipLink;
	for (const [id, node] of Object.entries(wf)) {
		if (id === samplerId) continue;
		for (const [key, val] of Object.entries(node?.inputs ?? {})) {
			if (key === 'clip' && Array.isArray(val)) {
				clipLink = val;
				break;
			}
		}
		if (clipLink) break;
	}
	if (!clipLink) return false;

	const id = 'dsh_lora';
	wf[id] = {
		class_type: 'LoraLoader',
		inputs: {
			model: samplerNode.inputs.model,
			clip: clipLink,
			lora_name: name,
			strength_model: strengthModel ?? 1,
			strength_clip: strengthClip ?? 1,
		},
	};
	/* 原本直连那个 CLIP 的地方改接到 LoRA 的 CLIP 输出。必须跳过 LoRA 自己，否则自引用。 */
	for (const [nodeId, node] of Object.entries(wf)) {
		if (nodeId === id) continue;
		for (const [key, val] of Object.entries(node?.inputs ?? {})) {
			if (key === 'clip' && Array.isArray(val) && val[0] === clipLink[0] && val[1] === clipLink[1]) node.inputs[key] = [id, 1];
		}
	}
	samplerNode.inputs.model = [id, 0];
	return true;
}

/* ----------------------------------------------------------- 图片解析 */

function collectImageRefs(content, out) {
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (!block || typeof block !== 'object') continue;
		if (block.type === 'image' && block.attachment?.attachmentId) out.push(block.attachment);
		else if (Array.isArray(block.content)) collectImageRefs(block.content, out);
	}
}

function messagesOf(exec) {
	try {
		const session = exec?.agent?.session;
		if (!session || typeof session.deriveMessages !== 'function') return null;
		const messages = session.deriveMessages();
		return Array.isArray(messages) ? messages : null;
	} catch {
		return null;
	}
}

function digestOf(value) {
	const match = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(String(value).trim());
	return match ? match[1].toLowerCase() : undefined;
}

function findAttachments(exec, spec) {
	const messages = messagesOf(exec);
	if (!messages) return [];
	const wanted = digestOf(spec);
	if (wanted) {
		const found = [];
		for (const message of messages) {
			const refs = [];
			collectImageRefs(message.content, refs);
			for (const ref of refs) if (String(ref.attachmentId).slice(7, 71).toLowerCase() === wanted || String(ref.attachmentId).toLowerCase() === wanted) found.push(ref);
		}
		return found.slice(-1);
	}
	// 默认：最新一条用户消息里的图，否则全对话最新的图
	const humans = messages.filter((m) => m.source?.kind === 'user');
	for (let i = humans.length - 1; i >= 0; i -= 1) {
		const refs = [];
		collectImageRefs(humans[i].content, refs);
		if (refs.length > 0) return refs.slice(0, 1);
	}
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const refs = [];
		collectImageRefs(messages[i].content, refs);
		if (refs.length > 0) return refs.slice(0, 1);
	}
	return [];
}

/** 通过 ComfyUI 的 /upload/image 传图，返回 LoadImage 能用的文件名（可能带 subfolder/）。 */
async function uploadImage(cfg, name, data, type = 'image/png') {
	const base = cfg.comfyBaseUrl.replace(/\/+$/, '');
	const form = new FormData();
	form.append('image', new Blob([data], { type }), name);
	form.append('overwrite', 'true');
	form.append('type', 'input');
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 120000);
	let res;
	try {
		res = await fetch(base + '/upload/image', { method: 'POST', body: form, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
	const text = await res.text();
	if (!res.ok) throw new Error(`上传输入图失败（HTTP ${res.status}）：${text.slice(0, 500)}`);
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`上传输入图返回了非 JSON 内容：${text.slice(0, 300)}`);
	}
	const saved = body?.name ?? name;
	const sub = typeof body?.subfolder === 'string' ? body.subfolder.trim() : '';
	return sub ? `${sub}/${saved}` : saved;
}

/**
 * 把一张图送进 ComfyUI 的 input（走 HTTP 上传，不碰本机目录），返回文件名。
 * spec 可以是本地绝对路径，或附件的 sha256。缺省取对话里最新的图。
 */
async function stageImage(ctx, exec, cfg, spec, fallbackName) {
	if (typeof spec === 'string' && spec.trim().length > 0 && !digestOf(spec) && existsSync(spec)) {
		const data = await readFile(spec);
		const ext = (path.extname(spec) || '.png').toLowerCase();
		const name = `draw_${randomUUID().slice(0, 8)}${ext}`;
		return await uploadImage(cfg, name, data);
	}

	const attachments = ctx.get?.('attachments');
	if (!attachments) throw new Error('当前会话没有 attachments 服务，无法读取对话里的图片；请改用本地文件路径');
	const refs = findAttachments(exec, spec);
	if (refs.length === 0) {
		throw new Error('没有找到可用作输入的图片：对话里没有图片，或给定的 sha256 不匹配。可以改传本地文件绝对路径');
	}
	const stored = await attachments.readImage(refs[0], exec?.signal);
	const ext = MEDIA_EXT[stored.ref.mediaType] ?? '.png';
	const name = `draw_${randomUUID().slice(0, 8)}${ext}`;
	return await uploadImage(cfg, name, Buffer.from(stored.data), stored.ref.mediaType ?? 'image/png');
}

/* --------------------------------------------------------- 提交 / 等待 */

async function submit(cfg, workflow, log) {
	const base = cfg.comfyBaseUrl.replace(/\/+$/, '');
	const res = await httpJson(base + '/prompt', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ prompt: workflow, client_id: 'dsh-draw' }),
	}, 60000);
	if (!res.ok) throw new Error(`ComfyUI 拒绝了该工作流（HTTP ${res.status}）：${typeof res.body === 'string' ? res.body.slice(0, 1500) : JSON.stringify(res.body).slice(0, 1500)}`);
	const promptId = res.body?.prompt_id;
	if (!promptId) throw new Error('ComfyUI 未返回 prompt_id');
	if (log) log(`已入队 ${promptId}`);
	return promptId;
}

async function waitHistory(cfg, promptId, timeoutMs) {
	const base = cfg.comfyBaseUrl.replace(/\/+$/, '');
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await sleep(1500);
		const res = await httpJson(base + '/history/' + promptId, { method: 'GET' }, 20000);
		if (!res.ok || !res.body || typeof res.body !== 'object') continue;
		const entry = res.body[promptId];
		if (!entry) continue;
		const status = entry.status ?? {};
		if (status.status_str === 'success' || status.completed === true) {
			ACTIVITY.last = Date.now();
			return entry;
		}
		if (status.status_str === 'error') {
			const detail = (status.messages ?? []).flat().filter(Boolean)
				.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' | ').slice(0, 1500);
			throw new Error(`ComfyUI 执行失败：${detail || '未知错误'}`);
		}
	}
	throw new Error(`等待 ComfyUI 出图超时（${Math.round(timeoutMs / 1000)}s）`);
}

/* ------------------------------------------------------------ 取产物 */

function joinChars(value) {
	if (typeof value === 'string') return value;
	if (Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length <= 1)) return value.join('');
	if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
	return value === undefined || value === null ? '' : String(value);
}

/** 从 ComfyUI 的 /view 取回产物（不读本机 output 目录，远程 ComfyUI 也能用）。 */
async function collectImages(cfg, entry) {
	const base = cfg.comfyBaseUrl.replace(/\/+$/, '');
	const refs = [];
	for (const output of Object.values(entry.outputs ?? {})) {
		for (const image of output?.images ?? []) {
			if (!image?.filename) continue;
			refs.push({
				filename: image.filename,
				subfolder: image.subfolder ?? '',
				type: image.type ?? 'output',
			});
		}
	}
	const out = [];
	for (const ref of refs) {
		const query = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 120000);
		let res;
		try {
			res = await fetch(`${base}/view?${query}`, { signal: controller.signal });
		} catch (err) {
			clearTimeout(timer);
			throw new Error(`从 ComfyUI 取图失败（${ref.filename}）：${err?.message ?? err}`);
		}
		clearTimeout(timer);
		if (!res.ok) throw new Error(`从 ComfyUI 取图失败（${ref.filename}，HTTP ${res.status}）`);
		const data = Buffer.from(await res.arrayBuffer());
		out.push({ ...ref, data });
	}
	return out;
}

function collectTexts(entry) {
	const texts = [];
	for (const output of Object.values(entry.outputs ?? {})) {
		if (output?.text === undefined) continue;
		const joined = joinChars(output.text).trim();
		if (joined.length > 0) texts.push(joined);
	}
	return texts;
}

function workspaceRoot(exec) {
	try {
		return exec?.agent?.session?.header?.cwd ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * 落盘：固定 outputDir 优先（配了就一定存），否则按 saveToWorkspace 存进会话工作区的
 * workspaceFolder。都没有就只返回 ComfyUI 侧的产物，不写本地。
 */
async function saveOutputs(cfg, exec, images) {
	const fixed = fixedOutputDir(cfg);
	let dir = fixed;
	if (!dir) {
		if (!cfg.saveToWorkspace) return { savedTo: [], savedDir: '' };
		const root = workspaceRoot(exec) ?? process.cwd();
		dir = path.isAbsolute(cfg.workspaceFolder) ? cfg.workspaceFolder : path.join(root, cfg.workspaceFolder);
	}
	await mkdir(dir, { recursive: true });
	const written = [];
	for (const image of images) {
		const target = path.join(dir, image.filename);
		await writeFile(target, image.data);
		written.push(target);
	}
	if (written.length > 0) ACTIVITY.lastSaveDir = dir;
	return { savedTo: written, savedDir: dir };
}

/** 面板列图用的目录：固定 outputDir > 最近一次实际落盘目录。 */
function outputListingDir(cfg) {
	return fixedOutputDir(cfg) || ACTIVITY.lastSaveDir || '';
}

/** 工作流里这些 input key 的值是模型文件名，以及 ComfyUI 会去哪些子目录找它。 */
const MODEL_DIRS = {
	unet_name: ['unet', 'diffusion_models'],
	clip_name: ['text_encoders', 'clip'],
	vae_name: ['vae'],
	lora_name: ['loras'],
	model_name: ['ultralytics'],
};

/**
 * 检查内置工作流要的模型文件在 modelsRoot 下有没有。纯本地检查（不联网），
 * ComfyUI 在线时它的 /object_info 才是准的，这里只用来提前提示缺什么。
 */
async function modelRequirements(manifest, cfg) {
	const root = modelsRoot(cfg);
	const byId = new Map();
	for (const entry of manifest.workflows) {
		let wf;
		try {
			wf = await loadWorkflow(cfg, entry);
		} catch {
			continue;
		}
		for (const node of Object.values(wf)) {
			const inputs = node?.inputs;
			if (!inputs) continue;
			for (const [key, value] of Object.entries(inputs)) {
				const dirs = MODEL_DIRS[key];
				if (!dirs || typeof value !== 'string' || value === '') continue;
				const id = `${key}:${value}`;
				const row = byId.get(id) ?? { key, name: value, dirs, workflows: [] };
				if (!row.workflows.includes(entry.id)) row.workflows.push(entry.id);
				byId.set(id, row);
			}
		}
	}
	const missing = [];
	for (const row of byId.values()) {
		if (!root) {
			missing.push({ ...row, reason: '未配置 modelsRoot，无法检查' });
			continue;
		}
		const candidates = row.dirs.map((dir) => path.join(root, dir, row.name));
		if (!candidates.some((p) => existsSync(p))) missing.push({ ...row, lookedIn: candidates });
	}
	return { modelsRoot: root || undefined, checked: Boolean(root), missing };
}

/* ------------------------------------------------------------- 工具实现 */

function workflowOf(manifest, workflowId) {
	return manifest.workflows.find((w) => w.id === workflowId);
}

/* ----------------------------------------------------------- 设置文件 */

/* 可以由面板修改的键。settingsPath 不在里面：它决定文件在哪，不能由文件自己改。 */
const SETTING_KEYS = [
	'comfyBaseUrl', 'comfyRoot', 'comfyPython', 'comfyMain', 'comfyWorkdir', 'comfyArgs',
	'autoStart', 'startTimeoutMs', 'timeoutMs',
	'modelsRoot', 'workflowsDir', 'modelMap',
	'outputDir', 'saveToWorkspace', 'workspaceFolder',
	'idleShutdown', 'idleShutdownMs', 'idlePollMs', 'idleShutdownScope',
];

function settingsFile(cfg) {
	return expandPath(cfg?.settingsPath, process.cwd()) || DEFAULT_SETTINGS_PATH;
}

function coerceSetting(key, value) {
	switch (key) {
		case 'autoStart':
		case 'saveToWorkspace':
			return Boolean(value);
		case 'idleShutdown':
			return value === undefined || value === null || value === '' ? undefined : Boolean(value);
		case 'idleShutdownMs':
		case 'idlePollMs':
		case 'timeoutMs':
		case 'startTimeoutMs': {
			const num = Number(value);
			return Number.isFinite(num) && num >= 0 ? num : undefined;
		}
		case 'comfyArgs':
			if (Array.isArray(value)) return value.map(String);
			return String(value ?? '').split(/\s+/).filter(Boolean);
		case 'modelMap':
			return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
		case 'idleShutdownScope':
			return value === 'port' ? 'port' : 'spawned';
		default:
			return value === undefined || value === null ? '' : String(value);
	}
}

async function readSettings(cfg) {
	try {
		const parsed = JSON.parse(await readFile(settingsFile(cfg), 'utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		const out = {};
		for (const key of SETTING_KEYS) if (key in parsed) out[key] = coerceSetting(key, parsed[key]);
		return out;
	} catch {
		return {};
	}
}

/**
 * 把面板提交的字段合并进设置文件。空串表示「取消这条覆盖」，回落到 patch 配置。
 * 只写已知键，未知键丢弃，避免把设置文件当成任意 JSON 存储。
 */
async function writeSettings(cfg, patch) {
	const next = { ...(await readSettings(cfg)) };
	for (const key of SETTING_KEYS) {
		if (!(key in patch)) continue;
		const value = coerceSetting(key, patch[key]);
		const empty = value === undefined || value === '' || (key === 'modelMap' && Object.keys(value).length === 0);
		if (empty) delete next[key];
		else next[key] = value;
	}
	const file = settingsFile(cfg);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
	return next;
}

/** 惰性加载一次设置文件（apply 是同步的，读文件只能异步）。 */
function settingsLoader(cfg) {
	let loaded;
	return () => {
		loaded ??= (async () => {
			Object.assign(cfg, await readSettings(cfg));
		})();
		return loaded;
	};
}

/* ----------------------------------------------------------- 配置视图 */

/** 解析后的实际配置，给人看。 */
function configView(cfg) {
	const paths = spawnPaths(cfg);
	const idle = idleSettings(cfg);
	return {
		baseUrl: cfg.comfyBaseUrl,
		comfyRoot: paths.root || '',
		comfyMain: paths.main || '',
		comfyPython: paths.python || '',
		comfyWorkdir: paths.cwd || '',
		comfyArgs: Array.isArray(cfg.comfyArgs) ? cfg.comfyArgs : [],
		autoStart: Boolean(cfg.autoStart),
		modelsRoot: modelsRoot(cfg),
		workflowsDir: expandPath(cfg.workflowsDir, configRoot(cfg)),
		outputDir: outputListingDir(cfg),
		saveToWorkspace: Boolean(cfg.saveToWorkspace),
		workspaceFolder: cfg.workspaceFolder,
		idleShutdown: idle.enabled,
		idleShutdownMs: idle.idleMs,
		idleShutdownScope: idleShutdownScope(cfg),
		timeoutMs: cfg.timeoutMs,
		startTimeoutMs: cfg.startTimeoutMs,
		settingsFile: settingsFile(cfg),
	};
}

/** 面板表单用的原始值：不展开 ~ 和变量，用户填的什么就显示什么。 */
function editableConfig(cfg) {
	const idle = idleSettings(cfg);
	return {
		comfyBaseUrl: cfg.comfyBaseUrl ?? '',
		comfyRoot: cfg.comfyRoot ?? '',
		comfyPython: cfg.comfyPython ?? '',
		comfyMain: cfg.comfyMain ?? '',
		comfyWorkdir: cfg.comfyWorkdir ?? '',
		comfyArgs: Array.isArray(cfg.comfyArgs) ? cfg.comfyArgs.join(' ') : String(cfg.comfyArgs ?? ''),
		autoStart: Boolean(cfg.autoStart),
		modelsRoot: cfg.modelsRoot ?? '',
		workflowsDir: cfg.workflowsDir ?? '',
		outputDir: cfg.outputDir ?? '',
		saveToWorkspace: Boolean(cfg.saveToWorkspace),
		workspaceFolder: cfg.workspaceFolder ?? 'draw-mode',
		idleShutdown: idle.enabled,
		idleMinutes: Math.round((idle.idleMs || 0) / 60000),
		idleShutdownScope: idleShutdownScope(cfg),
		timeoutMs: cfg.timeoutMs,
		startTimeoutMs: cfg.startTimeoutMs,
	};
}

/* ----------------------------------------------------------- 模型清单 */

/**
 * 从 ComfyUI 的 /object_info 读它实际装了什么模型。不写死任何文件名：
 * 用户装了什么就报什么，这是唯一可信的清单。
 */
async function installedModels(cfg) {
	const base = cfg.comfyBaseUrl.replace(/\/+$/, '');
	const res = await httpJson(base + '/object_info', { method: 'GET' }, 60000);
	if (!res.ok) throw new Error('ComfyUI 返回 HTTP ' + res.status);
	const info = res.body ?? {};
	const pick = (nodeClass, key) => {
		const spec = info?.[nodeClass]?.input?.required?.[key] ?? info?.[nodeClass]?.input?.optional?.[key];
		const list = Array.isArray(spec?.[0]) ? spec[0] : undefined;
		return Array.isArray(list) ? list.filter((v) => typeof v === 'string') : [];
	};
	const groups = [
		{ id: 'checkpoints', label: '检查点', items: pick('CheckpointLoaderSimple', 'ckpt_name') },
		{ id: 'diffusion', label: '扩散模型（unet）', items: [...new Set([...pick('UNETLoader', 'unet_name'), ...pick('UnetLoaderGGUF', 'unet_name')])] },
		{ id: 'text_encoders', label: '文本编码器', items: [...new Set([...pick('CLIPLoader', 'clip_name'), ...pick('DualCLIPLoader', 'clip_name1')])] },
		{ id: 'vae', label: 'VAE', items: pick('VAELoader', 'vae_name') },
		{ id: 'loras', label: 'LoRA', items: pick('LoraLoader', 'lora_name') },
	];
	return { online: true, baseUrl: cfg.comfyBaseUrl, groups: groups.filter((g) => g.items.length > 0) };
}

function readJsonBody(req, limit = 1 << 20) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error('请求体过大'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8').trim();
			if (!text) return resolve({});
			try {
				resolve(JSON.parse(text));
			} catch {
				reject(new Error('请求体不是合法 JSON'));
			}
		});
		req.on('error', reject);
	});
}

function numberOr(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function resolveSeed(seed) {
	if (typeof seed === 'number' && Number.isFinite(seed) && seed >= 1) return Math.floor(seed);
	if (typeof seed === 'number' && seed === 0) return 0;
	return Math.floor(Math.random() * 2 ** 31);
}

/* --------------------------------------------------- 面板 HTTP 接口 */

const API_PREFIX = '/draw-mode/api';
const IMAGE_NAME = /^[A-Za-z0-9._-]+\.(?:png|jpg|jpeg|webp|gif)$/;

function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(payload),
	});
	res.end(payload);
}

async function recentImages(cfg) {
	const dir = outputListingDir(cfg);
	if (!dir) return [];
	try {
		const names = await readdir(dir);
		const rows = [];
		for (const name of names) {
			if (!IMAGE_NAME.test(name)) continue;
			try {
				const info = await stat(path.join(dir, name));
				if (!info.isFile()) continue;
				rows.push({ name, size: info.size, mtime: info.mtimeMs });
			} catch { /* skip */ }
		}
		rows.sort((a, b) => b.mtime - a.mtime);
		return rows.slice(0, 24);
	} catch {
		return [];
	}
}

/** 空闲关闭的实际开关与时长：idleShutdown 显式布尔优先，否则看 idleShutdownMs。 */
function idleSettings(cfg) {
	const flag = cfg.idleShutdown;
	if (flag === false) return { enabled: false, idleMs: 0 };
	const raw = Number(cfg.idleShutdownMs);
	const configured = Number.isFinite(raw) && raw > 0;
	if (flag === true) return { enabled: true, idleMs: configured ? raw : 900000 };
	return { enabled: configured, idleMs: configured ? raw : 0 };
}

function idleSnapshot(cfg) {
	const { enabled, idleMs } = idleSettings(cfg);
	const idleFor = Date.now() - ACTIVITY.last;
	return {
		enabled,
		scope: idleShutdownScope(cfg),
		idleMs: enabled ? idleMs : 0,
		idleForMs: idleFor,
		remainingMs: enabled ? Math.max(0, idleMs - idleFor) : 0,
		lastShutdownAt: ACTIVITY.lastShutdownAt || undefined,
		lastStopPids: ACTIVITY.lastStopPids,
	};
}

/* 桌面端（Electron）主窗口对一切弹窗 action: deny，`<a target="_blank">` 点不动，
   所以"打开原图"改成 Host 侧的动作：调系统文件管理器定位文件。 */
function openInFileManager(target) {
	const options = { detached: true, stdio: 'ignore' };
	if (process.platform === 'win32') {
		spawn('explorer.exe', [`/select,${target}`], options).unref();
		return;
	}
	if (process.platform === 'darwin') {
		spawn('open', ['-R', target], options).unref();
		return;
	}
	spawn('xdg-open', [path.dirname(target)], options).unref();
}

function registerPanelRoutes(ctx, cfg, baseCfg, ensureSettings, log) {
	const server = ctx.get('webServer');
	if (!server) return;

	const disposers = [];
	/* 所有 handler 统一兜异常：路由里抛错会让连接悬着，面板只看到转圈。 */
	const guarded = (res, fn) => {
		Promise.resolve()
			.then(fn)
			.catch((error) => writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }));
	};

	/* 状态：面板首屏要的全部东西。 */
	disposers.push(server.register({
		kind: 'exact',
		path: API_PREFIX + '/state',
		handler: async (req, res) => {
			if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
			return guarded(res, async () => {
				await ensureSettings();
				const manifest = await discoverWorkflows(cfg);
				const stats = await systemStats(cfg);
				const device = stats?.devices?.[0];
				writeJson(res, 200, {
					ok: true,
					online: stats !== null,
					baseUrl: cfg.comfyBaseUrl,
					stats: device
						? {
							name: device.name,
							type: device.type,
							vramTotalMb: Math.round((device.vram_total ?? 0) / 1048576),
							vramFreeMb: Math.round((device.vram_free ?? 0) / 1048576),
						}
						: null,
					workflows: manifest.workflows.map((w) => ({
						id: w.id,
						label: w.label,
						task: w.task,
						defaults: w.defaults,
						inputs: Object.keys(w.slots ?? {}),
						notes: w.notes ?? '',
					})),
					workflowErrors: manifest.errors,
					workflowsDir: manifest.dir,
					recent: await recentImages(cfg),
					idle: idleSnapshot(cfg),
					config: configView(cfg),
					editable: editableConfig(cfg),
					settingsFile: settingsFile(cfg),
				});
			});
		},
	}));

	/* 配置：GET 读当前值（表单用），POST 保存并立刻生效。 */
	disposers.push(server.register({
		kind: 'exact',
		path: API_PREFIX + '/config',
		handler: async (req, res) => {
			if (req.method === 'GET') {
				return guarded(res, async () => {
					await ensureSettings();
					writeJson(res, 200, { ok: true, editable: editableConfig(cfg), config: configView(cfg), settingsFile: settingsFile(cfg) });
				});
			}
			if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
			return guarded(res, async () => {
				const patch = await readJsonBody(req);
				await writeSettings(cfg, patch ?? {});
				/* 重新算一遍：设置文件里没有的键要回落到 patch 配置，不能留着上一次的值。 */
				Object.assign(cfg, baseCfg, await readSettings(cfg));
				log('配置已更新：' + settingsFile(cfg));
				writeJson(res, 200, { ok: true, editable: editableConfig(cfg), config: configView(cfg), settingsFile: settingsFile(cfg) });
			});
		},
	}));

	/* 连通性测试：不落盘，只回报当前配置能不能连上 ComfyUI。 */
	disposers.push(server.register({
		kind: 'exact',
		path: API_PREFIX + '/test',
		handler: async (req, res) => {
			if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
			return guarded(res, async () => {
				await ensureSettings();
				const manifest = await discoverWorkflows(cfg);
				const stats = await systemStats(cfg);
				const device = stats?.devices?.[0];
				writeJson(res, 200, {
					ok: true,
					online: stats !== null,
					baseUrl: cfg.comfyBaseUrl,
					device: device?.name ?? null,
					vramFreeMb: device ? Math.round((device.vram_free ?? 0) / 1048576) : null,
					workflowsDir: manifest.dir,
					workflows: manifest.workflows.length,
					workflowErrors: manifest.errors,
					settingsFile: settingsFile(cfg),
					error: stats === null ? '连不上 ' + cfg.comfyBaseUrl : undefined,
				});
			});
		},
	}));

	disposers.push(server.register({
		kind: 'exact',
		path: API_PREFIX + '/start',
		handler: async (req, res) => {
			if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
			return guarded(res, async () => {
				await ensureSettings();
				const result = await ensureComfy(cfg, log ?? (() => {}));
				writeJson(res, 200, { ok: true, started: result.started });
			});
		},
	}));

	disposers.push(server.register({
		kind: 'exact',
		path: API_PREFIX + '/image',
		handler: async (req, res) => {
			if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
			let name;
			try {
				name = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('name') ?? '';
			} catch {
				name = '';
			}
			if (!IMAGE_NAME.test(name)) return writeJson(res, 400, { ok: false, error: 'bad-name' });
			return guarded(res, async () => {
				await ensureSettings();
				const dir = outputListingDir(cfg);
				if (!dir) return writeJson(res, 404, { ok: false, error: 'no-output-dir' });
				const data = await readFile(path.join(dir, name));
				const ext = path.extname(name).toLowerCase();
				const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
					: ext === '.webp' ? 'image/webp'
						: ext === '.gif' ? 'image/gif'
							: 'image/png';
				res.writeHead(200, {
					'content-type': type,
					'cache-control': 'private, max-age=31536000, immutable',
					'content-length': data.length,
				});
				res.end(data);
			});
		},
	}));

	disposers.push(server.register({
		kind: 'exact',
		path: API_PREFIX + '/reveal',
		handler: async (req, res) => {
			if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
			let name = '';
			try {
				name = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('name') ?? '';
			} catch {
				name = '';
			}
			if (!IMAGE_NAME.test(name)) return writeJson(res, 400, { ok: false, error: 'bad-name' });
			return guarded(res, async () => {
				await ensureSettings();
				const dir = outputListingDir(cfg);
				if (!dir) return writeJson(res, 404, { ok: false, error: 'no-output-dir' });
				const target = path.join(dir, name);
				if (!existsSync(target)) return writeJson(res, 404, { ok: false, error: 'not-found' });
				openInFileManager(target);
				writeJson(res, 200, { ok: true, path: target });
			});
		},
	}));

	return () => disposers.splice(0).forEach((dispose) => dispose());
}

export const inject = ['tools'];

export function apply(ctx, config) {
	/* cfg 可变：面板保存后直接 Object.assign，工具下次调用就读到新值。
	   baseCfg 是 patch 配置的快照，面板清空某项时回落到这里。 */
	const baseCfg = { ...DEFAULTS, ...(config ?? {}) };
	const cfg = { ...baseCfg };
	const ensureSettings = settingsLoader(cfg);
	const logs = [];

	const log = (line) => logs.push('[' + new Date().toISOString() + '] ' + line);

	/* 面板路由挂在 web app 的 webServer 上，headless 部署根本不组装它。
	   必须用 ctx.inject 跟随服务：apply 时直接 ctx.get('webServer') 只是「读一次」，
	   webServer 还没起来就拿到 undefined，registerPanelRoutes 静默 return，
	   一条路由都没注册，面板取 /draw-mode/api/state 落到静态兜底 → 接口异常：HTTP 404。 */
	ctx.inject(['webServer'], (webCtx) => {
		webCtx.effect(() => registerPanelRoutes(webCtx, cfg, baseCfg, ensureSettings, log));
	});

	/* ------------------------------------------------------ 空闲自动关闭 */

	ctx.effect(() => {
		const pollMs = Math.max(5000, Math.min(120000, Number(cfg.idlePollMs) || 30000));
		let stopping = false;

		const tick = async () => {
			if (stopping) return;
			/* 每轮都重读设置：面板里改了开关或时长要立刻生效，不用重启。 */
			await ensureSettings();
			const { enabled, idleMs } = idleSettings(cfg);
			if (!enabled || idleMs <= 0) return;
			if (!(await comfyUp(cfg))) {
				/* 没在跑就不用管，把计时推到现在，避免下次启动后立刻误杀 */
				ACTIVITY.last = Date.now();
				return;
			}
			if (await comfyBusy(cfg)) {
				/* 正在采样或排队，算活跃 */
				ACTIVITY.last = Date.now();
				return;
			}
			const idleFor = Date.now() - ACTIVITY.last;
			if (idleFor < idleMs) return;
			stopping = true;
			try {
				log('空闲 ' + Math.round(idleFor / 60000) + ' 分钟（阈值 ' + Math.round(idleMs / 60000) + ' 分钟），关闭 ComfyUI 释放显存与内存');
				await stopComfy(cfg, log);
				ACTIVITY.lastShutdownAt = Date.now();
			} finally {
				ACTIVITY.last = Date.now();
				stopping = false;
			}
		};

		const timer = setInterval(() => {
			tick().catch((error) => log('空闲关闭检查失败：' + (error?.message ?? error)));
		}, pollMs);
		timer.unref?.();
		return () => clearInterval(timer);
	});

	/* ---------------------------------------------------------- draw_status */

	/* ---------------------------------------------------------- draw_status */

	ctx.effect(() => ctx.tools.register({
		name: 'draw_status',
		description: 'Check whether the local ComfyUI server is reachable, and start it headlessly when it is not. Use this first in a drawing session, or when a draw_* call reports a connection error. Returns GPU/VRAM info, the resolved configuration, and how many workflows were found in workflowsDir.',
		parameters: {
			type: 'object',
			properties: {
				start: { type: 'boolean', description: 'Start ComfyUI if it is not running. Defaults to the configured autoStart value.' },
			},
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => {
				const c = value.config ?? {};
				const head = value.running
					? 'ComfyUI 在线：' + value.baseUrl + '（' + (value.device ?? '未知设备') + '，显存 ' + (value.vramFreeMb ?? '?') + ' / ' + (value.vramTotalMb ?? '?') + ' MB 空闲），工作流目录里有 ' + value.workflows + ' 个。' + (value.started ? ' 本次由插件自动启动。' : '')
					: 'ComfyUI 不在线：' + (value.error ?? value.baseUrl);
				const lines = [head];
				lines.push('配置：工作流目录=' + (c.workflowsDir || '（未配置）') + '；出图目录=' + (c.outputDir || (c.saveToWorkspace ? '会话工作区/' + c.workspaceFolder : '（不保存）')) + '；模型目录=' + (c.modelsRoot || '（未配置）'));
				lines.push('无头启动：' + (c.autoStart ? '开启' : '关闭') + (c.comfyMain ? '，main.py=' + c.comfyMain : '') + (c.comfyPython ? '，python=' + c.comfyPython : ''));
				lines.push(c.idleShutdown
					? '空闲关闭：' + Math.round((c.idleShutdownMs ?? 0) / 60000) + ' 分钟后关闭' + (c.idleShutdownScope === 'port' ? '（含端口上其他进程）' : '（仅本插件启动的进程）')
					: '空闲关闭：关闭');
				lines.push('设置文件：' + c.settingsFile + '（侧栏面板可直接改）');
				if (!value.workflows) {
					lines.push('工作流目录是空的：把 ComfyUI 里「Save (API Format)」导出的 JSON 放进去，或用侧栏面板改路径。');
				}
				const errors = value.workflowErrors ?? [];
				if (errors.length > 0) {
					lines.push('');
					lines.push('有 ' + errors.length + ' 个文件读不了：');
					for (const e of errors) lines.push('· ' + e.file + ' — ' + e.error);
				}
				const missing = value.requirements?.missing ?? [];
				if (missing.length > 0) {
					lines.push('');
					lines.push('缺 ' + missing.length + ' 个模型文件（' + (value.requirements.checked ? '在 modelsRoot 下没找到' : 'modelsRoot 未配置') + '）：');
					for (const m of missing) lines.push('· ' + m.key + ' ' + m.name + ' ← ' + m.workflows.join(', '));
				}
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		timeoutMs: 300000,
		isConcurrencySafe: () => false,
		execute: async (args) => {
			await ensureSettings();
			const manifest = await discoverWorkflows(cfg);
			let stats = await systemStats(cfg);
			let started = false;
			if (!stats && (args?.start ?? cfg.autoStart)) {
				const ensured = await ensureComfy(cfg, log);
				stats = ensured.stats;
				started = ensured.started;
			}
			const requirements = await modelRequirements(manifest, cfg);
			const config = configView(cfg);
			if (!stats) {
				return {
					running: false,
					baseUrl: cfg.comfyBaseUrl,
					workflows: manifest.workflows.length,
					workflowErrors: manifest.errors,
					config,
					requirements,
					error: '连接失败，且未开启自动启动',
					logs,
				};
			}
			const device = stats.devices?.[0];
			return {
				running: true,
				baseUrl: cfg.comfyBaseUrl,
				started,
				device: device?.name,
				vramTotalMb: device ? Math.round(device.vram_total / 1048576) : undefined,
				vramFreeMb: device ? Math.round(device.vram_free / 1048576) : undefined,
				workflows: manifest.workflows.length,
				workflowErrors: manifest.errors,
				config,
				requirements,
				logs,
			};
		},
	}));

	/* ------------------------------------------------------- draw_workflows */

	ctx.effect(() => ctx.tools.register({
		name: 'draw_workflows',
		description: 'List the workflows found in the configured workflowsDir (id, label, task, default parameters, which inputs are replaceable) so a matching one can be chosen before draw_generate or draw_reverse. Workflows are whatever ComfyUI API-format JSON files the user put there; the plugin bundles none.',
		parameters: {
			type: 'object',
			properties: {
				task: { type: 'string', enum: ['t2i', 'img2img', 'edit', 'reverse'], description: 'Only return workflows of this task type.' },
			},
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => {
				if (value.workflows.length === 0) {
					const text = value.dir
						? '工作流目录里没有可用的 JSON：' + value.dir + '\n把 ComfyUI 里「Save (API Format)」导出的工作流放进这个目录，或用侧栏面板改路径。'
						: '还没配置工作流目录（workflowsDir）。用侧栏面板填上，或在插件配置里设置。';
					return [{ type: 'text', text }];
				}
				const lines = value.workflows.map((w) => {
					const params = Object.entries(w.defaults ?? {}).map(([k, v]) => k + '=' + v).join(' ');
					const inputs = w.inputs?.length ? '；可传：' + w.inputs.join(', ') : '';
					return w.id + ' — ' + w.label + '［' + w.task + '］' + (params ? ' · ' + params : '') + inputs + (w.notes ? ' · ' + w.notes : '');
				});
				if (value.errors?.length) {
					lines.push('');
					lines.push('读不了的文件：' + value.errors.map((e) => e.file + '（' + e.error + '）').join('；'));
				}
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		isConcurrencySafe: () => true,
		execute: async (args) => {
			await ensureSettings();
			const manifest = await discoverWorkflows(cfg);
			const workflows = manifest.workflows
				.filter((w) => !args?.task || w.task === args.task)
				.map((w) => ({
					id: w.id,
					label: w.label,
					task: w.task,
					defaults: w.defaults,
					inputs: Object.keys(w.slots ?? {}),
					notes: w.notes,
				}));
			return { dir: manifest.dir, workflows, errors: manifest.errors };
		},
	}));

	/* ---------------------------------------------------------- draw_models */

	ctx.effect(() => ctx.tools.register({
		name: 'draw_models',
		description: 'List the model files the running ComfyUI actually has installed (checkpoints, diffusion models, text encoders, VAEs, LoRAs), read from its /object_info. Use it to pick a real file name for a workflow input or for the lora argument of draw_generate. Nothing is hard-coded: whatever ComfyUI reports is what you get.',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => {
				if (!value.online) return [{ type: 'text', text: 'ComfyUI 不在线，读不到模型清单：' + (value.error ?? value.baseUrl) }];
				if (!value.groups?.length) return [{ type: 'text', text: 'ComfyUI 在线，但没有装任何模型文件。' }];
				const lines = ['ComfyUI 里的模型（' + value.baseUrl + '）：'];
				for (const g of value.groups) {
					lines.push('');
					lines.push(g.label + '（' + g.items.length + '）');
					for (const item of g.items) lines.push('· ' + item);
				}
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		timeoutMs: 120000,
		isConcurrencySafe: () => true,
		execute: async () => {
			await ensureSettings();
			try {
				return await installedModels(cfg);
			} catch (error) {
				return { online: false, baseUrl: cfg.comfyBaseUrl, groups: [], error: error?.message ?? String(error) };
			}
		},
	}));

	/* -------------------------------------------------------- draw_generate */

	ctx.effect(() => ctx.tools.register({
		name: 'draw_generate',
		description: 'Generate or edit an image by running one of the workflows in workflowsDir through the local ComfyUI. Pick a workflow id from draw_workflows; the inputs that workflow exposes (prompt, negative, width, height, steps, cfg, seed, denoise, lora, image) are filled in, everything else stays as saved in the workflow. Image inputs default to the newest image in the conversation. The generated image is attached to the conversation and returned inline.',
		parameters: {
			type: 'object',
			properties: {
				workflow: { type: 'string', description: 'Workflow id from draw_workflows.' },
				prompt: { type: 'string', description: 'The finished positive prompt.' },
				negative: { type: 'string', description: 'Negative prompt, for workflows that expose one.' },
				width: { type: 'integer', description: 'Output width in pixels. Defaults to the workflow value.' },
				height: { type: 'integer', description: 'Output height in pixels. Defaults to the workflow value.' },
				steps: { type: 'integer', description: 'Sampling steps. Defaults to the workflow value.' },
				cfg: { type: 'number', description: 'CFG scale. Defaults to the workflow value.' },
				denoise: { type: 'number', description: 'Denoise strength, for img2img workflows.' },
				seed: { type: 'integer', description: 'Seed. Omit for a random one; the used seed is reported back.' },
				lora: { type: 'string', description: 'Exact LoRA file name from draw_models, applied on top of the base model.' },
				loraStrength: { type: 'number', description: 'LoRA strength for both model and clip. Defaults to 1.' },
				image: { type: 'string', description: 'Input image for img2img/edit: a local absolute file path, or an attachment sha256 id. Defaults to the newest image in the conversation.' },
				image2: { type: 'string', description: 'Second input image, for workflows with two image inputs.' },
				filenamePrefix: { type: 'string', description: 'ComfyUI output filename prefix, usually left unset.' },
			},
			required: ['workflow', 'prompt'],
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => {
				const images = value.images ?? [];
				const blocks = [{
					type: 'text',
					text: value.workflow + '（' + value.label + '）出图 ' + images.length + ' 张 · ' + value.width + 'x' + value.height + ' · ' + value.steps + ' 步 · cfg ' + value.cfg + ' · seed ' + value.seed + ' · ' + value.elapsedMs + 'ms'
						+ (value.lora ? ' · LoRA ' + value.lora : '')
						+ (value.savedTo?.length ? ' · 已存 ' + value.savedTo.join(', ') : '')
						+ '。图片已附加到对话。',
				}];
				for (const image of images) blocks.push({ type: 'image', attachment: image.attachment });
				return blocks;
			},
		},
		timeoutMs: 900000,
		isConcurrencySafe: () => false,
		execute: async (args, exec) => {
			await ensureSettings();
			const started = Date.now();
			const manifest = await discoverWorkflows(cfg);
			const entry = workflowOf(manifest, String(args.workflow));
			if (!entry) {
				const known = manifest.workflows.map((w) => w.id).join(', ') || '（工作流目录是空的）';
				throw new Error('没有这个工作流：' + args.workflow + '。可用：' + known);
			}

			await ensureComfy(cfg, log);
			const workflow = await loadWorkflow(cfg, entry);

			const defaults = entry.defaults ?? {};
			const seed = resolveSeed(args.seed);
			const steps = numberOr(args.steps, defaults.steps);
			const cfgScale = numberOr(args.cfg, defaults.cfg);
			const denoise = numberOr(args.denoise, defaults.denoise);
			const width = numberOr(args.width, defaults.width);
			const height = numberOr(args.height, defaults.height);

			setSlot(workflow, entry, 'prompt', args.prompt);
			if (args.negative !== undefined) setSlot(workflow, entry, 'negative', args.negative);
			setSlot(workflow, entry, 'width', width);
			setSlot(workflow, entry, 'height', height);
			setSlot(workflow, entry, 'steps', steps);
			setSlot(workflow, entry, 'cfg', cfgScale);
			setSlot(workflow, entry, 'denoise', denoise);
			setSlot(workflow, entry, 'seed', seed);

			let loraApplied = false;
			if (args.lora) {
				loraApplied = applyLora(workflow, entry, String(args.lora), numberOr(args.loraStrength, 1), numberOr(args.loraStrength, 1));
				if (!loraApplied) throw new Error('这个工作流里没有可挂 LoRA 的位置（找不到 LoraLoader，也找不到采样器的 model 与 clip 连线）');
			}

			if (entry.slots?.image) {
				const staged = await stageImage(ctx, exec, cfg, args.image);
				const slot = entry.slots.image;
				workflow[slot.node].inputs[slot.input] = staged;
			}
			if (entry.slots?.image2) {
				if (args.image2 !== undefined) {
					const staged2 = await stageImage(ctx, exec, cfg, args.image2);
					const slot = entry.slots.image2;
					workflow[slot.node].inputs[slot.input] = staged2;
				} else {
					dropNode(workflow, entry.slots.image2.node);
				}
			}
			if (args.filenamePrefix) {
				for (const node of Object.values(workflow)) {
					if (node?.class_type === 'SaveImage') node.inputs.filename_prefix = String(args.filenamePrefix);
				}
			}

			const promptId = await submit(cfg, workflow, log);
			const historyEntry = await waitHistory(cfg, promptId, cfg.timeoutMs);
			const raw = await collectImages(cfg, historyEntry);
			if (raw.length === 0) throw new Error('ComfyUI 执行完成但没有产出图片');

			const attachments = ctx.get?.('attachments');
			if (!attachments) throw new Error('当前会话没有 attachments 服务，无法把图片附加到对话');
			const images = [];
			for (const file of raw) {
				const mediaType = file.filename.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/png';
				const attachment = await attachments.saveImage({ data: file.data, mediaType, name: file.filename });
				images.push({ attachment, filename: file.filename });
			}
			const saved = await saveOutputs(cfg, exec, raw);

			return {
				workflow: entry.id,
				label: entry.label,
				images,
				width,
				height,
				steps,
				cfg: cfgScale,
				seed,
				denoise,
				...(loraApplied ? { lora: String(args.lora) } : {}),
				promptId,
				elapsedMs: Date.now() - started,
				...(saved.savedTo?.length ? { savedTo: saved.savedTo, savedDir: saved.savedDir } : {}),
				logs,
			};
		},
	}));

	/* --------------------------------------------------------- draw_reverse */

	ctx.effect(() => ctx.tools.register({
		name: 'draw_reverse',
		description: 'Run a reverse workflow (a tagger or captioner such as WD14 or JoyCaption that outputs text) on an image and return the text. The workflow must already exist in workflowsDir and have an image input; draw_workflows shows which ones do. Reads the newest image in the conversation by default. Does not generate an image.',
		parameters: {
			type: 'object',
			properties: {
				workflow: { type: 'string', description: 'Workflow id of the reverse workflow. Optional when exactly one workflow in workflowsDir has an image input.' },
				image: { type: 'string', description: 'Local absolute file path or attachment sha256. Defaults to the newest image in the conversation.' },
			},
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{
				type: 'text',
				text: '反推完成（' + value.workflow + '，' + value.elapsedMs + 'ms）：\n\n' + value.prompt,
			}],
		},
		timeoutMs: 900000,
		isConcurrencySafe: () => false,
		execute: async (args, exec) => {
			await ensureSettings();
			const started = Date.now();
			const manifest = await discoverWorkflows(cfg);
			const candidates = manifest.workflows.filter((w) => w.slots?.image);
			const id = args?.workflow ?? (candidates.length === 1 ? candidates[0].id : undefined);
			if (!id) {
				throw new Error(candidates.length === 0
					? '工作流目录里没有带图片输入的工作流'
					: '有多个候选，请指定 workflow：' + candidates.map((w) => w.id).join(', '));
			}
			const entry = workflowOf(manifest, String(id));
			if (!entry) throw new Error('没有这个工作流：' + id);
			if (!entry.slots?.image) throw new Error('工作流 ' + id + ' 没有图片输入，不能用来反推');

			await ensureComfy(cfg, log);
			const workflow = await loadWorkflow(cfg, entry);
			const staged = await stageImage(ctx, exec, cfg, args.image);
			workflow[entry.slots.image.node].inputs[entry.slots.image.input] = staged;
			/* 反推只喂一张图：第二个 LoadImage 留着会去要一个不存在的占位图，直接摘掉。 */
			if (entry.slots.image2) dropNode(workflow, entry.slots.image2.node);

			const promptId = await submit(cfg, workflow, log);
			const historyEntry = await waitHistory(cfg, promptId, cfg.timeoutMs);
			const prompt = collectTexts(historyEntry).join('\n').trim();
			if (!prompt) throw new Error('反推工作流跑完了但没读到文本输出：这个工作流可能只输出图片，或者文本没接到能回传的输出节点');

			return {
				workflow: entry.id,
				prompt,
				elapsedMs: Date.now() - started,
				promptId,
				logs,
			};
		},
	}));
}
