import {createHash} from 'node:crypto';
import {createFrameDecoder, parseMessage, DEFAULT_MAX_FRAME_BYTES} from './frames.mjs';

export const DEFAULT_MAX_STREAM_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_CHANNELS = 1000;
export const DEFAULT_MAX_CONNECTIONS = 1000;

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const digestText = value => digest(Buffer.from(value, 'utf8'));

// 来源只能给本地合成地址；与 transport 的越界判断保持同一规则。
function sourceScopedUrl(origin, value) {
  if (typeof value !== 'string' || !value) return null;
  let url;
  try { url = new URL(value, origin); } catch { return null; }
  return url.origin === origin ? url : null;
}

function receiptOf(response) {
  return {
    status: response.status,
    // 中继链按来源给出的原值保留；无声明时为 null，不推断实际连接方。
    relay: response.headers.get('x-relay') ?? null,
    truncated: response.truncated === true,
    interrupted: response.interrupted ?? null,
    headers: Object.fromEntries(response.headers),
  };
}

function priorMessages(archive) {
  const latest = new Map();
  let snapshot;
  try { snapshot = archive.snapshot(); } catch { return []; }
  for (const record of snapshot.records ?? []) {
    if (!record || record.kind !== 'frame' || typeof record.bodyHash !== 'string') continue;
    latest.set(record.id, {
      recordId: record.id,
      channel: record.channel,
      bodyHash: record.bodyHash,
      msgid: record.msgid ?? null,
      declaredHost: record.declaredHost ?? null,
      relay: record.relay ?? null,
    });
  }
  return [...latest.values()];
}

