#!/usr/bin/env node
/*
 * 本地图库浏览器 · 零依赖服务端
 * ------------------------------------------------------------------
 * 启动:  node server.js [--port=8710] [--root="D:\图片"] [--no-kill]
 *
 * 图库根目录不再写死：默认从 gallery/config.json 读取，
 * 也可以在网页里点「设置 → 更改图库目录」随时改，改完立即生效、无需重启。
 *
 * 接口:
 *   GET  /                    前端
 *   GET  /api/config          当前配置（root + ui）
 *   POST /api/config          保存配置 { root?, ui? }
 *   GET  /api/drives          盘符 + 常用目录（目录选择器用）
 *   GET  /api/browse?p=DIR    列出目录下的子目录（不受 root 限制，用于选路径）
 *   GET  /api/list?p=REL      root 内的目录内容；&recursive=1 递归
 *   GET  /img?p=REL           图片字节（Range / ETag / 强缓存）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execSync } = require('child_process');

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const ARG_PORT = Number((argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 0;
const ARG_ROOT = (argv.find((a) => a.startsWith('--root=')) || '').split('=')[1]
    || (argv.find((a) => !a.startsWith('--')) || '');
const NO_KILL = argv.includes('--no-kill');
const OPEN_BROWSER = !argv.includes('--no-open');

const PORT = ARG_PORT || Number(process.env.PORT) || 8710;
const HOST = '0.0.0.0';
const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const CONFIG_PATH = path.join(APP_DIR, 'config.json');

const MAX_RECURSIVE_FILES = 20000;
const MAX_DEPTH = 8;

const IMG_EXT = new Set(['.webp', '.jpg', '.jpeg', '.png', '.gif', '.avif', '.bmp', '.jfif', '.tif', '.tiff']);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.jfif': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
};

const DEFAULT_UI = {
    view: 'grid',        // grid | two | single
    cols: 4,
    gap: 4,
    fit: 'auto',         // auto(原图比例) | cover | contain | fill
    theme: 'light',
    rot: 0,
    autoSpeed: 90,
    autoMode: 'scroll',  // scroll = 连续滚动 / step = 按间隔跳
    autoStep: 6,         // step 模式下的间隔（秒）
    slideSec: 6,
    playMode: 'loop',    // loop = 播完循环本册 / next = 播完跳下一册
    twoH: 100,           // 多列模式图片缩放（%），100 = 正好填满一列
    twoCols: 2,          // 多列模式列数 2–6
    recursive: false,
    showIndex: false,
    sort: 'name',
};

// ---------------------------------------------------------------- 配置
let CONFIG = { root: '', ui: { ...DEFAULT_UI } };

// 去掉行注释和块注释（跳过字符串内部），让 config.json 可以写中文注释
function stripJsonComments(text) {
    let out = '';
    let inStr = false, quote = '', esc = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i], n = text[i + 1];
        if (inStr) {
            out += c;
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === quote) inStr = false;
            continue;
        }
        if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
        if (c === '/' && n === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            out += '\n';
            continue;
        }
        if (c === '/' && n === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i++;
            continue;
        }
        out += c;
    }
    return out;
}

// 生成带中文注释的 config.json（写盘用，注释不会丢）
function renderConfig(cfg) {
    const u = cfg.ui;
    const j = (v) => JSON.stringify(v);
    const b = (v) => (v ? 'true' : 'false');
    return [
        '{',
        '  // === 图库根目录 ==========================================',
        '  // 网页里「设置 -> 更改图库目录」选完会自动写这里',
        '  // 留空 = 启动后在网页里选；填绝对路径会直接用它',
        '  "root": ' + j(cfg.root) + ',',
        '',
        '  // ui = 界面与浏览的默认设置，网页里「保存设置」会写回这里',
        '  "ui": {',
        '    // 默认视图：grid = 网格 / two = 双列 / single = 单列长条',
        '    "view": ' + j(u.view) + ',',
        '    // 网格列数：1 - 8',
        '    "cols": ' + u.cols + ',',
        '    // 图片间距（px）：0 - 24',
        '    "gap": ' + u.gap + ',',
        '    // 图片填充：auto = 原图比例 / cover = 裁剪填满 / contain = 完整显示 / fill = 拉伸铺满',
        '    "fit": ' + j(u.fit) + ',',
        '    // 主题：light = 浅色 / dark = 深色',
        '    "theme": ' + j(u.theme) + ',',
        '    // 初始旋转角度：0 / 90 / 180 / 270',
        '    "rot": ' + u.rot + ',',
        '    // 自动滚动速度（px/s）：10 - 400，仅连续滚动时生效',
        '    "autoSpeed": ' + u.autoSpeed + ',',
        '    // 自动滚动方式：scroll = 连续匀速下滑 / step = 每隔 N 秒翻一屏',
        '    "autoMode": ' + j(u.autoMode || 'scroll') + ',',
        '    // 自动滚动间隔（秒）：1 - 60，仅 step 模式生效',
        '    "autoStep": ' + (u.autoStep || 6) + ',',
        '    // 幻灯片间隔（秒）：1 - 30',
        '    "slideSec": ' + u.slideSec + ',',
        '    // 播完一整册后：loop = 循环本册 / next = 自动跳下一个相册',
        '    "playMode": ' + j(u.playMode || 'loop') + ',',
        '    // 多列模式图片缩放（%）：100 = 填满一列，<100 变小留白，>100 放大裁边',
        '    "twoH": ' + (u.twoH || 100) + ',',
        '    // 多列模式列数：2 - 6',
        '    "twoCols": ' + (u.twoCols || 2) + ',',
        '    // 是否默认「读取所有子文件夹」',
        '    "recursive": ' + b(u.recursive) + ',',
        '    // 是否在图片上显示序号：true = 显示，false = 不显示',
        '    "showIndex": ' + b(u.showIndex) + ',',
        '    // 排序字段（目前只支持 name）',
        '    "sort": ' + j(u.sort || 'name'),
        '  }',
        '}',
        '',
    ].join('\n');
}

/** 配置读取失败的原因（前端会显示，不再假装「还没选目录」） */
let CONFIG_ERROR = '';

