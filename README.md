# 中继运行日志的帧边界与原始身份接收

这是资料接收服务的独立工作副本。当前版本支持人工摘要的领取、原文归档、重复导入和归档检查；`source` 模式按来源声明接收连续字节流，支持 `octet` 计数字节帧与 `line` 行帧，保留声明身份、中继链、结构化字段和未改写正文。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是初始产品的基线回归，验证现有摘要通路、原文摘要检查、本地来源响应，以及 CLI 在独立进程中的真实领取、重复导入和持久归档检查。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 的完整新来源验收，以及 `test/source-edge.test.mjs` 中与来源契约一致的补充边界验证（分块边界、UTF-8 字节长度、跨连接半帧、非法转义与重复参数、稳定标识与重复标记）。`npm run verify:complete` 依次跑基线和新来源验收；不能只用基线成功说明新功能已完成。

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

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令跑现有测试与实际摘要导入；完整新来源验收由 `npm run verify:complete` 执行。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口；既有 `legacy` 模式要保留。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断。
- `src/archive.mjs` 支持内容寻址原文与记录修订，存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 对输出使用局部结构断言，不限制内部模块划分。
- `src/frames.mjs` 提供每连接独立的帧解码器与消息子集解析；半帧在连接结束时单独结束，不拼接到下一连接。
- `src/source.mjs` 按渠道清单读取连接，生成 `channel`、`connection`、`offset`、`declaredHost`、`relay`、`timestamp`、`structured`、`body`、`rawHash` 记录。

## 来源接收的边界

- 接收身份是渠道内的连接与字节位置（`connection` + `offset`），正文相同仍是两次观察；稳定消息号（MSGID）相同才标记 `repeat`，没有消息号时相同正文只标记 `similar`，不删除日志。
- 声明身份（HOST）与中继（`X-Relay`）分别保留，实际连接方不从声明推断。
- TIMESTAMP 缺省保留为 `null`；STRUCTURED 按 `[{id, params}]` 保留元素顺序，重复参数与非法转义作为可复核问题，不静默合并。
- 每个连接的字节上限、帧长度上限与渠道/连接数量上限都可显式配置；触达上限以 `complete=false` 和带来源位置的 `issues` 表达。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。
