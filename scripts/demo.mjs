import { fixture, input } from '../test/fixtures.mjs';
const f = fixture();
try {
  const payment = await f.payment();
  const result = await f.service.execute(input, payment);
  const recovered = await f.service.execute(input, payment);
  console.log(JSON.stringify({ demonstration:'LOCAL SYNTHETIC FIXTURE — no public-chain settlement or credentials', sdk:'@x402/evm 2.29.0 exact EIP-3009', status:result.status, valid:result.result.valid, digest:result.result.sha256, amountBaseUnits:result.receipt.amount, asset:'fixture USDC profile', settleCalls:f.facilitator.settleCalls, recoveryIdentical:JSON.stringify(result)===JSON.stringify(recovered) },null,2));
} finally { f.close(); }