function readConfig() {
    CONFIG_ERROR = '';
    let raw = '';
    try {
        raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    } catch (e) {
        // 文件不存在：第一次运行
        CONFIG = { root: '', ui: { ...DEFAULT_UI } };
        if (ARG_ROOT && isDir(ARG_ROOT)) CONFIG.root = path.resolve(ARG_ROOT);
        return;
    }
    try {
        // 记事本存 UTF-8 默认带 BOM，JSON.parse 会直接报错；先吃掉它
        let text = raw;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const j = JSON.parse(stripJsonComments(text));
        CONFIG.root = typeof j.root === 'string' ? j.root : '';
        CONFIG.ui = { ...DEFAULT_UI, ...(j.ui || {}) };
    } catch (e) {
        // 文件在、但读不懂：保留磁盘上的原文，不要把 root 静默清空
        CONFIG = { root: '', ui: { ...DEFAULT_UI } };
        CONFIG_ERROR = 'config.json 解析失败：' + e.message;
        console.error('[gallery] ' + CONFIG_ERROR);
    }
    if (ARG_ROOT && isDir(ARG_ROOT)) CONFIG.root = path.resolve(ARG_ROOT);
}

function writeConfig() {
    const ui = safeUi();
    const text = renderConfig({ root: CONFIG.root, ui: ui });
    // 写盘前先确认生成的内容能被解析回来，防止把 config.json 写成坏文件
    const round = JSON.parse(stripJsonComments(text));
    if (!round || typeof round !== 'object' || !round.ui) throw new Error('配置生成异常');
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, CONFIG_PATH);
    CONFIG.ui = ui;
    return round;
}

function clampInt(v, lo, hi, dflt) {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** 把任意来源的 ui 规整成合法值，避免写出 undefined / 越界值。 */
function safeUi() {
    const u = CONFIG.ui || {};
    const pick = (k) => (u[k] === undefined || u[k] === null ? DEFAULT_UI[k] : u[k]);
    const out = {
        view: pick('view'),
        cols: clampInt(pick('cols'), 1, 8, DEFAULT_UI.cols),
        gap: clampInt(pick('gap'), 0, 24, DEFAULT_UI.gap),
        fit: pick('fit'),
        theme: pick('theme'),
        rot: Number(pick('rot')),
        autoSpeed: clampInt(pick('autoSpeed'), 10, 400, DEFAULT_UI.autoSpeed),
        autoMode: pick('autoMode'),
        autoStep: clampInt(pick('autoStep'), 1, 60, DEFAULT_UI.autoStep),
        slideSec: clampInt(pick('slideSec'), 1, 30, DEFAULT_UI.slideSec),
        playMode: pick('playMode'),
        twoH: clampInt(pick('twoH'), 60, 150, 100),
        twoCols: clampInt(pick('twoCols'), 2, 6, 2),
        recursive: !!pick('recursive'),
        showIndex: !!pick('showIndex'),
        sort: pick('sort') || 'name',
    };
    if (['grid', 'two', 'single'].indexOf(out.view) < 0) out.view = DEFAULT_UI.view;
    if (['auto', 'cover', 'contain', 'fill'].indexOf(out.fit) < 0) out.fit = DEFAULT_UI.fit;
    if (['light', 'dark'].indexOf(out.theme) < 0) out.theme = DEFAULT_UI.theme;
    if (['scroll', 'step'].indexOf(out.autoMode) < 0) out.autoMode = DEFAULT_UI.autoMode;
    if (['loop', 'next'].indexOf(out.playMode) < 0) out.playMode = DEFAULT_UI.playMode;
    if ([0, 90, 180, 270].indexOf(out.rot) < 0) out.rot = 0;
    return out;
}

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

/** 当前生效的图库根（可能为空字符串 = 还没选） */
function root() {
    return CONFIG.root && isDir(CONFIG.root) ? path.resolve(CONFIG.root) : '';
}

// ---------------------------------------------------------------- 工具
function log(...a) { console.log('[gallery]', ...a); }

function isImage(name) {
    return IMG_EXT.has(path.extname(name).toLowerCase());
}

function fail(status, msg) {
    const e = new Error(msg);
    e.status = status;
    return e;
}

function resolveSafe(rel) {
    const R = root();
    if (!R) throw fail(409, '还没有设置图库目录');
    let clean = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean.includes('\0')) throw fail(400, 'bad path');
    const abs = path.resolve(R, clean);
    const r = path.relative(R, abs);
    if (r === '') return abs;
    if (r.startsWith('..') || path.isAbsolute(r)) throw fail(403, 'path out of root');
    return abs;
}

