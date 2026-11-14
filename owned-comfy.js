/**
 * 「这个 ComfyUI 是不是我启动的」——空闲自动关闭只允许关自己拉起的那个实例。
 *
 * 为什么不按端口判断：手动打开的 ComfyUI 同样监听 8188，按端口杀会把用户正在
 * 用的实例一并杀掉。这里只认本插件 spawn 时留下的归属记录。
 *
 * 为什么不只比 pid：Windows 会回收 pid，几小时后同一个号完全可能属于另一个
 * python 进程。记录里同时存了进程创建时间；关闭前读出真实进程的名字、命令行
 * 与创建时间，三项都对上才动手，对不上就只清记录、不动进程。
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** spawn 返回的 pid 与系统记录的进程创建时间之间的允许偏差。 */
export const VERIFY_TOLERANCE_MS = 120000;
/** 读不到进程详情的降级模式下，只认这个时长内留下的记录。 */
export const DEGRADED_MAX_AGE_MS = 3600000;
/** 记录最长保留时间：更久的记录已经不可能对应还活着的进程。 */
export const RECORD_MAX_AGE_MS = 7 * 24 * 3600000;
/** 同时保留的记录条数上限。 */
export const MAX_RECORDS = 8;

/* ------------------------------------------------------------------ 路径 */

/** 状态文件：优先 DSH_HOME，其次平台常规目录。 */
export function resolveStateFile(env = process.env, platform = process.platform, home = os.homedir()) {
	const dshHome = String(env?.DSH_HOME ?? '').trim();
	if (dshHome) return path.join(dshHome, 'storages', 'dsh-draw-mode', 'owned-comfy.json');
	if (platform === 'win32') {
		const local = String(env?.LOCALAPPDATA ?? '').trim() || path.join(home, 'AppData', 'Local');
		return path.join(local, 'dsh-draw-mode', 'owned-comfy.json');
	}
	const xdg = String(env?.XDG_STATE_HOME ?? '').trim() || path.join(home, '.local', 'state');
	return path.join(xdg, 'dsh-draw-mode', 'owned-comfy.json');
}

/* ------------------------------------------------------------ 记录读写 */

function asText(value) {
	return typeof value === 'string' ? value : '';
}

/** 规范化一条记录；字段不全就返回 null。 */
export function normalizeRecord(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const pid = Number(raw.pid);
	const startedAt = Number(raw.startedAt);
	if (!Number.isInteger(pid) || pid <= 0) return null;
	if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
	return {
		pid,
		startedAt,
		port: asText(raw.port),
		root: asText(raw.root),
		exe: asText(raw.exe) || 'python.exe',
		main: asText(raw.main),
	};
}

export function makeRecord({ pid, startedAt = Date.now(), port = '', root = '', exe = 'python.exe', main = '' } = {}) {
	return normalizeRecord({ pid, startedAt, port, root, exe, main });
}

