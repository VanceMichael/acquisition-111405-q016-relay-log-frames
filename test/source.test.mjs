import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createFrameDecoder} from '../src/framing.mjs';
import {parseMessage} from '../src/syslog.mjs';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';

function feed(decoder, bytes, sizes) {
  let cursor = 0;
  for (const size of sizes) {
    decoder.write(bytes.subarray(cursor, cursor + size));
    cursor += size;
  }
  assert.equal(cursor, bytes.length, '测试切片必须覆盖全部字节');
  return decoder.finish();
}

// 按给定的任意切块（每块至少 1 字节）喂入，切块自动覆盖到流末尾。
function splitSizes(total, pattern) {
  const sizes = [];
  let cursor = 0;
  let index = 0;
  while (cursor < total) {
    const size = Math.min(pattern[index++ % pattern.length], total - cursor);
    sizes.push(size);
    cursor += size;
  }
  return sizes;
}

test('octet 帧按任意字节切片重组，正文换行不截断消息', () => {
  const first = Buffer.from('line1\nline2', 'utf8');
  const second = Buffer.from('a]b', 'utf8');
  const head1 = Buffer.from(`${first.length} `);
  const head2 = Buffer.from(`${second.length} `);
  const stream = Buffer.concat([head1, first, head2, second]);
  const result = feed(createFrameDecoder('octet'), stream, splitSizes(stream.length, [1, 4, 2, 7, 3, 5]));
  assert.equal(result.frames.length, 2);
  assert.deepEqual(result.frames[0], {offset: head1.length, bytes: first});
  assert.deepEqual(result.frames[1], {offset: head1.length + first.length + head2.length, bytes: second});
  assert.equal(result.incomplete, null);
  assert.equal(result.failure, null);
});

test('line 帧以 LF 定界，CR 与正文空格原样保留', () => {
  const stream = Buffer.from('a\rb\nx y\n', 'utf8');
  const result = feed(createFrameDecoder('line'), stream, splitSizes(stream.length, [2, 1, 3, 1]));
  assert.deepEqual(result.frames.map(f => f.bytes.toString()), ['a\rb', 'x y']);
  assert.deepEqual(result.frames.map(f => f.offset), [0, Buffer.from('a\rb\n').length]);
  assert.equal(result.incomplete, null);
});

test('连接中断的半帧进入 incomplete，新连接解码器不会继承', () => {
  const broken = createFrameDecoder('octet');
  broken.write(Buffer.from('12 abc')); // 声明 12 字节，只到 3 字节
  const ended = broken.finish();
  assert.equal(ended.frames.length, 0);
  assert.equal(ended.incomplete.bytes.length, Buffer.from('12 abc').length);
  const fresh = createFrameDecoder('octet');
  fresh.write(Buffer.from('5 hello'));
  const next = fresh.finish();
  assert.deepEqual(next.frames.map(f => f.bytes.toString()), ['hello']);
  assert.equal(next.incomplete, null);

  const halfLine = createFrameDecoder('line');
  halfLine.write(Buffer.from('no newline'));
  const lineEnd = halfLine.finish();
  assert.equal(lineEnd.frames.length, 0);
  assert.equal(lineEnd.incomplete.bytes.toString(), 'no newline');
});

test('octet 非法长度头与超限帧是致命帧错误，已收完整帧保留', () => {
  const decoder = createFrameDecoder('octet', {maxFrameBytes: 8});
  decoder.write(Buffer.from('3 abc'));
  decoder.write(Buffer.from('xx y'));
  const result = decoder.finish();
  assert.deepEqual(result.frames.map(f => f.bytes.toString()), ['abc']);
  assert.equal(result.failure.code, 'malformed-frame-header');

  const oversized = createFrameDecoder('octet', {maxFrameBytes: 4});
  oversized.write(Buffer.from('9 123456789'));
  assert.equal(oversized.finish().failure.code, 'frame-too-large');
});

test('UTF-8 多字节正文按字节长度匹配，不按字符数截断', () => {
  const content = Buffer.from('桥梁', 'utf8'); // 6 字节、2 字符
  const stream = Buffer.concat([Buffer.from(`${content.length} `), content]);
  const result = feed(createFrameDecoder('octet'), stream, [2, 3, 3]);
  assert.equal(result.frames.length, 1);
  assert.deepEqual(result.frames[0].bytes, content);
});

test('解析保留声明身份、缺省时间戳、结构化顺序与未经改写正文', () => {
  const message = parseMessage('<34>1 2026-11-18T10:00:00Z host app proc m1 [a x="1"][b y="2"] body with  spaces\nline2');
  assert.equal(message.ok, true);
  assert.equal(message.pri, 34);
  assert.equal(message.timestamp, '2026-11-18T10:00:00Z');
  assert.equal(message.declaredHost, 'host');
  assert.equal(message.proc, 'proc');
  assert.deepEqual(message.structured, [{id: 'a', params: {x: '1'}}, {id: 'b', params: {y: '2'}}]);
  assert.equal(message.body, 'body with  spaces\nline2');

  const dashed = parseMessage('<30>1 - device - - - - tail');
  assert.equal(dashed.ok, true);
  assert.equal(dashed.timestamp, null);
  assert.equal(dashed.declaredHost, 'device');
  assert.equal(dashed.proc, null);
  assert.equal(dashed.msgid, null);
  assert.deepEqual(dashed.structured, []);
  assert.equal(dashed.body, 'tail');

  const emptyBody = parseMessage('<30>1 - h a - - -');
  assert.equal(emptyBody.ok, true);
  assert.equal(emptyBody.body, '');
});

