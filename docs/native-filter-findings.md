# 为什么不能直接用 Eagle 原生的「形状筛选」

这份笔记记录了本插件存在的**根本原因**,以及几条已经验证过走不通的路。
留在这里是为了让后来者不必重走一遍 —— 其中有些结论只能靠读 Eagle 本体才能得到。

结论:**Eagle 原生形状筛选是精确匹配,没有容差、也没有长宽比区间;
而插件 API 没有权限扩展它。** 模糊匹配只能由插件自己在外面算(也就是本仓库做的事)。

---

## 1. 原生判定写死在应用本体里

Eagle 的形状筛选判定在 `app/js/rule-match.js` → `isMatchShapeRule()`:

```js
if (image.width > image.height) {
    shape = (image.width / image.height >= 2.5) ? "panoramic-landscape" : "landscape";
} else if (image.width < image.height) {
    shape = (image.height / image.width >= 2.5) ? "panoramic-portrait" : "portrait";
} else if (image.width === image.height) {
    shape = "square";
}
// 「自定」比例:
isEqual = (rule.width / rule.height === width / height);
```

由此可读出的硬约束:

| 选项 | 真实语义 |
|---|---|
| 方形 | `width === height`,差 1 像素就掉进「横图/竖图」 |
| 横图 / 竖图 | 按比值 **2.5** 一刀切分出的四档之一 |
| 4:3 / 3:4 / 16:9 / 9:16 / 自定 | 比值**浮点精确相等**(`1025×768` 就不命中 `4:3`) |

主界面的**筛选面板**判定在 `app/app.bundle.js`,同样是写死的一串分支
(`if (!result && shape.square) { if (image.width == image.height) ... }`),
`filterRules.shape` 只是 10 个布尔开关,**数据模型里根本没有能存放容差的字段**。

也就是说:不是「近似筛选被排除在外」,而是这套形状筛选**从来没有实现过容差**。

## 2. 智能文件夹的 `shape` 规则也表达不了区间

插件侧的智能文件夹规则 schema(`app/js/plugin/handlers/smart-folder-rules.js`)
把 `shape` 定义成:

```js
shape: {
    category: 'SPECIAL',
    methods: ['equal', 'unequal'],          // 没有 > < between
    options: ['landscape','portrait','square',
              'panoramic-landscape','panoramic-portrait','custom'],
    extraFields: { width: {...}, height: {...} }   // custom 时必填,且仍是精确比值
}
```

作为对比,同一份 schema 里 `width` / `height` 等数值属性**是**有 `between` 的。
所以 Eagle 具备区间能力,只是没有把它给「形状/长宽比」这个维度。
规则里也不存在 `aspectRatio` / `ratio` / `orientation` 这类属性名
(`orientation` 只是主界面筛选面板的界面分组名)。

有人会想到用一堆 `width between` + `height between` 的矩形去逼近比例带。
**这条路在一般情况下也是不通的**,因为「长宽比落在某区间」在几何上是一个**楔形**,
需要「或之与」两层结构,而智能文件夹的求值逻辑只支持「与」:

```js
// app/app.bundle.js -> existInSmartFilter
for (var i = 0; i < smartFolder.conditions.length; i++) {
    var isMatch = isMatchCondition(smartFolder.conditions[i], image);
    if (boolean === "FALSE") isMatch = !isMatch;
    if (!isMatch) return false;      // ← 条件组之间只能是「与」
}
```

组内可以是「或」,但外层永远是「与」,因此 `OR(AND, AND)` 表达不出来。

## 3. 插件 API 没有触碰主界面的通道

插件运行在独立窗口,注入的 `eagle` 对象只有:
`app / os / screen / notification / window / item / tag / tagGroup / folder /
smartFolder / contextMenu / extraModule / library / dialog / clipboard / drag / shell / log`。

**没有 `filter` 命名空间**;`require('electron')` 也被替换成 `{}`,
拿不到 `ipcRenderer` / `BrowserWindow`,所以既改不了主窗口的 Angular scope,也改不了它的 DOM。

## 4. 那直接改 `app.asar` 呢?—— 已验证:会被防篡改机制拦下

把两个新选项加进原生面板在**容器层面是可行的**,以下事实均已实测:

| 事实 | 证据 |
|---|---|
| asar 容器可以无损重建 | 未改动重建后与原文件 **SHA-256 完全相同** |
| 没有启用 Electron 的 asar 完整性校验 | asar 头部只有 `files` 键,没有 `integrity` 块 |
| 形状判定在明文 bundle 里,不在字节码里 | 三个 `bytenode` 的 `.jsc` 中搜不到任何形状相关字符串 |
| 界面模板运行期单独加载 | 没有 `ng-template` 内联,走 `templateUrl` |
| 补丁后的判定逻辑本身是正确的 | 从产物中抽出真实代码,用 3,908 条真实宽高数据跑通 23 项断言 |

