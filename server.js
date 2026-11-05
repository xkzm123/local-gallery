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
const dgram = require('dgram');
const crypto = require('crypto');
const { execSync, execFile } = require('child_process');

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

/** 目录选择器用：列任意路径下的子目录（不读文件内容，只列名字）；withFiles 时连文件名一起列 */
async function browseDir(target, withFiles) {
    if (process.platform === 'win32' && (!target || /^[A-Za-z]:?$/.test(target))) {
        const drives = [];
        for (let i = 67; i <= 90; i++) {
            const d = String.fromCharCode(i) + ':\\';
            if (isDir(d)) drives.push({ n: d, p: d });
        }
        return { path: '', parent: null, dirs: drives, drives: true, files: [] };
    }
    const abs = path.resolve(target);
    if (!isDir(abs)) throw fail(404, '目录不存在');
    const ents = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
    const dirs = ents
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ n: e.name, p: path.join(abs, e.name) }))
        .sort((a, b) => a.n.localeCompare(b.n, 'zh-CN', { numeric: true }));
    const files = withFiles
        ? ents
            .filter((e) => e.isFile() && !e.name.startsWith('.'))
            .map((e) => ({ n: e.name, p: path.join(abs, e.name) }))
            .sort((a, b) => a.n.localeCompare(b.n, 'zh-CN', { numeric: true }))
        : [];
    const parent = path.dirname(abs);
    return { path: abs, parent: parent === abs ? null : parent, dirs, files };
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
    // 手机要输的永远是 192.168 / 10 / 172.16-31 那一个。
    // 192.168.137.1 是 Windows 移动热点的固定地址，优先级压到最后。
    const rank = (ip) => (ip === '192.168.137.1' ? 9
        : /^192\.168\./.test(ip) ? 0
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

/**
 * DNS 劫持：只劫持「联网探测」那几个域名，其余全部转发给上游。
 *
 * 为什么只劫持这几个：
 *   把 53 端口整个劫持成「什么都回本机」= 酒店式强制门户，客人不点确认就上不了网；
 *   我们只是想让系统弹一次「登录网络」的提示，弹完人家该怎么上网怎么上网。
 *   所以非探测域名一律透明转发，PC 关掉时配合路由器备用 DNS 也不会断网。
 */
const PROBE_DOMAINS = [
    'connectivitycheck.gstatic.com',   // Android
    'connectivitycheck.android.com',
    'www.google.com',                  // 部分 Android 老版本
    'captive.apple.com',               // iOS / macOS
    'www.apple.com',
    'www.msftconnecttest.com',         // Windows
    'www.msftncsi.com',
    'detectportal.firefox.com',        // Firefox
    'networkcheck.kde.org',            // KDE
];

const DNS_UPSTREAM = (() => {
    const a = argv.find((x) => x.startsWith('--dns-upstream='));
    return a ? a.split('=')[1] : '223.5.5.5';
})();

function dnsQName(msg) {
    let p = 12;
    const parts = [];
    while (p < msg.length && msg[p] !== 0) {
        const len = msg[p];
        if (len > 63 || p + 1 + len > msg.length) return null;
        parts.push(msg.toString('ascii', p + 1, p + 1 + len));
        p += 1 + len;
    }
    // 问题段 = 域名 + 0x00 + QTYPE(2) + QCLASS(2)，整段都要原样抄回去
    if (p + 5 > msg.length) return null;
    return {
        name: parts.join('.').toLowerCase(),
        qtype: msg.readUInt16BE(p + 1),
        end: p + 5,
    };
}

function dnsA(msg, q, ip) {
    const head = Buffer.from(msg.subarray(0, q.end));
    head[2] = 0x81;                       // QR=1 RD=1
    head[3] = 0x80;                       // RA=1 NOERROR
    head[6] = 0; head[7] = 1;             // ANCOUNT = 1
    head[8] = 0; head[9] = 0;             // NSCOUNT
    head[10] = 0; head[11] = 0;           // ARCOUNT
    const ans = Buffer.alloc(16);
    ans.writeUInt16BE(0xc00c, 0);         // 指向问题里的域名
    ans.writeUInt16BE(1, 2);              // TYPE A
    ans.writeUInt16BE(1, 4);              // CLASS IN
    ans.writeUInt32BE(0, 6);              // TTL 0，不缓存
    ans.writeUInt16BE(4, 10);             // RDLENGTH
    const o = ip.split('.').map(Number);
    ans[12] = o[0]; ans[13] = o[1]; ans[14] = o[2]; ans[15] = o[3];
    return Buffer.concat([head, ans]);
}

/** qtype 不是 A 的查询：回一个「没有记录」，让客户端自己回退去查 A */
function dnsEmpty(msg, q) {
    const head = Buffer.from(msg.subarray(0, q.end));
    head[2] = 0x81;
    head[3] = 0x80;
    head[6] = 0; head[7] = 0;
    head[8] = 0; head[9] = 0;
    head[10] = 0; head[11] = 0;
    return head;
}

function startDns() {
    const lan = lanAddresses();
    const myIp = (lan[0] || {}).ip;
    if (!myIp) {
        console.error('  [!] DNS 劫持：找不到局域网地址，跳过');
        return;
    }

    const sock = dgram.createSocket('udp4');
    sock.on('error', (e) => {
        console.error('  [!] DNS 53 端口起不来：' + e.message
            + '（可能被其它 DNS 服务占用，或需要管理员权限）');
    });

    sock.on('message', (msg, rinfo) => {
        if (msg.length < 13) return;
        const q = dnsQName(msg);
        if (!q) return;
        const hit = PROBE_DOMAINS.some((d) => q.name === d || q.name.endsWith('.' + d));

        if (hit) {
            try {
                sock.send(q.qtype === 1 ? dnsA(msg, q, myIp) : dnsEmpty(msg, q), rinfo.port, rinfo.address);
            } catch (e) { }
            return;
        }

        // 其余透明转发
        const up = dgram.createSocket('udp4');
        let done = false;
        const finish = (buf) => {
            if (done) return;
            done = true;
            try { if (buf) sock.send(buf, rinfo.port, rinfo.address); } catch (e) { }
            try { up.close(); } catch (e) { }
        };
        up.on('message', (r) => finish(r));
        up.on('error', () => finish(null));
        setTimeout(() => finish(null), 3000);
        try {
            up.send(msg, 53, DNS_UPSTREAM);
        } catch (e) {
            finish(null);
        }
    });

    sock.bind(53, '0.0.0.0', () => {
        console.log('  |  DNS     : 53 已劫持探测域名 -> ' + myIp + '，其余转发 ' + DNS_UPSTREAM);
    });
}

// ---------------------------------------------------------------- 访客门户
// --portal        在 80 端口再起一个极简服务：任何请求都 302 到 /guest
// --portal=8080   换端口（调试用）
const PORTAL_PORT = (() => {
    const a = argv.find((x) => x === '--portal' || x.startsWith('--portal='));
    if (!a) return 0;
    if (a === '--portal') return 80;
    return Number(a.split('=')[1]) || 80;
})();

const GUEST_FILE = path.join(APP_DIR, 'guest.json');
const GUEST_LOG = path.join(APP_DIR, '.guest-log.json');
const GUEST_LOG_MAX = 500;

let guestLog = [];
let guestSaveTimer = 0;

function loadGuestLog() {
    try {
        const j = JSON.parse(fs.readFileSync(GUEST_LOG, 'utf8'));
        guestLog = Array.isArray(j) ? j.slice(0, GUEST_LOG_MAX) : [];
    } catch (e) {
        guestLog = [];
    }
}

function saveGuestLog() {
    clearTimeout(guestSaveTimer);
    guestSaveTimer = setTimeout(() => {
        try { fs.writeFileSync(GUEST_LOG, JSON.stringify(guestLog)); } catch (e) { }
    }, 400);
}

/** 门户文案：改 guest.json 就行，不用动代码 */
function guestInfo() {
    let g = {};
    try { g = JSON.parse(stripJsonComments(fs.readFileSync(GUEST_FILE, 'utf8'))); } catch (e) { }
    return {
        title: g.title || '欢迎连上这个 WiFi',
        subtitle: g.subtitle || '这台电脑上跑着几个局域网服务，打开就能用。',
        notice: g.notice || '',
        links: Array.isArray(g.links) && g.links.length
            ? g.links.filter((x) => x && x.href && x.name)
            : [
                { name: '本地图库', href: '/', desc: '看图、翻相册' },
                { name: '中转站', href: '/drop', desc: '传文件 / 下文件' },
            ],
    };
}

function clientIp(req) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    let ip = fwd || (req.socket && req.socket.remoteAddress) || '';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip;
}

