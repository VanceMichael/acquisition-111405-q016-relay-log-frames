import {createTransport} from './transport.mjs';
import {normalizeLegacy} from './legacy.mjs';
import {collectSource} from './source.mjs';

export async function collect({baseUrl, archive, mode = 'legacy', options = {}}) {
  const transport = createTransport(baseUrl);
  if (mode === 'legacy') {
    const response = await transport.request('/legacy');
    if (!response.ok) throw new Error(`摘要领取失败：${response.status}`);
    const records = [normalizeLegacy(response.json())];
    await archive.commit({records, exchanges: transport.exchanges});
    return {records, complete: true, issues: [], evidenceCount: transport.exchanges.length};
  }
  if (mode !== 'source') throw new Error('不支持的接收模式');
  const {derivedExchanges, ...result} = await collectSource({archive, transport, options});
  await archive.commit({
    records: result.records,
    exchanges: [...transport.exchanges, ...derivedExchanges],
    issues: result.issues,
  });
  return result;
}