export async function collectSource({archive, transport, options = {}}) {
  const maximumStreamBytes = options.maximumStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  const maximumFrameBytes = options.maximumFrameBytes ?? Math.min(DEFAULT_MAX_FRAME_BYTES, maximumStreamBytes);
  const maximumChannels = options.maximumChannels ?? DEFAULT_MAX_CHANNELS;
  const maximumConnections = options.maximumConnections ?? DEFAULT_MAX_CONNECTIONS;

  const records = [];
  const issues = [];
  const connections = [];
  const messages = [];
  const derivedExchanges = [];
  const known = priorMessages(archive);
  let complete = true;

  function addIssue(issue) {
    complete = false;
    issues.push({sequence: issues.length + 1, ...issue});
  }

  const manifestResponse = await transport.request('/channels');
  if (!manifestResponse.ok) {
    throw Object.assign(new Error(`渠道清单领取失败：${manifestResponse.status}`), {
      kind: 'channels-unavailable', status: manifestResponse.status,
    });
  }
  let manifest;
  try { manifest = manifestResponse.json(); } catch { manifest = null; }
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.channels)) {
    throw Object.assign(new Error('渠道清单不是声明的结构'), {kind: 'channels-invalid'});
  }
  if (manifest.channels.length > maximumChannels) {
    addIssue({
      kind: 'channels-truncated', message: '渠道数量超过本地接收上限',
      limit: maximumChannels, received: manifest.channels.length,
    });
  }

  const channels = manifest.channels.slice(0, maximumChannels);
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
    const channel = channels[channelIndex];
    const place = {channelIndex};
    if (!channel || typeof channel !== 'object' || typeof channel.id !== 'string' || !channel.id) {
      addIssue({kind: 'invalid-channel', message: '渠道缺少标识', ...place});
      continue;
    }
    place.channel = channel.id;
    if (channel.framing !== 'octet' && channel.framing !== 'line') {
      addIssue({kind: 'invalid-framing', message: '渠道帧方式未在来源契约内', framing: channel.framing ?? null, ...place});
      continue;
    }
    if (!Array.isArray(channel.connections)) {
      addIssue({kind: 'invalid-connection-list', message: '渠道缺少连接数组', ...place});
      continue;
    }
    if (channel.connections.length > maximumConnections) {
      addIssue({
        kind: 'connections-truncated', message: '单渠道连接数量超过本地接收上限',
        limit: maximumConnections, received: channel.connections.length, ...place,
      });
    }

    const list = channel.connections.slice(0, maximumConnections);
    for (let connectionIndex = 0; connectionIndex < list.length; connectionIndex++) {
      const where = {...place, connectionIndex};
      const url = sourceScopedUrl(transport.origin, list[connectionIndex]);
      if (!url) {
        addIssue({kind: 'invalid-connection', message: '连接地址缺失或指向来源之外', ...where});
        continue;
      }
      // 接收身份由渠道与连接位置确定，跨运行稳定且无需持久随机数。
      const connectionId = '/connection/' + digestText(`${channel.id}\u0000${url.href}`);
      const summary = {
        complete: true,
        receivedBytes: 0,
        truncated: false,
        incomplete: null,
        malformed: 0,
      };
      const connection = {
        channel: channel.id, connection: connectionId, connectionIndex,
        url: url.href, receipt: null, stream: summary, frames: [],
      };
      const decoder = createFrameDecoder(channel.framing, {maximumFrameBytes});
      const chunks = [];
      let receipt = null;
      let acceptance = 'pending';

      const absorb = ({frames, issues: frameIssues}) => {
        for (const issue of frameIssues) {
          addIssue({
            kind: issue.kind, message: issue.message,
            receivedBytes: issue.receivedBytes, declaredLength: issue.declaredLength,
            ...where, offset: issue.offset,
          });
          summary.complete = false;
        }
        for (const frame of frames) {
          const frameHash = digest(frame.payload);
          // 接收身份是渠道内连接的字节位置，不因正文相同而合并两条观察。
          const frameId = 'frame-' + digestText(`${connectionId}\u0000${frame.offset}`);
          const frameRecord = {
            id: frameId, kind: 'frame',
            channel: channel.id, connection: connectionId, ...where, offset: frame.offset,
            bytes: frame.payload.length, rawHash: frameHash,
          };
          derivedExchanges.push({
            url: `${url.href}#offset=${frame.offset}`, method: 'FRAME', status: 200,
            headers: {}, bytes: frame.payload,
          });
          const parsed = parseMessage(frame.payload);
          if (!parsed.ok) {
            records.push(frameRecord);
            addIssue({
              kind: 'unparsed-frame', message: parsed.error.message,
              cause: parsed.error.kind, ...where, offset: frame.offset,
            });
            summary.complete = false;
            summary.malformed++;
            connection.frames.push({
              offset: frame.offset, bytes: frame.payload.length, rawHash: frameHash,
              status: 'unparsed', cause: parsed.error.kind,
            });
            continue;
          }
          const value = parsed.value;
          const bodyHashOfMessage = digestText(value.body);
          const record = {
            ...frameRecord,
            timestamp: value.timestamp,
            declaredHost: value.declaredHost,
            app: value.app,
            proc: value.proc,
            msgid: value.msgid,
            relay: receipt?.relay ?? null,
            structured: value.structured,
            body: value.body,
            bodyHash: bodyHashOfMessage,
          };
          records.push(record);
          connection.frames.push({
            offset: frame.offset, bytes: frame.payload.length, rawHash: frameHash,
            status: 'ok', recordId: record.id,
          });
          messages.push({
            record,
            channel: channel.id,
            connection: connectionId,
            connectionIndex,
            msgid: value.msgid,
            bodyHash: bodyHashOfMessage,
            declaredHost: value.declaredHost,
            relay: record.relay,
          });
        }
      };

      // 正文按到达顺序解码；每个连接一个解码器，上一个连接留下的半帧已经结束。
      const response = await transport.request(url.href, {
        maximumBytes: maximumStreamBytes,
        truncate: true,
        partialOnError: true,
        onResponse(meta) {
          // 只有来源以成功状态给出正文时才解释为帧；错误页不是日志。
          acceptance = meta.status === 200 ? 'accepted' : 'rejected';
          receipt = {...meta, truncated: false, interrupted: null};
          connection.receipt = receipt;
        },
        onChunk(chunk) {
          if (acceptance !== 'accepted') return;
          chunks.push(chunk);
          summary.receivedBytes += chunk.length;
          absorb(decoder.push(chunk));
        },
      });
      receipt = receiptOf(response);
      connection.receipt = receipt;
      if (response.status !== 200) {
        addIssue({
          kind: 'connection-unavailable', message: '来源未提供连接正文',
          status: response.status, ...where,
        });
        summary.complete = false;
        connections.push(connection);
        continue;
      }
      summary.truncated = receipt.truncated;
      summary.complete = summary.complete && !receipt.truncated && !receipt.interrupted;
      const bytes = Buffer.concat(chunks);
      if (receipt.truncated) {
        addIssue({
          kind: 'stream-truncated', message: '连接超过本地接收上限，仅保留已读字节',
          limit: maximumStreamBytes, ...where,
        });
      }
      if (receipt.interrupted) {
        addIssue({
          kind: 'stream-interrupted', message: '连接读取中断，仅保留已收字节',
          detail: receipt.interrupted, receivedBytes: bytes.length, ...where,
        });
      }
      connections.push(connection);
      if (bytes.length) {
        const bodyHash = digest(bytes);
        records.push({
          id: 'evidence-' + digestText(`${connectionId}\u0000${bodyHash}`),
          kind: 'evidence', role: 'connection-body',
          channel: channel.id, connection: connectionId, connectionIndex, ...where,
          bytes: bytes.length, rawHash: bodyHash,
        });
      }
      const tail = decoder.finish();
      absorb(tail);
      if (tail.incomplete) {
        const incompleteHash = digest(tail.incomplete.bytes);
        if (tail.incomplete.bytes.length) {
          derivedExchanges.push({
            url: `${url.href}#offset=${tail.incomplete.offset}`, method: 'FRAME-PARTIAL',
            status: 200, headers: {}, bytes: tail.incomplete.bytes,
          });
          records.push({
            id: 'incomplete-' + digestText(`${connectionId}\u0000${tail.incomplete.offset}`),
            kind: 'incomplete-frame',
            channel: channel.id, connection: connectionId, ...where,
            offset: tail.incomplete.offset, bytes: tail.incomplete.bytes.length,
            declaredLength: tail.incomplete.declaredLength, rawHash: incompleteHash,
          });
        }
        addIssue({
          kind: 'incomplete-frame', message: '连接结束时仍有未结束的帧',
          ...where, offset: tail.incomplete.offset,
          receivedBytes: tail.incomplete.receivedBytes,
          declaredLength: tail.incomplete.declaredLength, rawHash: incompleteHash,
        });
        summary.complete = false;
        summary.incomplete = {
          offset: tail.incomplete.offset, receivedBytes: tail.incomplete.receivedBytes,
          declaredLength: tail.incomplete.declaredLength, rawHash: incompleteHash,
        };
      }
    }
  }

  // 相似与重复只用标记，绝不删除观察。稳定消息号按渠道+消息号判定重复；
  // 缺少消息号时，正文相同只能标记相似，不能据此判定为同一条日志。
  const historyByMessageId = new Map();
  const historyByBody = new Map();
  const pushTo = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (const previous of known) {
    if (previous.msgid) pushTo(historyByMessageId, JSON.stringify([previous.channel, previous.msgid]), previous.recordId);
    pushTo(historyByBody, JSON.stringify([previous.channel, previous.bodyHash]), previous.recordId);
  }
  const currentByBody = new Map();
  for (const message of messages) {
    const relatesTo = [];
    let status = 'first';
    if (message.msgid) {
      const prior = historyByMessageId.get(JSON.stringify([message.channel, message.msgid])) ?? [];
      const repeats = prior.filter(identity => identity !== message.record.id);
      if (repeats.length) {
        status = 'repeat';
        relatesTo.push(...repeats);
      } else if (prior.length) {
        // 同一接收位置已在归档中，本次不是新观察。
        status = 'repeat';
      }
    }
    const bodyKey = JSON.stringify([message.channel, message.bodyHash]);
    const similar = [
      ...(historyByBody.get(bodyKey) ?? []),
      ...(currentByBody.get(bodyKey) ?? []),
    ].filter((identity, index, list) =>
      identity !== message.record.id && list.indexOf(identity) === index && !relatesTo.includes(identity));
    if (similar.length) {
      if (status === 'first') status = 'similar';
      relatesTo.push(...similar);
    }
    message.record.similarity = {status, relatesTo};
    pushTo(currentByBody, bodyKey, message.record.id);
  }

  const observations = messages.map(message => ({
    channel: message.channel,
    connection: message.connection,
    connectionIndex: message.connectionIndex,
    declaredHost: message.declaredHost,
    relay: message.relay,
    timestamp: message.record.timestamp,
    msgid: message.msgid,
    offset: message.record.offset,
    body: message.record.body,
    rawHash: message.record.rawHash,
    similarity: message.record.similarity,
  }));

  return {
    records,
    complete,
    issues,
    evidenceCount: (transport.exchanges ?? []).filter(exchange =>
      exchange.status === 200 && new URL(exchange.url).pathname !== '/channels').length,
    observations,
    connections,
    derivedExchanges,
  };
}
