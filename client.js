/**
 * @local/dsh-draw — 画图模式面板（浏览器半边）
 *
 * 在左侧全局导航里加一行「画图」，点开后在中央列显示画图模式的状态面板：
 * ComfyUI 连通性 / GPU 显存、三族模型规格、工作流库清单、最近出图缩略图。
 * 数据来自 Host 半边注册的只读 HTTP 接口（/draw-mode/api/*），与 Web GUI 同源。
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

    const FAMILY_META = {
      anima: { name: 'Anima · SilvermoonMix', dialect: 'Danbooru 标签流，逗号分隔' },
      krea2: { name: 'Krea 2 Turbo', dialect: '自然语言长句，摄影术语优先' },
      qwen21: { name: 'Qwen-Image 2.1', dialect: '自然语言描述，可含中文字' },
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

      const online = Boolean(state && state.online);
      const stats = state && state.stats;
      const workflows = (state && state.workflows) || [];
      const families = (state && state.families) || [];
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
          config.modelsRoot ? `模型 ${config.modelsRoot}` : '模型目录未配置',
          config.outputDir ? `出图 ${config.outputDir}` : (config.saveToWorkspace ? '出图存会话工作区' : '不保存出图'),
          !online && !config.comfyMain ? '未配置 ComfyUI 启动路径' : '',
        ].filter(Boolean).join(' · ')
        : '';

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
            h('div', { key: 's', className: 'dshdraw-sub' }, '本地 ComfyUI · Anima / Krea2 / Qwen-Image 2.1 · 按模型扩写提示词与反推'),
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

        h('div', { key: 'families', className: 'dshdraw-section' }, [
          h('div', { key: 't', className: 'dshdraw-sectionTitle' }, '模型族'),
          h('div', { key: 'c', className: 'dshdraw-cards' }, families.map((family) => {
            const meta = FAMILY_META[family.id] || { name: family.id, dialect: '' };
            return h('div', { key: family.id, className: 'dshdraw-card' }, [
              h('div', { key: 'n', className: 'dshdraw-cardName' }, meta.name),
              h('div', { key: 'm', className: 'dshdraw-cardMeta' },
                `${family.width}×${family.height} · ${family.steps} 步 · cfg ${family.cfg}`),
              h('div', { key: 'd', className: 'dshdraw-cardDialect' }, meta.dialect),
              h('div', { key: 'w', className: 'dshdraw-cardDialect' }, family.workflows.join(' · ')),
            ]);
          })),
        ]),

        h('div', { key: 'workflows', className: 'dshdraw-section' }, [
          h('div', { key: 't', className: 'dshdraw-sectionTitle' }, `工作流库（${workflows.length}）`),
          workflows.length === 0
            ? h('div', { key: 'e', className: 'dshdraw-empty' }, '暂无工作流')
            : h('table', { key: 'tb', className: 'dshdraw-table' }, [
              h('thead', { key: 'h' }, h('tr', null, [
                h('th', { key: 'a' }, '工作流'),
                h('th', { key: 'b' }, '任务'),
                h('th', { key: 'c' }, '族'),
                h('th', { key: 'd' }, '默认尺寸'),
                h('th', { key: 'e' }, '步数 / CFG'),
                h('th', { key: 'f' }, '备注'),
              ])),
              h('tbody', { key: 'b' }, workflows.map((wf) => h('tr', { key: wf.id }, [
                h('td', { key: 'a' }, wf.id),
                h('td', { key: 'b' }, TASK_LABEL[wf.task] || wf.task),
                h('td', { key: 'c' }, wf.family),
                h('td', { key: 'd' }, wf.width ? `${wf.width}×${wf.height}` : '跟随输入'),
                h('td', { key: 'e' }, wf.steps ? `${wf.steps} / ${wf.cfg}` : '—'),
                h('td', { key: 'f' }, wf.notes || ''),
              ]))),
            ]),
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