function toRel(abs) {
    const R = root();
    if (!R) return '';
    const r = path.relative(R, abs).replace(/\\/g, '/');
    return r === '' ? '' : r;
}

async function mapLimit(list, limit, fn) {
    const out = new Array(list.length);
    let i = 0;
    const workers = new Array(Math.min(limit, list.length || 1)).fill(0).map(async () => {
        for (;;) {
            const k = i++;
            if (k >= list.length) return;
            out[k] = await fn(list[k], k);
        }
    });
    await Promise.all(workers);
    return out;
}

// ---------------------------------------------------------------- 尺寸探测
const dimCache = new Map();

function parseDims(b) {
    if (!b || b.length < 16) return null;

    // WEBP: 遍历 RIFF chunk，兼容 VP8X(带 alpha/动图) / VP8(有损) / VP8L(无损)
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
        let p = 12;
        let guard = 0;
        while (p + 8 <= b.length && guard++ < 32) {
            const id = b.toString('ascii', p, p + 4);
            const size = b.readUInt32LE(p + 4);
            const d = p + 8;
            if (id === 'VP8X' && d + 10 <= b.length) {
                return {
                    w: (b[d + 4] | (b[d + 5] << 8) | (b[d + 6] << 16)) + 1,
                    h: (b[d + 7] | (b[d + 8] << 8) | (b[d + 9] << 16)) + 1,
                };
            }
            if (id === 'VP8 ' && d + 10 <= b.length) {
                if (b[d + 3] === 0x9d && b[d + 4] === 0x01 && b[d + 5] === 0x2a) {
                    return { w: b.readUInt16LE(d + 6) & 0x3fff, h: b.readUInt16LE(d + 8) & 0x3fff };
                }
                return null;
            }
            if (id === 'VP8L' && d + 5 <= b.length && b[d] === 0x2f) {
                const v = b.readUInt32LE(d + 1);
                return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
            }
            if (size <= 0 || size > b.length) break;
            p = d + size + (size & 1);
        }
        return null;
    }

    // PNG
    if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG' && b.length >= 24) {
        return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    }

    // GIF
    if (b.toString('ascii', 0, 3) === 'GIF' && b.length >= 10) {
        return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    }

    // BMP
    if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) {
        return { w: Math.abs(b.readInt32LE(18)), h: Math.abs(b.readInt32LE(22)) };
    }

    // JPEG: 扫 SOFn 段
    if (b[0] === 0xff && b[1] === 0xd8) {
        let p = 2;
        while (p + 9 < b.length) {
            if (b[p] !== 0xff) { p++; continue; }
            const m = b[p + 1];
            if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
            const len = b.readUInt16BE(p + 2);
            if (len < 2) break;
            const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
            if (isSof) return { h: b.readUInt16BE(p + 5), w: b.readUInt16BE(p + 7) };
            p += 2 + len;
        }
    }
    return null;
}

async function probeDims(abs, stat) {
    const hit = dimCache.get(abs);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit;
    let out = { mtimeMs: stat.mtimeMs, w: 0, h: 0 };
    try {
        const fh = await fsp.open(abs, 'r');
        const buf = Buffer.alloc(131072);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        await fh.close();
        const d = parseDims(buf.subarray(0, bytesRead));
        if (d && d.w > 0 && d.h > 0) out = { mtimeMs: stat.mtimeMs, w: d.w, h: d.h };
    } catch (e) { /* ignore */ }
    if (dimCache.size > 40000) dimCache.clear();
    dimCache.set(abs, out);
    return out;
}

// ---------------------------------------------------------------- 目录扫描
const listCache = new Map();

async function countImagesIn(dirAbs) {
    let n = 0, cover = '', sub = 0;
    try {
        const ents = await fsp.readdir(dirAbs, { withFileTypes: true });
        for (const e of ents) {
            if (e.isDirectory()) { sub++; continue; }
            if (!e.isFile() || !isImage(e.name)) continue;
            n++;
            if (!cover || e.name.localeCompare(cover, 'zh-CN', { numeric: true }) < 0) cover = e.name;
        }
    } catch (e) { /* ignore */ }
    return { n, cover, sub };
}

