# 中继运行日志的帧边界与原始身份接收

这是资料接收服务的独立工作副本。当前版本支持人工摘要的领取、原文归档、重复导入和归档检查；`source` 模式已接入合作设备网关的连续字节流运行日志，按连接独立完成帧边界重组与结构化解析。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是初始产品的基线回归，验证现有摘要通路、原文摘要检查、本地来源响应，以及 CLI 在独立进程中的真实领取、重复导入和持久归档检查。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 的来源合同验收与 `test/source.test.mjs` 的设计边界验证（任意字节切片重组、行帧、半帧不跨连接、UTF-8 字节长度、结构化冲突留痕、端到端落库与错误位置）。交付时需执行 `npm run verify:complete`，让基线和新来源验收同时通过；不能只用基线成功说明新功能已完成。

```sh
npm run verify:complete
npm run demo:feature
```

正式演示使用完成后的 `npm run demo:feature`，从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `embedded-newline`。单次命令应在90秒内结束，不使用真实客户数据。

## 容器

```sh
docker build -t acquisition-relay-log-frames:local .
docker run --rm --network none acquisition-relay-log-frames:local
docker run --rm --network none acquisition-relay-log-frames:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令跑现有测试与实际摘要导入，不将未开发功能伪装成成功。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口，按 `mode` 分派 `legacy` 与 `source`；既有 `legacy` 模式保持不变。
- `src/source.mjs` 实现 `source` 模式：领取 `/channels`，逐连接流式接收，输出结构化记录与带来源位置的 `issues`。
- `src/framing.mjs` 是每连接独立的帧解码器，支持合同的 octet 计数字节帧与 line 行帧；连接结束时未拼完的半帧作为 `incomplete-frame` 留痕并随连接丢弃，不拼入下一条连接。
- `src/syslog.mjs` 解析合同子集 `<PRI>1 ...`：`-` 归一为空、结构化元素保留顺序、重复参数与非法转义不静默合并、正文原样保留。
- `src/transport.mjs` 提供原文字节与请求证据，`onChunk` 支持边接收边解码；错误状态由业务层判断，同源限制不变。
- `src/archive.mjs` 支持内容寻址原文与记录修订，存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 对输出使用局部结构断言，不限制内部模块划分。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。

## source 模式记录语义

每条完整帧产生一条记录，`id` 由 `channel + connection + offset` 内容寻址得到，非空且跨重跑稳定；同一连接里同正文的两帧仍是两次独立观察，按连接与偏移区分，只在缺少稳定消息号时以 `similar`/`similarTo` 标记，绝不凭文本相同删除或合并。记录保留 `declaredHost`（设备声明身份，可能与实际连接方不同）、`relay`（响应 `X-Relay` 的本次转发者，缺失为 `null`）、`timestamp`（`-` 归一为 `null`，其余原文保留）、`structured`（`[{id, params}]` 保留元素顺序）、未经改写的 `body` 与帧原文 SHA-256 `rawHash`。无法结构化解释的完整帧以 `parseState: "malformed"` 保留原文并在 `issues` 留痕；半帧、连接错误、非法帧、结构化冲突等均为带来源位置的可复核问题，存在未决问题时 `complete=false`（同正文重复观察已完整解释，不计为未决缺口）。该模式仅用于运行核查日志的接收与解释，不包含攻击载荷构造或入侵检测能力。
