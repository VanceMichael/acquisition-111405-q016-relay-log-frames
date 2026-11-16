import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startSource, fixtures} from '../provider/server.mjs';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';
import {createFrameDecoder, parseMessage} from '../src/frames.mjs';

function octets(...messages) {
  return Buffer.concat(messages.map(message => {
    const bytes = Buffer.from(message);
    return Buffer.concat([Buffer.from(`${bytes.length} `), bytes]);
  }));
}

function message({host = '-', msgid = '-', structured = '-', body = ''} = {}) {
  return `<34>1 - ${host} app - ${msgid} ${structured}${body === '' ? '' : ' ' + body}`;
}

test('octet解码器跨任意分块边界还原同一批帧', () => {
  const payload = octets(message({body: 'alpha'}), message({body: 'beta\ngamma'}), message({body: '桥梁'}));
  const whole = createFrameDecoder('octet');
  const expected = whole.push(payload).frames.map(frame => frame.payload.toString('utf8'));
  whole.finish();
  for (const chunk of [1, 2, 7, 13, 64]) {
    const decoder = createFrameDecoder('octet');
    const collected = [];
    for (let start = 0; start < payload.length; start += chunk) {
      collected.push(...decoder.push(payload.subarray(start, start + chunk)).frames);
    }
    collected.push(...decoder.finish().frames);
    assert.deepEqual(collected.map(frame => frame.payload.toString('utf8')), expected);
    assert.deepEqual(collected.map(frame => frame.offset), [0, 28, 61]);
  }
});

test('octet长度按UTF-8字节而不是字符数', () => {
  const bytes = Buffer.from(message({body: '桥梁日志'}));
  assert.equal(bytes.length, Buffer.byteLength(message({body: '桥梁日志'})));
  const decoder = createFrameDecoder('octet');
  const {frames} = decoder.push(Buffer.concat([Buffer.from(`${bytes.length} `), bytes]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString('utf8'), message({body: '桥梁日志'}));
});

test('line帧只按LF切分，正文中的CR与空行原样保留', () => {
  const decoder = createFrameDecoder('line');
  const first = decoder.push(Buffer.from(`${message({body: 'one\rtwo'})}\n\n`));
  assert.equal(first.frames.length, 2);
  assert.equal(first.frames[0].payload.toString('utf8'), message({body: 'one\rtwo'}));
  assert.equal(first.frames[1].payload.length, 0, '空行仍是独立行帧');
  assert.equal(decoder.finish().incomplete, null);
  // 行帧没有长度前缀，正文内部出现LF即按来源声明切分，不猜测跨行拼接。
  const split = createFrameDecoder('line');
  assert.equal(split.push(Buffer.from('a\nb\n')).frames.length, 2);
});

test('跨连接的半帧保持未结束且不拼接到下一条连接', () => {
  const first = createFrameDecoder('octet');
  first.push(Buffer.from('40 <34>1 - dev app - - - half'));
  const unfinished = first.finish().incomplete;
  assert.equal(unfinished.declaredLength, 40);
  assert.equal(unfinished.bytes.toString('utf8'), '<34>1 - dev app - - - half');
  const second = createFrameDecoder('octet');
  assert.deepEqual(second.push(Buffer.from('5 whole')).frames.map(frame => frame.payload.toString('utf8')), ['whole']);
  assert.equal(second.finish().incomplete, null);
});

test('长度前缀非法或超限时停止该连接并留下可复核问题', () => {
  const decoder = createFrameDecoder('octet');
  const result = decoder.push(Buffer.from('x5 hello'));
  assert.equal(result.frames.length, 0);
  assert.equal(result.issues[0].kind, 'invalid-length-prefix');
  assert.equal(decoder.push(Buffer.from('5 hello')).frames.length, 0);
  assert.equal(decoder.finish().incomplete, null);

  const oversized = createFrameDecoder('octet', {maximumFrameBytes: 8});
  assert.equal(oversized.push(Buffer.from('9 123456789')).issues[0].kind, 'frame-too-large');
});

test('结构化字段保留元素顺序、转义与原始正文', () => {
  // 契约中的连续[id ...]表示元素之间无分隔空格。
  const parsed = parseMessage(Buffer.from('<34>1 2026-01-01T00:00:00Z dev app - m1 [a x="1" y="2"][b z="q\\"w"] body  with  spaces '));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.timestamp, '2026-01-01T00:00:00Z');
  assert.equal(parsed.value.declaredHost, 'dev');
  assert.equal(parsed.value.app, 'app');
  assert.equal(parsed.value.proc, null);
  assert.equal(parsed.value.msgid, 'm1');
  assert.deepEqual(parsed.value.structured, [
    {id: 'a', params: {x: '1', y: '2'}},
    {id: 'b', params: {z: 'q"w'}},
  ]);
  assert.equal(parsed.value.body, 'body  with  spaces ');
});

