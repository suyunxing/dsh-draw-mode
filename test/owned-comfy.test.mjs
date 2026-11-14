import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	DEGRADED_MAX_AGE_MS,
	MAX_RECORDS,
	RECORD_MAX_AGE_MS,
	VERIFY_TOLERANCE_MS,
	loadOwned,
	makeRecord,
	matchesRecord,
	normalizeRecord,
	planOwnedStop,
	probeProcesses,
	resolveStateFile,
	saveOwned,
} from '../owned-comfy.js';

const ROOT = 'D:\\ai\\ComfyUI-aki-v3.2';
const MAIN = ROOT + '\\ComfyUI\\main.py';
const CMD = '"' + ROOT + '\\python\\python.exe" "' + MAIN + '" --listen 127.0.0.1 --port 8188 --disable-auto-launch';

function record(overrides = {}) {
	const startedAt = overrides.startedAt ?? 1_700_000_000_000;
	return makeRecord({ pid: 4242, startedAt, port: '8188', root: ROOT, exe: 'python.exe', main: MAIN, ...overrides });
}

function info(overrides = {}) {
	const startedAt = overrides.createdMs ?? 1_700_000_000_500;
	return { pid: 4242, name: 'python.exe', cmd: CMD, createdMs: startedAt, ...overrides };
}

/* ------------------------------------------------------------------ 路径 */

test('状态文件优先放在 DSH_HOME 下', () => {
	const file = resolveStateFile({ DSH_HOME: 'C:\\Users\\me\\.dsh' }, 'win32', 'C:\\Users\\me');
	assert.equal(file, path.join('C:\\Users\\me\\.dsh', 'storages', 'dsh-draw-mode', 'owned-comfy.json'));
});

