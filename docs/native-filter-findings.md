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

### 如果已经试过改 `app.asar`,恢复要两步

1. 把 `app.asar` 换回原始文件;
2. **删除 `%APPDATA%\Eagle\Certifications`**(一个 64 字节的校验文件)。

只做第 1 步是不够的 —— 那个「已篡改」状态已经落盘,不删掉它 Eagle 依然起不来;
删掉后 Eagle 下次启动会自行重建该文件并恢复正常。

> 顺带一个和插件无关、但排查时很容易误判的点:若在带 `ELECTRON_RUN_AS_NODE=1`
> 的环境里启动 Eagle(某些 Node 工具链会设置它),Electron 会以 Node 模式运行、
> 不开窗口直接退出,而且**不写任何日志**。启动 Eagle 前需要清掉这个变量。

## 5. 所以可行的做法

在插件里自己算:一次把条目宽高读进内存,之后所有容差/区间的调整都在本地重算。
这也正是本仓库的实现 —— 见 [README](../README.md) 与 `js/matcher.js`、`js/indexer.js`。

好处是补充关系而非替代关系:原生筛选照旧可用,插件只在需要模糊匹配时介入,
算完还可以把结果通过「在 Eagle 中选中」交回给 Eagle 自己的功能链。
