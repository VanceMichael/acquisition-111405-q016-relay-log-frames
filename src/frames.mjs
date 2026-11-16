export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

function problem(kind, message, details = {}) {
  return {kind, message, ...details};
}

/**
 * 按来源声明的帧方式增量切分一个连接的字节流。
 * 每个解码器只保存本连接的状态；finish() 返回的未结束字节不会交给下一条连接。
 */
export function createFrameDecoder(framing, options = {}) {
  if (framing !== 'octet' && framing !== 'line') throw new Error('未知的帧方式');
  const maximumFrameBytes = options.maximumFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes <= 0) throw new Error('帧长度上限无效');

  let buffer = Buffer.alloc(0);
  let offset = 0;
  let expected = null;
  let prefixBytes = 0;
  let stopped = false;
  let finished = false;

  function oversizedLine(issues) {
    issues.push(problem('frame-too-large', '行帧超过本地接收上限', {
      offset, receivedBytes: buffer.length, maximum: maximumFrameBytes,
    }));
    stopped = true;
    buffer = Buffer.alloc(0);
  }

  function drainLine(frames, issues) {
    while (!stopped) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      frames.push({payload: buffer.subarray(0, newline), offset});
      offset += newline + 1;
      buffer = buffer.subarray(newline + 1);
    }
    if (!stopped && buffer.length > maximumFrameBytes) oversizedLine(issues);
  }

  function drainOctet(frames, issues) {
    while (!stopped) {
      if (expected === null) {
        const space = buffer.indexOf(0x20);
        if (space < 0) {
          if (buffer.length > 20) {
            issues.push(problem('invalid-length-prefix', '字节帧长度前缀缺少空格或过长', {
              offset, receivedBytes: buffer.length,
            }));
            stopped = true;
            buffer = Buffer.alloc(0);
          }
          break;
        }
        const prefix = buffer.subarray(0, space).toString('latin1');
        if (!/^\d{1,18}$/.test(prefix)) {
          issues.push(problem('invalid-length-prefix', '字节帧长度前缀不是十进制字节数', {offset}));
          stopped = true;
          buffer = Buffer.alloc(0);
          break;
        }
        const length = Number(prefix);
        if (!Number.isSafeInteger(length) || length > maximumFrameBytes) {
          issues.push(problem('frame-too-large', '字节帧超出本地接收上限', {
            offset, declaredLength: Number.isSafeInteger(length) ? length : null, maximum: maximumFrameBytes,
          }));
          stopped = true;
          buffer = Buffer.alloc(0);
          break;
        }
        prefixBytes = space + 1;
        buffer = buffer.subarray(prefixBytes);
        expected = length;
      }
      if (buffer.length < expected) break;
      frames.push({payload: buffer.subarray(0, expected), offset});
      offset += prefixBytes + expected;
      buffer = buffer.subarray(expected);
      expected = null;
      prefixBytes = 0;
    }
  }

  return {
    framing,
    push(chunk) {
      const frames = [];
      const issues = [];
      if (finished || stopped) return {frames, issues};
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length === 0) return {frames, issues};
      buffer = buffer.length ? Buffer.concat([buffer, bytes]) : bytes;
      if (framing === 'line') drainLine(frames, issues);
      else drainOctet(frames, issues);
      return {frames, issues};
    },
    finish() {
      const frames = [];
      const issues = [];
      finished = true;
      let incomplete = null;
      if (!stopped) {
        if (framing === 'line') {
          if (buffer.length > 0) incomplete = {offset, receivedBytes: buffer.length, bytes: buffer};
        } else if (expected !== null) {
          incomplete = {
            offset, declaredLength: expected, receivedBytes: buffer.length, bytes: buffer,
          };
        } else if (buffer.length > 0) {
          incomplete = {offset, declaredLength: null, receivedBytes: buffer.length, bytes: buffer};
        }
      }
      buffer = Buffer.alloc(0);
      expected = null;
      prefixBytes = 0;
      stopped = true;
      return {frames, issues, incomplete};
    },
  };
}

class MessageError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

const utf8 = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

function readElementId(text, index) {
  const start = index;
  while (index < text.length && text[index] !== ' ' && text[index] !== ']') {
    if (text[index] === '=' || text[index] === '"' || text[index] === '\\') {
      throw new MessageError('invalid-structured', '结构化元素标识含非法字符');
    }
    index++;
  }
  const id = text.slice(start, index);
  if (!id) throw new MessageError('invalid-structured', '结构化元素缺少标识');
  return {id, index};
}

function readParamValue(text, index) {
  let value = '';
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      const escaped = text[index + 1];
      if (escaped === '\\' || escaped === '"' || escaped === ']') {
        value += escaped;
        index += 2;
        continue;
      }
      throw new MessageError('invalid-escape', escaped === undefined ? '参数值以单个反斜杠结束' : `不支持的转义\\${escaped}`);
    }
    if (character === '"') return {value, index: index + 1};
    value += character;
    index++;
  }
  throw new MessageError('unterminated-structured', '结构化参数值缺少结束引号');
}