function logGuestVisit(req) {
    const ip = clientIp(req);
    if (!ip) return;
    const last = guestLog[0];
    // 同一台设备 30 秒内只记一次，避免刷新刷屏
    if (last && last.ip === ip && Date.now() - last.t < 30000) return;
    guestLog.unshift({ t: Date.now(), ip, ua: String(req.headers['user-agent'] || '').slice(0, 200) });
    if (guestLog.length > GUEST_LOG_MAX) guestLog.length = GUEST_LOG_MAX;
    saveGuestLog();
}

/** 读系统 ARP 表：IP -> MAC（Windows 用 -，*nix 用 :，统一成 -） */
function arpTable() {
    const out = new Map();
    try {
        const txt = execSync('arp -a', { encoding: 'utf8', windowsHide: true, maxBuffer: 4 << 20 });
        const re = /(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})/gi;
        let m;
        while ((m = re.exec(txt))) out.set(m[1], m[2].toLowerCase().replace(/:/g, '-'));
    } catch (e) { }
    return out;
}

/** 随机 MAC（手机隐私地址）的本地管理位 */
function isRandomMac(mac) {
    const b = parseInt(String(mac).slice(0, 2), 16);
    return (b & 0x02) === 0x02;
}

/**
 * 扫一遍当前 /24：先并发 ping 唤醒 ARP，再读 ARP 表。
 * 只发 ICMP，不改任何东西；结果缓存 15 秒。
 */
