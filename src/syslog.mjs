// 来源合同子集的结构化解析：
// <PRI>1 TIMESTAMP HOST APP PROC MSGID STRUCTURED BODY
// TIMESTAMP/HOST/PROC 可为 "-"；STRUCTURED 为 "-" 或连续的 [id key="value"]。
// 只实现合同明确声明的子集；未声明的语法不会被解释成业务事实，
// 重复参数与非法转义作为可复核问题返回，不静默合并或吞掉。

const DASH = '-';

function takeToken(text, start) {
  let i = start;
  while (i < text.length && text.charCodeAt(i) !== 0x20) i += 1;
  return {token: text.slice(start, i), end: i};
}

// 解析一个 STRUCTURED-DATA 元素，游标位于 '[' 之后。
function parseElement(text, start) {
  const params = [];
  let i = start;
  while (i < text.length && text.charCodeAt(i) !== 0x20 && text.charCodeAt(i) !== 0x5d /* ] */) i += 1;
  const id = text.slice(start, i);
  if (!id) return {error: {code: 'structured-empty-id', detail: '结构化元素缺少 id'}};
  for (;;) {
    while (i < text.length && text.charCodeAt(i) === 0x20) i += 1;
    if (i >= text.length) return {error: {code: 'structured-unclosed', detail: `元素 ${id} 缺少闭合 ]`}};
    if (text.charCodeAt(i) === 0x5d) { i += 1; break; }
    const nameStart = i;
    while (i < text.length && text.charCodeAt(i) !== 0x20 && text.charCodeAt(i) !== 0x3d /* = */ && text.charCodeAt(i) !== 0x5d) i += 1;
    const name = text.slice(nameStart, i);
    if (!name || text.charCodeAt(i) !== 0x3d || text.charCodeAt(i + 1) !== 0x22) {
      return {error: {code: 'structured-bad-param', detail: `元素 ${id} 的参数缺少 key="value" 形式`}};
    }
    i += 2; // 跳过 = 和开引号
    let value = '';
    const conflicts = [];
    for (;;) {
      if (i >= text.length) return {error: {code: 'structured-unclosed-quote', detail: `参数 ${name} 的引号未闭合`}};
      const ch = text[i];
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === '\\' || next === '"' || next === ']') { value += next; i += 2; continue; }
        conflicts.push({code: 'structured-invalid-escape', detail: `参数 ${name} 出现非法转义 \\${String(next)}`});
        value += `\\${String(next ?? '')}`; // 保留未经解释的原始两字符，不猜测含义
        i += next === undefined ? 1 : 2;
        continue;
      }
      if (ch === '"') { i += 1; break; }
      value += ch;
      i += 1;
    }
    if (params.some(param => param.name === name)) {
      conflicts.push({code: 'structured-duplicate-param', detail: `元素 ${id} 的参数 ${name} 重复出现，保留首次取值`});
    }
    params.push({name, value, conflicts});
  }
  return {element: {id, params}, end: i};
}

// 返回 {data, issues}；data 为 null 表示结构段本身无法解释。
function parseStructured(text, start) {
  if (text.charCodeAt(start) === 0x2d /* - */ && (text.length === start + 1 || text.charCodeAt(start + 1) === 0x20)) {
    return {data: [], end: start + 1, issues: []};
  }
  const data = [];
  const issues = [];
  let i = start;
  while (i < text.length && text.charCodeAt(i) === 0x5b /* [ */) {
    const result = parseElement(text, i + 1);
    if (result.error) {
      issues.push(result.error);
      return {data: null, issues};
    }
    for (const param of result.element.params) issues.push(...param.conflicts);
    const params = {};
    for (const param of result.element.params) {
      if (!(param.name in params)) params[param.name] = param.value; // 重复键保留首次取值
    }
    data.push({
      id: result.element.id,
      // 元素顺序由外层数组保留；同名重复不覆盖，另以 paramConflicts 留痕。
      params,
      ...(result.element.params.some(param => param.conflicts.length)
        ? {paramConflicts: result.element.params
            .filter(param => param.conflicts.length)
            .map(param => ({name: param.name, conflicts: param.conflicts}))}
        : {}),
    });
    i = result.end;
    if (i < text.length && text.charCodeAt(i) !== 0x20 && text.charCodeAt(i) !== 0x5b) {
      issues.push({code: 'structured-bad-syntax', detail: '结构化元素之间出现非法字符'});
      return {data: null, issues};
    }
    // 元素必须连续；允许空格仅当它后面仍是新元素或正文起点。
    if (i < text.length && text.charCodeAt(i) === 0x20 && text.charCodeAt(i + 1) === 0x5b) i += 1;
  }
  if (i < text.length && text.charCodeAt(i) !== 0x20) {
    issues.push({code: 'structured-bad-syntax', detail: '结构化段未按连续元素排列'});
    return {data: null, issues};
  }
  return {data, end: i, issues};
}

export function parseMessage(text) {
  const issues = [];
  if (text.charCodeAt(0) !== 0x3c /* < */) {
    return {ok: false, issues: [{code: 'message-malformed', detail: '缺少 <PRI> 起始'}], body: text};
  }
  const close = text.indexOf('>');
  if (close < 2 || !/^[0-9]+$/.test(text.slice(1, close))) {
    return {ok: false, issues: [{code: 'message-malformed', detail: 'PRI 不是数字'}], body: text};
  }
  const pri = Number(text.slice(1, close));
  let cursor = close + 1;
  const versionToken = takeToken(text, cursor);
  if (versionToken.token !== '1') {
    return {ok: false, issues: [{code: 'message-unsupported-version', detail: `仅支持版本 1，收到 ${versionToken.token || '空值'}`}], body: text};
  }
  cursor = versionToken.end;
  if (text.charCodeAt(cursor) !== 0x20) {
    return {ok: false, issues: [{code: 'message-malformed', detail: '版本字段后缺少分隔空格'}], body: text};
  }

  const header = {};
  for (const field of ['timestamp', 'host', 'app', 'proc', 'msgid']) {
    cursor += 1;
    const part = takeToken(text, cursor);
    if (!part.token) {
      return {ok: false, issues: [{code: 'message-malformed', detail: `字段 ${field} 为空`}], body: text};
    }
    header[field] = part.token === DASH ? null : part.token;
    cursor = part.end;
  }
  if (cursor >= text.length || text.charCodeAt(cursor) !== 0x20) {
    return {ok: false, issues: [{code: 'message-malformed', detail: 'MSGID 后缺少结构化段'}], body: text};
  }
  cursor += 1;

  const structuredSegment = text.slice(cursor);
  const parsed = parseStructured(structuredSegment, 0);
  issues.push(...parsed.issues);
  let body = '';
  if (parsed.data !== null && parsed.end < structuredSegment.length) {
    // 结构化段与正文之间恰好一个空格；正文从该空格之后原样保留。
    if (structuredSegment.charCodeAt(parsed.end) !== 0x20) {
      issues.push({code: 'message-malformed', detail: '结构化段与正文之间缺少分隔空格'});
      return {ok: false, issues, body: text};
    }
    body = structuredSegment.slice(parsed.end + 1);
  }
  if (parsed.data === null) {
    return {ok: false, issues, body: text};
  }
  return {
    ok: true,
    pri,
    timestamp: header.timestamp,
    declaredHost: header.host,
    app: header.app,
    proc: header.proc,
    msgid: header.msgid,
    structured: parsed.data,
    body,
    issues,
  };
}