test('重复参数与非法转义不会被静默合并或丢弃', () => {
  const duplicate = parseMessage(Buffer.from('<34>1 - dev app - - [a x="1" x="2"] b'));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.kind, 'duplicate-param');
  const escape = parseMessage(Buffer.from('<34>1 - dev app - - [a x="1\\n2"] b'));
  assert.equal(escape.ok, false);
  assert.equal(escape.error.kind, 'invalid-escape');
  const unterminated = parseMessage(Buffer.from('<34>1 - dev app - - [a x="1] b'));
  assert.equal(unterminated.ok, false);
  assert.equal(unterminated.error.kind, 'unterminated-structured');
});

test('未声明字段与非法UTF-8不产生正常消息', () => {
  assert.equal(parseMessage(Buffer.from('<34> dev app - - - body')).ok, false);
  assert.equal(parseMessage(Buffer.from('<34>2 - dev app - - - body')).ok, false);
  assert.equal(parseMessage(Buffer.from('<999>1 - dev app - - - body')).ok, false);
  assert.equal(parseMessage(Buffer.from([0x3c, 0x33, 0x34, 0x3e, 0x31, 0x20, 0xff])).ok, false);
  assert.equal(parseMessage(Buffer.from('<34>1 - dev app - - x body')).ok, false);
});

async function withSource(scenarioName, callback) {
  const directory = await mkdtemp(join(tmpdir(), 'source-edge-'));
  const source = await startSource(scenarioName);
  try {
    await callback({directory, source});
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
}

test('重复领取只标记重复，不删除观察且不改变接收身份', async () => {
  await withSource('embedded-newline', async ({directory, source}) => {
    const first = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(first.records.filter(record => record.kind === 'frame').length, 2);
    const second = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(second.records.filter(record => record.kind === 'frame').length, 2);
    assert.ok(second.records.filter(record => record.kind === 'frame')
      .every(record => record.similarity.status === 'repeat'));
    const ids = new Set(first.records.map(record => record.id));
    assert.ok(second.records.every(record => ids.has(record.id)), '同一来源位置产生稳定标识');
    assert.ok(second.complete);
  });
});

test('没有稳定消息号时，正文相同也只标记相似', async () => {
  await withSource('embedded-newline', async ({directory, source}) => {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    const frames = result.records.filter(record => record.kind === 'frame');
    assert.deepEqual(frames.map(record => record.similarity.status), ['first', 'similar']);
    assert.deepEqual(frames[1].similarity.relatesTo, [frames[0].id]);
    assert.equal(frames[0].msgid, 'm1');
  });
});

test('半帧保留为未结束部分并留下可复核缺口', async () => {
  await withSource('partial-frame', async ({directory, source}) => {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    const incomplete = result.records.filter(record => record.kind === 'incomplete-frame');
    assert.equal(incomplete.length, 1);
    assert.ok(result.issues.some(issue => issue.kind === 'incomplete-frame'));
    assert.equal(result.complete, false, '未结束帧不得声明完整');
  });
});

test('帧与半帧原文均按摘要落库，归档可复核', async () => {
  await withSource('partial-frame', async ({directory, source}) => {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    const reopened = await openArchive(directory);
    const evidence = reopened.snapshot().evidence;
    assert.ok(evidence.length >= 3);
    for (const record of result.records) {
      if (!record.rawHash) continue;
      const raw = await reopened.raw(record.rawHash);
      assert.equal(raw.length, record.bytes);
    }
    const frame = result.records.find(record => record.kind === 'frame');
    assert.equal((await reopened.raw(frame.rawHash)).toString('utf8'), message({host: 'dev', body: 'whole'}));
  });
});

async function startManifest(manifest, handleConnection) {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url);
    if (request.url !== '/channels' && handleConnection) {
      await handleConnection(request, response);
      return;
    }
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify(manifest));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests: () => requests.slice(),
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

