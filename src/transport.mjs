export function createTransport(baseUrl, options = {}) {
  const root = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(root.hostname)) throw new Error('仅允许本地合成来源');
  const exchanges = [];
  const maximumBytes = options.maximumBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 3000;
  const idleTimeoutMs = options.idleTimeoutMs ?? timeoutMs;

  async function request(path, requestOptions = {}) {
    const url = new URL(path, root);
    if (url.origin !== root.origin) throw new Error('来源链接越界');
    const headers = new Headers(requestOptions.headers);
    let body = requestOptions.body;
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      headers.set('content-type', 'application/json');
    }
    const controller = new AbortController();
    // 总时限只约束到响应头；正文读取由逐块空闲时限约束，长连接不必等到超时被截断。
    const headerTimer = setTimeout(() => controller.abort(), requestOptions.timeoutMs ?? timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        ...requestOptions, headers, body, redirect: 'error', signal: controller.signal,
      });
    } finally {
      clearTimeout(headerTimer);
    }
    const relay = response.headers.get('x-relay') ?? null;
    await requestOptions.onResponse?.({status: response.status, ok: response.ok, headers: response.headers, relay});
    const chunks = [];
    let length = 0;
    let truncated = false;
    let interrupted = null;
    if (response.body) {
      const iterator = response.body[Symbol.asyncIterator]();
      try {
        for (;;) {
          let timer;
          const idle = new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('连接在等待更多字节时中断'));
            }, requestOptions.idleTimeoutMs ?? idleTimeoutMs);
          });
          let step;
          try {
            step = await Promise.race([iterator.next(), idle]);
          } finally {
            clearTimeout(timer);
          }
          if (step.done) break;
          length += step.value.length;
          if (length > (requestOptions.maximumBytes ?? maximumBytes)) {
            // 既有模式保持报错；来源接收可显式要求保留已读字节并记录截断。
            if (!requestOptions.truncate) throw new Error('资料超过本地接收上限');
            await response.body.cancel?.().catch?.(() => {});
            truncated = true;
            break;
          }
          chunks.push(step.value);
          await requestOptions.onChunk?.(step.value, response);
        }
      } catch (error) {
        // 来源接收保留中断前已解码的部分，交由业务层标记未决。
        if (!requestOptions.partialOnError) throw error;
        interrupted = String(error?.message ?? error);
      }
    }
    const bytes = Buffer.concat(chunks);
    const exchange = {
      url: url.href, method: requestOptions.method ?? 'GET', status: response.status,
      headers: Object.fromEntries(response.headers), bytes, truncated,
      ...(interrupted === null ? {} : {interrupted}),
    };
    exchanges.push(exchange);
    return {
      status: response.status, ok: response.ok, headers: response.headers, relay,
      bytes, truncated, interrupted,
      text: () => bytes.toString('utf8'), json: () => JSON.parse(bytes.toString('utf8'))
    };
  }
  return {request, exchanges, origin: root.origin};
}
