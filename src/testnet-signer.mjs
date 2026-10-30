import { Wallet, verifyTypedData } from 'ethers';
import { canonicalStringify } from './json.mjs';
import { QUOTE_TYPES, quoteDomain } from './testnet-chain.mjs';
import { getTestnetNetwork } from './testnet-networks.mjs';

const HEX = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9]\d{0,77})$/;
const fail = () => { throw Object.assign(new Error('Quote signer policy rejected the operation.'), { code: 'QUOTE_SIGNER_POLICY' }); };
const check = value => { if (!value) fail(); };
const same = (a,b) => canonicalStringify(a) === canonicalStringify(b);

/** Uses an already-provisioned key; never generates, persists, logs or attaches
 * it to a provider. Returns no transaction/deployment signing methods. */
export function createPilotQuoteSigner(privateKey, identity, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  check(typeof privateKey === 'string' && HEX.test(privateKey));
  let wallet; try { wallet = new Wallet(privateKey); } catch { fail(); }
  const network = getTestnetNetwork(identity.chainId);
  check(wallet.address.toLowerCase() === identity.quoteSigner.toLowerCase());
  const domain = quoteDomain(network.chainId, identity.router);
  const maximumQuoteLifetimeSeconds = network.chainId === 11155111 ? 7200 : 900;
  const bound = object => {
    check(object.protocol === network.protocol && object.chainId === network.chainId && object.asset === 'MOTE'
      && object.origin === identity.origin && object.configHash === identity.configHash && object.testOnly === true
      && object.publicSynthetic === true && object.localOnly === false && object.finality === 'finalized');
    for (const key of ['token', 'router', 'recipient', 'quoteSigner']) check(typeof object[key] === 'string' && object[key].toLowerCase() === identity[key].toLowerCase());
  };
  const quote = value => {
    check(value && Object.keys(value).sort().join() === 'amount,deadline,payer,quoteId,requestHash');
    check(HEX.test(value.quoteId) && HEX.test(value.requestHash) && /^0x[0-9a-fA-F]{40}$/.test(value.payer));
    check(typeof value.amount === 'string' && UINT.test(value.amount) && BigInt(value.amount) >= 1000n && BigInt(value.amount) <= 656360n);
    check(typeof value.deadline === 'string' && UINT.test(value.deadline) && BigInt(value.deadline) > BigInt(now()) && BigInt(value.deadline) <= BigInt(now() + maximumQuoteLifetimeSeconds));
  };
  return Object.freeze({
    address: wallet.address.toLowerCase(),
    async signTypedData(requestDomain, types, value) {
      check(same(requestDomain, domain) && same(types, QUOTE_TYPES)); quote(value);
      return wallet.signTypedData(domain, QUOTE_TYPES, value);
    },
    async signMessage(message) {
      check(typeof message === 'string' && Buffer.byteLength(message) <= 16384);
      let object; try { object = JSON.parse(message); } catch { fail(); }
      check(object && !Array.isArray(object) && same(object, JSON.parse(canonicalStringify(object))) && canonicalStringify(object) === message);
      bound(object);
      if (object.quote) {
        const fields = ['protocol','quote','domain','signature','chainId','token','router','recipient','quoteSigner','decimals','asset','service','resultHash','expiresAt','inputBytes','origin','configHash','finality','testOnly','publicSynthetic','localOnly'];
        check(Object.keys(object).length === fields.length && fields.every(k => Object.hasOwn(object,k)));
        quote(object.quote); check(same(object.domain, domain) && object.decimals === 6 && object.service === 'json.audit' && HEX.test(object.resultHash));
        check(Number.isSafeInteger(object.inputBytes) && object.inputBytes >= 0 && object.inputBytes <= 65536 && object.quote.amount === String(1000 + 10 * object.inputBytes));
        check(new Date(Number(object.quote.deadline) * 1000).toISOString() === object.expiresAt);
        try { check(verifyTypedData(domain, QUOTE_TYPES, object.quote, object.signature).toLowerCase() === wallet.address.toLowerCase()); } catch { fail(); }
      } else {
        const fields = ['protocol','quoteId','requestHash','resultHash','payer','amount','asset','chainId','token','router','recipient','quoteSigner','origin','configHash','transactionHash','blockNumber','blockHash','transactionIndex','logIndex','settledAt','finalized','finality','testOnly','publicSynthetic','localOnly'];
        check(Object.keys(object).length === fields.length && fields.every(k => Object.hasOwn(object,k)));
        for (const key of ['quoteId','requestHash','resultHash','transactionHash','blockHash']) check(HEX.test(object[key]));
        for (const key of ['amount','blockNumber','transactionIndex','logIndex']) check(typeof object[key] === 'string' && UINT.test(object[key]));
        check(object.finalized && Object.keys(object.finalized).sort().join() === 'blockHash,blockNumber' && HEX.test(object.finalized.blockHash)
          && typeof object.finalized.blockNumber === 'string' && UINT.test(object.finalized.blockNumber) && BigInt(object.finalized.blockNumber) >= BigInt(object.blockNumber));
        check(typeof object.settledAt === 'string' && Number.isFinite(Date.parse(object.settledAt)) && /^0x[0-9a-fA-F]{40}$/.test(object.payer));
      }
      return wallet.signMessage(message);
    },
  });
}
