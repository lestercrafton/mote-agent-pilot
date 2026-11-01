import { getBytes, verifyMessage } from 'ethers';
import { assert, address, hash32, makeOffer, validatePayment, requirements } from './protocol.mjs';
import { hashJson } from './core/json.mjs';

export class Service {
  constructor({ config, journal, facilitator, proof, receiptSigner, now = () => Math.floor(Date.now() / 1000), maxActive = 8, requestsPerMinute = 120, hook = async () => {} }) {
    assert(address(receiptSigner.address) === config.offerSigner && journal.identity === hashJson(config.identity), 'SERVICE_IDENTITY');
    this.c = config; this.j = journal; this.facilitator = facilitator; this.proof = proof; this.signer = receiptSigner; this.now = now; this.active = 0; this.maxActive = maxActive; this.rate = requestsPerMinute; this.window = -1; this.requests = 0; this.hook = hook;
  }
  async limited(fn) {
    const w = Math.floor(this.now() / 60);
    if (w !== this.window) { this.window = w; this.requests = 0; }
    assert(this.requests++ < this.rate && this.active < this.maxActive, 'ADMISSION_LIMIT');
    this.active++;
    try { return await fn(); } finally { this.active--; }
  }
  offer(input) { return this.limited(() => { this.j.assertNewAuthority(); return makeOffer(this.c, input, this.signer, this.now()); }); }
  pending(row) { return { status: 'pending', paymentId: row.paymentId, transaction: row.txHash, recovery: 'Repeat the same signed request. Never create a replacement payment.' }; }
  async reconcile(row, suppliedHash) {
    assert(['complete', 'unknown', 'unsettled'].includes(row.status), 'ORDER_CORRUPT');
    if (row.status === 'complete') {
      assert(hashJson(JSON.parse(row.result)) === row.resultHash, 'RESULT_CORRUPT');
      const response = JSON.parse(row.response);
      assert(response.status === 'complete' && hashJson(response.result) === row.resultHash && response.receipt.resultHash === row.resultHash && response.receipt.configHash === this.c.identity && response.receipt.requestFingerprint === row.fingerprint && response.receipt.paymentId === row.paymentId && response.receipt.payer === row.payer && response.receipt.transaction === row.txHash, 'RECEIPT_CORRUPT');
      assert(address(verifyMessage(getBytes(hashJson(response.receipt)), response.signature)) === this.c.offerSigner, 'RECEIPT_CORRUPT');
      return response;
    }
    if (row.status === 'unsettled') return { status: 'unsettled', paymentId: row.paymentId };
    const payment = JSON.parse(row.payment);
    const txHash = suppliedHash ?? row.txHash;
    {
      // Hashes from clients/providers are hints only; validate before adopting any new hash.
      const proof = txHash ? await this.proof.settled(payment, txHash) : await this.proof.locate(payment);
      if (proof) {
        if (!row.txHash) this.j.noteHash(row.authKey, proof.transaction);
        const receipt = { profile: this.c.profile, configHash: this.c.identity, paymentId: row.paymentId, payer: row.payer, requestFingerprint: row.fingerprint, resultHash: row.resultHash, amount: this.c.amount, asset: this.c.asset, payTo: this.c.payTo, ...proof };
        const signature = await this.signer.signMessage(getBytes(hashJson(receipt)));
        assert(address(verifyMessage(getBytes(hashJson(receipt)), signature)) === this.c.offerSigner, 'RECEIPT_SIGNER');
        await this.hook('beforeReceiptCommit');
        return this.j.complete(row.authKey, { status: 'complete', result: JSON.parse(row.result), receipt, signature });
      }
    }
    if (await this.proof.expiredUnused(payment)) {
      this.j.provenUnsettled(row.authKey);
      return { status: 'unsettled', paymentId: row.paymentId };
    }
    return this.pending(this.j.byKey(row.authKey));
  }
  execute(input, payment, { transaction } = {}) {
    // Snapshot caller-owned objects before the first await to avoid cross-request mutation.
    input = structuredClone(input); payment = structuredClone(payment);
    return this.limited(async () => {
      const recovered = validatePayment(this.c, input, payment, this.now(), { recovery: true });
      const old = this.j.find(recovered);
      if (old) {
        const saved = validatePayment(this.c, input, JSON.parse(old.payment), this.now(), { recovery: true });
        assert(saved.authKey === old.authKey && saved.fingerprint === old.fingerprint && saved.resultHash === old.resultHash && hashJson(JSON.parse(old.result)) === old.resultHash, 'ORDER_CORRUPT');
        return this.reconcile(old, transaction);
      }
      const v = validatePayment(this.c, input, payment, this.now());
      if (!this.j.admitVerification(v, this.now())) return { status: 'pending', paymentId: v.id, transaction: null, recovery: 'Verification in progress or cooling down. Repeat this exact signed request.' };
      const verification = await this.facilitator.verify(payment, requirements(this.c));
      assert(verification.isValid === true && address(verification.payer) === v.payer, 'FACILITATOR_REJECTED');
      // Recheck time after external verification; completed handler result is already deterministic and bounded.
      validatePayment(this.c, input, payment, this.now());
      const { row, owner } = this.j.reserve(v, payment, this.now());
      if (!owner) return this.reconcile(row, transaction);
      await this.hook('afterReservation');
      this.j.assertNewAuthority(); // Disk/restore pressure may have changed while verification or hooks ran.
      let settlement;
      try { settlement = await this.facilitator.settle(payment, requirements(this.c)); }
      catch { return this.pending(row); }
      await this.hook('afterSettlement');
      // Even a success reply is not finality proof. Failure/pending cannot release the reservation.
      const hint = settlement?.network === this.c.network && hash32(settlement?.transaction) ? settlement.transaction : undefined;
      // Persisting an unverified hint could pin a malicious/wrong hash forever. Only strict proof adopts it.
      return this.reconcile(row, hint);
    });
  }
}
