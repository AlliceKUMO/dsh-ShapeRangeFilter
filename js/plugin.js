/* ============================================================
 * 形状范围筛选 — 插件主体
 *
 * 数据来源:直接读资源库的 images/<id>.info/metadata.json(见 js/indexer.js),
 * 实测 59,928 条只需 3.4s,而 eagle.item.get() 要把 6 万个完整 Item 对象经
 * IPC 序列化,是之前卡顿的根因。
 *
 * 缩略图按需懒加载:网格里每个格子先用索引数据(尺寸/比例/名称)画出来,
 * 只为「当前可见的那一页」调一次 eagle.item.getByIds() 取 thumbnailURL,
 * 所以整库索引再大也不会把 IPC 拖慢。
 * ============================================================ */
(function () {
  'use strict';

  var M = window.ShapeMatcher;
  var IX = window.EagleIndex;

  var PAGE_SIZE = 240;            // 每次渲染的格子数
  var THUMB_CHUNK = 200;          // 一次 getByIds 取多少个缩略图
  var HYDRATE_LIMIT = 4000;       // 打标签/复制路径时最多回读多少条
  var HISTO_BINS = 72;
  var HISTO_RANGE = 2;            // log2 范围:1/4 ~ 4

  var state = {
    rows: [],          // 全库索引行 {id,w,h,ext,name}
    libraryPath: null, // 已定位到的资源库根目录
    scopeIds: null,    // null = 整个库;否则是限定范围的 id 集合
    exts: new Set(),   // Set:选中的文件格式;空集 = 不限格式
    extCounts: null,   // 全库格式统计,用于渲染格式按钮
    items: [],         // 当前范围 + 格式条件下的行
    matches: [],
    selection: new Set(), // Set:用户在网格里勾选的 id;空集 = 目标为全部匹配
    renderedIds: [],   // 当前已渲染格子的顺序,供 Shift 范围选用
    anchorId: null,    // Shift 范围选的锚点
    spec: null,
    shown: 0,
    thumbs: {},        // id -> thumbnailURL
    histo: null,
    indexSource: null,
    lastError: null
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- 运行环境 ---------------- */

  if (typeof eagle === 'undefined') {
    document.body.innerHTML =
      '<div style="padding:28px;font:13px/1.7 system-ui;color:#e8eaf0;background:#16181d;height:100%">' +
      '这个页面需要在 Eagle 中以插件形式运行。<br>请把整个 <code>eagle-shape-range</code> 文件夹放到 ' +
      '<code>%APPDATA%\\Eagle\\Plugins\\</code> 下,重启 Eagle 后在插件面板打开。</div>';
    return;
  }

  var nodeRequire = (typeof require === 'function') ? require : null;
  function safeRequire(name) {
    try { return nodeRequire ? nodeRequire(name) : null; } catch (e) { return null; }
  }
  var fsMod = safeRequire('fs');
  var pathMod = safeRequire('path');
  var canUseFastIndex = !!(fsMod && pathMod && IX);

  // 核心脚本没挂上时必须立刻说清楚。否则界面会永远停在初始文案上,
  // 看起来像「一直在扫描」—— 这个误判浪费过一轮排查。
  if (!M || !IX) {
    var missing = [];
    if (!M) missing.push('js/matcher.js');
    if (!IX) missing.push('js/indexer.js');
    plog('核心脚本未能加载:' + missing.join('、') + '(window.ShapeMatcher=' + !!M +
      ' window.EagleIndex=' + !!IX + ')');
    document.body.innerHTML =
      '<div style="padding:28px;font:13px/1.8 system-ui;color:#e8eaf0;background:#16181d;height:100%">' +
      '<b>核心脚本未能加载</b><br>缺少:' + missing.join('、') +
      '<br><br>插件目录里的 <code>js/</code> 可能不完整。请重新安装插件,或按 F12 查看控制台。</div>';
    return;
  }

  /** 同时写 Eagle 日志与 DevTools 控制台:插件窗口的 console 不进 log.log。 */
  function plog(msg) {
    try { if (eagle.log && eagle.log.info) eagle.log.info('[形状范围筛选] ' + msg); } catch (e) { /* ignore */ }
    try { console.log('[形状范围筛选]', msg); } catch (e) { /* ignore */ }
  }

  function pluginDir() {
    try {
      if (eagle.plugin && eagle.plugin.path) return eagle.plugin.path;
      if (typeof __dirname === 'string') return __dirname;
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * 资源库位置。Eagle 是在创建插件窗口时用字符串拼接注入的
   * (app.bundle.js: window.eagle.library.path = '${$bodyScope?.libraryPath?...}'),
   * 那一刻若 libraryPath 还没就绪,就会得到字符串 "undefined";
   * 若 eagle.library 还没挂上,整段注入脚本会抛错、什么都设不上。
   * 所以这里按多级回退去定位,并且每一级都写日志 —— 静默失败是上一次的教训。
   */
  function rawLibraryPath() {
    try {
      var p = eagle.library && eagle.library.path;
      return (typeof p === 'string' && p) ? p : null;
    } catch (e) { return null; }
  }

  function isUsableLibrary(p) {
    if (!p || typeof p !== 'string') return false;
    if (p === 'undefined' || p === 'null') return false;
    if (!fsMod || !pathMod) return false;
    try { return fsMod.existsSync(pathMod.join(p, 'images')); } catch (e) { return false; }
  }

  /** 从条目的 filePath 反推资源库根:`<lib>/images/<id>.info/<file>` → `<lib>`。 */
  function libraryRootFromItemPath(fp) {
    return IX ? IX.libraryRootFromItemPath(pathMod, fp) : null;
  }

  function savedLibraryPathFile() {
    var dir = pluginDir();
    return (dir && pathMod) ? pathMod.join(dir, 'library-path.txt') : null;
  }

  function readSavedLibraryPath() {
    var file = savedLibraryPathFile();
    if (!file || !fsMod) return null;
    try { return fsMod.readFileSync(file, 'utf8').trim() || null; } catch (e) { return null; }
  }

  function saveLibraryPath(p) {
    var file = savedLibraryPathFile();
    if (!file || !fsMod) return;
    try { fsMod.writeFileSync(file, p, 'utf8'); } catch (e) { /* 记不住也不影响本次使用 */ }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function resolveLibraryPath() {
    var direct = rawLibraryPath();
    if (isUsableLibrary(direct)) return direct;
    if (direct) plog('eagle.library.path = ' + JSON.stringify(direct) + ' 但不是一个可用的资源库');

    // 从任意一条素材的路径反推(只需两次轻量调用)
    try {
      var ids = await eagle.item.getIdsWithModifiedAt();
      if (ids && ids.length) {
        var one = await eagle.item.getByIds([ids[0].id]);
        var guess = libraryRootFromItemPath(one && one[0] && one[0].filePath);
        if (isUsableLibrary(guess)) {
          plog('由条目路径反推出资源库:' + guess);
          return guess;
        }
      }
    } catch (e) {
      plog('由条目路径反推资源库失败:' + (e && e.message ? e.message : e));
    }

    var saved = readSavedLibraryPath();
    if (isUsableLibrary(saved)) {
      plog('使用上次手动指定的资源库:' + saved);
      return saved;
    }

    // 资源库可能还在加载,短暂重试
    for (var i = 0; i < 12; i++) {
      await sleep(250);
      var again = rawLibraryPath();
      if (isUsableLibrary(again)) {
        plog('等待 ' + ((i + 1) * 250) + 'ms 后拿到资源库:' + again);
        return again;
      }
    }
    return null;
  }

  async function pickLibrary() {
    if (!eagle.dialog || !eagle.dialog.showOpenDialog) return;
    var r = await eagle.dialog.showOpenDialog({
      title: '选择 Eagle 资源库文件夹(内含 images 与 metadata.json)',
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return;
    var picked = r.filePaths[0];
    if (!isUsableLibrary(picked)) {
      setStatus('这个文件夹里没有 images 目录,不像是一个资源库:' + picked, false, true);
      return;
    }
    saveLibraryPath(picked);
    plog('用户手动指定资源库:' + picked);
    $('btnPickLib').classList.add('hidden');
    load(false);
  }

  function setStatus(text, busy, isError) {
    var el = $('status');
    el.className = isError ? 'err' : '';
    el.innerHTML = (busy ? '<span class="spin"></span> ' : '') + esc(text);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
  function num(n) { return Number(n || 0).toLocaleString('en-US'); }

  /* ---------------- 主题 ---------------- */

  function applyTheme() {
    var t = null;
    try { t = (eagle.app && eagle.app.theme) || null; } catch (e) { /* ignore */ }
    if (!t) {
      var m = /[?&]theme=([^&]+)/.exec(location.search);
      if (m) t = decodeURIComponent(m[1]);
    }
    var light = /^light/i.test(String(t || ''));
    document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  }

  /* ---------------- 启动 ---------------- */

  eagle.onPluginCreate(function () {
    try {
      applyTheme();
      try {
        if (eagle.onThemeChanged) eagle.onThemeChanged(applyTheme);
      } catch (e) { /* ignore */ }
      // 先记一行诊断:上一次的问题正是「什么都没写」导致无从判断。
      try {
        var app = eagle.app || {};
        plog('插件已创建 Eagle ' + app.version + ' build ' + app.build +
          ' | require=' + (typeof require) +
          ' fs=' + !!fsMod + ' path=' + !!pathMod + ' indexer=' + !!IX +
          ' matcher=' + !!M +
          ' | plugin.path=' + JSON.stringify(pluginDir()) +
          ' | library.path=' + JSON.stringify(rawLibraryPath()) +
          ' | fast=' + canUseFastIndex);
      } catch (e) { /* 诊断本身不能影响启动 */ }
      buildPresets();
      wireEvents();
      showLibraryName();
      loadFolders();
      load(false);
    } catch (err) {
      // 绝不让插件因为一个未捕获异常而变成「一个什么都不做的空窗口」。
      plog('插件初始化失败:' + (err && err.stack ? err.stack : err));
      setStatus('插件初始化失败:' + (err && err.message ? err.message : err), false, true);
    }
  });

  if (typeof eagle.onLibraryChanged === 'function') {
    eagle.onLibraryChanged(function () {
      state.rows = [];
      state.scopeIds = null;
      state.thumbs = {};
      state.exts = new Set();
      state.selection = new Set();
      state.renderedIds = [];
      showLibraryName();
      loadFolders();
      load(false);
    });
  }

  function showLibraryName() {
    var name = null;
    try { name = eagle.library && eagle.library.name; } catch (e) { /* ignore */ }
    if (!name) {
      var p = rawLibraryPath();
      if (p && typeof p === 'string') name = p.split(/[\\/]/).pop().replace(/\.library$/i, '');
    }
    $('libName').textContent = name ? '资源库 ' + name : '正在定位资源库…';
  }

  /* ---------------- 条件控件 ---------------- */

  function buildPresets() {
    var box = $('presets');
    box.innerHTML = '';
    M.PRESETS.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'chip';
      b.dataset.w = String(p.w);
      b.dataset.h = String(p.h);
      b.textContent = p.label;
      b.addEventListener('click', function () {
        $('cw').value = String(p.w);
        $('ch').value = String(p.h);
        syncPresetChips();
        refilter();
      });
      box.appendChild(b);
    });
    syncPresetChips();
  }

  function syncPresetChips() {
    var w = $('cw').value, h = $('ch').value;
    var chips = $('presets').querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', chips[i].dataset.w === w && chips[i].dataset.h === h);
    }
  }

  var tolTimer = null;
  function wireEvents() {
    $('btnRescan').disabled = !canUseFastIndex;
    $('btnRescan').addEventListener('click', function () { load(true); });
    $('btnPickLib').addEventListener('click', pickLibrary);
    $('btnClear').addEventListener('click', resetConditions);

    $('scope').addEventListener('change', function () {
      $('folderPick').classList.toggle('hidden', $('scope').value !== 'folder');
      applyScope();
    });
    $('folderPick').addEventListener('change', applyScope);

    $('modeSeg').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-mode]');
      if (!btn) return;
      var btns = $('modeSeg').querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i] === btn);
      var isRange = btn.dataset.mode === 'range';
      $('rangeRow').classList.toggle('hidden', !isRange);
      $('nearRow').classList.toggle('hidden', isRange);
      refilter();
    });

    $('orientation').addEventListener('change', refilter);
    $('cw').addEventListener('input', function () { syncPresetChips(); refilter(); });
    $('ch').addEventListener('input', function () { syncPresetChips(); refilter(); });
    $('minR').addEventListener('input', refilter);
    $('maxR').addEventListener('input', refilter);

    var tolNum = $('tolNum'), tolRange = $('tol');
    function onTol(value, from) {
      var v = Math.max(0, Math.min(50, Number(value) || 0));
      if (from !== 'num') tolNum.value = String(v);
      if (from !== 'range') tolRange.value = String(Math.min(25, v));
      $('tolReadout').textContent = '±' + v.toFixed(1) + '%';
      clearTimeout(tolTimer);
      tolTimer = setTimeout(refilter, 16);
    }
    tolNum.addEventListener('input', function () { onTol(tolNum.value, 'num'); });
    tolRange.addEventListener('input', function () { onTol(tolRange.value, 'range'); });

    $('btnMore').addEventListener('click', function () { renderGrid(true); });
    $('btnSelect').addEventListener('click', onSelectInEagle);
    $('btnTag').addEventListener('click', onTag);
    $('btnCopy').addEventListener('click', onCopyPaths);
    $('btnExport').addEventListener('click', onExport);
    $('btnPickAll').addEventListener('click', pickAll);
    $('btnPickInvert').addEventListener('click', pickInvert);
    $('btnPickNone').addEventListener('click', function () { pickClear(); });
    $('grid').addEventListener('click', onGridClick);
    $('extChips').addEventListener('click', onExtChipClick);

    var results = $('results');
    results.addEventListener('scroll', function () {
      if (results.scrollTop + results.clientHeight > results.scrollHeight - 320) {
        if (state.shown < state.matches.length) renderGrid(true);
      }
    });
  }

  function resetConditions() {
    $('cw').value = '1';
    $('ch').value = '1';
    $('tol').value = '5';
    $('tolNum').value = '5';
    $('tolReadout').textContent = '±5.0%';
    $('minR').value = '0.95';
    $('maxR').value = '1.05';
    $('orientation').value = 'any';
    syncPresetChips();
    refilter();
  }

  /* ---------------- 索引 ---------------- */

  function showProgress(on, ratio, label) {
    $('progressWrap').classList.toggle('hidden', !on);
    if (ratio != null) $('progressBar').style.width = Math.round(ratio * 100) + '%';
    if (label) setStatus(label, true);
  }

  async function load(force) {
    $('btnRescan').disabled = true;
    showProgress(true, 0.03, '正在定位资源库…');

    var lib = await resolveLibraryPath();
    if (!lib) {
      showProgress(false, 0, null);
      $('btnPickLib').classList.remove('hidden');
      $('btnRescan').disabled = !canUseFastIndex;
      plog('定位资源库失败:eagle.library.path=' + JSON.stringify(rawLibraryPath()) +
        ' require=' + (typeof require) + ' fs=' + !!fsMod + ' path=' + !!pathMod +
        ' indexer=' + !!IX);
      setStatus('无法自动确定资源库位置 —— 请点右上角「指定资源库…」选择 .library 文件夹', false, true);
      return;
    }
    $('btnPickLib').classList.add('hidden');
    state.libraryPath = lib;
    plog('开始扫描 force=' + !!force + ' libraryPath=' + lib +
      ' require=' + (typeof require) + ' fs=' + !!fsMod + ' path=' + !!pathMod +
      ' indexer=' + !!IX + ' fast=' + canUseFastIndex);

    var cachePath = null;
    var dir = pluginDir();
    if (dir && pathMod) cachePath = pathMod.join(dir, 'index-cache.json');
    saveLibraryPath(lib);   // 记下来,下次即使注入失效也能定位
    var heartbeat = 0;

    $('btnRescan').disabled = true;
    showProgress(true, 0.04, '正在索引资源库…');
    var t0 = Date.now();

    try {
      var res;
      if (canUseFastIndex) {
        res = await IX.loadIndex({
          fs: fsMod, path: pathMod, libraryPath: lib, cachePath: cachePath, force: !!force,
          onProgress: function (done, total) {
            showProgress(true, 0.04 + 0.9 * (done / Math.max(1, total)),
              '正在索引资源库… ' + num(done) + ' / ' + num(total));
            // 心跳:万一卡住,日志里能看出停在哪个进度
            var pct = Math.floor((done / Math.max(1, total)) * 100);
            if (pct >= heartbeat + 20) {
              heartbeat = pct - (pct % 20);
              plog('索引进度 ' + heartbeat + '% (' + done + '/' + total + ')');
            }
          }
        });
      } else {
        res = await loadViaPluginApi();
      }

      state.rows = res.rows;
      state.indexSource = res.source;
      state.lastError = null;
      state.thumbs = {};
      state.selection = new Set();
      state.renderedIds = [];
      // 重扫后可能有些格式已经不存在了,先把失效的勾选丢掉再画按钮
      var stale = [];
      state.exts.forEach(function (e) { stale.push(e); });
      for (var si = 0; si < stale.length; si++) {
        if (!res.rows.some(function (r) { return (r.ext || '').toLowerCase() === stale[si]; })) {
          state.exts.delete(stale[si]);
        }
      }
      buildExtChips();
      applyScope();

      var how = res.source === 'cache'
        ? '缓存命中'
        : (res.cacheSaved === false ? '已读取(缓存写入失败)' : '已重新索引');
      var skipped = res.skipped || 0;
      $('libName').textContent = '资源库 ' + (lib.split(/[\\/]/).pop() || '')
        + ' · ' + num(res.rows.length) + ' 项可筛选'
        + (skipped ? ' · 跳过 ' + num(skipped) + ' 项无尺寸' : '');
      plog('索引完成 来源=' + res.source + ' 行数=' + res.rows.length +
        ' 跳过=' + skipped + ' 总目录=' + res.total + ' 耗时=' + (res.ms || (Date.now() - t0)) + 'ms');
      setStatus(how + ' · ' + num(res.rows.length) + ' 项 · 用时 '
        + ((res.ms || (Date.now() - t0)) / 1000).toFixed(2) + 's');
    } catch (e) {
      state.lastError = e;
      plog('索引失败:' + (e && e.message ? e.message : e));
      setStatus('索引失败:' + (e && e.message ? e.message : e), false, true);
    } finally {
      showProgress(false, 1, null);
      $('btnRescan').disabled = !canUseFastIndex;
      refilter();
    }
  }

  /** 退路:拿不到 Node fs 时仍可用插件 API 取数据(慢,但能用)。 */
  async function loadViaPluginApi() {
    plog('Node fs 不可用,退回 eagle.item.get()(较慢)');
    var attempts = [
      { fields: ['id', 'name', 'ext', 'width', 'height'] },
      {}
    ];
    var lastErr = null;
    for (var i = 0; i < attempts.length; i++) {
      try {
        var items = await eagle.item.get(attempts[i]);
        if (Array.isArray(items) && items.length && items[0].width != null) {
          var rows = [];
          for (var j = 0; j < items.length; j++) {
            var it = items[j];
            if (it && it.width > 0 && it.height > 0) {
              rows.push({ id: it.id, w: it.width, h: it.height, ext: it.ext || '', name: it.name || '' });
              if (it.thumbnailURL) state.thumbs[it.id] = it.thumbnailURL;
            }
          }
          return { rows: rows, total: items.length, skipped: items.length - rows.length, source: 'plugin-api', cacheSaved: false };
        }
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('无法从插件 API 读取条目');
  }

  /** 把「范围」下拉变成一组限定的 id(整个库时为 null)。 */
  function applyScope() {
    var mode = $('scope').value;
    $('folderPick').classList.toggle('hidden', mode !== 'folder');

    if (mode === 'all') {
      state.scopeIds = null;
      refilter();
      return;
    }

    var query = mode === 'selected' ? { isSelected: true } : { folders: [$('folderPick').value] };
    if (mode === 'folder' && !$('folderPick').value) {
      state.scopeIds = new Set();
      refilter();
      return;
    }

    setStatus('正在读取范围…', true);
    eagle.item.get(Object.assign({ fields: ['id'] }, query)).then(function (items) {
      var ids = new Set();
      (items || []).forEach(function (it) { if (it && it.id) ids.add(it.id); });
      state.scopeIds = ids;
      setStatus('范围已限定为 ' + num(ids.size) + ' 项');
      refilter();
    }).catch(function (e) {
      setStatus('读取范围失败:' + (e.message || e), false, true);
      state.scopeIds = null;
      refilter();
    });
  }

  async function loadFolders() {
    try {
      var folders = await eagle.folder.getAll();
      var flat = [];
      (function walk(list, depth) {
        (list || []).forEach(function (f) {
          flat.push({ id: f.id, label: '\u3000'.repeat(depth) + (depth ? '└ ' : '') + f.name });
          if (f.children && f.children.length) walk(f.children, depth + 1);
        });
      })(folders, 0);
      $('folderPick').innerHTML = flat.map(function (f) {
        return '<option value="' + escAttr(f.id) + '">' + esc(f.label) + '</option>';
      }).join('');
    } catch (e) {
      $('folderPick').innerHTML = '<option value="">(无法读取文件夹)</option>';
    }
  }

  /* ---------------- 筛选 ---------------- */

  function currentSpec() {
    var mode = $('modeSeg').querySelector('button.active').dataset.mode;
    var orientation = $('orientation').value;
    if (mode === 'range') {
      return {
        mode: 'range',
        minRatio: Number($('minR').value),
        maxRatio: Number($('maxR').value),
        orientation: orientation
      };
    }
    var w = Math.max(1, Number($('cw').value) || 1);
    var h = Math.max(1, Number($('ch').value) || 1);
    return {
      mode: 'near',
      target: w / h,
      tolerancePct: Number($('tolNum').value) || 0,
      orientation: orientation
    };
  }

  var lastFilterLog = 0;

  function scopedRows() {
    if (!state.scopeIds) return state.rows;
    return state.rows.filter(function (r) { return state.scopeIds.has(r.id); });
  }

  function refilter() {
    if (!state.rows.length) {
      state.items = [];
      state.matches = [];
      state.renderedIds = [];
      renderSummary();
      renderGrid(false);
      updateActions();
      return;
    }

    // 范围(全库/选中/文件夹)→ 格式 → 比例。格式是「与」关系的前置条件,
    // 所以直方图与「共 N 项」都基于格式过滤后的集合,保持三处数字一致。
    var scoped = scopedRows();
    var filtered = scoped;
    if (state.exts && state.exts.size) {
      filtered = scoped.filter(function (r) {
        return state.exts.has((r.ext || '').toLowerCase());
      });
    }
    state.items = filtered;
    state.spec = currentSpec();

    // 索引行用 w/h,匹配器用 width/height —— 在这里适配一次。
    var adapted = new Array(filtered.length);
    for (var i = 0; i < filtered.length; i++) {
      var r = filtered[i];
      adapted[i] = { id: r.id, width: r.w, height: r.h, ext: r.ext, name: r.name, _row: r };
    }
    var res = M.filterItems(adapted, state.spec);
    state.matches = res.matches;
    state.nativeBuckets = res.nativeBuckets;
    state.shown = 0;
    state.histo = buildHistogram(adapted, state.spec);

    // 条件变化后,只保留仍然命中的勾选项 —— 静默丢掉用户选好的东西更糟。
    if (state.selection && state.selection.size) {
      var matchIds = Object.create(null);
      for (var m = 0; m < state.matches.length; m++) matchIds[state.matches[m].id] = 1;
      var kept = new Set();
      state.selection.forEach(function (id) { if (matchIds[id]) kept.add(id); });
      state.selection = kept;
    }

    renderSummary();
    renderGrid(false);
    updateActions();

    var now = Date.now();
    if (now - lastFilterLog > 800) {
      lastFilterLog = now;
      plog('条件「' + M.describe(state.spec) + '」格式[' +
        (state.exts && state.exts.size ? Array.from(state.exts).join(',') : '全部') + '] -> 匹配 ' +
        state.matches.length + '/' + adapted.length);
    }
  }

  /* ---------------- 多选 ---------------- */

  /** 动作的作用对象:有勾选就用勾选的,否则用全部匹配。 */
  function targetItems() {
    if (!state.selection || !state.selection.size) return state.matches;
    return state.matches.filter(function (i) { return state.selection.has(i.id); });
  }

  function togglePick(id, extend) {
    if (!state.selection) state.selection = new Set();
    if (extend && state.anchorId && state.anchorId !== id) {
      pickRange(state.anchorId, id);
      return;
    }
    if (state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
    state.anchorId = id;
    renderPickState();
    updateActions();
  }

  function pickRange(fromId, toId) {
    var ids = state.renderedIds || [];
    var a = ids.indexOf(fromId);
    var b = ids.indexOf(toId);
    if (a < 0 || b < 0) {
      state.selection.add(toId);
    } else {
      var lo = Math.min(a, b), hi = Math.max(a, b);
      for (var i = lo; i <= hi; i++) state.selection.add(ids[i]);
    }
    state.anchorId = toId;
    renderPickState();
    updateActions();
  }

  function pickAll() {
    state.selection = new Set(state.matches.map(function (i) { return i.id; }));
    state.anchorId = null;
    renderPickState();
    updateActions();
  }

  function pickInvert() {
    if (!state.selection) state.selection = new Set();
    var next = new Set();
    for (var i = 0; i < state.matches.length; i++) {
      var id = state.matches[i].id;
      if (!state.selection.has(id)) next.add(id);
    }
    state.selection = next;
    renderPickState();
    updateActions();
  }

  function pickClear() {
    state.selection = new Set();
    state.anchorId = null;
    renderPickState();
    updateActions();
  }

  /** 只改 class,不重建 DOM —— 否则一次勾选会丢掉滚动位置和已加载的缩略图。 */
  function renderPickState() {
    var cells = document.querySelectorAll('#grid .cell');
    for (var i = 0; i < cells.length; i++) {
      cells[i].classList.toggle('selected',
        !!(state.selection && state.selection.has(cells[i].dataset.id)));
    }
  }

  function onGridClick(ev) {
    var cell = ev.target.closest('#grid .cell');
    if (!cell) return;
    var id = cell.dataset.id;
    // 勾选:点复选框,或按住 Ctrl/Shift 点格子(和 Eagle 主界面的习惯一致)
    if (ev.target.closest('.pick') || ev.ctrlKey || ev.metaKey || ev.shiftKey) {
      ev.preventDefault();
      ev.stopPropagation();
      togglePick(id, ev.shiftKey);
      return;
    }
    eagle.item.open(id).catch(function () {});
  }

  /* ---------------- 格式筛选 ---------------- */

  var EXT_CHIP_LIMIT = 16;

  function buildExtChips() {
    var counts = Object.create(null);
    for (var i = 0; i < state.rows.length; i++) {
      var e = (state.rows[i].ext || '').toLowerCase();
      counts[e] = (counts[e] || 0) + 1;
    }
    state.extCounts = counts;
    var list = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    var shown = list.slice(0, EXT_CHIP_LIMIT);

    var html = '<button class="chip ext-chip' + (state.exts.size ? '' : ' active')
      + '" data-ext="">全部<span class="c">' + num(state.rows.length) + '</span></button>';
    for (var j = 0; j < shown.length; j++) {
      var ext = shown[j];
      html += '<button class="chip ext-chip' + (state.exts.has(ext) ? ' active' : '')
        + '" data-ext="' + escAttr(ext) + '">' + esc(ext || '无扩展名')
        + '<span class="c">' + num(counts[ext]) + '</span></button>';
    }
    $('extChips').innerHTML = html;
    $('extHint').textContent = list.length > shown.length
      ? '另有 ' + (list.length - shown.length) + ' 种较少见格式未列出'
      : '';
  }

  function onExtChipClick(ev) {
    var chip = ev.target.closest('.chip[data-ext]');
    if (!chip) return;
    var ext = chip.dataset.ext;
    if (!ext) state.exts.clear();
    else if (state.exts.has(ext)) state.exts.delete(ext);
    else state.exts.add(ext);

    var chips = $('extChips').querySelectorAll('.chip[data-ext]');
    for (var i = 0; i < chips.length; i++) {
      var e = chips[i].dataset.ext;
      chips[i].classList.toggle('active', e ? state.exts.has(e) : state.exts.size === 0);
    }
    refilter();
  }

  /* ---------------- 分布直方图 ---------------- */

  /**
   * 把 log2(宽高比) 分箱,并标出当前条件覆盖的区间。
   * 高亮判定直接复用匹配器,所以图与结果永远一致。
   */
  function buildHistogram(items, spec) {
    var bins = new Array(HISTO_BINS);
    var i;
    for (i = 0; i < HISTO_BINS; i++) bins[i] = 0;
    var max = 0;
    var peakBin = 0;

    for (i = 0; i < items.length; i++) {
      var r = items[i].width / items[i].height;
      var t = Math.log(r) / Math.LN2;
      if (t < -HISTO_RANGE) t = -HISTO_RANGE;
      if (t > HISTO_RANGE) t = HISTO_RANGE;
      var b = Math.floor((t + HISTO_RANGE) / (2 * HISTO_RANGE) * HISTO_BINS);
      if (b >= HISTO_BINS) b = HISTO_BINS - 1;
      if (b < 0) b = 0;
      bins[b]++;
      if (bins[b] > max) { max = bins[b]; peakBin = b; }
    }

    // 每个箱中心比例是否落在当前条件里 —— 用真实匹配器判定
    var matcher = M.createMatcher(spec);
    var hot = new Array(HISTO_BINS);
    for (i = 0; i < HISTO_BINS; i++) {
      var centre = Math.pow(2, ((i + 0.5) / HISTO_BINS) * (2 * HISTO_RANGE) - HISTO_RANGE);
      hot[i] = matcher({ width: centre, height: 1 });
    }
    return { bins: bins, max: max, hot: hot, peakBin: peakBin, total: items.length };
  }

  function renderHistogram() {
    var box = $('histo');
    if (!state.histo) {
      box.innerHTML = '';
      $('histoInfo').textContent = '—';
      return;
    }
    var h = state.histo;
    var scale = h.max > 0 ? 1 / Math.sqrt(h.max) : 0;
    var html = '';
    for (var i = 0; i < HISTO_BINS; i++) {
      var ratio = h.bins[i] > 0 ? Math.max(0.06, Math.sqrt(h.bins[i]) * scale) : 0;
      var cls = h.bins[i] === 0 ? 'bar zero' : (h.hot[i] ? 'bar hot' : 'bar');
      html += '<div class="' + cls + '" style="height:' + (ratio * 100).toFixed(1) + '%" title="'
        + escAttr(binLabel(i) + ' · ' + h.bins[i] + ' 项') + '"></div>';
    }
    box.innerHTML = html;
    var peak = Math.pow(2, ((h.peakBin + 0.5) / HISTO_BINS) * (2 * HISTO_RANGE) - HISTO_RANGE);
    $('histoInfo').textContent = num(h.total) + ' 项 · 峰值约 ' + peak.toFixed(2) + ':1';
  }

  function binLabel(i) {
    var centre = Math.pow(2, ((i + 0.5) / HISTO_BINS) * (2 * HISTO_RANGE) - HISTO_RANGE);
    return centre.toFixed(3) + ':1';
  }

  /* ---------------- 摘要 ---------------- */

  function renderSummary() {
    var box = $('summary');
    if (!state.items.length) {
      box.innerHTML = '<span class="c" style="color:var(--fg-dim)">'
        + (state.lastError ? '未读到条目,请重新扫描' : '等待索引…') + '</span>';
      return;
    }
    var spec = state.spec || currentSpec();
    var exact = spec.mode === 'near'
      ? M.filterItems(state.items.map(function (r) {
          return { id: r.id, width: r.w, height: r.h };
        }), { mode: 'near', target: spec.target, tolerancePct: 0, orientation: spec.orientation }).matched
      : null;

    var parts = [];
    parts.push('<span class="stat"><span class="n accent">' + num(state.matches.length)
      + '</span><span class="c">项匹配 / 共 ' + num(state.items.length) + '</span></span>');
    if (exact !== null && spec.tolerancePct > 0) {
      var gain = state.matches.length - exact;
      parts.push('<span class="stat"><span class="c">容差 0 时</span><span class="n">' + num(exact) + '</span></span>');
      if (gain > 0) parts.push('<span class="delta">+' + num(gain) + ' 项被容差捞出</span>');
    }
    parts.push('<span class="cond">' + esc(M.describe(spec)) + '</span>');
    box.innerHTML = parts.join('');
  }

  /* ---------------- 结果网格 ---------------- */

  /**
   * 渲染结果网格。`append` 为真时只追加新的一页 —— 无限滚动时若整块重建,
   * 滚动位置会被重置到顶部。
   */
  function renderGrid(append) {
    var grid = $('grid');
    var total = state.matches.length;

    if (!total) {
      grid.innerHTML = state.items.length
        ? '<div class="empty" style="grid-column:1/-1"><span class="big">◔</span>'
          + '<span class="t">没有符合条件的素材</span>'
          + '<span class="s">试试放宽容差、切换「横竖均可」,或改用「长宽比区间」直接给出区间。</span></div>'
        : '';
      $('btnMore').classList.add('hidden');
      state.renderedIds = [];
      renderHistogram();
      return;
    }

    var from = append ? state.shown : 0;
    state.shown = Math.min(from + PAGE_SIZE, total);
    var slice = state.matches.slice(from, state.shown);

    var html = '';
    var ids = [];
    for (var i = 0; i < slice.length; i++) {
      html += cellHtml(slice[i]);
      ids.push(slice[i].id);
    }
    if (append) {
      grid.insertAdjacentHTML('beforeend', html);
      state.renderedIds = state.renderedIds.concat(ids);
    } else {
      grid.innerHTML = html;
      state.renderedIds = ids;
    }

    var more = total - state.shown;
    var btn = $('btnMore');
    btn.classList.toggle('hidden', more <= 0);
    if (more > 0) btn.textContent = '显示更多(还有 ' + num(more) + ' 项)';

    renderHistogram();
    renderPickState();
    queueThumbnails();
  }

  function cellHtml(it) {
    var caught = M.nativeWouldFind(it, state.spec);
    var ratio = (it.width / it.height).toFixed(4);
    var src = state.thumbs[it.id];
    var picked = state.selection && state.selection.has(it.id);
    return '<div class="cell' + (picked ? ' selected' : '') + '" data-id="' + escAttr(it.id) + '" title="'
      + escAttr((it.name || it.id) + '\n' + it.width + ' × ' + it.height
        + '\n单击在 Eagle 中打开 · Ctrl 点勾选 · Shift 点范围选') + '">'
      + '<span class="pick" title="勾选(可用 Ctrl / Shift 多选)"></span>'
      + (src
        ? '<img class="thumb" loading="lazy" alt="" src="' + escAttr(src) + '">'
        : '<div class="thumb"></div>')
      + '<span class="badge' + (caught ? ' caught' : '') + '">' + (caught ? '原生 ✓' : '原生漏') + '</span>'
      + '<div class="meta"><div class="dim">' + it.width + '×' + it.height
      + ' <span class="ratio">' + ratio + '</span></div>'
      + '<div class="nm">' + esc(it.name || it.id) + (it.ext ? '.' + esc(it.ext) : '') + '</div></div>'
      + '</div>';
  }

  /**
   * 缩略图懒加载:串行排队而不是「忙就丢弃」,否则滚动或改条件时新渲染出来的
   * 格子会永远停在占位状态。每一轮都重新计算还缺哪些 id,所以不会重复请求。
   */
  var thumbChain = Promise.resolve();

  function queueThumbnails() {
    thumbChain = thumbChain.then(doHydrateThumbnails).catch(function (e) {
      plog('缩略图加载失败:' + (e && e.message ? e.message : e));
    });
  }

  async function doHydrateThumbnails() {
    var cells = document.querySelectorAll('#grid .cell');
    var need = [];
    var seen = Object.create(null);
    for (var i = 0; i < cells.length; i++) {
      var id = cells[i].dataset.id;
      if (!state.thumbs[id] && !seen[id]) { seen[id] = 1; need.push(id); }
    }
    if (!need.length) return;

    for (var off = 0; off < need.length; off += THUMB_CHUNK) {
      var items = await eagle.item.getByIds(need.slice(off, off + THUMB_CHUNK));
      (items || []).forEach(function (it) {
        var url = it && it.thumbnailURL;
        if (!url) return url;
        state.thumbs[it.id] = url;
        var cell = document.querySelector('#grid .cell[data-id="' + cssEscape(it.id) + '"]');
        if (!cell) return;
        // 必须显式按 class 找 .thumb 槽位:格子的第一个子元素是勾选框 .pick,
        // 若按位置取元素,src 会被设到勾选框上,缩略图永远不出现。
        var slot = cell.querySelector('.thumb');
        if (!slot) return;
        if (slot.tagName === 'IMG') { slot.src = url; return; }
        var img = document.createElement('img');
        img.className = 'thumb';
        img.loading = 'lazy';
        img.alt = '';
        img.onerror = function () {
          // 缩略图缺失时退回占位块,而不是留一个碎图标
          var ph = document.createElement('div');
          ph.className = 'thumb';
          if (img.parentNode) img.parentNode.replaceChild(ph, img);
        };
        img.src = url;
        slot.parentNode.replaceChild(img, slot);
      });
    }
  }

  function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* ---------------- 动作 ---------------- */

  function updateActions() {
    var total = state.matches.length;
    var picked = state.selection ? state.selection.size : 0;
    var target = picked || total;
    var has = target > 0;

    ['btnSelect', 'btnTag', 'btnCopy', 'btnExport'].forEach(function (id) {
      $(id).disabled = !has;
    });
    $('btnPickAll').disabled = total === 0;
    $('btnPickInvert').disabled = total === 0;
    $('btnPickNone').classList.toggle('hidden', picked === 0);

    var info = $('targetInfo');
    if (!total) {
      info.className = 'target none';
      info.textContent = '—';
    } else if (picked) {
      info.className = 'target';
      info.textContent = '目标:已选 ' + num(picked) + ' 项';
    } else {
      info.className = 'target none';
      info.textContent = '目标:全部 ' + num(total) + ' 项';
    }
  }

  async function onSelectInEagle() {
    var ids = targetItems().map(function (i) { return i.id; });
    try {
      await eagle.item.select(ids);
      if (eagle.app && typeof eagle.app.show === 'function') {
        await eagle.app.show().catch(function () {});
      }
      plog('已在 Eagle 中选中 ' + ids.length + ' 项');
      setStatus('已在 Eagle 中选中 ' + num(ids.length) + ' 项(已切到 Eagle 主窗口)');
    } catch (e) {
      plog('选中失败:' + (e.message || e));
      setStatus('选中失败:' + (e.message || e), false, true);
    }
  }

  async function hydrate(ids) {
    var out = [];
    for (var i = 0; i < ids.length; i += THUMB_CHUNK) {
      setStatus('读取条目 ' + num(Math.min(i + THUMB_CHUNK, ids.length)) + ' / ' + num(ids.length) + '…', true);
      var part = await eagle.item.getByIds(ids.slice(i, i + THUMB_CHUNK));
      out.push.apply(out, part || []);
      await new Promise(function (r) { setTimeout(r, 0); });
    }
    return out;
  }

  async function onTag() {
    var tag = ($('tagName').value || '').trim();
    if (!tag) { setStatus('请先填写标签名', false, true); return; }

    var ids = targetItems().map(function (i) { return i.id; });
    if (ids.length > HYDRATE_LIMIT) {
      ids = ids.slice(0, HYDRATE_LIMIT);
      setStatus('数量超过 ' + num(HYDRATE_LIMIT) + ',本次只处理前 ' + num(HYDRATE_LIMIT) + ' 项', true);
    }
    var ok = await confirmBox('给 ' + num(ids.length) + ' 项匹配素材添加标签「' + tag + '」?\n\n'
      + '标签会合并到条目已有标签上,不会覆盖原标签。');
    if (!ok) return;

    try {
      var items = await hydrate(ids);
      var done = 0, failed = 0;
      for (var i = 0; i < items.length; i++) {
        try {
          var it = items[i];
          var tags = Array.isArray(it.tags) ? it.tags.slice() : [];
          if (tags.indexOf(tag) === -1) tags.push(tag);
          it.tags = tags;
          await it.save();
          done++;
        } catch (e) { failed++; }
        if ((done + failed) % 25 === 0) {
          setStatus('打标签 ' + num(done + failed) + ' / ' + num(items.length) + '…', true);
        }
      }
      plog('打标签「' + tag + '」成功 ' + done + ' 项,失败 ' + failed);
      setStatus('已为 ' + num(done) + ' 项添加标签「' + tag + '」' + (failed ? ',' + failed + ' 项失败' : ''));
    } catch (e) {
      plog('打标签失败:' + (e.message || e));
      setStatus('打标签失败:' + (e.message || e), false, true);
    }
  }

  async function onCopyPaths() {
    var ids = targetItems().map(function (i) { return i.id; });
    var capped = ids.slice(0, HYDRATE_LIMIT);
    try {
      var items = await hydrate(capped);
      var text = items.map(function (i) { return i.filePath; }).filter(Boolean).join('\r\n');
      if (eagle.clipboard && eagle.clipboard.writeText) await eagle.clipboard.writeText(text);
      else await navigator.clipboard.writeText(text);
      setStatus('已复制 ' + num(items.length) + ' 条文件路径到剪贴板'
        + (ids.length > capped.length ? '(仅前 ' + num(capped.length) + ' 项)' : ''));
    } catch (e) {
      setStatus('复制失败:' + (e.message || e), false, true);
    }
  }

  async function onExport() {
    var spec = state.spec || currentSpec();
    var target = targetItems();
    var picked = state.selection ? state.selection.size : 0;
    var payload = {
      exportedAt: new Date().toISOString(),
      library: state.libraryPath || rawLibraryPath(),
      condition: { spec: spec, description: M.describe(spec) },
      formats: state.exts && state.exts.size ? Array.from(state.exts) : 'all',
      indexSource: state.indexSource,
      note: 'Eagle 原生形状筛选只有精确匹配(square 要求 width === height);本清单由容差/区间匹配得出。',
      totalScanned: state.items.length,
      matched: state.matches.length,
      exported: target.length,
      target: picked ? 'selection' : 'all-matches',
      items: target.map(function (i) {
        return {
          id: i.id, name: i.name, ext: i.ext,
          width: i.width, height: i.height,
          ratio: Number((i.width / i.height).toFixed(6)),
          nativeShape: M.nativeShape(i.width, i.height)
        };
      })
    };
    var json = JSON.stringify(payload, null, 2);

    try {
      var dest = null;
      if (eagle.dialog && eagle.dialog.showSaveDialog) {
        var r = await eagle.dialog.showSaveDialog({
          title: '导出筛选清单',
          defaultPath: 'shape-range-' + Date.now() + '.json',
          filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (r.canceled || !r.filePath) return;
        dest = r.filePath;
      }
      if (dest && fsMod) {
        fsMod.writeFileSync(dest, json, 'utf8');
        setStatus('已导出 ' + num(state.matches.length) + ' 项到 ' + dest);
      } else {
        var blob = new Blob([json], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'shape-range-' + Date.now() + '.json';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        setStatus('已导出 ' + num(state.matches.length) + ' 项');
      }
    } catch (e) {
      setStatus('导出失败:' + (e.message || e), false, true);
    }
  }

  async function confirmBox(message) {
    if (eagle.dialog && eagle.dialog.showMessageBox) {
      try {
        var r = await eagle.dialog.showMessageBox({
          type: 'question', buttons: ['取消', '确定'], defaultId: 1, cancelId: 0, message: message
        });
        return r.response === 1;
      } catch (e) { /* 落到 window.confirm */ }
    }
    return window.confirm(message);
  }
})();