async function listDir(relDir) {
    const abs = resolveSafe(relDir);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) throw fail(404, '目录不存在');
    if (!stat.isDirectory()) throw fail(400, '不是目录');

    const cached = listCache.get(abs);
    // 目录 mtime 只反映「增删文件」，原地替换一张图不会变；再加一个短 TTL 兜住这种情况
    if (cached && cached.mtimeMs === stat.mtimeMs && Date.now() - cached.at < 4000) {
        return { ...cached.data, cached: true };
    }

    const ents = await fsp.readdir(abs, { withFileTypes: true });
    const dirEnts = [], fileEnts = [];
    for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) dirEnts.push(e);
        else if (e.isFile() && isImage(e.name)) fileEnts.push(e);
    }

    const dirs = await mapLimit(dirEnts, 16, async (e) => {
        const childAbs = path.join(abs, e.name);
        const c = await countImagesIn(childAbs);
        let mtime = 0;
        try { mtime = (await fsp.stat(childAbs)).mtimeMs; } catch (err) { }
        return { n: e.name, p: toRel(childAbs), count: c.n, sub: c.sub, cover: c.cover, t: Math.round(mtime) };
    });

    const files = await mapLimit(fileEnts, 24, async (e) => {
        const fAbs = path.join(abs, e.name);
        let st;
        try { st = await fsp.stat(fAbs); } catch (err) { return null; }
        const d = await probeDims(fAbs, st);
        return { n: e.name, p: toRel(fAbs), s: st.size, t: Math.round(st.mtimeMs), w: d.w, h: d.h };
    });

    const clean = files.filter(Boolean).sort((a, b) => a.n.localeCompare(b.n, 'zh-CN', { numeric: true }));
    const data = {
        path: toRel(abs),
        name: path.basename(abs) || root(),
        parent: (() => {
            const r = toRel(abs);
            if (!r) return null;
            const i = r.lastIndexOf('/');
            return i < 0 ? '' : r.slice(0, i);
        })(),
        dirs: dirs.sort((a, b) => a.n.localeCompare(b.n, 'zh-CN', { numeric: true })),
        files: clean,
        total: clean.length,
    };

    if (listCache.size > 500) listCache.clear();
    listCache.set(abs, { mtimeMs: stat.mtimeMs, at: Date.now(), data });
    return { ...data, cached: false };
}

async function listRecursive(relDir) {
    const abs0 = resolveSafe(relDir);
    const out = [];
    let truncated = false;

    async function walk(abs, depth) {
        if (truncated || depth > MAX_DEPTH) return;
        let ents = [];
        try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { return; }

        const files = ents.filter((e) => e.isFile() && isImage(e.name) && !e.name.startsWith('.'));
        await mapLimit(files, 24, async (e) => {
            if (out.length >= MAX_RECURSIVE_FILES) { truncated = true; return; }
            const fAbs = path.join(abs, e.name);
            let st;
            try { st = await fsp.stat(fAbs); } catch (err) { return; }
            const d = await probeDims(fAbs, st);
            out.push({ n: e.name, p: toRel(fAbs), f: toRel(abs), s: st.size, t: Math.round(st.mtimeMs), w: d.w, h: d.h });
        });

        for (const s of ents.filter((e) => e.isDirectory() && !e.name.startsWith('.'))) {
            if (truncated) return;
            await walk(path.join(abs, s.name), depth + 1);
        }
    }

    const stat = await fsp.stat(abs0).catch(() => null);
    if (!stat || !stat.isDirectory()) throw fail(404, '目录不存在');
    await walk(abs0, 0);

    out.sort((a, b) => {
        if (a.f !== b.f) return a.f.localeCompare(b.f, 'zh-CN', { numeric: true });
        return a.n.localeCompare(b.n, 'zh-CN', { numeric: true });
    });

    return { path: toRel(abs0), files: out, total: out.length, truncated, recursive: true };
}

/** 目录选择器用：列任意路径下的子目录（不读文件内容，只列名字） */
async function browseDir(target) {
    if (process.platform === 'win32' && (!target || /^[A-Za-z]:?$/.test(target))) {
        const drives = [];
        for (let i = 67; i <= 90; i++) {
            const d = String.fromCharCode(i) + ':\\';
            if (isDir(d)) drives.push({ n: d, p: d });
        }
        return { path: '', parent: null, dirs: drives, drives: true };
    }
    const abs = path.resolve(target);
    if (!isDir(abs)) throw fail(404, '目录不存在');
    const ents = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
    const dirs = ents
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ n: e.name, p: path.join(abs, e.name) }))
        .sort((a, b) => a.n.localeCompare(b.n, 'zh-CN', { numeric: true }));
    const parent = path.dirname(abs);
    return { path: abs, parent: parent === abs ? null : parent, dirs };
}