function readStructured(text, start) {
  let index = start;
  const elements = [];
  while (index < text.length && text[index] === '[') {
    index++;
    const elementId = readElementId(text, index);
    let id = elementId.id;
    index = elementId.index;
    const params = {};
    const seen = new Set();
    while (index < text.length && text[index] === ' ') {
      index++;
      const keyStart = index;
      while (index < text.length && text[index] !== '=') {
        if (text[index] === ' ' || text[index] === ']' || text[index] === '"') {
          throw new MessageError('invalid-param', '结构化参数缺少等号');
        }
        index++;
      }
      if (index >= text.length) throw new MessageError('unterminated-structured', '结构化参数缺少等号');
      const key = text.slice(keyStart, index);
      if (!key) throw new MessageError('invalid-param', '结构化参数缺少名称');
      index++;
      if (text[index] !== '"') throw new MessageError('invalid-param', '结构化参数值必须以引号开始');
      const parsed = readParamValue(text, index + 1);
      index = parsed.index;
      if (seen.has(key)) throw new MessageError('duplicate-param', `结构化元素${id}含重复参数${key}`, {id, key});
      seen.add(key);
      // 不使用普通赋值，避免 __proto__ 等名称改变对象原型。
      Object.defineProperty(params, key, {
        value: parsed.value, enumerable: true, writable: true, configurable: true,
      });
      if (index < text.length && text[index] !== ' ' && text[index] !== ']') {
        throw new MessageError('invalid-param', '结构化参数之间缺少分隔');
      }
    }
    if (index >= text.length || text[index] !== ']') {
      throw new MessageError('unterminated-structured', '结构化元素缺少结束方括号');
    }
    index++;
    elements.push({id, params});
  }
  if (!elements.length) throw new MessageError('invalid-structured', '结构化字段没有元素');
  return {elements, index};
}

function nilOr(value) {
  return value === '-' ? null : value;
}

/**
 * 解析 <PRI>1 TIMESTAMP HOST APP PROC MSGID STRUCTURED BODY。
 * 只解释来源契约明确声明的子集；正文保持原字节解码后的内容，不做裁剪或改写。
 */
export function parseMessage(bytes) {
  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    return {ok: false, error: problem('invalid-utf8', '消息正文不是有效的UTF-8')};
  }
  try {
    if (text[0] !== '<') throw new MessageError('invalid-header', '消息缺少PRI');
    const priEnd = text.indexOf('>', 1);
    if (priEnd < 0) throw new MessageError('invalid-header', '消息PRI缺少结束符');
    const priText = text.slice(1, priEnd);
    if (!/^\d{1,3}$/.test(priText)) throw new MessageError('invalid-pri', 'PRI不是十进制数');
    const pri = Number(priText);
    if (pri > 191) throw new MessageError('invalid-pri', 'PRI超出声明范围');
    let index = priEnd + 1;
    const versionEnd = text.indexOf(' ', index);
    if (versionEnd < 0) throw new MessageError('invalid-header', '消息缺少版本之后的字段');
    const version = text.slice(index, versionEnd);
    if (version !== '1') throw new MessageError('unsupported-version', '仅声明了解释版本1');
    index = versionEnd;

    function readField(name) {
      if (text[index] !== ' ') throw new MessageError('invalid-header', `消息缺少${name}`);
      const start = index + 1;
      const end = text.indexOf(' ', start);
      if (end < 0) throw new MessageError('invalid-header', `消息字段${name}之后不完整`);
      const value = text.slice(start, end);
      if (!value) throw new MessageError('invalid-header', `消息字段${name}为空`);
      index = end;
      return value;
    }

    const timestampRaw = readField('TIMESTAMP');
    const hostRaw = readField('HOST');
    const appRaw = readField('APP');
    const procRaw = readField('PROC');
    const msgidRaw = readField('MSGID');

    if (text[index] !== ' ') throw new MessageError('invalid-structured', '消息缺少结构化字段');
    const structuredStart = index + 1;
    let structured;
    let body;
    if (text[structuredStart] === '-') {
      structured = [];
      index = structuredStart + 1;
    } else if (text[structuredStart] === '[') {
      const parsed = readStructured(text, structuredStart);
      structured = parsed.elements;
      index = parsed.index;
    } else {
      throw new MessageError('invalid-structured', '结构化字段必须为-或以[开头');
    }
    if (index === text.length) body = '';
    else if (text[index] === ' ') body = text.slice(index + 1);
    else throw new MessageError('invalid-structured', '结构化字段之后缺少正文分隔空格');

    return {
      ok: true,
      value: {
        pri,
        version,
        timestamp: nilOr(timestampRaw),
        declaredHost: nilOr(hostRaw),
        app: nilOr(appRaw),
        proc: nilOr(procRaw),
        msgid: nilOr(msgidRaw),
        structured,
        body,
      },
    };
  } catch (error) {
    if (error instanceof MessageError) {
      return {ok: false, error: problem(error.kind, error.message, error.details)};
    }
    throw error;
  }
}