**但 Eagle 自己会在启动时校验 `app.bundle.js`**,日志里会明确写出:

```
[info] [app] Library loaded
[info] ---------------------------------------
[info] app.bundle.js has been tampered.        ← 随后中止启动
```

它的主进程里也有相应文案,例如
`The host file has been tampered with and the software cannot be opened.`
(连 hosts 文件被动过都会拒绝启动,属于有意为之的反修改防护)。

### 如果已经试过改 `app.asar`,恢复步骤

1. 把 `app.asar` 换回原始文件(**这一步是必须的**)。
2. 如果换回后 Eagle 仍然起不来,继续看下一节 —— 那可能已经不是防篡改的问题了。

本机实测的经过是:换回原始 `app.asar` 后 Eagle 依旧无法启动(连续 4 次尝试、且不写任何日志);
此后删掉 `%APPDATA%\Eagle\Certifications`(64 字节的校验文件)后立刻恢复,且 Eagle 会自行重建该文件。

但要如实说明:后来我在 Eagle 的启动日志里发现了另一条机制,两者可能混在一起了,
所以**不要把「删 `Certifications`」当成确定的修复方法**:

- `App crashes within 10s.` —— Eagle 检测到主窗口在启动后 10 秒内崩溃时会打印这行,
  接着 `The sandbox feature has already been disabled.` 并退出。
- 也就是说,**反复崩溃本身就会让 Eagle「起不来」**,表现得和防篡改锁定一模一样。
- 而这台机器上的 Eagle 从 2026-07-31 起就几乎每天崩一次(`mainWindow has crashed`),
  与本仓库的插件无关。所以当时那次「起不来」很可能主要是崩溃循环,而非证书文件。

### 排查 Eagle 启动问题时的几个坑(均在本机实测)

| 现象 | 真实原因 |
|---|---|
| 启动后立刻退出,且**完全不写日志** | 环境里有 `ELECTRON_RUN_AS_NODE=1`(某些 Node 工具链会设置它)。Electron 会以 Node 模式运行、不开窗口。启动前清掉该变量即可。 |
| 启动几秒后 `mainWindow has crashed`,随后 `App crashes within 10s` + 禁用沙箱 + 退出 | Eagle 的崩溃循环保护。要查的是**主窗口为什么崩**,而不是启动参数。 |
| 崩溃在**每一次**会话都发生(实测 45 秒 ~ 8 分钟),且转储的故障地址固定 | 这是 Eagle 自身的可复现崩溃,与插件无关。注意**插件创建顺序会造成时间上的假相关**:service 插件启动得早,早期崩溃自然都紧跟在它后面。本机就曾据此怀疑某个 service 插件,但把它停用后每次会话照样崩 —— 判断因果必须做「停用它再复现」的对照。 |
| 想确认 Eagle 到底有没有在运行 | **不要用进程枚举**:在某些受限/沙箱环境里 `tasklist` 会返回 `Access denied`、`Get-Process` 会静默返回空,于是「看不到进程」被误判成「Eagle 已经退出」。用 **本地 API 端口 `41593`/`41595` 是否在监听**,或日志文件是否还在活动来判断。 |
| 每次启动固定出现 2 条 `TypeError: Cannot read properties of null (reading 'forEach') at loadManifest` | Eagle 自身的 i18n bug:插件 manifest 有 `languages` 字段、目录里有 `_locales`,但 manifest 正文**不含任何 `{{...}}` 占位符**时,`string.match(/{{(.*?)}}/gm)` 返回 `null`,紧接的 `.forEach` 抛错(源码 `app/js/plugin/index.js` 约 3115 行)。异常被 catch,不影响启动。 |
| 插件目录里多出一个以插件 id 命名、却没有 `manifest.json` 的子目录 | Eagle 把窗口状态写到 `<Plugins>/<id>/window-state.json`。若插件目录名不等于自己的 id,就会多出这个目录。**无害**:`loadManifest` 在 `fs.existsSync(manifestPath)` 为假时直接返回,不会报错。 |

> 诊断主窗口崩溃时,**转储里的故障地址比日志有用得多**。本机三次崩溃都是
> `0xC0000005` 读越界、故障地址 `Eagle.exe+0x3701e70`,完全一致 —— 说明是可复现的
> 确定性 bug,而不是随机内存损坏。同一次崩溃既没有 Windows 事件日志记录、也没有 WER 报告,
> 只有 Eagle 自带的 Crashpad 留下了转储(minidump 里的异常流给出异常码与地址)。

## 5. 所以可行的做法

在插件里自己算:一次把条目宽高读进内存,之后所有容差/区间的调整都在本地重算。
这也正是本仓库的实现 —— 见 [README](../README.md) 与 `js/matcher.js`、`js/indexer.js`。

好处是补充关系而非替代关系:原生筛选照旧可用,插件只在需要模糊匹配时介入,
算完还可以把结果通过「在 Eagle 中选中」交回给 Eagle 自己的功能链。