function quickPlaces() {
    const home = os.homedir();
    const cands = [
        { n: '桌面', p: path.join(home, 'Desktop') },
        { n: '下载', p: path.join(home, 'Downloads') },
        { n: '图片', p: path.join(home, 'Pictures') },
        { n: '文档', p: path.join(home, 'Documents') },
        { n: '用户目录', p: home },
    ];
    return cands.filter((c) => isDir(c.p));
}

// ---------------------------------------------------------------- HTTP
function sendJSON(req, res, code, obj) {
    let body = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const ae = String(req.headers['accept-encoding'] || '');
    if (body.length > 1024 && /\bgzip\b/.test(ae)) {
        body = zlib.gzipSync(body, { level: 6 });
        head['Content-Encoding'] = 'gzip';
    }
    head['Content-Length'] = body.length;
    res.writeHead(code, head);
    res.end(body);
}

function sendFile(req, res, abs, stat, cacheControl) {
    const total = stat.size;
    const etag = 'W/"' + total.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';

    const base = {
        'Content-Type': type,
        'ETag': etag,
        'Last-Modified': stat.mtime.toUTCString(),
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl || 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
    };

    if (req.headers['if-none-match'] === etag) { res.writeHead(304, base); res.end(); return; }

    const range = req.headers.range;
    if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
            let start = m[1] === '' ? null : Number(m[1]);
            let end = m[2] === '' ? null : Number(m[2]);
            if (start === null && end !== null) { start = Math.max(0, total - end); end = total - 1; }
            if (start !== null && end === null) end = total - 1;
            if (start === null || start > end || start >= total) {
                res.writeHead(416, { 'Content-Range': 'bytes */' + total });
                res.end();
                return;
            }
            end = Math.min(end, total - 1);
            res.writeHead(206, { ...base, 'Content-Range': 'bytes ' + start + '-' + end + '/' + total, 'Content-Length': end - start + 1 });
            const rs = fs.createReadStream(abs, { start, end });
            // 200 分支挂了 error 监听，这里也必须挂：文件被占用/中途读失败时，
            // 没有监听就是未捕获异常，整个服务进程会直接退出。
            rs.on('error', () => { try { res.destroy(); } catch (e) { } });
            rs.pipe(res);
            return;
        }
    }

    res.writeHead(200, { ...base, 'Content-Length': total });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(abs);
    stream.on('error', () => { try { res.destroy(); } catch (e) { } });
    stream.pipe(res);
}

function servePublic(req, res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    const abs = path.resolve(PUBLIC_DIR, rel.replace(/^\/+/, ''));
    // startsWith 会把 ...\public2 这种前缀也算成命中，用 path.relative 判包含才严谨
    const inside = path.relative(PUBLIC_DIR, abs);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
    }
    fs.stat(abs, (err, st) => {
        if (err || !st.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404');
            return;
        }
        sendFile(req, res, abs, st, 'no-cache');
    });
}

function openBrowser(url) {
    try {
        if (process.platform === 'win32') {
            execSync('start "" "' + url + '"', { shell: 'cmd.exe', stdio: 'ignore', windowsHide: true });
        } else if (process.platform === 'darwin') {
            execSync('open "' + url + '"', { stdio: 'ignore' });
        } else {
            execSync('xdg-open "' + url + '"', { stdio: 'ignore' });
        }
    } catch (e) { /* 打不开就算了，不影响服务 */ }
}

function lanAddresses() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family !== 'IPv4' || a.internal) continue;
            if (a.address.startsWith('169.254.')) continue;
            out.push({ iface: name, ip: a.address });
        }
    }
    // 私网地址排前面：VPN / 虚拟网卡（198.18.x、100.64.x）不该抢到第一行，
    // 手机要输的永远是 192.168 / 10 / 172.16-31 那一个
    const rank = (ip) => (/^192\.168\./.test(ip) ? 0
        : /^10\./.test(ip) ? 1
            : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
    out.sort((a, b) => rank(a.ip) - rank(b.ip));
    return out;
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        let n = 0;
        let tooBig = false;
        const chunks = [];
        req.on('data', (c) => {
            n += c.length;
            if (n > (limit || 262144)) {
                // 不 destroy：socket 一销毁，上层连 413 都回不出去
                if (!tooBig) { tooBig = true; reject(fail(413, 'body too large')); }
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
            catch (e) { reject(fail(400, 'bad json')); }
        });
        req.on('error', reject);
    });
}

// ---------------------------------------------------------------- 中转站
// 文件直接落在磁盘目录里，按原文件名保存（同名自动加 (1)(2)），
// 不做 TTL、不做鉴权 —— 局域网内谁打开页面谁就能看、能下、能删。
const DROP_DIR = (() => {
    const a = argv.find((x) => x.startsWith('--drop='));
    return path.resolve(a ? a.slice('--drop='.length) : path.join(APP_DIR, '.drops'));
})();

