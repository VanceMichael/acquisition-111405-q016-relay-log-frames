// 每连接独立的连续字节流帧解码器。
// 一个解码器实例只对应一条连接：连接结束时未拼完的半帧随实例丢弃，
// 不会进入下一条连接的缓冲区。
//
// octet：十进制 UTF-8 字节长度 + 0x20 空格 + 消息字节，长度按字节计数。
// line ：以 LF(0x0A) 结束，LF 之前的全部字节属于该帧（正文可包含任意内容）。

const MAX_HEADER_DIGITS = 20;

export function createFrameDecoder(framing, options = {}) {
  if (framing !== 'octet' && framing !== 'line') {
    throw new Error(`未知帧格式：${String(framing)}`);
  }
  const maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
  let pending = Buffer.alloc(0);
  let consumed = 0; // 本连接已确认消费的字节数，offset 以连接起点为零
  const frames = [];
  let failure = null;

  function fail(code, detail, offset = consumed) {
    if (failure) return;
    failure = {code, detail, offset};
    pending = Buffer.alloc(0);
  }

  function writeOctet(chunk) {
    if (failure) return;
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    while (pending.length && !failure) {
      const space = pending.indexOf(0x20);
      if (space === -1) {
        // 长度头尚未到齐：只允许出现数字，且长度有界，避免坏连接撑爆内存。
        const headerPart = pending.toString('ascii');
        if (pending.length > MAX_HEADER_DIGITS || !/^[0-9]*$/.test(headerPart)) {
          fail('malformed-frame-header', '计数字节帧的长度头不是十进制数字或缺少分隔空格');
        }
        return;
      }
      const headerText = pending.subarray(0, space).toString('ascii');
      if (!/^[0-9]+$/.test(headerText)) {
        fail('malformed-frame-header', `计数字节帧长度头非法：${headerText}`);
        return;
      }
      const length = Number(headerText);
      if (!Number.isSafeInteger(length) || length > maxFrameBytes) {
        fail('frame-too-large', `声明帧长 ${headerText} 超过单帧上限 ${maxFrameBytes}`);
        return;
      }
      if (pending.length < space + 1 + length) return; // 消息体未到齐，等待后续字节
      const offset = consumed + space + 1;
      frames.push({offset, bytes: Buffer.from(pending.subarray(space + 1, space + 1 + length))});
      consumed += space + 1 + length;
      pending = pending.subarray(space + 1 + length);
    }
  }

  function writeLine(chunk) {
    if (failure) return;
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    let lf;
    while ((lf = pending.indexOf(0x0a)) !== -1) {
      if (lf > maxFrameBytes) {
        fail('frame-too-large', `行帧长度 ${lf} 超过单帧上限 ${maxFrameBytes}`);
        return;
      }
      frames.push({offset: consumed, bytes: Buffer.from(pending.subarray(0, lf))});
      consumed += lf + 1;
      pending = pending.subarray(lf + 1);
    }
    if (pending.length > maxFrameBytes) {
      fail('frame-too-large', `未结束行帧已超过单帧上限 ${maxFrameBytes}`);
    }
  }

  return {
    framing,
    write(chunk) {
      if (!(chunk instanceof Uint8Array) || chunk.length === 0) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (framing === 'octet') writeOctet(bytes);
      else writeLine(bytes);
    },
    // 连接正常结束：返回完整帧、未结束半帧（如有）与致命帧错误。
    finish() {
      const incomplete = failure || !pending.length
        ? null
        : {offset: consumed, bytes: Buffer.from(pending)};
      pending = Buffer.alloc(0);
      return {frames, incomplete, failure};
    },
  };
}
