/**
 * @local/dsh-draw — 画图模式 Host 插件
 *
 * 把本地 ComfyUI 接进 DSH：工作流库路由、参数落位、LoRA 注入、无头启动、
 * 出图回传（内联附件）、按目标模型反推提示词。
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF_DIR = path.join(HERE, 'workflows');

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
	/* 额外的工作流目录（放自己的 manifest.json + 工作流 JSON），与内置库合并；
	   同 id 覆盖内置。 */
	workflowsDir: '',
	/* 模型文件名映射：内置工作流写死的名字 → 你本机的名字。
	   例如 { 'qwen_image_2.1_turbo_Q4_K_M.gguf': 'qwen_image_2.1_turbo_Q8_0.gguf' } */
	modelMap: {},

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

async function readManifestAt(dir) {
	try {
		const raw = await readFile(path.join(dir, 'manifest.json'), 'utf8');
		const parsed = JSON.parse(raw);
		return parsed && Array.isArray(parsed.workflows) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * 工作流库 = 内置库 + workflowsDir（可选）。同 id 时用户目录覆盖内置，
 * 其余按 id 去重，内置顺序在前。每条都带上它所在目录，加载时按目录取文件。
 */
async function loadManifest(cfg) {
	const merged = new Map();
	const builtin = await readManifestAt(WF_DIR);
	for (const wf of builtin?.workflows ?? []) merged.set(wf.id, { ...wf, __dir: WF_DIR });
	const extraDir = expandPath(cfg?.workflowsDir, configRoot(cfg));
	if (extraDir && path.resolve(extraDir) !== path.resolve(WF_DIR)) {
		const extra = await readManifestAt(extraDir);
		for (const wf of extra?.workflows ?? []) merged.set(wf.id, { ...wf, __dir: extraDir, __custom: true });
	}
	return { version: builtin?.version, workflows: [...merged.values()] };
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
	const dir = entry.__dir ?? WF_DIR;
	const raw = await readFile(path.join(dir, entry.file), 'utf8');
	const wf = JSON.parse(raw);
	applyModelMap(wf, cfg);
	return wf;
}

/* --------------------------------------------------- 参数落位 / LoRA */

const LORA_NODE = '90';

function setSlot(wf, entry, name, value) {
	if (value === undefined || value === null) return false;
	const slot = entry.slots?.[name];
	if (!slot || Array.isArray(slot)) return false;
	const node = wf[slot.node];
	if (!node || !node.inputs) return false;
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

function applyLora(wf, entry, name, strengthModel, strengthClip) {
	const anchor = entry.slots?.lora_anchor;
	const base = entry.slots?.lora_base;
	if (!name || !anchor || !base) return false;
	wf[LORA_NODE] = {
		class_type: 'LoraLoader',
		inputs: {
			model: base,
			clip: ['2', 0],
			lora_name: name,
			strength_model: strengthModel ?? 1,
			strength_clip: strengthClip ?? 1,
		},
	};
	const node = wf[anchor.node];
	if (!node?.inputs) return false;
	node.inputs[anchor.input] = [LORA_NODE, 0];
	// 把原本直连 CLIPLoader 的 clip 输入改接到 LoRA 的 CLIP 输出。
	// 必须跳过 LoRA 节点自己，否则会写出自引用环。
	for (const [id, candidate] of Object.entries(wf)) {
		if (id === LORA_NODE || !candidate?.inputs) continue;
		for (const [key, val] of Object.entries(candidate.inputs)) {
			if (key === 'clip' && Array.isArray(val) && val[0] === '2') candidate.inputs[key] = [LORA_NODE, 1];
		}
	}
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

function familyOf(manifest, workflowId) {
	return manifest.workflows.find((w) => w.id === workflowId);
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

function familyDigest(manifest) {
	const seen = new Map();
	for (const wf of manifest.workflows) {
		if (seen.has(wf.family)) continue;
		const d = wf.defaults ?? {};
		seen.set(wf.family, {
			id: wf.family,
			width: d.width,
			height: d.height,
			steps: d.steps,
			cfg: d.cfg,
			workflows: manifest.workflows.filter((w) => w.family === wf.family).map((w) => w.id),
		});
	}
	return [...seen.values()];
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

function registerPanelRoutes(ctx, cfg, log) {
	const server = ctx.get('webServer');
	if (!server) return;

	const disposers = [];

	disposers.push(server.register({
		kind: 'exact',
		path: `${API_PREFIX}/state`,
		handler: async (req, res) => {
			if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
			try {
				const manifest = await loadManifest(cfg);
				const stats = await systemStats(cfg);
				const device = stats?.devices?.[0];
				return writeJson(res, 200, {
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
						family: w.family,
						task: w.task,
						width: w.defaults?.width,
						height: w.defaults?.height,
						steps: w.defaults?.steps,
						cfg: w.defaults?.cfg,
						notes: w.notes ?? '',
					})),
					families: familyDigest(manifest),
					recent: await recentImages(cfg),
					idle: idleSnapshot(cfg),
					config: (() => {
						const paths = spawnPaths(cfg);
						const idle = idleSettings(cfg);
						return {
							baseUrl: cfg.comfyBaseUrl,
							comfyRoot: paths.root || '',
							comfyMain: paths.main || '',
							comfyPython: paths.python || '',
							autoStart: Boolean(cfg.autoStart),
							modelsRoot: modelsRoot(cfg),
							workflowsDir: expandPath(cfg.workflowsDir, paths.root),
							outputDir: outputListingDir(cfg),
							saveToWorkspace: Boolean(cfg.saveToWorkspace),
							idleShutdown: idle.enabled,
							idleShutdownMs: idle.idleMs,
							idleShutdownScope: idleShutdownScope(cfg),
						};
					})(),
				});
			} catch (error) {
				return writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		},
	}));

	disposers.push(server.register({
		kind: 'exact',
		path: `${API_PREFIX}/start`,
		handler: async (req, res) => {
			if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
			try {
				const result = await ensureComfy(cfg, log ?? (() => {}));
				return writeJson(res, 200, { ok: true, started: result.started });
			} catch (error) {
				return writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		},
	}));

	disposers.push(server.register({
		kind: 'exact',
		path: `${API_PREFIX}/image`,
		handler: async (req, res) => {
			if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
			let name;
			try {
				name = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('name') ?? '';
			} catch {
				name = '';
			}
			if (!IMAGE_NAME.test(name)) return writeJson(res, 400, { ok: false, error: 'bad-name' });
			try {
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
			} catch {
				return writeJson(res, 404, { ok: false, error: 'not-found' });
			}
		},
	}));

	disposers.push(server.register({
		kind: 'exact',
		path: `${API_PREFIX}/reveal`,
		handler: async (req, res) => {
			if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
			let name = '';
			try {
				name = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('name') ?? '';
			} catch {
				name = '';
			}
			if (!IMAGE_NAME.test(name)) return writeJson(res, 400, { ok: false, error: 'bad-name' });
			const dir = outputListingDir(cfg);
			if (!dir) return writeJson(res, 404, { ok: false, error: 'no-output-dir' });
			const target = path.join(dir, name);
			if (!existsSync(target)) return writeJson(res, 404, { ok: false, error: 'not-found' });
			try {
				openInFileManager(target);
				return writeJson(res, 200, { ok: true, path: target });
			} catch (error) {
				return writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		},
	}));

	return () => disposers.splice(0).forEach((dispose) => dispose());
}

export const inject = ['tools'];

export function apply(ctx, config) {
	const cfg = { ...DEFAULTS, ...(config ?? {}) };
	const logs = [];

	const log = (line) => logs.push(`[${new Date().toISOString()}] ${line}`);

	/* 面板路由挂在 web app 的 webServer 上，headless 部署根本不组装它。
	   必须用 ctx.inject 跟随服务：apply 时直接 ctx.get('webServer') 只是「读一次」，
	   webServer 还没起来就拿到 undefined，registerPanelRoutes 静默 return，
	   一条路由都没注册，面板取 /draw-mode/api/state 落到静态兜底 → 接口异常：HTTP 404。 */
	ctx.inject(['webServer'], (webCtx) => {
		webCtx.effect(() => registerPanelRoutes(webCtx, cfg, log));
	});

	/* ------------------------------------------------------ 空闲自动关闭 */

	ctx.effect(() => {
		const { enabled, idleMs } = idleSettings(cfg);
		if (!enabled || idleMs <= 0) return;
		const pollMs = Math.max(5000, Math.min(120000, Number(cfg.idlePollMs) || 30000));
		let stopping = false;

		const tick = async () => {
			if (stopping) return;
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
				log(`空闲 ${Math.round(idleFor / 60000)} 分钟（阈值 ${Math.round(idleMs / 60000)} 分钟），关闭 ComfyUI 释放显存与内存`);
				await stopComfy(cfg, log);
				ACTIVITY.lastShutdownAt = Date.now();
			} finally {
				ACTIVITY.last = Date.now();
				stopping = false;
			}
		};

		const timer = setInterval(() => {
			tick().catch((error) => log(`空闲关闭检查失败：${error?.message ?? error}`));
		}, pollMs);
		timer.unref?.();
		return () => clearInterval(timer);
	});

	/* ---------------------------------------------------------- draw_status */

	ctx.effect(() => ctx.tools.register({
		name: 'draw_status',
		description: 'Check whether the local ComfyUI server is reachable, and start it headlessly when it is not. Use this first in a drawing session, or when a draw_* call reports a connection error. Returns GPU/VRAM info and how many workflows are installed.',
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
				const lines = [value.running
					? `ComfyUI 在线：${value.baseUrl}（${value.device ?? '未知设备'}，显存 ${value.vramFreeMb ?? '?'} / ${value.vramTotalMb ?? '?'} MB 空闲），已装 ${value.workflows} 个工作流。${value.started ? ' 本次由插件自动启动。' : ''}`
					: `ComfyUI 不在线：${value.error ?? value.baseUrl}`];
				lines.push(`配置：modelsRoot=${c.modelsRoot ?? '（未配置）'}；工作流目录=${c.workflowsDir ?? '（仅内置）'}；出图目录=${c.outputDir ?? (c.saveToWorkspace ? '会话工作区/draw-mode' : '（不保存）')}`);
				lines.push(`无头启动：${c.autoStart ? '开启' : '关闭'}${c.comfyMain ? `，main.py=${c.comfyMain}` : ''}${c.comfyPython ? `，python=${c.comfyPython}` : ''}`);
				lines.push(c.idleShutdown
					? `空闲关闭：${Math.round((c.idleShutdownMs ?? 0) / 60000)} 分钟后关闭${c.idleShutdownScope === 'port' ? '（含端口上其他进程）' : '（仅本插件启动的进程）'}`
					: '空闲关闭：关闭');
				const missing = value.requirements?.missing ?? [];
				if (missing.length > 0) {
					lines.push(`\n缺 ${missing.length} 个模型文件（${value.requirements.checked ? '在 modelsRoot 下没找到' : 'modelsRoot 未配置'}）：`);
					for (const m of missing) lines.push(`· ${m.key} ${m.name} ← ${m.workflows.join(', ')}`);
				}
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		timeoutMs: 300000,
		isConcurrencySafe: () => false,
		execute: async (args) => {
			const url = cfg.comfyBaseUrl;
			const manifest = await loadManifest(cfg);
			const paths = spawnPaths(cfg);
			const idle = idleSettings(cfg);
			const config = {
				baseUrl: url,
				comfyRoot: paths.root || undefined,
				comfyMain: paths.main || undefined,
				comfyPython: paths.python || undefined,
				comfyWorkdir: paths.cwd || undefined,
				autoStart: Boolean(cfg.autoStart),
				modelsRoot: modelsRoot(cfg) || undefined,
				workflowsDir: expandPath(cfg.workflowsDir, paths.root) || undefined,
				outputDir: fixedOutputDir(cfg) || ACTIVITY.lastSaveDir || undefined,
				saveToWorkspace: Boolean(cfg.saveToWorkspace),
				idleShutdown: idle.enabled,
				idleShutdownMs: idle.idleMs,
				idleShutdownScope: idleShutdownScope(cfg),
			};
			let stats = await systemStats(cfg);
			let started = false;
			if (!stats && (args?.start ?? cfg.autoStart)) {
				const ensured = await ensureComfy(cfg, log);
				stats = ensured.stats;
				started = ensured.started;
			}
			const requirements = await modelRequirements(manifest, cfg);
			if (!stats) {
				return { running: false, baseUrl: url, workflows: manifest.workflows.length, config, requirements, error: '连接失败，且未开启自动启动', logs };
			}
			const device = stats.devices?.[0];
			return {
				running: true,
				baseUrl: url,
				started,
				device: device?.name,
				vramTotalMb: device ? Math.round(device.vram_total / 1048576) : undefined,
				vramFreeMb: device ? Math.round(device.vram_free / 1048576) : undefined,
				workflows: manifest.workflows.length,
				config,
				requirements,
				logs,
			};
		},
	}));

	/* ------------------------------------------------------- draw_workflows */

	ctx.effect(() => ctx.tools.register({
		name: 'draw_workflows',
		description: 'List the installed drawing workflows (id, model family, task type, default parameters, optional workflow notes) so a matching workflow can be chosen before calling draw_generate. Optionally filter by task.',
		parameters: {
			type: 'object',
			properties: {
				task: { type: 'string', enum: ['t2i', 'img2img', 'edit', 'reverse'], description: 'Only return workflows of this task type.' },
			},
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{
				type: 'text',
				text: value.workflows.map((w) => `${w.id} — ${w.label}［${w.task}］${w.notes ? ' · ' + w.notes : ''}`).join('\n'),
			}],
		},
		isConcurrencySafe: () => true,
		execute: async (args) => {
			const manifest = await loadManifest(cfg);
			const workflows = manifest.workflows
				.filter((w) => !args?.task || w.task === args.task)
				.map((w) => ({ id: w.id, label: w.label, family: w.family, task: w.task, defaults: w.defaults, notes: w.notes }));
			return { workflows };
		},
	}));

	/* ---------------------------------------------------------- draw_models */

	ctx.effect(() => ctx.tools.register({
		name: 'draw_models',
		description: 'Describe the three drawing model families available locally: which checkpoint, text encoder and VAE each uses, its default resolution/steps/cfg/sampler, and the prompt dialect it expects. Optionally include the LoRA files installed for that family.',
		parameters: {
			type: 'object',
			properties: {
				includeLoras: { type: 'boolean', description: 'Also return installed LoRA file names usable with draw_generate.' },
			},
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => {
				const lines = value.families.map((f) => `${f.id} — ${f.label}：${f.unet}，${f.width}x${f.height}，${f.steps} 步，cfg ${f.cfg}，${f.sampler}；提示词写法：${f.promptStyle}`);
				if (value.loras?.length) lines.push(`\n可用 LoRA（${value.loras.length} 个，draw_generate 的 lora 参数取这里的完整文件名）：\n` + value.loras.map((l) => '· ' + l).join('\n'));
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		isConcurrencySafe: () => true,
		execute: async (args) => {
			const families = [
				{
					id: 'anima', label: 'Anima SilvermoonMix（2.9B 动漫）',
					unet: 'SilvermoonMix-Anima29B-Evolved-V2.3-INT8-ConvRot.safetensors',
					clip: 'qwen_3_06b_base.safetensors (stable_diffusion)', vae: 'qwen_image_vae.safetensors',
					width: 832, height: 1216, steps: 30, cfg: 4, sampler: 'er_sde / simple',
					promptStyle: 'Danbooru 标签串，逗号分隔，质量前缀 masterpiece/best quality/very aesthetic/score_7/safe，必须配负面词',
				},
				{
					id: 'krea2', label: 'Krea2（写实/风格化）',
					unet: 'Krea-2-Turbo-Q4_K_M.gguf',
					clip: 'qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors (krea2)', vae: 'qwen_image_vae.safetensors',
					width: 768, height: 1280, steps: 8, cfg: 1, sampler: 'euler / simple',
					promptStyle: '自然语言长句，描述主体+环境+光线+镜头，不用标签堆砌，负面词留空',
				},
				{
					id: 'qwen21', label: 'Qwen-Image 2.1（通用/改图）',
					unet: 'qwen_image_2.1_turbo_Q4_K_M.gguf',
					clip: 'qwen3vl_8b_w4a8_heretic.safetensors (qwen_image)', vae: 'qwen_image_2.1_vae_bf16.safetensors',
					width: 1024, height: 1024, steps: 8, cfg: 1, sampler: 'euler / simple',
					promptStyle: '自然语言（中英文皆可），改图时写成明确的编辑指令，说明改什么、不动什么',
				},
			];
			let loras;
			if (args?.includeLoras) {
				try {
					const res = await httpJson(cfg.comfyBaseUrl.replace(/\/+$/, '') + '/object_info/LoraLoader', { method: 'GET' }, 30000);
					const names = res.body?.LoraLoader?.input?.required?.lora_name?.[0];
					if (Array.isArray(names)) loras = names;
				} catch {
					loras = undefined;
				}
			}
			return { families, ...(loras ? { loras } : {}) };
		},
	}));

	/* -------------------------------------------------------- draw_generate */

	ctx.effect(() => ctx.tools.register({
		name: 'draw_generate',
		description: 'Generate or edit an image through the local ComfyUI workflow library. Pick a workflow id from draw_workflows, then pass the finished prompt in that model family\'s dialect. Image-to-image and edit workflows read the newest image in the conversation by default; pass image with a local file path or an attachment sha256 to override. The generated image is attached to the conversation and returned inline.',
		parameters: {
			type: 'object',
			properties: {
				workflow: { type: 'string', description: 'Workflow id from draw_workflows, for example anima-t2i, krea2-t2i, qwen21-t2i, anima-img2img, qwen21-edit, anima-t2i-handfix.' },
				prompt: { type: 'string', description: 'The finished prompt, already written in the target model family prompt dialect.' },
				negative: { type: 'string', description: 'Negative prompt. Only meaningful for the anima family; others leave it empty.' },
				width: { type: 'integer', description: 'Output width in pixels. Defaults to the workflow default.' },
				height: { type: 'integer', description: 'Output height in pixels. Defaults to the workflow default.' },
				steps: { type: 'integer', description: 'Sampling steps. Defaults to the workflow default.' },
				cfg: { type: 'number', description: 'CFG scale. Keep 1.0 for the turbo models unless asked otherwise.' },
				seed: { type: 'integer', description: 'Seed. Omit or pass -1 for a random seed; the used seed is reported back.' },
				denoise: { type: 'number', description: 'Denoise strength for image-to-image workflows; ignored by text-to-image.' },
				lora: { type: 'string', description: 'Exact LoRA file name from draw_models includeLoras, to apply on top of the base model.' },
				loraStrength: { type: 'number', description: 'LoRA model strength. Defaults to 1.' },
				image: { type: 'string', description: 'Reference image for img2img/edit: a local absolute file path, or an attachment sha256 id. Defaults to the newest image in the conversation.' },
				image2: { type: 'string', description: 'Second reference image for workflows that accept two, such as qwen21-edit.' },
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
					text: `${value.workflow}（${value.label}）出图 ${images.length} 张 · ${value.width}x${value.height} · ${value.steps} 步 · cfg ${value.cfg} · seed ${value.seed} · ${value.elapsedMs}ms`
						+ (value.lora ? ` · LoRA ${value.lora}` : '')
						+ (value.savedTo?.length ? ` · 已存 ${value.savedTo.join(', ')}` : '')
						+ '。图片已附加到对话。',
				}];
				for (const image of images) blocks.push({ type: 'image', attachment: image.attachment });
				return blocks;
			},
		},
		timeoutMs: 900000,
		isConcurrencySafe: () => false,
		execute: async (args, exec) => {
			const started = Date.now();
			const manifest = await loadManifest(cfg);
			const entry = familyOf(manifest, String(args.workflow));
			if (!entry) throw new Error(`没有这个工作流：${args.workflow}。可用：${manifest.workflows.map((w) => w.id).join(', ')}`);

			await ensureComfy(cfg, log);
			const workflow = await loadWorkflow(cfg, entry);

			const defaults = entry.defaults ?? {};
			const seed = resolveSeed(args.seed);
			const steps = numberOr(args.steps, defaults.steps);
			const cfgScale = numberOr(args.cfg, defaults.cfg);
			const denoise = numberOr(args.denoise, defaults.denoise);

			setSlot(workflow, entry, 'prompt', args.prompt);
			if (args.negative !== undefined) setSlot(workflow, entry, 'negative', args.negative);
			setSlot(workflow, entry, 'width', numberOr(args.width, defaults.width));
			setSlot(workflow, entry, 'height', numberOr(args.height, defaults.height));
			setSlot(workflow, entry, 'resolution', defaults.resolution);
			setSlot(workflow, entry, 'steps', steps);
			setSlot(workflow, entry, 'cfg', cfgScale);
			setSlot(workflow, entry, 'denoise', denoise);
			setSlot(workflow, entry, 'seed', seed);
			setSlot(workflow, entry, 'detailer_seed', seed);
			setSlot(workflow, entry, 'detailer_denoise', defaults.detailer_denoise);
			setSlot(workflow, entry, 'threshold', defaults.threshold);
			setSlot(workflow, entry, 'character_threshold', defaults.character_threshold);
			setSlot(workflow, entry, 'caption_length', defaults.caption_length);
			setSlot(workflow, entry, 'prompt_style', defaults.prompt_style);
			setSlot(workflow, entry, 'megapixels', defaults.megapixels);

			if (args.lora) applyLora(workflow, entry, String(args.lora), numberOr(args.loraStrength, 1), numberOr(args.loraStrength, 1));

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
				width: numberOr(args.width, defaults.width) ?? undefined,
				height: numberOr(args.height, defaults.height) ?? undefined,
				steps,
				cfg: cfgScale,
				seed,
				denoise,
				...(args.lora ? { lora: String(args.lora) } : {}),
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
		description: 'Reverse-engineer an image into a prompt written in the target model family dialect. For anima it runs a WD14 Danbooru tagger and returns a comma-separated tag string; for krea2 and qwen21 it runs JoyCaption and returns descriptive English prose. Reads the newest image in the conversation by default. Does not generate an image.',
		parameters: {
			type: 'object',
			properties: {
				target: { type: 'string', enum: ['anima', 'krea2', 'qwen21'], description: 'The model family the prompt will be used with. Decides which tagger runs.' },
				image: { type: 'string', description: 'Local absolute file path or attachment sha256. Defaults to the newest image in the conversation.' },
				threshold: { type: 'number', description: 'Tag score threshold for the anima tagger. Defaults to 0.35.' },
				captionLength: { type: 'string', enum: ['long', 'medium', 'short'], description: 'Caption length for krea2 and qwen21. Defaults to long.' },
			},
			required: ['target'],
			additionalProperties: false,
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{
				type: 'text',
				text: `反推完成（${value.target} / ${value.workflow}，${value.elapsedMs}ms）：\n\n${value.prompt}`,
			}],
		},
		timeoutMs: 900000,
		isConcurrencySafe: () => false,
		execute: async (args, exec) => {
			const started = Date.now();
			const manifest = await loadManifest(cfg);
			const target = String(args.target);
			const workflowId = target === 'anima' ? 'reverse-wd14' : 'reverse-joycaption';
			const entry = familyOf(manifest, workflowId);
			if (!entry) throw new Error(`工作流库里缺少 ${workflowId}`);

			await ensureComfy(cfg, log);
			const workflow = await loadWorkflow(cfg, entry);
			const staged = await stageImage(ctx, exec, cfg, args.image);
			workflow[entry.slots.image.node].inputs[entry.slots.image.input] = staged;
			if (target === 'anima' && args.threshold !== undefined) setSlot(workflow, entry, 'threshold', args.threshold);
			if (target !== 'anima' && args.captionLength !== undefined) setSlot(workflow, entry, 'caption_length', args.captionLength);

			const promptId = await submit(cfg, workflow, log);
			const historyEntry = await waitHistory(cfg, promptId, cfg.timeoutMs);
			const texts = collectTexts(historyEntry);
			const prompt = texts.join('\n').trim();
			if (!prompt) throw new Error('反推工作流跑完了但没读到文本输出');

			return {
				target,
				workflow: workflowId,
				prompt,
				elapsedMs: Date.now() - started,
				promptId,
				logs,
			};
		},
	}));
}