async function scanLan(force) {
    const now = Date.now();
    if (!force && scanLan.at && now - scanLan.at < 15000) return scanLan.data;

    const lan = lanAddresses();
    const me = lan[0] ? lan[0].ip : '';
    const ips = [];
    if (me) {
        const base = me.split('.').slice(0, 3).join('.');
        for (let i = 1; i <= 254; i++) ips.push(base + '.' + i);
    }

    let idx = 0;
    const workers = new Array(40).fill(0).map(async () => {
        while (idx < ips.length) {
            const ip = ips[idx++];
            await new Promise((res) => {
                execFile('ping', ['-n', '1', '-w', '250', ip], { windowsHide: true }, () => res());
            });
        }
    });
    await Promise.all(workers);

    const table = arpTable();
    const devices = [];
    for (const [ip, mac] of table) {
        if (ip.endsWith('.255') || ip.startsWith('224.') || ip.startsWith('239.')) continue;
        devices.push({
            ip,
            mac,
            self: ip === me,
            randomMac: isRandomMac(mac),
            lastSeen: (guestLog.find((v) => v.ip === ip) || {}).t || 0,
        });
    }
    devices.sort((a, b) => Number(a.ip.split('.')[3]) - Number(b.ip.split('.')[3]));

    scanLan.at = Date.now();
    scanLan.data = devices;
    return devices;
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

// ---------------------------------------------------------------- 中转站（路径引用）
// 不复制文件：只记「路径 + 大小 + 修改时间 + md5」，下载时直接从原路径流式读。
// 只有「手机上传来」的文件才落盘到 DROP_DIR，落盘后同样登记成一条路径记录。
const DROP_DB = path.join(APP_DIR, '.drops.json');
const HASH_MAX = 512 * 1024 * 1024;   // 超过这个大小不在添加时自动算 md5，交给「校验」按钮

let dropItems = [];                   // [{ id, path, name, size, mtime, hash, hashAt, addedAt, source }]
let dropSaveTimer = 0;

function loadDropDb() {
    try {
        const j = JSON.parse(fs.readFileSync(DROP_DB, 'utf8'));
        dropItems = Array.isArray(j.items) ? j.items.filter((x) => x && x.path) : [];
    } catch (e) {
        dropItems = [];
    }
}

function saveDropDb() {
    clearTimeout(dropSaveTimer);
    dropSaveTimer = setTimeout(() => {
        try { fs.writeFileSync(DROP_DB, JSON.stringify({ items: dropItems }, null, 2)); } catch (e) { }
    }, 300);
}

function newDropId() {
    return crypto.randomBytes(4).toString('hex');
}

/** 流式算 md5，几 GB 的文件也不会把内存吃掉 */
function md5File(abs) {
    return new Promise((resolve) => {
        const h = crypto.createHash('md5');
        let failed = false;
        const rs = fs.createReadStream(abs);
        rs.on('data', (c) => h.update(c));
        rs.on('end', () => resolve(failed ? null : h.digest('hex')));
        rs.on('error', () => { failed = true; resolve(null); });
    });
}

/** 列表里每条都 stat 一次：O(1)，比复制整个文件便宜几个数量级 */
function dropStat(item) {
    try {
        const st = fs.statSync(item.path);
        if (!st.isFile()) return { missing: true };
        const mtime = Math.round(st.mtimeMs);
        return {
            missing: false,
            size: st.size,
            mtime,
            changed: st.size !== item.size || mtime !== item.mtime,
        };
    } catch (e) {
        return { missing: true };
    }
}

async function addDropPath(raw, source) {
    const p = path.resolve(String(raw == null ? '' : raw).trim());
    if (!p) throw fail(400, '空路径');
    let st;
    try { st = fs.statSync(p); } catch (e) { throw fail(404, '路径不存在：' + p); }
    if (!st.isFile()) throw fail(400, '不是文件：' + p);

    const exist = dropItems.find((x) => x.path.toLowerCase() === p.toLowerCase());
    if (exist) return { item: exist, dup: true };

    const item = {
        id: newDropId(),
        path: p,
        name: path.basename(p),
        size: st.size,
        mtime: Math.round(st.mtimeMs),
        hash: null,
        hashAt: 0,
        addedAt: Date.now(),
        source: source || 'path',
    };
    dropItems.unshift(item);
    if (dropItems.length > 500) dropItems.length = 500;
    saveDropDb();

    // 小文件添加时顺手算一份 md5，之后「校验」就有基线可比
    if (st.size <= HASH_MAX) {
        md5File(p).then((h) => {
            if (h && !item.hash) { item.hash = h; item.hashAt = Date.now(); saveDropDb(); broadcastDrops(); }
        });
    }
    return { item, dup: false };
}

async function verifyDrops(id) {
    const targets = id ? dropItems.filter((x) => x.id === id) : dropItems.slice();
    const out = [];
    for (const it of targets) {
        const s = dropStat(it);
        if (s.missing) { out.push({ id: it.id, ok: false, reason: 'missing' }); continue; }
        const h = await md5File(it.path);
        if (!h) { out.push({ id: it.id, ok: false, reason: 'read-failed' }); continue; }
        const ok = it.hash ? h === it.hash : true;   // 第一次校验只建立基线
        it.hash = h;
        it.hashAt = Date.now();
        out.push({ id: it.id, ok, reason: ok ? 'ok' : 'hash-mismatch', hash: h });
    }
    saveDropDb();
    broadcastDrops();
    return out;
}

function listDrops() {
    const items = dropItems.map((it) => {
        const s = dropStat(it);
        return {
            id: it.id,
            n: it.name,
            p: it.path,
            s: s.missing ? it.size : s.size,
            t: s.missing ? it.mtime : s.mtime,
            added: it.addedAt,
            hash: it.hash,
            hashAt: it.hashAt,
            source: it.source,
            missing: !!s.missing,
            changed: !!s.changed,
            u: '/d/' + it.id,
        };
    });
    const bytes = items.reduce((a, b) => a + (b.missing ? 0 : b.s || 0), 0);
    return { items, total: items.length, bytes, dir: DROP_DIR, lan: lanAddresses(), port: PORT };
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

        // ------------------------------------------------ 访客门户
        if (p === '/guest' || p === '/portal') {
            logGuestVisit(req);
            servePublic(req, res, '/guest.html');
            return;
        }

        if (p === '/guest.json') {
            sendJSON(req, res, 200, guestInfo());
            return;
        }

        if (p === '/guest/devices') {
            servePublic(req, res, '/devices.html');
            return;
        }

        if (p === '/api/guest/devices') {
            const devices = await scanLan(u.searchParams.get('scan') === '1');
            sendJSON(req, res, 200, {
                devices,
                visits: guestLog.slice(0, 200),
                info: guestInfo(),
                me: (lanAddresses()[0] || {}).ip || '',
                you: clientIp(req),
            });
            return;
        }

        // ------------------------------------------------ 中转站
        if (p === '/api/drop/list') {
            sendJSON(req, res, 200, await listDrops());
            return;
        }

        // 加一条「路径引用」：不复制文件，只登记路径 + 大小 + 时间
        if (p === '/api/drop/add' && req.method === 'POST') {
            const body = await readBody(req);
            const paths = Array.isArray(body.paths) ? body.paths : (body.path ? [body.path] : []);
            if (!paths.length) throw fail(400, '没有给路径');
            const added = [], dup = [], errors = [];
            for (const raw of paths) {
                try {
                    const r = await addDropPath(raw, body.source);
                    (r.dup ? dup : added).push(r.item);
                } catch (e) {
                    errors.push({ path: raw, error: e.message });
                }
            }
            broadcastDrops();
            sendJSON(req, res, 200, { added, dup, errors, total: dropItems.length });
            return;
        }

        // 校验：重新算 md5，和登记时的基线比对
        if (p === '/api/drop/verify' && req.method === 'POST') {
            const body = await readBody(req).catch(() => ({}));
            const results = await verifyDrops(body && body.id ? body.id : '');
            sendJSON(req, res, 200, { results });
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
                const absUp = path.join(dropDir(), final);
                await fsp.rename(part, absUp);
                await addDropPath(absUp, 'upload');   // 上传完也登记成一条路径记录，和引用进来的混在一起
                broadcastDrops();
                sendJSON(req, res, 200, { done: true, name: final, size, received: size });
            } else {
                sendJSON(req, res, 200, { done: false, name, received: size });
            }
            return;
        }

        // 移除：只删这条记录，绝不动磁盘上的原文件
        if (p === '/api/drop/item' && req.method === 'DELETE') {
            const id = u.searchParams.get('id') || '';
            const i = dropItems.findIndex((x) => x.id === id);
            if (i < 0) throw fail(404, '没有这一项');
            dropItems.splice(i, 1);
            saveDropDb();
            broadcastDrops();
            sendJSON(req, res, 200, { ok: true });
            return;
        }

        if (p === '/api/drop/all' && req.method === 'DELETE') {
            const removed = dropItems.length;
            dropItems = [];
            saveDropDb();
            broadcastDrops();
            sendJSON(req, res, 200, { ok: true, removed });
            return;
        }

        // 下载：按 id 找到登记过的路径，直接从原文件流式读（Range / 206 / 416 都是现成的）
        if (p.startsWith('/d/')) {
            let id = decodeURIComponent(p.slice(3));
            if (id.endsWith('/')) id = id.slice(0, -1);
            const it = dropItems.find((x) => x.id === id);
            if (!it) throw fail(404, '没有这一项');
            const st = await fsp.stat(it.path).catch(() => null);
            if (!st || !st.isFile()) throw fail(410, '文件已经不在了：' + it.path);
            res.setHeader('Content-Disposition', contentDisposition(it.name));
            sendFile(req, res, it.path, st, 'no-store');
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
            sendJSON(req, res, 200, await browseDir(target, u.searchParams.get('files') === '1'));
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
loadGuestLog();
loadDropDb();
startListening(0);

/**
 * 门户模式：80 端口上任何请求都 302 到 /guest。
 * 这是「连上 WiFi 自动弹说明页」的最后一步 —— 前提是路由器把 80 或 DNS 指到这台机器。
 */
function startPortal() {
    if (!PORTAL_PORT) return;
    const ps = http.createServer((req, res) => {
        // 客户端是从哪个 IP 打到我们的，就跳回哪个 IP —— 不能猜，
        // 多网卡（热点 / VPN）时猜错就把人送到一个他连不上的地址
        let ip = (req.socket && req.socket.localAddress) || '';
        if (ip.startsWith('::ffff:')) ip = ip.slice(7);
        if (!ip || ip === '::1' || ip.startsWith('127.')) {
            ip = (lanAddresses()[0] || {}).ip || '127.0.0.1';
        }
        const target = 'http://' + ip + ':' + PORT + '/guest';
        logGuestVisit(req);
        res.writeHead(302, { Location: target, 'Cache-Control': 'no-store', Connection: 'close' });
        res.end();
    });
    ps.on('error', (e) => {
        console.error('  [!] 门户端口 ' + PORTAL_PORT + ' 起不来：' + e.message);
    });
    ps.listen(PORTAL_PORT, '0.0.0.0', () => {
        console.log('  |  Portal  : http://<LAN-IP>:' + PORTAL_PORT + '  ->  /guest');
    });
}

startPortal();
if (argv.includes('--dns')) startDns();