/** 上传中的分片文件后缀，列表里不显示 */
const PART_SUFFIX = '.part';
const dropClients = new Set();

function dropDir() {
    try { fs.mkdirSync(DROP_DIR, { recursive: true }); } catch (e) { }
    return DROP_DIR;
}

/** 把任意文件名洗成 Windows / macOS 都能落盘的形式 */
function safeDropName(raw) {
    let t = String(raw == null ? '' : raw)
        .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    t = t.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    if (!t) t = 'file';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(t)) t = '_' + t;
    if (t.length > 120) {
        const ext = path.extname(t).slice(0, 12);
        t = t.slice(0, 120 - ext.length) + ext;
    }
    return t;
}

/** 同名文件自动加 (1)(2)…，不覆盖已有文件 */
function uniqueDropName(name) {
    const dir = dropDir();
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let cand = name;
    for (let i = 1; i < 1000; i++) {
        if (!fs.existsSync(path.join(dir, cand))) return cand;
        cand = stem + ' (' + i + ')' + ext;
    }
    return Date.now() + '-' + name;
}

/** 分片文件名带上总大小：同名但不同内容的两份文件不会互相拼接 */
function partPath(name, total) {
    return path.join(dropDir(), name + '.' + (Number(total) || 0) + PART_SUFFIX);
}

