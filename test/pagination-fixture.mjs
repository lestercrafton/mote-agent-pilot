import { H, FixtureChain } from './fixtures.mjs';

export function pagedChain(c, now, { top = 1000n, timestamp = () => now } = {}) {
  const chain = new FixtureChain(c, now), base = chain.rpc;
  chain.finalized = top; chain.pages = []; chain.reads = []; chain.pageHook = null; chain.blockHook = null;
  chain.rpc = async (method, params, options) => {
    chain.reads.push({ method, params: structuredClone(params) });
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'finalized' ? chain.finalized : BigInt(params[0]);
      const b = { number: '0x' + n.toString(16), hash: H(n), timestamp: '0x' + BigInt(timestamp(n)).toString(16), transactions: [...chain.transfers].filter(([,v]) => BigInt(v.tx.blockNumber) === n).map(([hash]) => hash) };
      return chain.blockHook ? chain.blockHook(b, params[0]) : b;
    }
    if (method === 'eth_getLogs') {
      const filter = params[0], first = BigInt(filter.fromBlock), last = BigInt(filter.toBlock);
      if (last < first || last - first + 1n > 200n) throw Error('PROVIDER_200_BLOCK_LIMIT');
      chain.pages.push([first,last]);
      const logs = [...chain.transfers.values()].flatMap(v=>v.receipt.logs).filter(l=>l.topics[0] === filter.topics[0] && l.topics[1] === filter.topics[1] && l.topics[2] === filter.topics[2] && BigInt(l.blockNumber)>=first && BigInt(l.blockNumber)<=last);
      return chain.pageHook ? chain.pageHook(structuredClone(logs), filter, options) : structuredClone(logs);
    }
    return base(method,params);
  };
  chain.place = async (payment, block) => {
    const hash = await chain.settle(payment), record = chain.transfers.get(hash), n = BigInt(block), number = '0x'+n.toString(16);
    record.tx.blockNumber = number; record.tx.blockHash = H(n); record.tx.transactionIndex = '0x0';
    record.receipt.blockNumber = number; record.receipt.blockHash = H(n); record.receipt.transactionIndex = '0x0';
    record.receipt.logs.forEach((l,i)=>Object.assign(l,{blockNumber:number,blockHash:H(n),transactionIndex:'0x0',logIndex:'0x'+i.toString(16)}));
    return hash;
  };
  return chain;
}