test('连接正文逐块到达时按真实流边界解码', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-stream-'));
  const firstMessage = Buffer.from(message({host: 'dev', body: 'a'}));
  const secondMessage = Buffer.from(message({host: 'dev', body: '桥梁日志'}));
  const bytes = Buffer.concat([
    Buffer.from(`${firstMessage.length} `),
    firstMessage,
    Buffer.from(`${secondMessage.length} `),
    secondMessage,
  ]);
  const secondOffset = firstMessage.length + String(firstMessage.length).length + 1;
  const source = await startManifest({channels: [
    {id: 'c1', framing: 'octet', connections: ['/connection/1']},
  ]}, async (_request, response) => {
    response.writeHead(200, {'content-type': 'application/octet-stream', 'x-relay': 'relay-z'});
    const splits = [[0, 3], [3, secondOffset + 1], [secondOffset + 1, bytes.length]];
    for (const [start, end] of splits) {
      response.write(bytes.subarray(start, end));
      await new Promise(resolve => setImmediate(resolve));
    }
    response.end();
  });
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    const frames = result.records.filter(record => record.kind === 'frame');
    assert.equal(frames.length, 2);
    assert.deepEqual(frames.map(record => record.body), ['a', '桥梁日志']);
    assert.deepEqual(frames.map(record => record.offset), [0, secondOffset]);
    assert.ok(frames.every(record => record.relay === 'relay-z'));
    assert.equal(result.complete, true);
  } finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
});

test('连接中途断开时保留已收帧，并把剩余部分作为未决缺口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-cut-'));
  const whole = Buffer.from(message({host: 'dev', body: 'one'}));
  const first = Buffer.concat([Buffer.from(`${whole.length} `), whole]);
  const partial = Buffer.from('12 <34>1 - de');
  const source = await startManifest({channels: [
    {id: 'c1', framing: 'octet', connections: ['/connection/1']},
  ]}, async (_request, response) => {
    response.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': String(first.length + 400)});
    response.write(first);
    response.write(partial);
    await new Promise(resolve => setTimeout(resolve, 20));
    response.destroy();
  });
  try {
    const result = await collect({
      baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source',
      options: {idleTimeoutMs: 200},
    });
    const frames = result.records.filter(record => record.kind === 'frame');
    assert.deepEqual(frames.map(record => record.body), ['one']);
    const incomplete = result.records.filter(record => record.kind === 'incomplete-frame');
    assert.equal(incomplete.length, 1);
    // 未结束帧保存已收的正文部分（长度前缀已被消费）。
    assert.equal(incomplete[0].bytes, partial.length - 3);
    assert.equal(incomplete[0].declaredLength, 12);
    assert.equal((await (await openArchive(directory)).raw(incomplete[0].rawHash)).toString('utf8'), '<34>1 - de');
    assert.deepEqual(result.issues.map(issue => issue.kind).sort(), ['incomplete-frame', 'stream-interrupted']);
    assert.equal(result.complete, false);
  } finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
});

test('错误状态下返回的正文不被解释成日志', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-error-'));
  const source = await startManifest({channels: [
    {id: 'c1', framing: 'octet', connections: ['/connection/1']},
  ]}, async (_request, response) => {
    response.writeHead(503, {'content-type': 'text/plain'});
    response.end('5 error');
  });
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.deepEqual(result.records, [], '错误页不生成帧或消息');
    assert.equal(result.complete, false);
    assert.deepEqual(result.issues.map(issue => issue.kind), ['connection-unavailable']);
    assert.equal(result.evidenceCount, 0);
  } finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
});

test('来源声明的渠道与连接结构不合法时留下问题而不伪造消息', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-invalid-'));
  const source = await startManifest({channels: [
    {id: 'weird', framing: 'packet', connections: ['/connection/1']},
    {id: 'outside', framing: 'octet', connections: ['https://example.invalid/x']},
  ]});
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.deepEqual(result.records, []);
    assert.equal(result.complete, false);
    assert.deepEqual(result.issues.map(issue => issue.kind).sort(), ['invalid-connection', 'invalid-framing']);
    assert.equal(result.evidenceCount, 0);
    assert.deepEqual(source.requests(), ['/channels'], '只按声明读取，不遍历未声明路径');
  } finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
});

test('公开情景的每条记录都有稳定标识，原文可复核', async () => {
  for (const scenario of fixtures) {
    await withSource(scenario.name, async ({directory, source}) => {
      const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
      assert.ok(Array.isArray(result.records));
      assert.equal(result.records.some(record => !record.id), false);
      assert.equal(result.evidenceCount > 0, true);
      for (const record of result.records) {
        assert.ok(record.rawHash, '每条记录引用原文');
        assert.equal(record.bytes, (await (await openArchive(directory)).raw(record.rawHash)).length);
      }
    });
  }
});