/** 把名字解析成绝对路径，并保证不跑出中转目录 */
function dropPath(name) {
    const dir = dropDir();
    const abs = path.resolve(dir, name);
    const rel = path.relative(dir, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw fail(403, 'bad name');
    return abs;
}

async function listDrops() {
    const dir = dropDir();
    const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = [];
    let bytes = 0;
    for (const e of ents) {
        if (!e.isFile() || e.name.endsWith(PART_SUFFIX)) continue;
        let st;
        try { st = await fsp.stat(path.join(dir, e.name)); } catch (err) { continue; }
        files.push({
            n: e.name,
            s: st.size,
            t: Math.round(st.mtimeMs),
            u: '/d/' + encodeURIComponent(e.name),
        });
        bytes += st.size;
    }
    files.sort((a, b) => b.t - a.t);
    return { dir, files, total: files.length, bytes, lan: lanAddresses(), port: PORT };
}

function broadcastDrops() {
    if (!dropClients.size) return;
    listDrops().then((d) => {
        const msg = 'data: ' + JSON.stringify(d) + '\n\n';
        for (const c of dropClients) { try { c.write(msg); } catch (e) { } }
    }).catch(() => { });
}

/** RFC 6266：中文名走 filename*，同时给一个纯 ASCII 的兜底名 */
function contentDisposition(name) {
    const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const enc = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    return 'attachment; filename="' + ascii + '"; filename*=UTF-8' + "''" + enc;
}

const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
    catch (e) { res.writeHead(400); res.end('bad url'); return; }
    const p = u.pathname;

    try {
        if (p === '/api/info') {
            sendJSON(req, res, 200, {
                root: root(),
                configuredRoot: CONFIG.root,
                port: PORT,
                lan: lanAddresses(),
                node: process.version,
                platform: process.platform,
                configPath: CONFIG_PATH,
                places: quickPlaces(),
            });
            return;
        }

        if (p === '/api/config' && req.method === 'GET') {
            sendJSON(req, res, 200, {
                root: root(),
                configuredRoot: CONFIG.root,
                rootExists: !!root(),
                rootMissing: !!CONFIG.root && !root(),
                configError: CONFIG_ERROR,
                ui: CONFIG.ui,
                defaults: DEFAULT_UI,
                configPath: CONFIG_PATH,
            });
            return;
        }

        if (p === '/api/config' && req.method === 'POST') {
            const body = await readBody(req);
            const prevRoot = CONFIG.root;
            const prevUi = CONFIG.ui;
            let saved;
            try {
                if (typeof body.root === 'string') {
                    const candidate = body.root.trim();
                    if (!candidate) {
                        CONFIG.root = '';
                    } else {
                        const abs = path.resolve(candidate);
                        if (!isDir(abs)) throw fail(400, '目录不存在：' + abs);
                        CONFIG.root = abs;
                    }
                    listCache.clear();
                    dimCache.clear();
                }
                if (body.ui && typeof body.ui === 'object') {
                    const next = { ...CONFIG.ui };
                    for (const [k, v] of Object.entries(body.ui)) {
                        if (!(k in DEFAULT_UI)) continue;
                        next[k] = v;
                    }
                    CONFIG.ui = next;
                }
                saved = writeConfig();
            } catch (err) {
                // 写盘失败就回滚内存，别出现「界面显示改了、磁盘没改」
                CONFIG.root = prevRoot;
                CONFIG.ui = prevUi;
                throw err;
            }
            // 回读磁盘，确认真的落地了
            let onDisk = null;
            try { onDisk = JSON.parse(stripJsonComments(fs.readFileSync(CONFIG_PATH, 'utf8'))); } catch (e) { }
            console.log('[gallery] 已保存配置 -> ' + CONFIG_PATH
                + '  root=' + (CONFIG.root || '(空)')
                + '  disk.root=' + (onDisk ? JSON.stringify(onDisk.root) : '读取失败'));
            sendJSON(req, res, 200, {
                ok: true,
                root: root(),
                configuredRoot: CONFIG.root,
                rootMissing: !!CONFIG.root && !root(),
                ui: CONFIG.ui,
                saved: saved,
                onDiskRoot: onDisk ? onDisk.root : null,
                configPath: CONFIG_PATH,
            });
            return;
        }

        // ------------------------------------------------ 中转站
        if (p === '/api/drop/list') {
            sendJSON(req, res, 200, await listDrops());
            return;
        }

        // SSE：别的设备传完 / 删完，这边列表自动刷新
        if (p === '/api/drop/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-store',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            dropClients.add(res);
            const push = () => {
                listDrops().then((d) => { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch (e) { } }).catch(() => { });
            };
            push();
            const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { } }, 15000);
            req.on('close', () => { clearInterval(ping); dropClients.delete(res); });
            return;
        }

        // 断点续传：问一下已经收了多少字节（HEAD 没有 body，所以两个都支持，HEAD 走 X-Received 头）
        if (p === '/api/drop/upload' && (req.method === 'GET' || req.method === 'HEAD')) {
            const name = safeDropName(u.searchParams.get('name') || '');
            const total = Number(u.searchParams.get('size') || 0);
            let have = 0;
            try { have = (await fsp.stat(partPath(name, total))).size; } catch (e) { }
            res.setHeader('X-Received', String(have));
            sendJSON(req, res, 200, { name, received: have });
            return;
        }

        // 分片上传：裸 body + Content-Range，不用 multipart，也不经过内存缓冲
        if (p === '/api/drop/upload' && (req.method === 'PUT' || req.method === 'POST')) {
            const name = safeDropName(u.searchParams.get('name') || '');
            const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] || ''));
            if (!m) throw fail(400, 'need Content-Range: bytes a-b/total');
            const start = Number(m[1]);
            const total = Number(m[3]);
            const part = partPath(name, total);

            let have = 0;
            try { have = (await fsp.stat(part)).size; } catch (e) { }
            if (have !== start) { sendJSON(req, res, 409, { expect: have, name }); return; }

            const ws = fs.createWriteStream(part, { flags: start === 0 ? 'w' : 'a' });
            await new Promise((resolve, reject) => {
                ws.on('error', reject);
                ws.on('finish', resolve);
                req.on('aborted', () => { ws.destroy(); reject(fail(499, 'aborted')); });
                req.pipe(ws);          // pipe 自带背压，几 GB 也不会把内存撑爆
            });

            let size = 0;
            try { size = (await fsp.stat(part)).size; } catch (e) { }
            if (total && size >= total) {
                const final = uniqueDropName(name);
                await fsp.rename(part, path.join(dropDir(), final));
                broadcastDrops();
                sendJSON(req, res, 200, { done: true, name: final, size, received: size });
            } else {
                sendJSON(req, res, 200, { done: false, name, received: size });
            }
            return;
        }

        if (p === '/api/drop/file' && req.method === 'DELETE') {
            const abs = dropPath(safeDropName(u.searchParams.get('name') || ''));
            let ok = true;
            try { await fsp.unlink(abs); } catch (e) { ok = false; }
            if (!ok) throw fail(404, '文件不存在');
            broadcastDrops();
            sendJSON(req, res, 200, { ok: true });
            return;
        }

        if (p === '/api/drop/all' && req.method === 'DELETE') {
            const dir = dropDir();
            const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
            let removed = 0;
            for (const e of ents) {
                if (!e.isFile()) continue;
                try { await fsp.unlink(path.join(dir, e.name)); removed++; } catch (err) { }
            }
            broadcastDrops();
            sendJSON(req, res, 200, { ok: true, removed });
            return;
        }

        // 下载：直接复用 sendFile，Range / 206 / 416 都是现成的
        if (p.startsWith('/d/')) {
            const raw = decodeURIComponent(p.slice(3));
            const abs = dropPath(safeDropName(raw));
            const st = await fsp.stat(abs).catch(() => null);
            if (!st || !st.isFile()) throw fail(404, '文件不存在');
            res.setHeader('Content-Disposition', contentDisposition(path.basename(abs)));
            sendFile(req, res, abs, st, 'no-store');
            return;
        }

        if (p === '/api/drives') {
            const places = quickPlaces();
            let drives = [];
            if (process.platform === 'win32') {
                for (let i = 67; i <= 90; i++) {
                    const d = String.fromCharCode(i) + ':\\';
                    if (isDir(d)) drives.push({ n: d, p: d });
                }
            } else {
                drives = [{ n: '/', p: '/' }];
            }
            sendJSON(req, res, 200, { drives, places });
            return;
        }

        if (p === '/api/browse') {
            const target = u.searchParams.get('p') || '';
            sendJSON(req, res, 200, await browseDir(target));
            return;
        }

        if (p === '/api/list') {
            const rel = u.searchParams.get('p') || '';
            if (!root()) { sendJSON(req, res, 409, { error: '还没有设置图库目录', needRoot: true }); return; }
            if (u.searchParams.get('recursive') === '1') sendJSON(req, res, 200, await listRecursive(rel));
            else sendJSON(req, res, 200, await listDir(rel));
            return;
        }

        if (p === '/img' || p === '/api/thumb') {
            const rel = u.searchParams.get('p') || '';
            const abs = resolveSafe(rel);
            if (!isImage(abs)) throw fail(403, 'not an image');
            const st = await fsp.stat(abs);
            if (!st.isFile()) throw fail(404, 'not a file');
            sendFile(req, res, abs, st);
            return;
        }

        if (p === '/drop' || p === '/drop/') { servePublic(req, res, '/drop.html'); return; }
        if (p.startsWith('/api/')) { sendJSON(req, res, 404, { error: 'no such api' }); return; }

        servePublic(req, res, p);
    } catch (e) {
        const code = e.status || 500;
        if (code >= 500) console.error('[gallery] 500', p, e);
        try { sendJSON(req, res, code, { error: e.message }); } catch (err) { }
    }
});

