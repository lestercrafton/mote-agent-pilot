import { readFileSync, writeFileSync } from 'node:fs';
import { Journal } from '../src/journal.mjs';
import { Service } from '../src/service.mjs';
import { validatePayment } from '../src/protocol.mjs';
import { FinalizedProof } from '../src/chain-proof.mjs';
import { FixtureChain, PUBLIC_FIXTURE_OPERATOR, input } from './fixtures.mjs';
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const j = new Journal(data.path, data.identity, data.options);
process.send({ ready: true });
process.once('message', async () => {
  try {
    if (data.mode === 'client') { j.clientReserve(data.id, data.id, '1000'); process.send({ ok: true }); }
    else if (data.mode === 'server') { const v = validatePayment(data.c, input, data.payment, data.now); process.send({ owner: j.reserve(v, data.payment, data.now).owner }); }
    else {
      const chain = new FixtureChain(data.c, data.now);
      const service = new Service({ config: data.c, journal: j, receiptSigner: PUBLIC_FIXTURE_OPERATOR, now: () => data.now, proof: new FinalizedProof(data.c, chain.rpc),
        facilitator: { verify: async p => ({ isValid: true, payer: p.payload.authorization.from }), settle: async p => ({ success: true, network: data.c.network, transaction: await chain.settle(p) }) },
        hook: async stage => { if (stage === data.point) { writeFileSync(data.externalState, JSON.stringify([...chain.transfers]), { mode: 0o600 }); process.send({ killPoint: stage }); await new Promise(() => {}); } },
      });
      await service.execute(input, data.payment);
    }
  } catch (e) { process.send({ error: e.code ?? e.message }); }
  j.close(); process.disconnect();
});
