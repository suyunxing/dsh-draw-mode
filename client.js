/**
 * @local/dsh-draw — 画图模式面板（浏览器半边）
 *
 * 在左侧全局导航里加一行「画图」，点开后在中央列显示画图模式面板：
 * ComfyUI 连通性 / GPU 显存、工作流目录与清单、配置表单、最近出图缩略图。
 * 数据来自 Host 半边注册的 HTTP 接口（/draw-mode/api/*），与 Web GUI 同源。
 * 插件不自带工作流：这里显示的永远是用户自己放进 workflowsDir 的文件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-draw-mode',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'dsh-draw';
    const PANEL_ORDER = 30;
    const API = '/draw-mode/api';

    // 桌面端（Electron）主窗口的 setWindowOpenHandler 一律 deny，只有 http(s) 交给系统浏览器，
    // 所以 `<a target="_blank">` 在桌面端点不开（手机浏览器却是正常开新标签页）。
    // 这里改成面板内灯箱：两端行为一致，也不依赖弹窗权限。
    const ReactDOM = (() => {
      try {
        const mod = require('react-dom');
        return mod && typeof mod.createPortal === 'function' ? mod : null;
      } catch {
        return null;
      }
    })();

    // 有 react-dom 就挂到 body，避免祖先 transform 让 position:fixed 失效。
    const portal = (node) => (ReactDOM ? ReactDOM.createPortal(node, document.body) : node);

    // 桌面端外壳是 Electron：主窗口拒绝一切弹窗，所以"新标签页打开"在那里永远没反应，
    // 换成 Host 侧的"在文件夹中显示"（/draw-mode/api/reveal）。浏览器/手机保留原链接。
    // 判据优先用 preload 注入的 window.dshDesktop（lib/preload-app.cjs 无条件暴露），
    // 退路才是 UA 里的 Electron 标记。
    const DESKTOP_SHELL = (() => {
      try {
        if (typeof window !== 'undefined' && window.dshDesktop) return true;
        if (typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent || '')) return true;
        return false;
      } catch {
        return false;
      }
    })();

    const imageUrl = (name) => `${API}/image?name=${encodeURIComponent(name)}`;

    const formatSize = (bytes) => {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
      const mb = bytes / 1048576;
      return mb >= 1 ? `${mb.toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    };

    const TASK_LABEL = {
      t2i: '文生图',
      img2img: '图生图',
      edit: '改图',
      reverse: '反推提示词',
    };

    const CSS = `
.dshdraw-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  min-height: 0;
  padding: 24px 28px 32px;
  overflow-y: auto;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}
.dshdraw-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.dshdraw-headText { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.dshdraw-title { font-size: 17px; font-weight: 600; line-height: 1.35; }
.dshdraw-sub { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dshdraw-actions { display: flex; gap: 8px; flex: none; }
.dshdraw-btn {
  appearance: none;
  font: inherit;
  cursor: pointer;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  padding: 5px 12px;
  font-size: 12px;
  line-height: 1.5;
}
.dshdraw-btn:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
.dshdraw-btn:disabled { opacity: 0.45; cursor: default; }
.dshdraw-btnPrimary {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-layer-3);
}
.dshdraw-btnPrimary:hover:not(:disabled) { color: var(--dsw-alias-bg-layer-3); }
.dshdraw-dim {
        opacity: 0.72;
      }
      .dshdraw-conf {
        margin-top: 4px;
        font-size: 11px;
        line-height: 1.4;
        word-break: break-all;
      }

      .dshdraw-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  border-radius: 12px;
  padding: 12px 16px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.dshdraw-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dshdraw-dotOn { background: var(--dsw-alias-state-success-primary, #16a34a); }
.dshdraw-dotOff { background: var(--dsw-alias-state-error-primary, #b42318); }
.dshdraw-strong { color: var(--dsw-alias-label-primary); font-weight: 500; }
.dshdraw-section { display: flex; flex-direction: column; gap: 8px; }
.dshdraw-sectionTitle {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}
.dshdraw-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.dshdraw-card {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dshdraw-cardName { font-size: 13px; font-weight: 600; }
.dshdraw-cardMeta { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dshdraw-cardDialect { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dshdraw-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dshdraw-table th {
  text-align: left;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
  padding: 6px 10px 6px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  white-space: nowrap;
}
.dshdraw-table td {
  padding: 7px 10px 7px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  vertical-align: top;
}
.dshdraw-table td:first-child { color: var(--dsw-alias-label-primary); font-weight: 500; white-space: nowrap; }
.dshdraw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 10px;
}
.dshdraw-thumb {
  display: block;
  position: relative;
  width: 100%;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  overflow: hidden;
  background: var(--dsw-alias-bg-module-platform);
  aspect-ratio: 1 / 1;
  cursor: zoom-in;
  font: inherit;
  color: inherit;
  text-align: left;
}
.dshdraw-thumb:hover { border-color: var(--dsw-alias-label-dimmed); }
.dshdraw-thumb:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.dshdraw-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dshdraw-thumbName {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 10px 6px 4px;
  font-size: 10px;
  line-height: 1.3;
  color: #fff;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.72), transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshdraw-lb {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 56px 24px 28px;
  background: rgba(0, 0, 0, 0.84);
  overscroll-behavior: contain;
}
.dshdraw-lbImg {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
  cursor: zoom-out;
}
.dshdraw-lbBar {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px 12px;
  max-width: 100%;
  color: #fff;
  font-size: 12px;
  line-height: 1.4;
}
.dshdraw-lbName {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60vw;
}
.dshdraw-lbMeta { color: rgba(255, 255, 255, 0.6); flex: none; }
.dshdraw-lbClose,
.dshdraw-lbNav {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: rgba(0, 0, 0, 0.42);
  color: #fff;
  font: inherit;
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
}
.dshdraw-lbClose:hover,
.dshdraw-lbNav:hover { background: rgba(255, 255, 255, 0.18); }
.dshdraw-lbClose { top: 14px; right: 16px; }
.dshdraw-lbPrev { left: 14px; top: 50%; transform: translateY(-50%); }
.dshdraw-lbNext { right: 14px; top: 50%; transform: translateY(-50%); }
.dshdraw-lbFoot {
  display: flex;
  align-items: center;
  gap: 14px;
  color: rgba(255, 255, 255, 0.62);
  font-size: 11px;
}
.dshdraw-lbLink { color: rgba(255, 255, 255, 0.88); text-decoration: underline; }
.dshdraw-lbLink:hover { color: #fff; }
.dshdraw-lbAction {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  cursor: pointer;
}
.dshdraw-lbNote { color: #ff9d9d; }
@media (hover: none) {
  .dshdraw-lbHint { display: none; }
  .dshdraw-lbPrev,
  .dshdraw-lbNext { width: 38px; height: 38px; }
}
.dshdraw-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  border-radius: 12px;
  padding: 14px 16px;
}
.dshdraw-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshdraw-fieldWide { grid-column: 1 / -1; }
.dshdraw-label {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  letter-spacing: 0.02em;
}
.dshdraw-input {
  appearance: none;
  font: inherit;
  font-size: 12px;
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
}
.dshdraw-input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dshdraw-check { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshdraw-check input { accent-color: var(--dsw-alias-brand-primary); }
.dshdraw-hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.45; word-break: break-all; }
.dshdraw-note { color: var(--dsw-alias-state-success-primary, #16a34a); font-size: 12px; }
.dshdraw-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  background: var(--dsw-alias-bg-module-platform);
  border-radius: 5px;
  padding: 1px 5px;
}
.dshdraw-empty { color: var(--dsw-alias-label-tertiary); font-size: 12px; padding: 8px 0; }
.dshdraw-error { color: var(--dsw-alias-state-error-primary, #b42318); font-size: 12px; }
`;

    function DrawPanelIcon({ size }) {
      return h('svg', {
        'data-dsh-panel-entry': PANEL_ID,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.3',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, [
        h('rect', { key: 'f', x: '2', y: '2.5', width: '12', height: '11', rx: '1.5' }),
        h('path', { key: 'h', d: 'M2 10.5l3.2-3 2.6 2.4 2.4-2.9 3.8 4' }),
        h('circle', { key: 'c', cx: '5.6', cy: '6', r: '1' }),
      ]);
    }

    function Panel() {
      const [state, setState] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [failed, setFailed] = React.useState('');
      const [starting, setStarting] = React.useState(false);
      const [viewer, setViewer] = React.useState(-1);
      const [note, setNote] = React.useState('');
      const [editing, setEditing] = React.useState(false);
      const [form, setForm] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [testing, setTesting] = React.useState(false);
      const [tested, setTested] = React.useState(null);
      const [notice, setNotice] = React.useState('');
      const openerRef = React.useRef(null);

      const load = React.useCallback(() => {
        setLoading(true);
        fetch(`${API}/state`, { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
          .then((body) => {
            setState(body);
            setFailed('');
          })
          .catch((error) => setFailed(String(error && error.message ? error.message : error)))
          .finally(() => setLoading(false));
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const start = () => {
        setStarting(true);
        fetch(`${API}/start`, { method: 'POST' })
          .catch(() => {})
          .then(() => {
            setStarting(false);
            load();
          });
      };

      // 打开表单时把服务端的原始值抄一份：用户改到一半刷新面板不该丢掉草稿。
      const openEditor = () => {
        const editable = state && state.editable;
        if (!editable) return;
        setForm({ ...editable });
        setTested(null);
        setNotice('');
        setEditing(true);
      };

      const closeEditor = () => {
        setEditing(false);
        setForm(null);
        setTested(null);
        setNotice('');
      };

      const setField = (key) => (event) => {
        const target = event && event.target;
        if (!target) return;
        const value = target.type === 'checkbox' ? Boolean(target.checked) : target.value;
        setForm((prev) => ({ ...(prev || {}), [key]: value }));
      };

      // 空串表示「这条不覆盖，回落到插件配置」——Host 侧 writeSettings 就是这么处理的，
      // 所以这里不做任何过滤，原样提交。
      const save = () => {
        if (!form) return;
        setSaving(true);
        setNotice('');
        const payload = {
          comfyBaseUrl: form.comfyBaseUrl,
          comfyRoot: form.comfyRoot,
          comfyPython: form.comfyPython,
          comfyMain: form.comfyMain,
          comfyWorkdir: form.comfyWorkdir,
          comfyArgs: form.comfyArgs,
          autoStart: form.autoStart,
          modelsRoot: form.modelsRoot,
          workflowsDir: form.workflowsDir,
          outputDir: form.outputDir,
          saveToWorkspace: form.saveToWorkspace,
          workspaceFolder: form.workspaceFolder,
          idleShutdown: form.idleShutdown,
          idleShutdownMs: Math.round((Number(form.idleMinutes) || 0) * 60000),
          idleShutdownScope: form.idleShutdownScope,
          timeoutMs: form.timeoutMs,
          startTimeoutMs: form.startTimeoutMs,
        };
        fetch(`${API}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then((res) => (res.ok ? res.json() : res.json().then((b) => Promise.reject(new Error((b && b.error) || `HTTP ${res.status}`)))))
          .then((body) => {
            setNotice('已保存，立即生效');
            setForm(body && body.editable ? { ...body.editable } : form);
            load();
          })
          .catch((error) => setNotice(`保存失败：${error && error.message ? error.message : error}`))
          .finally(() => setSaving(false));
      };

      const test = () => {
        setTesting(true);
        setTested(null);
        fetch(`${API}/test`, { method: 'POST' })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
          .then((body) => setTested(body))
          .catch((error) => setTested({ ok: false, online: false, error: String(error && error.message ? error.message : error) }))
          .finally(() => setTesting(false));
      };

      const online = Boolean(state && state.online);
      const stats = state && state.stats;
      const workflows = (state && state.workflows) || [];
      const recent = (state && state.recent) || [];
      const current = viewer >= 0 && viewer < recent.length ? recent[viewer] : null;
      const total = recent.length;

      const closeViewer = React.useCallback(() => {
        setViewer(-1);
        setNote('');
        const opener = openerRef.current;
        openerRef.current = null;
        if (opener && typeof opener.focus === 'function') opener.focus();
      }, []);

      const reveal = React.useCallback((name) => {
        setNote('');
        fetch(`${API}/reveal?name=${encodeURIComponent(name)}`, { method: 'POST' })
          .then((res) => (res.ok ? null : Promise.reject(new Error(`HTTP ${res.status}`))))
          .catch((error) => setNote(`定位失败：${error && error.message ? error.message : error}`));
      }, []);

      const stepViewer = React.useCallback((delta) => {
        setViewer((value) => {
          if (value < 0 || total === 0) return -1;
          return (value + delta + total) % total;
        });
      }, [total]);

      React.useEffect(() => {
        if (current === null) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeViewer();
            return;
          }
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            stepViewer(-1);
            return;
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            stepViewer(1);
          }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [current, closeViewer, stepViewer]);

      const idle = state && state.idle;
      const idleHint = idle && idle.enabled
        ? `空闲 ${Math.round(idle.idleMs / 60000)} 分钟后自动关闭${idle.scope === 'port' ? '（含端口上其他进程）' : '（仅本插件启动的进程）'}${online ? `（剩 ${Math.max(0, Math.round(idle.remainingMs / 60000))} 分）` : ''}`
        : '';

      const config = state && state.config;
      const configHint = config
        ? [
          config.workflowsDir ? `工作流 ${config.workflowsDir}` : '工作流目录未配置',
          config.modelsRoot ? `模型 ${config.modelsRoot}` : '',
          config.outputDir ? `出图 ${config.outputDir}` : (config.saveToWorkspace ? '出图存会话工作区' : '不保存出图'),
          !online && !config.comfyMain ? '未配置 ComfyUI 启动路径' : '',
        ].filter(Boolean).join(' · ')
        : '';
      const workflowErrors = (state && state.workflowErrors) || [];

      const field = (label, key, opts) => {
        const options = opts || {};
        const value = form && form[key] !== undefined && form[key] !== null ? form[key] : '';
        return h('div', {
          key: `f-${key}`,
          className: options.wide ? 'dshdraw-field dshdraw-fieldWide' : 'dshdraw-field',
        }, [
          h('label', { key: 'l', className: 'dshdraw-label', htmlFor: `dshdraw-${key}` }, label),
          h('input', {
            key: 'i',
            id: `dshdraw-${key}`,
            className: 'dshdraw-input',
            type: options.type || 'text',
            value,
            onChange: setField(key),
            spellCheck: false,
          }),
          options.hint ? h('div', { key: 'h', className: 'dshdraw-hint' }, options.hint) : null,
        ]);
      };

      const summaryItem = (label, value) => h('div', { key: `s-${label}`, className: 'dshdraw-field' }, [
        h('div', { key: 'l', className: 'dshdraw-label' }, label),
        h('div', { key: 'v', className: 'dshdraw-strong' }, value || '—'),
      ]);

      const statusLine = stats
        ? [
          h('span', { key: 'd', className: ['dshdraw-dot', online ? 'dshdraw-dotOn' : 'dshdraw-dotOff'].join(' ') }),
          h('span', { key: 't', className: 'dshdraw-strong' }, online ? 'ComfyUI 在线' : 'ComfyUI 离线'),
          h('span', { key: 'u' }, (state && state.baseUrl) || ''),
          h('span', { key: 'g' }, stats.name || ''),
          h('span', { key: 'v' }, `显存 ${stats.vramFreeMb} / ${stats.vramTotalMb} MB 空闲`),
          idleHint ? h('span', { key: 'auto', className: 'dshdraw-dim' }, idleHint) : null,
        ]
        : [
          h('span', { key: 'd', className: 'dshdraw-dot dshdraw-dotOff' }),
          h('span', { key: 't', className: 'dshdraw-strong' }, loading ? '检测中…' : 'ComfyUI 离线'),
          h('span', { key: 'u' }, (state && state.baseUrl) || ''),
          h('span', { key: 'h' }, '在本面板点「启动」即可无头拉起，约 30 秒'),
          idleHint ? h('span', { key: 'i', className: 'dshdraw-dim' }, idleHint) : null,
        ];

      return h('div', {
        className: 'dshdraw-root',
        'data-dsh-plugin': 'dsh-draw',
        'data-dsh-draw-view': '',
      }, [
        h('style', { key: 'css', 'data-plugin': '@local/dsh-draw', dangerouslySetInnerHTML: { __html: CSS } }),

        h('div', { key: 'head', className: 'dshdraw-head' }, [
          h('div', { key: 'txt', className: 'dshdraw-headText' }, [
            h('div', { key: 't', className: 'dshdraw-title' }, '画图模式'),
            h('div', { key: 's', className: 'dshdraw-sub' }, '本地 ComfyUI · 自带工作流即插即用 · 插件本身不带任何工作流与模型'),
          ]),
          h('div', { key: 'act', className: 'dshdraw-actions' }, [
            online
              ? null
              : h('button', {
                key: 'start',
                type: 'button',
                className: 'dshdraw-btn dshdraw-btnPrimary',
                disabled: starting,
                onClick: start,
              }, starting ? '启动中…' : '启动 ComfyUI'),
            h('button', {
              key: 'refresh',
              type: 'button',
              className: 'dshdraw-btn',
              disabled: loading,
              onClick: load,
            }, loading ? '刷新中…' : '刷新'),
          ]),
        ]),

        h('div', { key: 'status', className: 'dshdraw-status' }, statusLine),
        configHint ? h('div', { key: 'conf', className: 'dshdraw-dim dshdraw-conf' }, configHint) : null,
        failed ? h('div', { key: 'err', className: 'dshdraw-error' }, `接口异常：${failed}`) : null,

        h('div', { key: 'settings', className: 'dshdraw-section' }, [
          h('div', { key: 'bar', className: 'dshdraw-actions' }, [
            h('div', { key: 't', className: 'dshdraw-sectionTitle', style: { flex: 1, alignSelf: 'center' } }, '配置'),
            editing
              ? h('button', { key: 'test', type: 'button', className: 'dshdraw-btn', disabled: testing, onClick: test }, testing ? '测试中…' : '测试连接')
              : null,
            editing
              ? h('button', { key: 'save', type: 'button', className: 'dshdraw-btn dshdraw-btnPrimary', disabled: saving, onClick: save }, saving ? '保存中…' : '保存')
              : null,
            h('button', {
              key: 'edit',
              type: 'button',
              className: editing ? 'dshdraw-btn' : 'dshdraw-btn',
              disabled: !state || !state.editable,
              onClick: editing ? closeEditor : openEditor,
            }, editing ? '取消' : '编辑'),
          ]),

          notice ? h('div', { key: 'notice', className: 'dshdraw-note' }, notice) : null,
          tested
            ? h('div', { key: 'tested', className: tested.online ? 'dshdraw-note' : 'dshdraw-error' },
              tested.online
                ? `连接正常：${tested.baseUrl}（${tested.device || '未知设备'}，显存 ${tested.vramFreeMb ?? '?'} MB 空闲），找到 ${tested.workflows} 个工作流`
                : `连接失败：${tested.error || tested.baseUrl}`)
            : null,

          editing && form
            ? h('div', { key: 'form', className: 'dshdraw-form' }, [
              field('ComfyUI 地址', 'comfyBaseUrl', { hint: 'http://127.0.0.1:8188' }),
              field('ComfyUI 安装目录', 'comfyRoot', { hint: '用于推导 python / main.py / 模型目录，可留空' }),
              field('python 路径', 'comfyPython', { hint: '留空自动探测（便携包 python/、venv/）' }),
              field('main.py 路径', 'comfyMain', { hint: '留空用 <安装目录>/ComfyUI/main.py' }),
              field('工作目录', 'comfyWorkdir', { hint: '启动 ComfyUI 时的 cwd，留空同上' }),
              field('启动参数', 'comfyArgs', { hint: '空格分隔，例如 --lowvram --preview-method auto' }),
              field('模型目录', 'modelsRoot', { hint: '离线检查工作流要的模型在不在，留空自动推导' }),
              field('工作流目录', 'workflowsDir', { wide: true, hint: '把 ComfyUI「Save (API Format)」导出的 JSON 放进这个目录' }),
              field('出图目录', 'outputDir', { hint: '固定保存目录，留空则按下面的开关处理' }),
              field('会话工作区子目录', 'workspaceFolder', { hint: '存到工作区时用的文件夹名' }),
              field('空闲关闭阈值（分钟）', 'idleMinutes', { type: 'number', hint: '0 = 不关闭' }),
              field('单次出图超时（毫秒）', 'timeoutMs', { type: 'number' }),
              field('启动超时（毫秒）', 'startTimeoutMs', { type: 'number' }),
              h('div', { key: 'scope', className: 'dshdraw-field' }, [
                h('label', { key: 'l', className: 'dshdraw-label' }, '空闲关闭范围'),
                h('select', {
                  key: 'i',
                  className: 'dshdraw-input',
                  value: form.idleShutdownScope || 'spawned',
                  onChange: setField('idleShutdownScope'),
                }, [
                  h('option', { key: 's', value: 'spawned' }, '仅本插件启动的进程'),
                  h('option', { key: 'p', value: 'port' }, '端口上所有 ComfyUI'),
                ]),
              ]),
              h('div', { key: 'checks', className: 'dshdraw-field dshdraw-fieldWide' }, [
                h('label', { key: 'a', className: 'dshdraw-check' }, [
                  h('input', { key: 'i', type: 'checkbox', checked: Boolean(form.autoStart), onChange: setField('autoStart') }),
                  h('span', { key: 's' }, '不在线时自动无头启动'),
                ]),
                h('label', { key: 'b', className: 'dshdraw-check' }, [
                  h('input', { key: 'i', type: 'checkbox', checked: Boolean(form.saveToWorkspace), onChange: setField('saveToWorkspace') }),
                  h('span', { key: 's' }, '没设出图目录时，把图存进会话工作区'),
                ]),
                h('label', { key: 'c', className: 'dshdraw-check' }, [
                  h('input', { key: 'i', type: 'checkbox', checked: Boolean(form.idleShutdown), onChange: setField('idleShutdown') }),
                  h('span', { key: 's' }, '空闲后关闭 ComfyUI 释放显存'),
                ]),
              ]),
              h('div', { key: 'file', className: 'dshdraw-hint dshdraw-fieldWide' },
                `保存到 ${(state && state.settingsFile) || ''}；留空的项不覆盖插件配置。`),
            ])
            : h('div', { key: 'summary', className: 'dshdraw-form' }, [
              summaryItem('ComfyUI', config ? config.baseUrl : ''),
              summaryItem('工作流目录', config ? (config.workflowsDir || '未配置') : ''),
              summaryItem('出图目录', config
                ? (config.outputDir || (config.saveToWorkspace ? `会话工作区/${config.workspaceFolder}` : '不保存'))
                : ''),
              summaryItem('模型目录', config ? (config.modelsRoot || '未配置') : ''),
              summaryItem('无头启动', config
                ? (config.autoStart ? `开启${config.comfyMain ? ` · ${config.comfyMain}` : ''}` : '关闭')
                : ''),
              summaryItem('空闲关闭', config
                ? (config.idleShutdown ? `${Math.round(config.idleShutdownMs / 60000)} 分钟` : '关闭')
                : ''),
            ]),
        ]),

        h('div', { key: 'workflows', className: 'dshdraw-section' }, [
          h('div', { key: 't', className: 'dshdraw-sectionTitle' }, `工作流（${workflows.length}）`),
          (state && state.workflowsDir)
            ? h('div', { key: 'dir', className: 'dshdraw-hint' }, `目录：${state.workflowsDir}`)
            : h('div', { key: 'dir', className: 'dshdraw-hint' }, '还没配置工作流目录，点上面的「编辑」填一个'),
          workflows.length === 0
            ? h('div', { key: 'e', className: 'dshdraw-empty' },
              '这个目录里还没有工作流。在 ComfyUI 里点「Save (API Format)」导出 JSON，丢进上面的目录，刷新即可。')
            : h('table', { key: 'tb', className: 'dshdraw-table' }, [
              h('thead', { key: 'h' }, h('tr', null, [
                h('th', { key: 'a' }, '工作流'),
                h('th', { key: 'b' }, '任务'),
                h('th', { key: 'c' }, '默认参数'),
                h('th', { key: 'd' }, '可传输入'),
                h('th', { key: 'e' }, '备注'),
              ])),
              h('tbody', { key: 'b' }, workflows.map((wf) => h('tr', { key: wf.id }, [
                h('td', { key: 'a' }, wf.label && wf.label !== wf.id ? `${wf.label}\n${wf.id}` : wf.id),
                h('td', { key: 'b' }, TASK_LABEL[wf.task] || wf.task),
                h('td', { key: 'c' }, Object.entries(wf.defaults || {}).map(([k, v]) => `${k}=${v}`).join(' ') || '—'),
                h('td', { key: 'd' }, (wf.inputs || []).join(', ') || '—'),
                h('td', { key: 'e' }, wf.notes || ''),
              ]))),
            ]),
          workflowErrors.length === 0
            ? null
            : h('div', { key: 'errors', className: 'dshdraw-error' },
              workflowErrors.map((e) => `${e.file}：${e.error}`).join('；')),
        ]),

        h('div', { key: 'recent', className: 'dshdraw-section' }, [
          h('div', { key: 't', className: 'dshdraw-sectionTitle' }, `最近出图（${recent.length}）`),
          recent.length === 0
            ? h('div', { key: 'e', className: 'dshdraw-empty' }, '还没有出图记录')
            : h('div', { key: 'g', className: 'dshdraw-grid' }, recent.map((item, index) => h('div', {
              key: item.name,
              className: 'dshdraw-thumb',
              role: 'button',
              tabIndex: 0,
              title: `${item.name}（点击查看大图）`,
              'aria-label': `查看大图：${item.name}`,
              onClick: (event) => {
                openerRef.current = event.currentTarget;
                setViewer(index);
              },
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                openerRef.current = event.currentTarget;
                setViewer(index);
              },
            }, [
              h('img', { key: 'i', src: imageUrl(item.name), alt: item.name, loading: 'lazy' }),
              h('span', { key: 'n', className: 'dshdraw-thumbName' }, item.name),
            ]))),
        ]),

        current === null
          ? null
          : portal(h('div', {
            key: 'lightbox',
            className: 'dshdraw-lb',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': `查看大图：${current.name}`,
            onClick: closeViewer,
          }, [
            h('div', { key: 'bar', className: 'dshdraw-lbBar' }, [
              h('span', { key: 'n', className: 'dshdraw-lbName' }, current.name),
              h('span', { key: 'm', className: 'dshdraw-lbMeta' }, formatSize(current.size)),
            ]),
            h('img', {
              key: 'i',
              className: 'dshdraw-lbImg',
              src: imageUrl(current.name),
              alt: current.name,
              draggable: false,
              onClick: (event) => event.stopPropagation(),
            }),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'dshdraw-lbClose',
              'aria-label': '关闭',
              onClick: closeViewer,
            }, '×'),
            total > 1
              ? h('button', {
                key: 'prev',
                type: 'button',
                className: 'dshdraw-lbNav dshdraw-lbPrev',
                'aria-label': '上一张',
                onClick: (event) => {
                  event.stopPropagation();
                  stepViewer(-1);
                },
              }, '‹')
              : null,
            total > 1
              ? h('button', {
                key: 'next',
                type: 'button',
                className: 'dshdraw-lbNav dshdraw-lbNext',
                'aria-label': '下一张',
                onClick: (event) => {
                  event.stopPropagation();
                  stepViewer(1);
                },
              }, '›')
              : null,
            h('div', { key: 'foot', className: 'dshdraw-lbFoot' }, [
              DESKTOP_SHELL
                ? h('button', {
                  key: 'reveal',
                  type: 'button',
                  className: 'dshdraw-lbLink dshdraw-lbAction',
                  onClick: (event) => {
                    event.stopPropagation();
                    reveal(current.name);
                  },
                }, '在文件夹中显示')
                : h('a', {
                  key: 'open',
                  className: 'dshdraw-lbLink',
                  href: imageUrl(current.name),
                  target: '_blank',
                  rel: 'noreferrer',
                  onClick: (event) => event.stopPropagation(),
                }, '新标签页打开'),
              note
                ? h('span', { key: 'note', className: 'dshdraw-lbNote' }, note)
                : null,
              h('span', { key: 'hint', className: 'dshdraw-lbHint' }, 'Esc 关闭 · ← → 切换'),
            ]),
          ])),
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots;
        const disposers = [];
        disposers.push(slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          label: () => '画图',
        }, DrawPanelIcon)));
        disposers.push(slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
        }, Panel)));
        ctx.effect(() => () => {
          for (const dispose of disposers.splice(0)) dispose();
        });
      },
    };
  },
});
