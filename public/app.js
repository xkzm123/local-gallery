/* ============================================================
   本地图库 · 前端
   ============================================================ */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const IMG_RE = /\.(webp|jpe?g|png|gif|avif|bmp|jfif|tiff?)$/i;

  const DEFAULT_UI = {
    view: 'grid', cols: 4, gap: 4, fit: 'auto', theme: 'light',
    rot: 0, autoSpeed: 90, autoMode: 'scroll', autoStep: 6, slideSec: 6, playMode: 'loop', twoH: 100, twoCols: 2,
    recursive: false, showIndex: false, sort: 'name',
  };

  const S = {
    rootPath: '',
    configuredRoot: '',
    rootMissing: false,
    cfgLoaded: false,
    cfgError: '',
    ui: Object.assign({}, DEFAULT_UI),
    cfgPath: '',
    places: [],

    path: '',
    dirs: [],
    items: [],
    list: [],
    q: '',
    loaded: 0,

    autoOn: false,
    slideshow: false,
    lbIndex: -1,
    zoom: 1,
    panX: 0,
    panY: 0,
    lbRot: 0,
    local: false,
    pending: null,
    pickerCur: '',
  };

  const view = () => S.ui.view;
  const fitMode = () => S.ui.fit;

  // ------------------------------------------------------------ 基础
  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 1800);
  }

  async function api(url, opts) {
    const r = await fetch(url, opts);
    let j = null;
    try { j = await r.json(); } catch (e) { }
    if (!r.ok) {
      const err = new Error((j && j.error) || ('HTTP ' + r.status));
      err.status = r.status;
      throw err;
    }
    return j;
  }

  async function saveConfig(patch) {
    const r = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (typeof r.root === 'string') S.rootPath = r.root;
    if (r.ui) S.ui = Object.assign({}, S.ui, r.ui);
    if (r.configPath) S.cfgPath = r.configPath;
    return r;
  }

  // ---- 自动保存：任何设置变更都立刻写盘，不用点按钮 ----
  let saveTimer = 0;
  let savePending = false;

  function collectUi() {
    return {
      view: S.ui.view, cols: S.ui.cols, gap: S.ui.gap, fit: S.ui.fit,
      theme: S.ui.theme, rot: S.ui.rot, autoSpeed: S.ui.autoSpeed,
      autoMode: S.ui.autoMode, autoStep: S.ui.autoStep,
      slideSec: S.ui.slideSec, playMode: S.ui.playMode, twoH: S.ui.twoH || 100, twoCols: S.ui.twoCols || 2,
      recursive: S.ui.recursive,
      showIndex: !!S.ui.showIndex,
    };
  }

  function setSaveState(kind, msg) {
    const e = $('#saveState');
    if (!e) return;
    e.className = 'save-state' + (kind ? ' ' + kind : '');
    e.textContent = msg || '';
  }

  async function doSave() {
    savePending = false;
    try {
      const r = await saveConfig({ ui: collectUi() });
      if (r && r.onDiskRoot !== undefined && r.onDiskRoot !== null
          && r.onDiskRoot !== (r.configuredRoot || '')) {
        setSaveState('err', '写盘校验失败，请检查 config.json');
        return r;
      }
      if (r && typeof r.configuredRoot === 'string') S.configuredRoot = r.configuredRoot;
      setSaveState('ok', '已保存 · ' + new Date().toLocaleTimeString());
      return r;
    } catch (e) {
      setSaveState('err', '保存失败：' + e.message);
      toast('设置没保存上：' + e.message);
      throw e;
    }
  }

  function autoSave() {
    clearTimeout(saveTimer);
    savePending = true;
    setSaveState('', '保存中…');
    saveTimer = setTimeout(() => { doSave().catch(() => { }); }, 250);
  }

  /**
   * 页面被隐藏 / 切后台 / 关掉时，立刻把待保存的设置发出去。
   * 手机端改完设置直接切走很常见，400ms 的防抖等不到就会丢。
   */
  function flushSave() {
    if (!savePending) return;
    savePending = false;
    clearTimeout(saveTimer);
    try {
      fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ui: collectUi() }),
        keepalive: true,
      }).catch(() => { });
    } catch (e) { }
  }

  const srcOf = (it) => it.url || ('/img?p=' + encodeURIComponent(it.p));

  function aspectOf(it) {
    const w = it.w || 0, h = it.h || 0;
    return w > 0 && h > 0 ? w / h : 3 / 4;
  }

  function fmtSize(n) {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  }

  // ------------------------------------------------------------ 设置应用
  function applyTheme() {
    document.documentElement.dataset.theme = S.ui.theme === 'dark' ? 'dark' : 'light';
    const m = $('meta[name=theme-color]');
    if (m) m.setAttribute('content', S.ui.theme === 'dark' ? '#0d0e10' : '#ffffff');
    $('#btnTheme').classList.toggle('on', S.ui.theme === 'dark');
  }

  function applyLayoutVars() {
    document.documentElement.style.setProperty('--gap', S.ui.gap + 'px');
    const twoCols = Math.max(2, Math.min(6, S.ui.twoCols || 2));
    document.documentElement.style.setProperty('--two-cols', String(twoCols));

    let c = S.ui.cols;
    if (view() === 'two') {
      c = twoCols;                            // 多列模式：2–6 列
    } else {
      // 配置里存了多少列就用多少列；只在窄屏上收上限，免得手机上被挤成一条
      const vw = window.innerWidth;
      const cap = vw < 480 ? 3 : vw < 760 ? 4 : 8;
      c = Math.min(c, cap);
    }
    c = Math.max(1, Math.min(8, c));
    document.documentElement.style.setProperty('--cols', String(c));
    S._cols = c;
    unlockScroll();
    document.body.classList.toggle('view-two', view() === 'two');
    document.body.classList.toggle('view-single', view() === 'single');
    document.body.classList.toggle('show-idx', !!S.ui.showIndex);
    $('#btnGrid').classList.toggle('on', view() === 'grid');
    $('#btnTwo').classList.toggle('on', view() === 'two');
    $('#btnSingle').classList.toggle('on', view() === 'single');
    const colRange = $('#setCols');
    if (colRange) colRange.disabled = view() === 'two';
  }

  function applyAll() {
    applyTheme();
    applyLayoutVars();
    applyBoxes();
    syncSettingsUI();
  }

  // ------------------------------------------------------------ 目录树
  function nodeEl(dir, depth) {
    const node = el('div', 'node' + (depth ? ' child' : ''));
    const tw = el('span', 'tw', (dir.sub || dir.count) ? '\u25b6' : '');
    const nm = el('span', 'nm', dir.n);
    const ct = el('span', 'ct', dir.count ? String(dir.count) : (dir.sub ? '\u00b7' : ''));
    node.title = dir.p;
    if (dir.p === S.path) node.classList.add('active');
    node.append(tw, nm, ct);

    const kids = el('div', '');
    kids.hidden = true;
    node.__kids = kids;
    node.__dir = dir;
    node.__depth = depth;

    node.addEventListener('click', (ev) => {
      if (ev.target === tw) { toggleNode(node); return; }
      openDir(dir.p);
    });
    return node;
  }

  async function toggleNode(node, silent) {
    const kids = node.__kids;
    const tw = node.querySelector('.tw');
    if (!kids.hidden) { kids.hidden = true; tw.classList.remove('open'); return; }
    if (!kids.__filled) {
      try {
        const d = await api('/api/list?p=' + encodeURIComponent(node.__dir.p));
        if (!d.dirs.length) { if (!silent) toast('没有子文件夹'); return; }
        for (const sub of d.dirs) {
          const n = nodeEl(sub, node.__depth + 1);
          kids.appendChild(n);
          kids.appendChild(n.__kids);
        }
        kids.__filled = true;
      } catch (e) { if (!silent) toast('读取失败：' + e.message); return; }
    }
    kids.hidden = false;
    tw.classList.add('open');
  }

  async function renderTree() {
    const tree = $('#tree');
    tree.innerHTML = '';
    if (!S.rootPath) { tree.appendChild(el('div', 'hint', '还没有设置图库目录')); return; }
    try {
      // 侧栏始终以「图库根」为起点，这样进到子目录也不会丢失上一层结构
      const d = await api('/api/list?p=');
      if (!d.dirs.length) {
        tree.appendChild(el('div', 'hint', '根目录下没有子文件夹'));
        return;
      }
      for (const sub of d.dirs) {
        const n = nodeEl(sub, 0);
        tree.appendChild(n);
        tree.appendChild(n.__kids);
      }
      if (S.path) await expandTo(S.path);
      markActive();
    } catch (e) {
      tree.appendChild(el('div', 'hint', '读取目录失败：' + e.message));
    }
  }

  /** 把当前路径的整条祖先链在树里展开 */
  async function expandTo(path) {
    const segs = String(path).split('/').filter(Boolean);
    let acc = '';
    for (const seg of segs) {
      acc = acc ? acc + '/' + seg : seg;
      const node = $$('#tree .node').find((n) => n.__dir && n.__dir.p === acc);
      if (!node) return;
      if (node.__kids.hidden) await toggleNode(node, true);
    }
  }

  function markActive() {
    $$('#tree .node').forEach((n) => n.classList.toggle('active', n.__dir && n.__dir.p === S.path));
  }

  // ------------------------------------------------------------ 标题
  function currentLabel() {
    if (S.local) return '本地拖入';
    if (S.path) return S.path.split('/').pop();
    if (S.rootPath) {
      const parts = S.rootPath.split(/[\\/]/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : S.rootPath;
    }
    return '图库';
  }

  function updateHeader() {
    $('#docTitle').textContent = currentLabel();
    $('#docTitle').title = S.path || S.rootPath || '';
    const total = S.list.length;
    const size = S.list.reduce((a, b) => a + (b.s || 0), 0);
    const bits = [];
    if (S.items.length) {
      bits.push(S.q ? total + ' / ' + S.items.length + ' 张' : total + ' 张');
      if (size) bits.push(fmtSize(size));
      if (S.autoOn) bits.push('滚动中');
    }
    $('#docMeta').textContent = bits.join(' \u00b7 ');
  }

  // ------------------------------------------------------------ 打开目录
  let openSeq = 0;

  function syncURL(p, replace) {
    try {
      const u = new URL(location.href);
      if (p) u.searchParams.set('p', p); else u.searchParams.delete('p');
      const st = { p: p || '' };
      if (replace) history.replaceState(st, '', u);
      else history.pushState(st, '', u);
    } catch (e) { }
  }

  async function openDir(p, opts) {
    opts = opts || {};
    const seq = ++openSeq;
    unlockScroll();
    S.path = p || '';
    S.local = false;
    // 换目录时把搜索词清掉，否则进新相册会直接显示「没有匹配的图片」
    if (S.q) { S.q = ''; const qi = $('#q'); if (qi) qi.value = ''; }
    if (opts.history !== false) syncURL(S.path, opts.replace);
    markActive();

    if (!S.cfgLoaded) { renderEmpty('cfg-error', S.cfgError); return; }
    if (!S.rootPath) { renderEmpty(S.rootMissing ? 'root-missing' : 'no-root'); return; }

    try {
      const qs = '/api/list?p=' + encodeURIComponent(S.path) + (S.ui.recursive ? '&recursive=1' : '');
      const d = await api(qs);
      if (seq !== openSeq) return;

      S.dirs = d.dirs || [];
      S.items = d.files || [];
      render();
      markActive();
      renderTree();
      if (d.truncated) toast('文件太多，只加载了前 ' + S.items.length + ' 张');

      // 只有「点进一个纯目录壳」才自动往下钻；图库根目录永远停在相册列表页，
      // 否则相册墙永远看不到，点「根目录」也会被弹回最大的那个相册。
      if (!S.items.length && S.dirs.length && S.path && opts.auto !== false) {
        const target = await findGalleryDir(S.dirs, 0);
        if (target && target !== S.path) {
          openDir(target, { auto: false, replace: true });   // 同步 URL，刷新/分享才对得上
          return;
        }
      }
      if (!S.items.length && S.dirs.length) renderFolders();
      else if (!S.items.length) renderEmpty('no-image');
    } catch (e) {
      if (e.status === 409) {
        S.rootPath = '';
        // 目录可能是在运行中被删/断开的：回读一次配置，别一律当成「还没选目录」
        try {
          const c = await api('/api/config');
          S.configuredRoot = c.configuredRoot || '';
          S.rootMissing = !!c.rootMissing;
        } catch (err) { }
        renderEmpty(S.rootMissing ? 'root-missing' : 'no-root');
        return;
      }
      renderEmpty('error', e.message);
    }
  }

  async function findGalleryDir(dirs, depth) {
    let best = null;
    for (const d of dirs) if (d.count > 0 && (!best || d.count > best.count)) best = d;
    if (best) return best.p;
    if (depth >= 3) return null;
    for (const d of dirs) {
      if (!d.sub) continue;
      try {
        const sub = await api('/api/list?p=' + encodeURIComponent(d.p));
        const r = await findGalleryDir(sub.dirs || [], depth + 1);
        if (r) return r;
      } catch (e) { }
    }
    return null;
  }

  // ------------------------------------------------------------ 空状态
  function renderEmpty(kind, msg) {
    const box = $('#empty');
    box.innerHTML = '';
    box.hidden = false;
    $('#gallery').innerHTML = '';
    S.list = [];

    if (kind === 'no-root') {
      box.appendChild(el('div', 'e1', '还没有选择图库目录'));
      box.appendChild(el('div', 'e2', '选一个放图片的文件夹。选择会记在 gallery/config.json，下次打开直接用。'));
      const b = el('button', 'btn primary', '选择图库目录');
      b.addEventListener('click', () => openPicker(''));
      box.appendChild(b);
    } else if (kind === 'cfg-error') {
      box.appendChild(el('div', 'e1', '读不到服务端配置'));
      box.appendChild(el('div', 'e2', msg || '请确认服务还在运行'));
      const b = el('button', 'btn primary', '重新加载');
      b.addEventListener('click', () => location.reload());
      box.appendChild(b);
      // config.json 被写坏（比如记事本存成了带 BOM 的 UTF-8）时，重选一次目录就能覆盖修复
      const b2 = el('button', 'btn', '重新选择图库目录');
      b2.style.marginLeft = '8px';
      b2.addEventListener('click', () => openPicker(''));
      box.appendChild(b2);
    } else if (kind === 'root-missing') {
      box.appendChild(el('div', 'e1', '上次用的图库目录现在打不开'));
      box.appendChild(el('div', 'e2', S.configuredRoot || ''));
      const b1 = el('button', 'btn primary', '重新选择图库目录');
      b1.addEventListener('click', () => openPicker(''));
      box.appendChild(b1);
      const b2 = el('button', 'btn', '清空这个设置');
      b2.style.marginLeft = '8px';
      b2.addEventListener('click', async () => {
        try {
          await saveConfig({ root: '' });
          S.rootPath = ''; S.configuredRoot = ''; S.rootMissing = false;
          renderEmpty('no-root');
        } catch (e) { toast('清空失败：' + e.message); }
      });
      box.appendChild(b2);
    } else if (kind === 'error') {
      box.appendChild(el('div', 'e1', '加载失败'));
      box.appendChild(el('div', 'e2', msg || ''));
      const b = el('button', 'btn', '重试');
      b.addEventListener('click', () => openDir(S.path));
      box.appendChild(b);
    } else if (kind === 'no-image') {
      box.appendChild(el('div', 'e1', '这个文件夹里没有图片'));
      box.appendChild(el('div', 'e2', '把图片放进来后刷新，或直接把文件夹拖进页面（仅本机可见）。'));
    } else {
      box.appendChild(el('div', 'e1', '空目录'));
    }
    updateHeader();
  }

  // ------------------------------------------------------------ 渲染
  function filtered() {
    const q = S.q.trim().toLowerCase();
    if (!q) return S.items;
    return S.items.filter((it) => it.n.toLowerCase().indexOf(q) >= 0);
  }

  function applyCellBox(c) {
    const it = c.__it;
    const ph = c.querySelector('.ph');
    const im = c.__img;
    if (!ph || !im || !it) return;
    const single = view() === 'single';
    // 单列固定按原图比例（不拉伸），网格才听设置
    const f = single ? 'auto' : S.ui.fit;
    const a = aspectOf(it);
    const cw = c.__cw || 240;

    // 180°：盒子比例不变，只要把图翻过来（原来这里被漏掉，180° 完全不生效）
    if (S.ui.rot === 180) {
      ph.style.aspectRatio = String(a);
      ph.style.height = '';
      ph.style.minHeight = '';
      im.style.position = 'absolute';
      im.style.width = '100%';
      im.style.height = '100%';
      im.style.objectFit = (f === 'auto') ? 'cover' : f;
      im.style.transform = 'translate(-50%,-50%) rotate(180deg)';
      return;
    }

    // 旋转：必须用绝对定位 + px 盒子，按旋转后的真实比例算
    if (S.ui.rot % 180 !== 0) {
      const bh = cw * a;
      ph.style.aspectRatio = '';
      ph.style.height = bh.toFixed(2) + 'px';
      im.style.position = '';
      im.style.width = bh.toFixed(2) + 'px';
      im.style.height = cw.toFixed(2) + 'px';
      im.style.objectFit = 'fill';
      im.style.transform = 'translate(-50%,-50%) rotate(' + S.ui.rot + 'deg)';
      return;
    }

    // 多列 + 图片缩放：格子按原图比例，只把图片放大/缩小
    if (view() === 'two') {
      const k = Math.max(0.6, Math.min(1.5, (S.ui.twoH || 100) / 100));
      ph.style.aspectRatio = String(a);
      ph.style.height = '';
      im.style.position = 'absolute';
      im.style.width = '100%';
      im.style.height = '100%';
      im.style.objectFit = 'cover';
      im.style.transform = 'translate(-50%,-50%) scale(' + k + ')';
      return;
    }

    // 其余：满格铺排
    ph.style.height = '';
    ph.style.minHeight = '';
    ph.style.aspectRatio = (f === 'auto') ? String(a) : '3 / 4';
    im.style.position = 'absolute';
    im.style.width = '100%';
    im.style.height = '100%';
    im.style.objectFit = (f === 'auto') ? 'cover' : f;
    im.style.transform = 'translate(-50%,-50%)';
  }

  function applyBoxes() {
    const cells = $$('#gallery .cell');
    if (!cells.length) return;
    const cw = cells[0].getBoundingClientRect().width || 240;
    for (const c of cells) { c.__cw = cw; applyCellBox(c); }
  }

  function loadCell(c) {
    const im = c.__img;
    if (!im) return;
    if (S.pending) S.pending.delete(c);
    if (im.getAttribute('src')) return;
    im.src = srcOf(c.__it);
  }

  function scheduleSweep() {
    if (scheduleSweep.raf) return;
    scheduleSweep.raf = requestAnimationFrame(() => {
      scheduleSweep.raf = 0;
      sweepNow();
      // 轮询可能已经自己停了，滚动/缩放时再叫醒一次
      if (!sweepTimer && S.pending && S.pending.size) startSweepLoop();
    });
  }

  function sweepNow() {
    if (!S.pending || !S.pending.size) return;
    const vh = window.innerHeight || 800;
    for (const c of Array.from(S.pending)) {
      const r = c.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) { loadCell(c); continue; }
      if (r.top < vh * 2.5 && r.bottom > -vh * 1.5) loadCell(c);
    }
  }

  let sweepTimer = 0;
  /**
   * 视口外还没加载的图靠这个轮询补。
   * 关键：用户不滚动就不会有新图需要加载，所以连续几轮没有进展就停下，等 scroll / resize
   * 再唤醒；否则图一多就变成每 600ms 对上千个节点做 getBoundingClientRect，纯白烧 CPU。
   */
  function startSweepLoop() {
    clearInterval(sweepTimer);
    sweepTimer = 0;
    if (!S.pending || !S.pending.size) return;
    let lastSize = S.pending.size;
    let idle = 0;
    sweepTimer = setInterval(() => {
      if (!S.pending || !S.pending.size) { clearInterval(sweepTimer); sweepTimer = 0; return; }
      sweepNow();
      if (S.pending.size === lastSize) {
        if (++idle >= 4) { clearInterval(sweepTimer); sweepTimer = 0; }
      } else {
        lastSize = S.pending.size;
        idle = 0;
      }
    }, 600);
  }

  function cellEl(it, idx) {
    const c = el('div', 'cell');
    const ph = el('div', 'ph');
    const im = el('img');
    im.alt = it.n;
    im.decoding = 'async';
    im.draggable = false;
    im.style.transform = 'translate(-50%,-50%)';
    const badge = el('div', 'idx', String(idx + 1));
    badge.title = it.n;

    im.addEventListener('load', () => {
      im.classList.add('loaded');
      ph.classList.add('done');
      const nw = im.naturalWidth || 0;
      const nh = im.naturalHeight || 0;
      if (nw && nh && (nw !== it.w || nh !== it.h)) {
        it.w = nw;
        it.h = nh;
        applyCellBox(c);
      }
      S.loaded++;
    }, { once: true });

    im.addEventListener('error', () => {
      ph.classList.add('done');
      ph.appendChild(el('div', 'ph-fail', '加载失败'));
      im.remove();
      c.__img = null;
    }, { once: true });

    ph.appendChild(im);
    c.append(ph, badge);
    c.__it = it;
    c.__img = im;
    c.__idx = idx;
    c.addEventListener('click', () => openLB(c.__idx));
    return c;
  }

  function render() {
    const g = $('#gallery');
    const box = $('#empty');
    g.innerHTML = '';
    box.hidden = true;
    box.innerHTML = '';

    S.list = filtered();
    S.list.forEach((it, i) => { it.__idx = i; });

    if (!S.list.length) {
      if (S.items.length) {
        box.hidden = false;
        box.appendChild(el('div', 'e1', '没有匹配的图片'));
        box.appendChild(el('div', 'e2', '换个关键词试试'));
        updateHeader();
      } else {
        renderEmpty('no-image');
      }
      return;
    }

    let lastFolder = null;
    const frag = document.createDocumentFragment();
    S.list.forEach((it, i) => {
      if (S.ui.recursive || S.local) {
        const f = it.f == null ? '' : it.f;
        if (f !== lastFolder) {
          lastFolder = f;
          const head = el('div', 'group-head');
          head.appendChild(el('span', null, f ? f.split('/').pop() : currentLabel()));
          const cnt = S.list.filter((x) => (x.f == null ? '' : x.f) === f).length;
          head.appendChild(el('span', 'ct', cnt + ' 张'));
          frag.appendChild(head);
        }
      }
      frag.appendChild(cellEl(it, i));
    });
    g.appendChild(frag);

    applyBoxes();
    S.pending = new Set($$('#gallery .cell'));
    Array.from(S.pending).slice(0, 8).forEach(loadCell);
    scheduleSweep();
    startSweepLoop();
    updateHeader();
  }

  function renderFolders() {
    const box = $('#empty');
    box.hidden = false;
    box.innerHTML = '';
    const wrap = el('div', 'folders');
    for (const d of S.dirs) {
      const card = el('div', 'fc');
      const v = el('div', 'fcv');
      if (d.cover) {
        const im = el('img');
        im.loading = 'lazy';
        im.decoding = 'async';
        im.addEventListener('load', () => im.classList.add('loaded'), { once: true });
        im.src = '/img?p=' + encodeURIComponent((d.p ? d.p + '/' : '') + d.cover);
        v.appendChild(im);
      }
      const meta = el('div', 'fcm');
      meta.appendChild(el('div', 'fcn', d.n));
      const info = [];
      if (d.count) info.push(d.count + ' 张');
      if (d.sub) info.push(d.sub + ' 个子目录');
      meta.appendChild(el('div', 'fcc', info.join(' \u00b7 ') || '空'));
      card.append(v, meta);
      card.addEventListener('click', () => openDir(d.p));
      wrap.appendChild(card);
    }
    box.appendChild(wrap);
    updateHeader();
  }

  // ------------------------------------------------------------ 自动滚动
  let autoTimer = 0;
  let lastT = 0;

  let lastStep = 0;

  // ---------------- 长按唤出滚动调节 ----------
  function syncSpeedPop() {
    $('#popSpeed').value = S.ui.autoSpeed;
    $('#popSpeedV').textContent = S.ui.autoSpeed + ' px/s';
    $('#popStep').value = S.ui.autoStep;
    $('#popStepV').textContent = S.ui.autoStep + ' s';
    $('#popSlide').value = S.ui.slideSec;
    $('#popSlideV').textContent = S.ui.slideSec + ' s';
    const stepMode = S.ui.autoMode === 'step';
    $('#popSpeed').style.opacity = stepMode ? '.3' : '1';
    $('#popStep').style.opacity = stepMode ? '1' : '.3';
    const tc = S.ui.twoCols || 2;
    $$('#popColsSeg .pseg').forEach((b) => b.classList.toggle('on', Number(b.dataset.c) === tc));
    $('#popTwoH').value = S.ui.twoH || 100;
    $('#popTwoHV').textContent = (S.ui.twoH || 100) + '%';
    const m = $('#popMode');
    if (m) {
      m.textContent = stepMode
        ? '当前：按间隔跳，每 ' + S.ui.autoStep + ' 秒翻一屏'
        : '当前：连续滚动，' + S.ui.autoSpeed + ' px/s';
    }
  }

  let popOutside = null;
  let popArmTimer = 0;

  function openSpeedPop(anchor) {
    const pop = $('#speedPop');
    syncSpeedPop();
    // 列数 / 双列这两行只跟「多列」按钮有关，从 ⬇ 或 ▶ 长按弹出来时不该出现
    const isTwo = anchor && anchor.id === 'btnTwo';
    const colsRow = $('#popColsRow');
    const twoRow = $('#popTwoRow');
    if (colsRow) colsRow.hidden = !isTwo;
    if (twoRow) twoRow.hidden = !isTwo;
    pop.hidden = false;

    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(8, Math.min(window.innerWidth - pw - 8, left));
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = r.top - ph - 8;
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(Math.max(8, top)) + 'px';

    clearTimeout(popArmTimer);
    if (popOutside) document.removeEventListener('pointerdown', popOutside, true);
    popOutside = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchor && !anchor.contains(ev.target)) closeSpeedPop();
    };
    popArmTimer = setTimeout(() => document.addEventListener('pointerdown', popOutside, true), 60);
  }

  function closeSpeedPop() {
    $('#speedPop').hidden = true;
    if (popOutside) {
      document.removeEventListener('pointerdown', popOutside, true);
      popOutside = null;
    }
  }

  function setAuto(on) {
    S.autoOn = !!on;
    lastStep = 0;
    $('#btnAuto').classList.toggle('on', on);
    $('#mAuto').classList.toggle('on', on);
    const inDrawer = $('#btnAutoInDrawer');
    if (inDrawer) inDrawer.textContent = on ? '停止自动滚动' : '开始自动滚动';
    if (on) {
      lastT = performance.now();
      if (!autoTimer) autoTimer = setInterval(tickScroll, 16);
    } else {
      clearInterval(autoTimer);
      autoTimer = 0;
    }
    updateHeader();
  }

  /** 页面滚动容器（有的场景滚动发生在 html 而不是 window 上） */
  function scroller() {
    return document.scrollingElement || document.documentElement;
  }

  /** 灯箱关着的时候，绝不允许 body 被 overflow:hidden 锁住 */
  function unlockScroll() {
    const lb = $('#lightbox');
    if (lb && lb.hidden && document.body.style.overflow === 'hidden') {
      document.body.style.overflow = '';
    }
  }

  function tickScroll() {
    if (!S.autoOn) { clearInterval(autoTimer); autoTimer = 0; return; }

    const now = performance.now();
    const dt = Math.min(0.5, (now - lastT) / 1000);
    lastT = now;

    unlockScroll();

    const el = scroller();
    const max = Math.max(el.scrollHeight, document.body.scrollHeight, $('#gallery').scrollHeight) - window.innerHeight;
    const before = window.scrollY || el.scrollTop || 0;

    if (max <= 2) {
      setAuto(false);
      toast('内容不够长（高 ' + Math.round(el.scrollHeight) + ' / 视口 ' + window.innerHeight + '）');
      return;
    }
    if (before >= max - 2) { setAuto(false); toast('到底了'); return; }

    if (S.ui.autoMode === 'step') {
      if (!lastStep) { lastStep = now; return; }
      if (now - lastStep < S.ui.autoStep * 1000) return;
      lastStep = now;
      const stepPx = view() === 'single'
        ? Math.round(window.innerHeight * 0.94)   // 单列一张图基本占满一屏
        : Math.round(window.innerHeight * 0.86);
      window.scrollBy({ top: stepPx, behavior: 'smooth' });
      // 平滑滚动是异步的，这里必须直接返回：下面的兜底会写 scrollTop，
      // 一写就把动画掐掉，结果每轮只挪一两像素 —— 「按间隔跳」形同失效。
      return;
    }

    window.scrollBy(0, S.ui.autoSpeed * dt);

    // 兜底：如果 window.scrollBy 没生效，直接写 scrollTop（只在连续滚动模式下用）
    const after = window.scrollY || el.scrollTop || 0;
    if (after === before) {
      el.scrollTop = Math.min(max, before + Math.max(1, S.ui.autoSpeed * dt));
    }
  }

  // ------------------------------------------------------------ 灯箱
  const inLB = () => S.lbIndex >= 0;

  let lbUiTimer = 0;
  function showLBUI(autoHide) {
    const el2 = $('#lightbox');
    el2.classList.remove('ui-hidden');
    clearTimeout(lbUiTimer);
    if (autoHide) {
      lbUiTimer = setTimeout(() => el2.classList.add('ui-hidden'), 4000);
    }
  }
  function toggleLBUI() {
    const el2 = $('#lightbox');
    if (el2.classList.contains('ui-hidden')) showLBUI(true);
    else { el2.classList.add('ui-hidden'); clearTimeout(lbUiTimer); }
  }

  function openLB(i) {
    if (i < 0 || i >= S.list.length) return;
    closeSpeedPop();
    S.lbIndex = i;
    S.lbOpenIndex = i;          // 用来判断关掉时要不要跳回列表位置
    S.zoom = 1; S.panX = 0; S.panY = 0;
    S.lbRot = S.ui.rot;
    $('#lightbox').hidden = false;
    document.body.style.overflow = 'hidden';
    showLB();
    showLBUI(true);
    try {
      if (!localStorage.getItem('gallery-lb-tip')) {
        localStorage.setItem('gallery-lb-tip', '1');
        setTimeout(() => toast('点一下画面显示 / 隐藏控件，右上角 ✕ 关闭'), 500);
      }
    } catch (e) { }
  }

  function showLB() {
    const it = S.list[S.lbIndex];
    if (!it) return;
    const img = $('#lbImg');
    img.style.opacity = '';
    img.style.transition = '';
    img.classList.add('instant');
    img.__for = it;
    img.onload = () => {
      if (img.naturalWidth && img.naturalHeight) {
        it.w = img.naturalWidth;
        it.h = img.naturalHeight;
      }
    };
    img.src = srcOf(it);
    requestAnimationFrame(() => img.classList.remove('instant'));
    $('#lbCount').textContent = (S.lbIndex + 1) + ' / ' + S.list.length;
    $('#lbName').textContent = it.n;
    $('#lbBar').style.width = ((S.lbIndex + 1) / S.list.length * 100) + '%';
    fitLB();
    applyLBTransform();
    [S.lbIndex - 1, S.lbIndex + 1].forEach((k) => {
      const n = S.list[k];
      if (n) { const p = new Image(); p.src = srcOf(n); }
    });
  }

  function fitLB() {
    const it = S.list[S.lbIndex];
    const st = $('#lbStage').getBoundingClientRect();
    const img = $('#lbImg');
    if (!it || !st.width || !st.height) return;
    fitLB.lastW = st.width;
    fitLB.lastH = st.height;

    const rot = S.lbRot % 180 !== 0;

    if (!rot) {
      // 永远是「等比放到最大 + 完整可见」：一边贴满，另一边留黑边，既不裁也不变形
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      return;
    }

    // 旋转 90/270：按旋转后的真实比例算框，再把框放到最大
    // 优先用服务端量好的尺寸：src 刚换掉时 img.naturalWidth 还是上一张的值
    const nw = it.w || img.naturalWidth || 0;
    const nh = it.h || img.naturalHeight || 0;
    const ar = (nw > 0 && nh > 0) ? nw / nh : 0.75;
    const boxAR = 1 / ar;
    let vw = st.width;
    let vh = vw / boxAR;
    if (vh > st.height) { vh = st.height; vw = vh * boxAR; }
    img.style.width = vh.toFixed(1) + 'px';
    img.style.height = vw.toFixed(1) + 'px';
    img.style.objectFit = 'fill';
  }

  function applyLBTransform() {
    $('#lbImg').style.transform = 'translate(-50%,-50%) translate(' + S.panX + 'px,' + S.panY + 'px)'
      + ' rotate(' + S.lbRot + 'deg) scale(' + S.zoom + ')';
  }

  function lbStep(d) {
    if (!S.list.length) return;
    let n = S.lbIndex + d;

    if (n >= S.list.length) {
      // 幻灯片播到最后一页：按设置决定循环还是跳下一册
      if (d > 0 && S.slideshow && S.ui.playMode === 'next' && !S.ui.recursive) {
        jumpToNextAlbum();
        return;
      }
      n = 0;
    }
    if (n < 0) n = S.list.length - 1;

    S.lbIndex = n;
    S.zoom = 1; S.panX = 0; S.panY = 0;
    showLB();
  }

  /** 找同级的下一个「有图」的相册（文件夹），没有就返回 null */
  async function nextAlbumPath() {
    if (!S.path) return null;
    const idx = S.path.lastIndexOf('/');
    const parent = idx < 0 ? '' : S.path.slice(0, idx);
    let d;
    try {
      d = await api('/api/list?p=' + encodeURIComponent(parent));
    } catch (e) {
      return null;
    }
    const dirs = (d.dirs || []).filter((x) => x.count > 0);
    if (!dirs.length) return null;
    const cur = dirs.findIndex((x) => x.p === S.path);
    if (cur < 0) return dirs[0].p;
    for (let k = 1; k < dirs.length; k++) {
      const cand = dirs[(cur + k) % dirs.length];
      if (cand.p !== S.path) return cand.p;
    }
    return null;   // 只有自己
  }

  let albumJumping = false;

  async function jumpToNextAlbum() {
    if (albumJumping) return;
    albumJumping = true;
    try {
      const next = await nextAlbumPath();
      if (!next) {           // 没有下一册，回到本册第一张继续播
        S.lbIndex = 0;
        S.zoom = 1; S.panX = 0; S.panY = 0;
        showLB();
        return;
      }
      const keepPlaying = S.slideshow;
      await openDir(next);
      if (!S.list.length) return;
      S.lbIndex = 0;
      S.lbOpenIndex = -1;       // 换册了，关灯箱时一定要重新定位
      S.zoom = 1; S.panX = 0; S.panY = 0;
      showLB();
      if (keepPlaying) {
        stopSlideshow();
        toggleSlideshow();
      }
      toast('已跳到下一个相册');
    } catch (e) {
      toast('跳转失败：' + e.message);
    } finally {
      albumJumping = false;
    }
  }

  function closeLB() {
    const last = S.lbIndex;
    const moved = last >= 0 && last !== S.lbOpenIndex;
    try { document.dispatchEvent(new Event('lb:reset')); } catch (e) { }
    clearTimeout(lbUiTimer);
    $('#lightbox').classList.remove('ui-hidden');
    $('#lightbox').hidden = true;
    document.body.style.overflow = '';
    S.lbIndex = -1;
    stopSlideshow();
    // 幻灯片/翻页看到哪张，关掉后就滚到列表里的那一张
    if (moved && last >= 0) {
      setTimeout(() => revealCell(last), 80);
    }
    if (S.lbFullscreen) {
      S.lbFullscreen = false;
      const ex = document.exitFullscreen || document.webkitExitFullscreen;
      if (ex && (document.fullscreenElement || document.webkitFullscreenElement)) {
        try { ex.call(document); } catch (e) { }
      }
    }
  }

  /** 把列表滚到第 idx 张，并闪一下作为定位提示 */
  function revealCell(idx) {
    const cells = $$('#gallery .cell');
    const c = cells[idx];
    if (!c) return;
    const bar = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h'), 10) || 48;
    const rect = c.getBoundingClientRect();
    const target = Math.max(0, window.scrollY + rect.top - bar - 6);
    const far = Math.abs(target - window.scrollY) > window.innerHeight * 2.5;
    window.scrollTo({ top: target, behavior: far ? 'auto' : 'smooth' });
    c.classList.add('flash');
    setTimeout(() => c.classList.remove('flash'), 950);
  }

  /** 手机底栏的上一屏 / 下一屏：整屏滚动，单列模式下正好一张图 */
  function pageScroll(dir) {
    const step = Math.round(window.innerHeight * (view() === 'single' ? 0.94 : 0.86));
    window.scrollBy({ top: dir * step, behavior: 'smooth' });
  }

  /** 全屏：顶栏 ⛶、灯箱 ⛶、F 键共用一套（带 webkit 前缀，iOS 上不会抛 TypeError） */
  function toggleFullscreen() {
    const d = document.documentElement;
    const req = d.requestFullscreen || d.webkitRequestFullscreen;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    if (!active) {
      if (!req) { toast('这个浏览器不支持网页全屏，可以用「添加到主屏幕」'); return; }
      try { Promise.resolve(req.call(d)).catch(() => toast('全屏被拒绝')); } catch (e) { toast('全屏被拒绝'); }
    } else if (exit) {
      try { Promise.resolve(exit.call(document)).catch(() => { }); } catch (e) { }
    }
  }

  let slideTimer = 0;
  function toggleSlideshow() {
    if (slideTimer) { stopSlideshow(); return; }
    if (!inLB()) {
      if (!S.list.length) return;      // 空列表别开一个空转的定时器
      openLB(0);
    }
    if (!inLB()) return;
    S.slideshow = true;
    $('#lbPlay').classList.add('on');
    $('#btnSlideshow').classList.add('on');
    slideTimer = setInterval(() => lbStep(1), S.ui.slideSec * 1000);
  }
  function stopSlideshow() {
    S.slideshow = false;
    $('#lbPlay').classList.remove('on');
    $('#btnSlideshow').classList.remove('on');
    clearInterval(slideTimer);
    slideTimer = 0;
  }

  // ------------------------------------------------------------ 设置面板
  function syncSettingsUI() {
    $('#setRoot').textContent = S.rootPath || '（未设置）';
    $('#setCfgPath').textContent = S.cfgPath || 'config.json';
    $$('#fitRow .segb').forEach((b) => b.classList.toggle('on', b.dataset.fit === S.ui.fit));
    $$('#viewRow .segb').forEach((b) => b.classList.toggle('on', b.dataset.view === S.ui.view));
    $$('#themeRow .segb').forEach((b) => b.classList.toggle('on', b.dataset.theme === S.ui.theme));
    $$('#indexRow .segb').forEach((b) => b.classList.toggle('on', (b.dataset.index === '1') === !!S.ui.showIndex));
    $$('#playModeRow .segb').forEach((b) => b.classList.toggle('on', b.dataset.play === S.ui.playMode));
    $('#setCols').value = S.ui.cols;
    $('#vCols').textContent = S.ui.cols + ' 列';
    $('#setGap').value = S.ui.gap;
    $('#vGap').textContent = S.ui.gap + ' px';
    $('#setTwoH').value = S.ui.twoH || 100;
    $('#vTwoH').textContent = (S.ui.twoH || 100) + '%';
    $$('#autoModeRow .segb').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.ui.autoMode));
    $('#setSpeed').value = S.ui.autoSpeed;
    $('#vSpeed').textContent = S.ui.autoSpeed + ' px/s';
    $('#setStep').value = S.ui.autoStep;
    $('#vStep').textContent = S.ui.autoStep + ' s';
    $('#setSlide').value = S.ui.slideSec;
    $('#vSlide').textContent = S.ui.slideSec + ' s';
    $('#btnRecursive').classList.toggle('on', !!S.ui.recursive);
    const inDrawer = $('#btnAutoInDrawer');
    if (inDrawer) inDrawer.textContent = S.autoOn ? '停止自动滚动' : '开始自动滚动';
  }

  function openSettings() {
    closeSpeedPop();
    syncSettingsUI();
    $('#settings').hidden = false;
    $('#drawerScrim').classList.add('on');
  }
  function closeSettings() {
    $('#settings').hidden = true;
    $('#drawerScrim').classList.remove('on');
  }

  // ------------------------------------------------------------ 目录选择器
  function folderIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M3 7h6l2 2h10v10H3z');
    svg.appendChild(p);
    return svg;
  }

  async function openPicker(start) {
    $('#picker').hidden = false;
    $('#pickerList').innerHTML = '';
    try {
      const d = await api('/api/drives');
      S.places = d.places || [];
    } catch (e) { }
    const q = $('#pickerQuick');
    q.innerHTML = '';
    for (const pl of S.places) {
      const c = el('div', 'chip', pl.n);
      c.title = pl.p;
      c.addEventListener('click', () => browse(pl.p));
      q.appendChild(c);
    }
    await browse(start || S.rootPath || '');
  }

  async function browse(p) {
    let d;
    try {
      d = await api('/api/browse?p=' + encodeURIComponent(p || ''));
    } catch (e) {
      toast('打不开：' + e.message);
      return;
    }
    S.pickerCur = d.path || '';
    $('#pickerPath').value = d.path || '';
    $('#pickerSel').textContent = S.pickerCur || '（未选中文件夹）';
    const list = $('#pickerList');
    list.innerHTML = '';
    if (!d.dirs.length) {
      list.appendChild(el('div', 'hint', d.drives ? '没有检测到盘符' : '这个文件夹里没有子文件夹（可以直接用它）'));
    }
    for (const sub of d.dirs) {
      const row = el('div', 'picker-row');
      row.appendChild(folderIcon());
      row.appendChild(el('span', 'prn', sub.n));
      row.addEventListener('click', () => browse(sub.p));
      list.appendChild(row);
    }
    const up = $('#pickerUp');
    up.disabled = !d.parent;
    up.__parent = d.parent || '';
  }

  async function usePickedFolder() {
    // 优先用当前浏览到的目录，其次用输入框里手打的路径
    const typed = ($('#pickerPath').value || '').trim();
    // 手打/粘贴的路径优先：输入框里有内容就用它，别静默换成上次浏览到的目录
    const target = typed || S.pickerCur;
    if (!target) { toast('先进入一个文件夹，或粘贴完整路径'); return; }
    try {
      setSaveState('', '保存中…');
      await saveConfig({ root: target });
      // 回读校验：确认服务端真的记住了，而不是只在前端改了变量
      const chk = await api('/api/config');
      if (!chk.root) {
        throw new Error(chk.rootMissing
          ? '服务端记住了 ' + chk.configuredRoot + '，但这个目录访问不到'
          : '服务端没有记住这个目录');
      }
      S.rootPath = chk.root;
      S.configuredRoot = chk.configuredRoot || chk.root;
      S.rootMissing = false;
      $('#picker').hidden = true;
      $('#setRoot').textContent = S.rootPath;
      setSaveState('ok', '已保存图库目录');
      toast('图库目录已设置');
      S.path = '';
      syncURL('', true);
      if (!$('#settings').hidden) syncSettingsUI();
      await openDir('');
    } catch (e) {
      setSaveState('err', '设置失败：' + e.message);
      toast('设置失败：' + e.message);
    }
  }

  // ------------------------------------------------------------ 拖入文件夹
  function readEntries(reader) {
    return new Promise((res) => {
      const acc = [];
      const step = () => reader.readEntries((ents) => {
        if (!ents.length) { res(acc); return; }
        acc.push.apply(acc, ents);
        step();
      }, () => res(acc));
      step();
    });
  }

  async function collectFromEntry(entry, folder, out) {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((res) => entry.file(res, () => res(null))).catch(() => null);
      if (file && IMG_RE.test(file.name)) out.push({ file: file, folder: folder });
      return;
    }
    if (entry.isDirectory) {
      const ents = await readEntries(entry.createReader());
      const f = folder ? folder + '/' + entry.name : entry.name;
      for (const e of ents) await collectFromEntry(e, f, out);
    }
  }

  function dimsOf(url) {
    return new Promise((res) => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => res({ w: 0, h: 0 });
      im.src = url;
    });
  }

  async function handleDrop(dt) {
    const entries = [];
    if (dt.items && dt.items.length) {
      for (const item of dt.items) {
        const e = item.webkitGetAsEntry && item.webkitGetAsEntry();
        if (e) entries.push(e);
      }
    }
    const out = [];
    if (entries.length) {
      for (const e of entries) await collectFromEntry(e, '', out);
    } else if (dt.files) {
      for (const f of dt.files) if (IMG_RE.test(f.name)) out.push({ file: f, folder: '' });
    }
    if (!out.length) { toast('没发现图片文件'); return; }

    out.sort((a, b) => (a.folder + '/' + a.file.name).localeCompare(b.folder + '/' + b.file.name, 'zh-CN', { numeric: true }));
    const items = out.map((o) => ({
      n: o.file.name, f: o.folder, s: o.file.size, w: 0, h: 0,
      url: URL.createObjectURL(o.file),
    }));

    // 换一批图之前先关掉灯箱，否则正在看的那张 blob URL 会被 revoke 掉变成白屏
    if (inLB()) closeLB();
    for (const old of S.items) {
      if (old.url && old.url.indexOf('blob:') === 0) { try { URL.revokeObjectURL(old.url); } catch (e) { } }
    }
    S.local = true;
    S.items = items;
    S.path = '';
    S.q = '';
    $('#q').value = '';
    render();
    toast('已载入 ' + items.length + ' 张（本地模式，仅本机可见）');
    (async () => {
      for (const it of items) {
        const d = await dimsOf(it.url);
        it.w = d.w; it.h = d.h;
      }
      applyBoxes();
    })();
  }

  /** 长按 480ms 触发 onLong，短按触发 onClick；长按之后吞掉随之而来的 click */
  /**
   * 长按 360ms 触发 onLong；短按触发 onClick。
   * 移动端浏览器会在长按时抛 pointercancel / pointerleave，这里不把它们当取消，
   * 只要按下超过 260ms 就认作长按，避免「按了没反应」。
   */
  function longPress(el, onLong, onClick) {
    let timer = 0;
    let fired = false;
    let downAt = 0;
    let sx = 0;
    let sy = 0;

    const clear = () => { clearTimeout(timer); timer = 0; };

    const fire = () => {
      if (fired) return;
      fired = true;
      clear();
      try { el.classList.add('pressing'); } catch (e) { }
      try { if (navigator.vibrate) navigator.vibrate(14); } catch (e) { }
      try { onLong(); } catch (e) { toast('调节面板打不开：' + e.message); }
      setTimeout(() => { try { el.classList.remove('pressing'); } catch (e) { } }, 180);
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      fired = false;
      downAt = performance.now();
      sx = e.clientX;
      sy = e.clientY;
      clear();
      timer = setTimeout(fire, 360);
    });

    el.addEventListener('pointermove', (e) => {
      if (fired || !timer) return;
      // 手指轻微抖动不算取消，超过 26px 才认为是在滑页面
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 26) clear();
    });

    // 浏览器抢走手势时不直接放弃：按够时间就地触发
    const rescue = () => {
      if (!fired && downAt && performance.now() - downAt > 260) fire();
      else clear();
    };
    el.addEventListener('pointercancel', rescue);
    el.addEventListener('pointerleave', rescue);

    el.addEventListener('pointerup', () => {
      if (!fired && downAt && performance.now() - downAt > 360) { fire(); return; }
      clear();
      if (!fired) onClick();
    });

    el.addEventListener('contextmenu', (e) => e.preventDefault());

    // 长按之后浏览器还会补一个 click，吞掉它
    el.addEventListener('click', (e) => {
      if (fired) {
        e.preventDefault();
        e.stopPropagation();
        fired = false;
      }
    }, true);
  }

  // ------------------------------------------------------------ 事件
  function bind() {
    // 侧栏：桌面是「收起留白」，窄屏是「抽屉覆盖」，都用同一个 hide 类
    $('#btnMenu').addEventListener('click', () => {
      const sb = $('#sidebar');
      const hidden = sb.classList.toggle('hide');
      if (window.innerWidth > 900) {
        document.body.classList.toggle('side-hide', hidden);
      } else {
        $('#scrim').classList.toggle('on', !hidden);
      }
    });
    $('#scrim').addEventListener('click', () => {
      $('#sidebar').classList.add('hide');
      $('#scrim').classList.remove('on');
    });
    $('#btnRoot').addEventListener('click', () => openDir(''));

    $('#btnGrid').addEventListener('click', () => setView('grid'));
    longPress($('#btnTwo'),
      () => {
        if (S.ui.view !== 'two') setView('two');
        openSpeedPop($('#btnTwo'));
      },
      () => setView('two'));
    $('#btnSingle').addEventListener('click', () => setView('single'));

    $('#btnRot').addEventListener('click', () => rotateBy(90));
    $('#mRot').addEventListener('click', () => rotateBy(90));

    longPress($('#btnAuto'), () => openSpeedPop($('#btnAuto')), () => setAuto(!S.autoOn));
    longPress($('#mAuto'), () => openSpeedPop($('#mAuto')), () => setAuto(!S.autoOn));
    $('#btnAutoInDrawer').addEventListener('click', () => setAuto(!S.autoOn));

    $('#popSpeed').addEventListener('input', (e) => {
      S.ui.autoSpeed = Number(e.target.value);
      // 拖速度就说明想用连续滚动，顺手切过去，免得改了没反应
      if (S.ui.autoMode !== 'scroll') S.ui.autoMode = 'scroll';
      syncSpeedPop();
      $('#setSpeed').value = S.ui.autoSpeed;
      $('#vSpeed').textContent = S.ui.autoSpeed + ' px/s';
      autoSave();
    });
    $$('#popColsSeg .pseg').forEach((b) => b.addEventListener('click', () => {
      S.ui.twoCols = Number(b.dataset.c);
      if (S.ui.view !== 'two') S.ui.view = 'two';
      applyLayoutVars();
      scheduleReflow();
      syncSettingsUI();
      syncSpeedPop();
      autoSave();
    }));

    $('#popTwoH').addEventListener('input', (e) => {
      S.ui.twoH = Number(e.target.value);
      $('#popTwoHV').textContent = S.ui.twoH + '%';
      $('#setTwoH').value = S.ui.twoH;
      $('#vTwoH').textContent = S.ui.twoH + '%';
      applyBoxes();
      autoSave();
    });

    $('#setTwoH').addEventListener('input', (e) => {
      S.ui.twoH = Number(e.target.value);
      $('#vTwoH').textContent = S.ui.twoH + '%';
      $('#popTwoH').value = S.ui.twoH;
      $('#popTwoHV').textContent = S.ui.twoH + '%';
      applyBoxes();
      autoSave();
    });

    $('#popSlide').addEventListener('input', (e) => {
      S.ui.slideSec = Number(e.target.value);
      $('#popSlideV').textContent = S.ui.slideSec + ' s';
      $('#setSlide').value = S.ui.slideSec;
      $('#vSlide').textContent = S.ui.slideSec + ' s';
      if (slideTimer) { stopSlideshow(); toggleSlideshow(); }
      autoSave();
    });

    $('#popStep').addEventListener('input', (e) => {
      S.ui.autoStep = Number(e.target.value);
      if (S.ui.autoMode !== 'step') S.ui.autoMode = 'step';
      syncSpeedPop();
      $('#setStep').value = S.ui.autoStep;
      $('#vStep').textContent = S.ui.autoStep + ' s';
      autoSave();
    });

    longPress($('#btnSlideshow'),
      () => openSpeedPop($('#btnSlideshow')),
      () => { if (!inLB()) openLB(0); toggleSlideshow(); });

    $('#btnFullscreen').addEventListener('click', toggleFullscreen);
    $('#lbFull').addEventListener('click', toggleFullscreen);

    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnCloseSettings').addEventListener('click', closeSettings);
    $('#drawerScrim').addEventListener('click', closeSettings);

    $('#btnTheme').addEventListener('click', () => {
      S.ui.theme = S.ui.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      syncSettingsUI();
      autoSave();
    });

    const sb = $('#searchBox');
    const qi = $('#q');
    $('#btnSearch').addEventListener('click', () => {
      sb.classList.toggle('open');
      if (sb.classList.contains('open')) setTimeout(() => qi.focus(), 30);
    });
    let qTimer = 0;
    qi.addEventListener('input', () => {
      clearTimeout(qTimer);
      const v = qi.value;
      qTimer = setTimeout(() => {
        S.q = v;
        render();
        window.scrollTo({ top: 0 });
      }, 150);
    });
    qi.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { sb.classList.remove('open'); qi.blur(); }
    });

    $('#btnRootPick').addEventListener('click', () => {
      if (window.innerWidth <= 900) {
        $('#sidebar').classList.add('hide');
        $('#scrim').classList.remove('on');
      }
      openPicker(S.rootPath);
    });

    $('#btnRecursive').addEventListener('click', async () => {
      S.ui.recursive = !S.ui.recursive;
      syncSettingsUI();
      autoSave();
      if (S.local) render(); else await openDir(S.path);
    });

    $$('#fitRow .segb').forEach((b) => b.addEventListener('click', () => {
      S.ui.fit = b.dataset.fit;
      syncSettingsUI();
      autoSave();
      applyLayoutVars();
      applyBoxes();
    }));
    $$('#viewRow .segb').forEach((b) => b.addEventListener('click', () => {
      S.ui.view = b.dataset.view;
      applyLayoutVars();
      autoSave();
      syncSettingsUI();
      scheduleReflow();
    }));
    $$('#playModeRow .segb').forEach((b) => b.addEventListener('click', () => {
      S.ui.playMode = b.dataset.play;
      syncSettingsUI();
      autoSave();
    }));

    $$('#indexRow .segb').forEach((b) => b.addEventListener('click', () => {
      S.ui.showIndex = b.dataset.index === '1';
      document.body.classList.toggle('show-idx', S.ui.showIndex);
      syncSettingsUI();
      autoSave();
    }));
    $$('#themeRow .segb').forEach((b) => b.addEventListener('click', () => {
      S.ui.theme = b.dataset.theme;
      applyTheme();
      autoSave();
      syncSettingsUI();
    }));
    $('#setCols').addEventListener('input', (e) => {
      S.ui.cols = Number(e.target.value);
      $('#vCols').textContent = S.ui.cols + ' 列';
      applyLayoutVars();
      autoSave();
      scheduleReflow();
    });
    $('#setGap').addEventListener('input', (e) => {
      S.ui.gap = Number(e.target.value);
      $('#vGap').textContent = S.ui.gap + ' px';
      applyLayoutVars();
      autoSave();
      scheduleReflow();
    });
    $$('#autoModeRow .segb').forEach((b) => b.addEventListener('click', () => {
      S.ui.autoMode = b.dataset.mode;
      syncSettingsUI();
      autoSave();
    }));
    $('#setSpeed').addEventListener('input', (e) => {
      S.ui.autoSpeed = Number(e.target.value);
      $('#vSpeed').textContent = S.ui.autoSpeed + ' px/s';
      autoSave();
    });
    $('#setStep').addEventListener('input', (e) => {
      S.ui.autoStep = Number(e.target.value);
      $('#vStep').textContent = S.ui.autoStep + ' s';
      autoSave();
    });
    $('#setSlide').addEventListener('input', (e) => {
      S.ui.slideSec = Number(e.target.value);
      $('#vSlide').textContent = S.ui.slideSec + ' s';
      autoSave();
      if (slideTimer) { stopSlideshow(); toggleSlideshow(); }
    });

    $('#btnChangeRoot').addEventListener('click', () => { closeSettings(); openPicker(S.rootPath); });

    $('#btnSaveSettings').addEventListener('click', async () => {
      try { await doSave(); toast('已保存到 config.json'); } catch (e) { }
    });

    $('#pickerCancel').addEventListener('click', () => { $('#picker').hidden = true; });
    $('#pickerGo').addEventListener('click', () => browse($('#pickerPath').value.trim()));
    $('#pickerPath').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') browse(e.target.value.trim());
    });
    $('#pickerUp').addEventListener('click', () => {
      const p = $('#pickerUp').__parent;
      if (p) browse(p);
    });
    $('#pickerUse').addEventListener('click', usePickedFolder);

    $('#lbClose').addEventListener('click', closeLB);
    // 电脑端：鼠标在画面上移动就把控件叫回来，避免 Autohide 之后找不到按钮
    $('#lightbox').addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') showLBUI(true);
    });
    $('#lightbox').addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') showLBUI(true);
    });
    // 触屏：长按图片不要弹「存储图片 / 分享」这种系统菜单
    if (document.body.classList.contains('touch')) {
      $('#lightbox').addEventListener('contextmenu', (e) => e.preventDefault());
    }
    $('#lbPrev').addEventListener('click', () => lbStep(-1));
    $('#lbNext').addEventListener('click', () => lbStep(1));
    // 手机底栏的上一屏 / 下一屏（之前完全没绑事件，是两颗死按钮）
    $('#mPrev').addEventListener('click', () => pageScroll(-1));
    $('#mNext').addEventListener('click', () => pageScroll(1));
    $('#lbRot').addEventListener('click', () => { S.lbRot = (S.lbRot + 90) % 360; fitLB(); applyLBTransform(); });
    $('#lbZoomIn').addEventListener('click', () => { S.zoom = Math.min(8, S.zoom * 1.25); applyLBTransform(); });
    $('#lbZoomOut').addEventListener('click', () => { S.zoom = Math.max(0.2, S.zoom / 1.25); applyLBTransform(); });
    longPress($('#lbPlay'),
      () => openSpeedPop($('#lbPlay')),
      () => toggleSlideshow());
    $('#lbStage').addEventListener('wheel', (e) => {
      e.preventDefault();
      S.zoom = Math.max(0.2, Math.min(8, S.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      applyLBTransform();
      showLBUI(true);
    }, { passive: false });

    (function gestures() {
      const stage = $('#lbStage');
      const img = $('#lbImg');
      const pointers = new Map();

      let ghost = null;        // 跟手进来的那一张
      let ghostDir = 0;        // -1 = 上一张（往右滑），1 = 下一张（往左滑）
      let ghostIdx = -1;

      let dragging = false, moved = false, swiping = false;
      let startX = 0, startY = 0, baseX = 0, baseY = 0;
      let downT = 0, lastX = 0, lastT = 0, vx = 0;
      let pinchStart = 0, pinchZoom = 1;

      const stageW = () => stage.clientWidth || window.innerWidth;

      function resetPan() { S.panX = 0; S.panY = 0; }

      function ensureGhost(dir) {
        if (ghost && ghostDir === dir) return ghost;

        if (!ghost) {
          ghost = document.createElement('img');
          ghost.id = 'lbGhost';
          ghost.alt = '';
          ghost.draggable = false;
          stage.appendChild(ghost);
        }

        let n = S.lbIndex + dir;
        if (n < 0) n = S.list.length - 1;
        if (n >= S.list.length) n = 0;
        ghostIdx = n;
        ghostDir = dir;

        ghost.src = srcOf(S.list[n]);
        const cs = getComputedStyle(img);
        ghost.style.width = cs.width;
        ghost.style.height = cs.height;
        ghost.style.objectFit = cs.objectFit;
        ghost.style.display = 'block';
        ghost.style.transition = 'none';
        ghost.style.opacity = '1';
        ghost.style.transform = 'translate(-50%,-50%) translate(' + (dir * stageW()) + 'px,0) rotate(' + S.lbRot + 'deg)';
        return ghost;
      }

      function hideGhost() {
        if (!ghost) return;
        ghost.style.display = 'none';
        ghost.style.transition = 'none';
        ghostDir = 0;
        ghostIdx = -1;
      }

      function prefetchAround() {
        [S.lbIndex - 1, S.lbIndex + 1].forEach((k) => {
          const i = k < 0 ? S.list.length - 1 : (k >= S.list.length ? 0 : k);
          const n = S.list[i];
          if (n) { const p = new Image(); p.src = srcOf(n); }
        });
      }

      function setMeta() {
        const it = S.list[S.lbIndex];
        if (!it) return;
        $('#lbCount').textContent = (S.lbIndex + 1) + ' / ' + S.list.length;
        $('#lbName').textContent = it.n;
        $('#lbBar').style.width = ((S.lbIndex + 1) / S.list.length * 100) + '%';
      }

      // 吸附翻页：当前图滑出、下一张滑入
      function commitFlip(dir) {
        const w = stageW();
        const g = ghost || ensureGhost(dir);
        const ease = 'transform .26s cubic-bezier(.22,.61,.36,1), opacity .2s linear';

        img.style.transition = ease;
        img.style.transform = 'translate(-50%,-50%) translate(' + (-dir * w) + 'px,0) rotate(' + S.lbRot + 'deg) scale(1)';
        img.style.opacity = '0';

        g.style.transition = ease;
        g.style.transform = 'translate(-50%,-50%) translate(0,0) rotate(' + S.lbRot + 'deg)';
        g.style.opacity = '1';

        setTimeout(() => {
          if (ghostIdx >= 0) S.lbIndex = ghostIdx;
          S.zoom = 1;
          resetPan();

          const it = S.list[S.lbIndex];
          img.style.transition = 'none';
          img.style.opacity = '1';
          img.__for = it;
          img.src = srcOf(it);
          fitLB();
          applyLBTransform();   // 补回 rotate/scale，否则旋转过的图会被拉伸
          setMeta();

          hideGhost();
          requestAnimationFrame(() => {
            img.style.transition = 'transform .2s var(--ease), opacity .2s linear';
            setTimeout(() => { img.style.transition = ''; }, 220);
          });

          prefetchAround();
          showLBUI(true);
        }, 265);
      }

      // 没到翻页阈值：弹回原位
      function springBack() {
        const w = stageW();
        const ease = 'transform .28s cubic-bezier(.22,.61,.36,1)';

        img.style.transition = ease;
        img.style.transform = 'translate(-50%,-50%) rotate(' + S.lbRot + 'deg) scale(1)';

        if (ghost) {
          ghost.style.transition = ease;
          ghost.style.transform = 'translate(-50%,-50%) translate(' + (ghostDir * w) + 'px,0) rotate(' + S.lbRot + 'deg)';
        }

        setTimeout(() => {
          img.style.transition = '';
          hideGhost();
        }, 300);
      }

      stage.addEventListener('pointerdown', (e) => {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
          dragging = true;
          moved = false;
          swiping = false;
          startX = e.clientX;
          startY = e.clientY;
          baseX = S.panX;
          baseY = S.panY;
          downT = performance.now();
          lastX = e.clientX;
          lastT = downT;
          vx = 0;
          try { stage.setPointerCapture(e.pointerId); } catch (err) { }
        } else if (pointers.size === 2) {
          const v = Array.from(pointers.values());
          pinchStart = Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y);
          pinchZoom = S.zoom;
          moved = true;
          swiping = false;
          hideGhost();
        }
      });

      stage.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size === 2 && pinchStart > 0) {
          const v = Array.from(pointers.values());
          const d = Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y);
          S.zoom = Math.max(0.2, Math.min(8, pinchZoom * (d / pinchStart)));
          img.style.transition = 'none';
          applyLBTransform();
          return;
        }

        if (!dragging) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 5) moved = true;
        if (!moved) return;

        const now = performance.now();
        if (now - lastT > 12) {
          vx = (e.clientX - lastX) / Math.max(1, now - lastT);
          lastX = e.clientX;
          lastT = now;
        }

        img.style.transition = 'none';

        if (S.zoom > 1.02) {
          S.panX = baseX + dx;
          S.panY = baseY + dy;
          applyLBTransform();
          return;
        }

        if (!swiping && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.15) swiping = true;

        if (swiping) {
          const dir = dx < 0 ? 1 : -1;
          const g = ensureGhost(dir);
          const w = stageW();
          img.style.transform = 'translate(-50%,-50%) translate(' + dx.toFixed(1) + 'px,0) rotate(' + S.lbRot + 'deg) scale(1)';
          g.style.transform = 'translate(-50%,-50%) translate(' + (dir * w + dx).toFixed(1) + 'px,0) rotate(' + S.lbRot + 'deg)';
        } else {
          img.style.transform = 'translate(-50%,-50%) translate(' + (dx * 0.35).toFixed(1) + 'px,'
            + (dy * 0.22).toFixed(1) + 'px) rotate(' + S.lbRot + 'deg) scale(1)';
        }
      });

      function end(e) {
        const had = pointers.has(e.pointerId);
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinchStart = 0;
        if (!had || !dragging) { if (!pointers.size) dragging = false; return; }

        const wasSwiping = swiping;
        dragging = false;
        swiping = false;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const elapsed = Math.max(1, performance.now() - downT);
        const velocity = Math.abs(dx) / elapsed;

        if (!moved) {
          img.style.transition = '';
          resetPan();
          applyLBTransform();
          toggleLBUI();
          return;
        }

        if (S.zoom > 1.02) { applyLBTransform(); return; }

        if (wasSwiping && Math.abs(dx) > 30) {
          const w = stageW();
          const shouldFlip = Math.abs(dx) > w * 0.16
            || velocity > 0.45
            || (Math.abs(dx) > 70 && Math.abs(dy) < 110);
          if (shouldFlip) { commitFlip(dx < 0 ? 1 : -1); return; }
          springBack();
          return;
        }

        img.style.transition = 'transform .26s cubic-bezier(.22,.61,.36,1)';
        img.style.transform = 'translate(-50%,-50%) rotate(' + S.lbRot + 'deg) scale(1)';
        setTimeout(() => { img.style.transition = ''; }, 280);
      }

      stage.addEventListener('pointerup', end);
      stage.addEventListener('pointercancel', end);

      stage.addEventListener('dblclick', () => {
        if (S.zoom > 1.02) { S.zoom = 1; resetPan(); }
        else S.zoom = 2.4;
        applyLBTransform();
        showLBUI(true);
      });

      $$('#lightbox .ibtn, #lightbox .lb-nav').forEach((b) => {
        b.addEventListener('pointerdown', () => showLBUI(true), true);
      });

      document.addEventListener('lb:reset', () => {
        img.style.transition = '';
        img.style.opacity = '';
        hideGhost();
      });
    })();

    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      switch (e.key) {
        case 'Escape':
          if (inLB()) closeLB();
          else if (!$('#settings').hidden) closeSettings();
          else if (!$('#picker').hidden) $('#picker').hidden = true;
          break;
        case 'ArrowLeft': if (inLB()) lbStep(-1); break;
        case 'ArrowRight': if (inLB()) lbStep(1); break;
        case 'r': case 'R':
          if (inLB()) { S.lbRot = (S.lbRot + 90) % 360; fitLB(); applyLBTransform(); }
          else rotateBy(90);
          break;
        case 'f': case 'F':
          toggleFullscreen();
          break;
        case ' ':
          e.preventDefault();
          // 按钮持焦点时，按钮自己的 click 会在 keyup 再触发一次，净效果等于没按
          if (e.target && /^(button|a)$/i.test(e.target.tagName || '')) { try { e.target.blur(); } catch (err) { } }
          if (inLB()) toggleSlideshow(); else setAuto(!S.autoOn);
          break;
        case '1': setView('grid'); break;
        case '2': setView('single'); break;
        case '3': setView('two'); break;
        case '-': nudgeCols(-1); break;
        case '=': case '+': nudgeCols(1); break;
        case 'm': case 'M': $('#btnMenu').click(); break;
        default: break;
      }
    });

    let depth = 0;
    const hasFiles = (dt) => Array.from((dt && dt.types) || []).indexOf('Files') >= 0;
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e.dataTransfer)) return;
      depth++;
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e.dataTransfer)) e.preventDefault();
    });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth = 0;
      try { await handleDrop(e.dataTransfer); } catch (err) { toast('拖入失败：' + err.message); }
    });

    // 页面隐藏 / 关闭前把没落盘的设置补上
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSave();
      else unlockScroll();
    });

    // 每 1.2 秒兜底一次：灯箱关着却还锁着滚动的情况几乎都出在这里
    setInterval(unlockScroll, 1200);
    window.addEventListener('pagehide', flushSave);
    window.addEventListener('beforeunload', flushSave);

    // 滑块松手立刻存，不等防抖
    ['setCols', 'setGap', 'setSpeed', 'setStep', 'setSlide', 'popSpeed', 'popStep', 'popSlide']
      .forEach((id) => {
        const el = $('#' + id);
        if (el) el.addEventListener('change', () => { doSave().catch(() => { }); });
      });

    window.addEventListener('scroll', scheduleSweep, { passive: true });
    window.addEventListener('popstate', (ev) => {
      const p = (ev.state && ev.state.p) || '';
      if (p !== S.path) openDir(p, { history: false });
    });
    let rz = 0;
    window.addEventListener('resize', () => {
      clearTimeout(rz);
      rz = setTimeout(() => {
        applyLayoutVars();
        applyBoxes();
        scheduleSweep();
        if (inLB()) {
          const st = $('#lbStage').getBoundingClientRect();
          const dw = Math.abs(st.width - (fitLB.lastW || 0));
          const dh = Math.abs(st.height - (fitLB.lastH || 0));
          // 只有横竖屏切换这种大变化才重算，地址栏伸缩不碰
          if (dw + dh > 120) { fitLB(); applyLBTransform(); }
        }
      }, 140);
    });
  }

  let reflowTimer = 0;
  function scheduleReflow() {
    clearTimeout(reflowTimer);
    reflowTimer = setTimeout(() => {
      applyBoxes();
      scheduleSweep();
    }, 30);
  }

  /** 切换视图：按钮和快捷键走同一条路，保证面板状态和落盘一致 */
  function setView(v) {
    S.ui.view = v;
    applyLayoutVars();
    syncSettingsUI();
    scheduleReflow();
    autoSave();
  }

  /** 列数 +/-：顺手把面板文字和配置一起更新 */
  function nudgeCols(d) {
    S.ui.cols = Math.max(1, Math.min(8, (S._cols || S.ui.cols) + d));
    applyLayoutVars();
    syncSettingsUI();
    scheduleReflow();
    autoSave();
  }

  function rotateBy(d) {
    S.ui.rot = ((S.ui.rot + d) % 360 + 360) % 360;
    $('#btnRot').classList.toggle('on', S.ui.rot !== 0);
    applyBoxes();
    autoSave();
    if (inLB()) { S.lbRot = S.ui.rot; fitLB(); applyLBTransform(); }
  }

  // ------------------------------------------------------------ 启动
  async function loadConfig() {
    try {
      const c = await api('/api/config');
      if (!c || typeof c !== 'object') throw new Error('返回内容异常');
      S.rootPath = c.root || '';
      S.configuredRoot = c.configuredRoot || '';
      S.rootMissing = !!c.rootMissing;
      S.ui = Object.assign({}, DEFAULT_UI, c.ui || {});
      S.cfgPath = c.configPath || '';
      S.cfgLoaded = true;
      S.cfgError = c.configError || '';
    } catch (e) {
      // 读不到配置时不要静默当成「未设置」，否则看起来就像根目录丢了
      S.cfgLoaded = false;
      S.cfgError = e.message || String(e);
    }
  }

  async function boot() {
    try {
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
        document.body.classList.add('touch');
      }
    } catch (e) { }
    bind();
    await loadConfig();
    applyAll();
    $('#btnRot').classList.toggle('on', S.ui.rot !== 0);

    if (window.innerWidth <= 900) {
      document.body.classList.add('side-hide');
      $('#sidebar').classList.add('hide');
    }

    if (!S.cfgLoaded) { renderEmpty('cfg-error', S.cfgError); return; }
    if (S.cfgError) { renderEmpty('cfg-error', S.cfgError); return; }
    if (!S.rootPath) { renderEmpty(S.rootMissing ? 'root-missing' : 'no-root'); return; }

    let start = '';
    try { start = new URLSearchParams(location.search).get('p') || ''; } catch (e) { }
    await openDir(start, { replace: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
