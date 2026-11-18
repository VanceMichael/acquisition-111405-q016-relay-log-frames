import {createHash} from 'node:crypto';
import {createTransport} from './transport.mjs';
import {createFrameDecoder} from './framing.mjs';
import {parseMessage} from './syslog.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function relayHeader(headers) {
  const value = typeof headers.get === 'function' ? headers.get('x-relay') : headers['x-relay'];
  return value ?? null;
}

// 同一连接内把解析问题补齐来源位置。
function located(issues, location) {
  return issues.map(issue => ({...issue, ...location}));
}

export async function collectSource({baseUrl, archive}) {
  const transport = createTransport(baseUrl);
  const issues = [];
  const records = [];

  const catalog = await transport.request('/channels');
  if (!catalog.ok) throw new Error(`通道目录领取失败：${catalog.status}`);
  let channels;
  try { channels = catalog.json().channels; }
  catch (error) { throw new Error(`通道目录不是有效 JSON：${error.message}`); }
  if (!Array.isArray(channels)) throw new Error('通道目录缺少 channels 数组');

  for (const channel of channels) {
    if (!channel || typeof channel.id !== 'string' || !channel.id) {
      issues.push({code: 'channel-invalid', detail: '通道缺少有效 id'});
      continue;
    }
    if (channel.framing !== 'octet' && channel.framing !== 'line') {
      issues.push({code: 'channel-invalid', channel: channel.id, detail: `不支持的帧格式：${String(channel.framing)}`});
      continue;
    }
    if (!Array.isArray(channel.connections) || !channel.connections.length) {
      issues.push({code: 'channel-invalid', channel: channel.id, detail: '通道缺少 connections URL 数组'});
      continue;
    }
    for (const connectionPath of channel.connections) {
      if (typeof connectionPath !== 'string' || !connectionPath.startsWith('/')) {
        issues.push({code: 'connection-invalid', channel: channel.id, detail: `连接 URL 必须为同源相对路径：${String(connectionPath)}`});
        continue;
      }
      const decoder = createFrameDecoder(channel.framing);
      let response;
      try {
        response = await transport.request(connectionPath, {onChunk: chunk => decoder.write(chunk)});
      } catch (error) {
        issues.push({code: 'connection-failed', channel: channel.id, connection: connectionPath, detail: error.message});
        continue;
      }
      const relay = relayHeader(response.headers);
      if (!response.ok) {
        issues.push({code: 'connection-status', channel: channel.id, connection: connectionPath, status: response.status, detail: `来源返回 ${response.status}`});
        continue;
      }
      const {frames, incomplete, failure} = decoder.finish();
      const base = {channel: channel.id, connection: connectionPath};

      if (failure) {
        issues.push({...failure, ...base, detail: failure.detail});
      }
      if (incomplete) {
        // 半帧只属于本连接：这里记录缺口并随解码器一起丢弃，绝不拼到下一条连接。
        issues.push({
          code: 'incomplete-frame',
          ...base,
          offset: incomplete.offset,
          byteLength: incomplete.bytes.length,
          detail: `连接结束时仍有 ${incomplete.bytes.length} 字节未形成完整帧，已丢弃不跨连接拼接`,
        });
      }

      for (const frame of frames) {
        const location = {...base, offset: frame.offset};
        const rawHash = sha256(frame.bytes);
        // 按 UTF-8 解释；非法字节由问题留痕，但正文仍保留可复核形态，不伪造内容。
        const text = frame.bytes.toString('utf8');
        const decoded = parseMessage(text);
        issues.push(...located(decoded.issues, location));
        const identity = `${channel.id}\u0000${connectionPath}\u0000${frame.offset}`;
        const id = `relay-log:${sha256(Buffer.from(identity))}`;
        records.push({
          id,
          channel: channel.id,
          connection: connectionPath,
          offset: frame.offset,
          framing: channel.framing,
          relay,
          rawHash,
          parseState: decoded.ok ? 'parsed' : 'malformed',
          ...(decoded.ok ? {
            pri: decoded.pri,
            timestamp: decoded.timestamp, // "-" 归一为 null，其余原文保留，不擅自解析时区
            declaredHost: decoded.declaredHost,
            app: decoded.app,
            proc: decoded.proc,
            msgid: decoded.msgid,
            structured: decoded.structured,
            body: decoded.body, // 未经改写的正文，允许包含换行与空格
          } : {
            timestamp: null,
            declaredHost: null,
            structured: [],
            body: decoded.body,
          }),
        });
      }
    }
  }

  // 没有稳定消息号：同正文只标记“相似观察”，绝不凭文本相同删除或合并任何一条。
  const firstByHash = new Map();
  for (const record of records) {
    const previous = firstByHash.get(record.rawHash);
    if (previous) {
      record.similar = true;
      record.similarTo = previous;
      issues.push({
        code: 'duplicate-observation',
        channel: record.channel,
        connection: record.connection,
        offset: record.offset,
        detail: `与 ${previous} 原文一致，但缺少稳定消息号，按独立观察保留`,
      });
    } else {
      record.similar = false;
      firstByHash.set(record.rawHash, record.id);
    }
  }

  await archive.commit({records, exchanges: transport.exchanges, issues});
  // 同正文的重复观察已完整解释并保留，不属于未决缺口；其余问题（半帧、坏帧、
  // 连接错误、结构化冲突等）存在时不声明完整。
  const blocking = issues.filter(issue => issue.code !== 'duplicate-observation');
  return {records, complete: blocking.length === 0, issues, evidenceCount: transport.exchanges.length};
}