test('没有 DSH_HOME 时 Windows 用 LOCALAPPDATA', () => {
	const file = resolveStateFile({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', 'C:\\Users\\me');
	assert.equal(file, path.join('C:\\Users\\me\\AppData\\Local', 'dsh-draw-mode', 'owned-comfy.json'));
});

test('其它平台用 XDG_STATE_HOME', () => {
	const file = resolveStateFile({}, 'linux', '/home/me');
	assert.equal(file, path.join('/home/me', '.local', 'state', 'dsh-draw-mode', 'owned-comfy.json'));
});

/* ------------------------------------------------------------ 记录读写 */

test('记录校验：pid 与创建时间不合法就丢掉', () => {
	assert.equal(normalizeRecord(null), null);
	assert.equal(normalizeRecord({ pid: 0, startedAt: 1 }), null);
	assert.equal(normalizeRecord({ pid: 12, startedAt: 0 }), null);
	assert.deepEqual(normalizeRecord({ pid: '12', startedAt: 5 }), {
		pid: 12, startedAt: 5, port: '', root: '', exe: 'python.exe', main: '',
	});
});

test('读不到或读坏状态文件时返回空，不影响出图', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'draw-owned-'));
	try {
		assert.deepEqual(await loadOwned(path.join(dir, 'missing.json')), []);
		const broken = path.join(dir, 'broken.json');
		await writeFile(broken, '{ not json', 'utf8');
		assert.deepEqual(await loadOwned(broken), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('保存后可读回，过期记录与重复 pid 被清掉', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'draw-owned-'));
	try {
		const file = path.join(dir, 'nested', 'owned-comfy.json');
		const now = Date.now();
		await saveOwned(file, [
			record({ pid: 11, startedAt: now - 1000 }),
			record({ pid: 11, startedAt: now - 2000 }),
			record({ pid: 22, startedAt: now - 5 * 24 * 3600 * 1000 }),
			{ pid: 'nope' },
		]);
		const raw = JSON.parse(await readFile(file, 'utf8'));
		assert.equal(raw.version, 1);
		assert.deepEqual(raw.records.map((item) => item.pid), [11, 22]);
		const loaded = await loadOwned(file, now);
		assert.deepEqual(loaded.map((item) => item.pid), [11, 22]);
		/* 再过两天，pid 22 的记录过期，pid 11 还在有效期内 */
		const stale = await loadOwned(file, now + 2 * 24 * 3600 * 1000 + 10_000);
		assert.deepEqual(stale.map((item) => item.pid), [11]);
		assert.ok(RECORD_MAX_AGE_MS > 6 * 24 * 3600 * 1000);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('记录条数有上限', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'draw-owned-'));
	try {
		const file = path.join(dir, 'owned-comfy.json');
		const now = Date.now();
		const list = Array.from({ length: MAX_RECORDS + 4 }, (_, index) => record({ pid: 100 + index, startedAt: now - index * 10 }));
		await saveOwned(file, list);
		const loaded = await loadOwned(file, now);
		assert.equal(loaded.length, MAX_RECORDS);
		assert.equal(loaded.at(-1).pid, 100 + MAX_RECORDS + 3);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------ 归属判定 */

test('名字、命令行、创建时间都对上才算我们的进程', () => {
	assert.deepEqual(matchesRecord(record(), info()), { ok: true });
	assert.equal(matchesRecord(record(), info({ name: 'pythonw.exe' })).ok, true);
	assert.equal(matchesRecord(record(), info({ name: 'comfyui.exe' })).reason, 'not-python');
	assert.equal(matchesRecord(record(), info({ cmd: '' })).reason, 'no-command-line');
	assert.equal(matchesRecord(record(), info({ cmd: '"py" "D:\\other\\main.py"' })).reason, 'other-main-script');
	assert.equal(matchesRecord(record(), info({ createdMs: 1_700_000_000_500 + VERIFY_TOLERANCE_MS + 1 })).reason, 'create-time-mismatch');
	assert.equal(matchesRecord(record(), info({ createdMs: undefined })).reason, 'no-create-time');
	assert.equal(matchesRecord(record(), null).reason, 'gone');
});

test('命令行大小写和斜杠方向不影响判定', () => {
	const rec = record();
	const info2 = info({ cmd: CMD.toUpperCase(), name: 'PYTHON.EXE' });
	assert.equal(matchesRecord(rec, info2).ok, true);
});

test('planOwnedStop 只杀自己的进程，端口上的外部实例不动', () => {
	const rec = record({ pid: 1000 });
	const probe = {
		ok: true,
		processes: new Map([[1000, info({ pid: 1000 })], [2000, info({ pid: 2000, name: 'python.exe' })]]),
	};
	const plan = planOwnedStop({ records: [rec], listeners: [1000, 2000], probe, now: rec.startedAt + 1000 });
	assert.deepEqual(plan.kill, [1000]);
	assert.deepEqual(plan.external, [2000]);
	assert.deepEqual(plan.forget, []);
	assert.equal(plan.degraded, false);
});

test('planOwnedStop 对「记录指向的进程已经没了」只清记录', () => {
	const rec = record({ pid: 1000 });
	const plan = planOwnedStop({ records: [rec], listeners: [], probe: { ok: true, processes: new Map() }, now: rec.startedAt });
	assert.deepEqual(plan.kill, []);
	assert.deepEqual(plan.forget, [1000]);
	assert.equal(plan.skipped[0].reason, 'gone');
});

test('planOwnedStop 遇到 pid 被复用（创建时间不符）不杀，只清记录', () => {
	const rec = record({ pid: 1000 });
	const reused = info({ pid: 1000, createdMs: rec.startedAt + 3600_000 });
	const plan = planOwnedStop({ records: [rec], listeners: [1000], probe: { ok: true, processes: new Map([[1000, reused]]) }, now: rec.startedAt + 7200_000 });
	assert.deepEqual(plan.kill, []);
	assert.deepEqual(plan.forget, [1000]);
	assert.deepEqual(plan.external, [1000]);
	assert.equal(plan.skipped[0].reason, 'create-time-mismatch');
});

test('planOwnedStop 在拿不到进程详情时只认「新记录 + 确实在监听」', () => {
	const now = 1_800_000_000_000;
	const fresh = record({ pid: 111, startedAt: now - 60_000 });
	const stale = record({ pid: 222, startedAt: now - DEGRADED_MAX_AGE_MS - 60_000 });
	const plan = planOwnedStop({ records: [fresh, stale], listeners: [111, 222], probe: { ok: false }, now });
	assert.equal(plan.degraded, true);
	assert.deepEqual(plan.kill, [111]);
	assert.deepEqual(plan.external, [222]);
});

test('planOwnedStop 没有记录时什么也不杀', () => {
	const plan = planOwnedStop({ records: [], listeners: [3000], probe: { ok: true, processes: new Map() } });
	assert.deepEqual(plan.kill, []);
	assert.deepEqual(plan.external, [3000]);
});

/* ------------------------------------------------------------ 进程探测 */

test('探测结果按行解析成 pid → 进程信息', async () => {
	const calls = [];
	const exec = (file, args, options, callback) => {
		calls.push({ file, args });
		const rows = [
			JSON.stringify({ pid: 11, name: 'python.exe', cmd: CMD, created: '2023-11-14T22:13:20.5000000Z' }),
			JSON.stringify({ pid: 22, name: 'node.exe', cmd: '"node" x.js', created: '2023-11-14T22:13:20Z' }),
		].join('\r\n');
		callback(null, rows, '');
	};
	const probe = await probeProcesses([11, 22, 11, 'x', -3], { exec, platform: 'win32' });
	assert.equal(probe.ok, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].file, 'powershell.exe');
	assert.match(calls[0].args.at(-1), /@\(11,22\)/);
	assert.equal(probe.processes.get(11).name, 'python.exe');
	assert.equal(probe.processes.get(11).createdMs, Date.parse('2023-11-14T22:13:20.500Z'));
	assert.equal(probe.processes.get(22).cmd, '"node" x.js');
	assert.equal(probe.processes.has(33), false);
});

test('探测本身失败时返回 ok=false（调用方据此拒绝关闭）', async () => {
	const exec = (file, args, options, callback) => {
		const error = new Error('powershell 不可用');
		callback(error, '', 'denied');
	};
	const probe = await probeProcesses([11], { exec, platform: 'win32' });
	assert.equal(probe.ok, false);
	assert.match(probe.error, /denied|不可用/);
});

test('没有候选 pid 时不启动外部进程', async () => {
	let called = 0;
	const exec = () => { called += 1; };
	const probe = await probeProcesses([], { exec, platform: 'win32' });
	assert.equal(called, 0);
	assert.equal(probe.ok, true);
	assert.equal(probe.processes.size, 0);
});