test('重复参数与非法转义不静默合并，全部留可复核问题', () => {
  const duplicate = parseMessage('<30>1 - h a - - [sd k="1" k="2"] x');
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.structured[0].params.k, '1'); // 保留首次取值
  assert.ok(duplicate.issues.some(i => i.code === 'structured-duplicate-param'));
  assert.deepEqual(duplicate.structured[0].paramConflicts[0].conflicts.map(c => c.code), ['structured-duplicate-param']);

  const badEscape = parseMessage('<30>1 - h a - - [sd k="a\\nb"] x');
  assert.equal(badEscape.ok, true);
  assert.equal(badEscape.structured[0].params.k, 'a\\nb'); // 不猜测、不吞掉
  assert.ok(badEscape.issues.some(i => i.code === 'structured-invalid-escape'));

  assert.equal(parseMessage('<30>1 - h a - - [sd k="unclosed] x').ok, false);
  assert.equal(parseMessage('garbage').ok, false);
  assert.equal(parseMessage('<30>2 - h a - - - x').ok, false);
});

function startLocalSource(routes) {
  const server = createServer((request, response) => {
    const route = routes[new URL(request.url, 'http://localhost').pathname];
    if (!route) { response.writeHead(404).end(); return; }
    response.writeHead(route.status ?? 200, route.headers ?? {});
    response.end(route.body);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done))});
  }));
}

test('端到端：line 通道、中继头、半帧隔离与相似标记都落库且可重开复核', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-e2e-'));
  const octetFrame = text => Buffer.concat([Buffer.from(`${Buffer.byteLength(text)} `), Buffer.from(text)]);
  const channels = JSON.stringify({channels: [
    {id: 'line-c', framing: 'line', connections: ['/l1', '/l2']},
    {id: 'oct-c', framing: 'octet', connections: ['/o1']},
  ]});
  const source = await startLocalSource({
    '/channels': {body: channels, headers: {'content-type': 'application/json'}},
    '/l1': {body: Buffer.from('<30>1 2026-01-01T00:00:00Z hostA app - m1 - one\ntwo\n')},
    '/l2': {body: Buffer.from('dangling without lf'), headers: {'x-relay': 'relay-b'}},
    '/o1': {body: Buffer.concat([
      octetFrame('<30>1 - hostB app - - - same'),
      octetFrame('<30>1 - hostB app - - - same'),
      octetFrame('not a message at all'),
    ]), headers: {'x-relay': 'relay-c'}},
  });
  try {
    const archive = await openArchive(directory);
    const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    const records = result.records;
    assert.equal(records.length, 5, '两条 line + 两条 octet + 一条坏帧全部保留为独立观察');
    const lineOne = records.find(r => r.connection === '/l1' && r.body === 'one');
    assert.equal(lineOne.relay, null);
    assert.equal(lineOne.declaredHost, 'hostA');
    assert.equal(lineOne.timestamp, '2026-01-01T00:00:00Z');
    // 正文里的换行不会把一条日志截成两条：line 帧各自独立，残缺的第二行仍如实留痕。
    const lineTwo = records.find(r => r.connection === '/l1' && r.body === 'two');
    assert.equal(lineTwo.parseState, 'malformed');
    const dangling = result.issues.find(i => i.code === 'incomplete-frame' && i.connection === '/l2');
    assert.ok(dangling, '未结束行帧作为可复核缺口');
    assert.equal(dangling.channel, 'line-c');
    const similar = records.filter(r => r.similar);
    assert.equal(similar.length, 1, '没有稳定消息号时同正文只标记不删除');
    assert.equal(records.filter(r => r.body === 'same').length, 2);
    const malformed = records.find(r => r.connection === '/o1' && r.parseState === 'malformed');
    assert.equal(malformed.body, 'not a message at all');
    assert.ok(result.issues.some(i => i.code === 'message-malformed' && i.connection === '/o1'));
    assert.equal(result.complete, false);

    const reopened = await openArchive(directory);
    const snapshot = reopened.snapshot();
    assert.ok(snapshot.evidence.length >= 4, '每条连接原文均作为证据留存');
    const ids = new Set(records.map(r => r.id));
    assert.equal(ids.size, records.length, 'id 非空且按连接身份稳定唯一');
    for (const evidence of snapshot.evidence) {
      assert.equal(Buffer.isBuffer(await reopened.raw(evidence.hash)), true);
    }
    // 再次领取：同 id 同修订不重复落库，记录总数保持稳定。
    const before = (await openArchive(directory)).snapshot().records.length;
    await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    const after = (await openArchive(directory)).snapshot();
    assert.equal(after.records.length, before, '同一业务身份重复接收不新增修订');
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('端到端：连接错误状态与传输失败生成带位置的问题，不影响其他连接', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-issue-'));
  const channels = JSON.stringify({channels: [
    {id: 'c', framing: 'line', connections: ['/good', '/bad', '/gone']},
  ]});
  const source = await startLocalSource({
    '/channels': {body: channels, headers: {'content-type': 'application/json'}},
    '/good': {body: Buffer.from('<30>1 - h a - - - ok\n')},
    '/bad': {status: 500, body: Buffer.from('fault')},
  });
  try {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].body, 'ok');
    const statusIssue = result.issues.find(i => i.code === 'connection-status' && i.connection === '/bad');
    assert.equal(statusIssue.status, 500);
    const goneIssue = result.issues.find(i => i.code === 'connection-status' && i.connection === '/gone');
    assert.equal(goneIssue.status, 404, '缺失连接与 5xx 一样带来源位置留痕');
    assert.equal(result.complete, false);
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});