// ---------------------------------------------------------------- 端口占用清理
function findPidsOnPort(port) {
    const pids = new Set();
    try {
        if (process.platform === 'win32') {
            const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true, maxBuffer: 8 << 20 });
            for (const line of out.split(/\r?\n/)) {
                const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
                if (m && Number(m[1]) === port) pids.add(Number(m[2]));
            }
        } else {
            const out = execSync('lsof -ti tcp:' + port + ' -sTCP:LISTEN', { encoding: 'utf8', windowsHide: true });
            for (const s of out.split(/\s+/)) if (s) pids.add(Number(s));
        }
    } catch (e) { /* 没装 lsof 或没有占用 */ }
    return pids;
}

function killPids(pids) {
    let ok = 0;
    for (const pid of pids) {
        if (!pid || pid === process.pid) continue;
        try {
            if (process.platform === 'win32') execSync('taskkill /PID ' + pid + ' /F /T', { stdio: 'ignore', windowsHide: true });
            else execSync('kill -9 ' + pid, { stdio: 'ignore' });
            ok++;
        } catch (e) { /* 权限不足等 */ }
    }
    return ok;
}

function startListening(attempt) {
    server.once('error', (e) => {
        if (e.code !== 'EADDRINUSE' || NO_KILL || attempt >= 4) {
            if (e.code === 'EADDRINUSE') {
                console.error('');
                console.error('  [x] Port ' + PORT + ' is already in use.');
                console.error('      Close the other window, or run with another port:');
                console.error('      node server.js --port=' + (PORT + 1));
                console.error('');
            } else {
                console.error(e);
            }
            process.exit(1);
            return;
        }
        const pids = findPidsOnPort(PORT);
        if (!pids.size) {
            setTimeout(() => startListening(attempt + 1), 400);
            return;
        }
        console.log('[gallery] Port ' + PORT + ' is busy (pid ' + [...pids].join(', ') + '), stopping it...');
        killPids(pids);
        setTimeout(() => startListening(attempt + 1), 900);
    });

    server.listen(PORT, HOST, () => {
        const lan = lanAddresses();
        const R = root();
        console.log('');
        console.log('  +---------------------------------------------');
        console.log('  |  Local Gallery');
        console.log('  +---------------------------------------------');
        if (R) {
            console.log('  |  Library : ' + R);
        } else if (CONFIG.root) {
            console.log('  |  Library : [目录不存在] ' + CONFIG.root);
        } else {
            console.log('  |  Library : (not set)  -> pick it in the web page');
        }
        console.log('  |  Config  : ' + CONFIG_PATH);
        console.log('  |  Drop    : ' + DROP_DIR);
        console.log('  |  Local   : http://localhost:' + PORT);
        for (const a of lan) console.log('  |  LAN     : http://' + a.ip + ':' + PORT);
        console.log('  +---------------------------------------------');
        console.log('  |  Ctrl+C to stop');
        console.log('');
        if (OPEN_BROWSER) setTimeout(() => openBrowser('http://localhost:' + PORT + '/'), 200);
    });
}

readConfig();
// 中转站要传大文件：Node 18+ 默认 requestTimeout = 300000ms，慢 WiFi 传几 GB 必被掐断
server.requestTimeout = 0;
startListening(0);