/** 读归属记录：文件缺失/损坏/过期都当成空，不让状态文件影响出图。 */
export async function loadOwned(file, now = Date.now()) {
	let raw;
	try {
		raw = await readFile(file, 'utf8');
	} catch {
		return [];
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : [];
	const seen = new Set();
	const out = [];
	for (const item of list) {
		const record = normalizeRecord(item);
		if (!record) continue;
		if (now - record.startedAt > RECORD_MAX_AGE_MS) continue;
		if (seen.has(record.pid)) continue;
		seen.add(record.pid);
		out.push(record);
	}
	return out.slice(-MAX_RECORDS);
}

/** 先写临时文件再改名，避免半截 JSON。 */
export async function saveOwned(file, records) {
	const list = [];
	const seen = new Set();
	for (const item of Array.isArray(records) ? records : []) {
		const record = normalizeRecord(item);
		if (!record || seen.has(record.pid)) continue;
		seen.add(record.pid);
		list.push(record);
	}
	const body = JSON.stringify({ version: 1, records: list.slice(-MAX_RECORDS) });
	await mkdir(path.dirname(file), { recursive: true });
	const tmp = file + '.tmp';
	await writeFile(tmp, body, 'utf8');
	await rename(tmp, file);
}

/* ------------------------------------------------------------ 进程探测 */

function sanitizePids(pids) {
	const out = [];
	const seen = new Set();
	for (const raw of Array.isArray(pids) ? pids : []) {
		const pid = Number(raw);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		if (seen.has(pid)) continue;
		seen.add(pid);
		out.push(pid);
	}
	return out;
}

function run(exec, file, args, timeoutMs) {
	return new Promise((resolve) => {
		exec(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({ error: error ?? null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
		});
	});
}

/** Windows：一次 PowerShell 调用取回所有候选进程的名字 / 命令行 / 创建时间。 */
async function probeWindows(pids, exec) {
	const script = [
		"$ErrorActionPreference='Stop'",
		'[Console]::OutputEncoding=[Text.Encoding]::UTF8',
		'foreach($procId in @(' + pids.join(',') + ')){',
		"  $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $procId) -ErrorAction SilentlyContinue",
		'  if($p){ [pscustomobject]@{ pid=[int]$p.ProcessId; name=[string]$p.Name; cmd=[string]$p.CommandLine; created=[string]$p.CreationDate.ToUniversalTime().ToString(' + "'o'" + ') } | ConvertTo-Json -Compress }',
		'}',
	].join('\n');
	const { error, stdout, stderr } = await run(exec, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 20000);
	const processes = new Map();
	let parsedAny = false;
	for (const line of stdout.split(/\r?\n/)) {
		const text = line.replace(/^\uFEFF/, '').trim();
		if (!text.startsWith('{')) continue;
		let row;
		try {
			row = JSON.parse(text);
		} catch {
			continue;
		}
		parsedAny = true;
		const pid = Number(row.pid);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const createdMs = Date.parse(String(row.created ?? ''));
		processes.set(pid, {
			pid,
			name: asText(row.name),
			cmd: asText(row.cmd),
			createdMs: Number.isFinite(createdMs) ? createdMs : undefined,
		});
	}
	if (error && !parsedAny) return { ok: false, processes, error: stderr.trim() || error.message };
	return { ok: true, processes };
}

/** 其它平台：ps 的 etimes 换算创建时间。 */
async function probePosix(pids, exec, now) {
	const { error, stdout, stderr } = await run(exec, 'ps', ['-o', 'pid=,etimes=,args=', '-p', pids.join(',')], 20000);
	const processes = new Map();
	let parsedAny = false;
	for (const line of stdout.split(/\r?\n/)) {
		const text = line.trim();
		if (!text) continue;
		const match = text.match(/^(\d+)\s+(\d+)\s+(.*)$/);
		if (!match) continue;
		parsedAny = true;
		const pid = Number(match[1]);
		const elapsedMs = Number(match[2]) * 1000;
		if (!Number.isInteger(pid) || pid <= 0) continue;
		processes.set(pid, {
			pid,
			name: path.basename(String(match[3] ?? '').split(/\s+/)[0] ?? ''),
			cmd: String(match[3] ?? ''),
			createdMs: Number.isFinite(elapsedMs) ? now - elapsedMs : undefined,
		});
	}
	if (error && !parsedAny) return { ok: false, processes, error: stderr.trim() || error.message };
	return { ok: true, processes };
}

/**
 * 读候选进程的详情。
 * 返回 { ok, processes: Map<pid, {pid,name,cmd,createdMs}>, error }。
 * ok=false 表示这一轮拿不到可信信息，调用方应拒绝关闭（宁可不关，也不误杀）。
 */
export async function probeProcesses(pids, options = {}) {
	const list = sanitizePids(pids);
	if (list.length === 0) return { ok: true, processes: new Map() };
	const exec = options.exec ?? execFile;
	const platform = options.platform ?? process.platform;
	const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
	return platform === 'win32' ? probeWindows(list, exec) : probePosix(list, exec, now);
}

/* ------------------------------------------------------------ 归属判定 */

function normalizePathText(value) {
	return String(value ?? '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').trim().toLowerCase();
}

/**
 * 记录与真实进程是不是同一个：名字像 python、命令行指向同一个 main.py、
 * 创建时间对得上。任一项不符都判否（pid 复用就是靠创建时间挡住的）。
 */
export function matchesRecord(record, info, tolerance = VERIFY_TOLERANCE_MS) {
	if (!record || !info) return { ok: false, reason: 'gone' };
	const name = String(info.name ?? '').toLowerCase();
	const expected = String(record.exe || 'python.exe').toLowerCase();
	const pythonish = name === expected || name === 'python.exe' || name === 'pythonw.exe';
	if (!pythonish) return { ok: false, reason: 'not-python' };
	const cmd = normalizePathText(info.cmd);
	if (!cmd) return { ok: false, reason: 'no-command-line' };
	const main = normalizePathText(record.main);
	const root = normalizePathText(record.root);
	if (main) {
		if (!cmd.includes(main)) return { ok: false, reason: 'other-main-script' };
	} else if (!cmd.includes('main.py') || (root && !cmd.includes(root))) {
		return { ok: false, reason: 'other-main-script' };
	}
	if (!Number.isFinite(info.createdMs) || !Number.isFinite(record.startedAt)) {
		return { ok: false, reason: 'no-create-time' };
	}
	if (Math.abs(info.createdMs - record.startedAt) > tolerance) {
		return { ok: false, reason: 'create-time-mismatch' };
	}
	return { ok: true };
}

/**
 * 决定这一轮该关谁。
 * - kill：确认是本插件启动的 pid
 * - forget：记录作废（进程已退出或已经不是那个进程）
 * - external：端口上不属于本插件、因此绝不触碰的 pid
 * - degraded：拿不到进程详情，只按「记录够新 + 确实在监听」降级判断
 */
export function planOwnedStop({ records = [], listeners = [], probe, now = Date.now(), platform = process.platform, tolerance = VERIFY_TOLERANCE_MS } = {}) {
	const listenerSet = new Set(sanitizePids(listeners));
	const processes = probe && probe.processes instanceof Map ? probe.processes : new Map();
	const degraded = !probe || probe.ok !== true;
	const kill = [];
	const forget = [];
	const skipped = [];
	for (const item of Array.isArray(records) ? records : []) {
		const record = normalizeRecord(item);
		if (!record) continue;
		if (degraded) {
			const fresh = now - record.startedAt <= DEGRADED_MAX_AGE_MS;
			if (fresh && listenerSet.has(record.pid)) kill.push(record.pid);
			else skipped.push({ pid: record.pid, reason: fresh ? 'not-listening' : 'stale-record' });
			continue;
		}
		const info = processes.get(record.pid);
		if (!info) {
			forget.push(record.pid);
			skipped.push({ pid: record.pid, reason: 'gone' });
			continue;
		}
		const verdict = matchesRecord(record, info, tolerance);
		if (!verdict.ok) {
			forget.push(record.pid);
			skipped.push({ pid: record.pid, reason: verdict.reason });
			continue;
		}
		kill.push(record.pid);
	}
	const killSet = new Set(kill);
	const external = [...listenerSet].filter((pid) => !killSet.has(pid));
	return {
		kill,
		forget: [...new Set(forget)],
		external,
		skipped,
		degraded,
		platform,
	};
}
