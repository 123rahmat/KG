import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptField, decryptField, encryptJson, decryptJson, keyedDigest, stripeBillingPrivateState } from '../src/data-protection.js';

const billingKey = Buffer.from('billing-key-32-bytes-long-000000');
const personalKey = Buffer.from('personal-key-32-bytes-long-00000');

test('sensitive fields use authenticated randomized encryption', () => {
  const first = encryptField(billingKey, 'workspace-billing-v1', 'accounts@example.com');
  const second = encryptField(billingKey, 'workspace-billing-v1', 'accounts@example.com');
  assert.notEqual(first, second);
  assert.equal(decryptField(billingKey, 'workspace-billing-v1', first), 'accounts@example.com');
  assert.throws(() => decryptField(personalKey, 'workspace-billing-v1', first));
  assert.throws(() => decryptField(billingKey, 'other-purpose', first));
});

test('encrypted JSON preserves structured billing state without plaintext indexes', () => {
  const value = { billingEmail: 'accounts@example.com', taxId: 'PK-1234567', stripeCustomerId: 'cus_123' };
  const encoded = encryptJson(billingKey, 'workspace-billing-v1', value);
  assert.equal(decryptJson(billingKey, 'workspace-billing-v1', encoded).stripeCustomerId, 'cus_123');
  assert.equal(encoded.includes('cus_123'), false);
  assert.equal(encoded.includes('accounts@example.com'), false);
});

test('keyed lookup digests are stable but keyed', () => {
  const first = keyedDigest(personalKey, 'memory-lookup-v1', 'site engineer lahore');
  const second = keyedDigest(personalKey, 'memory-lookup-v1', 'site engineer lahore');
  const other = keyedDigest(billingKey, 'memory-lookup-v1', 'site engineer lahore');
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('Stripe billing state drops local invoice/profile fields', () => {
  const sanitized = stripeBillingPrivateState({
    billingEmail: 'accounts@example.com',
    companyName: 'Example Ltd',
    taxId: 'PK-1234567',
    country: 'Pakistan',
    address: 'Private address',
    stripeCustomerId: 'cus_123',
    stripeSubscriptionId: 'sub_123',
    stripeLastEventCreated: 123,
    stripeLastEventId: 'evt_123'
  });
  assert.deepEqual(sanitized, {
    stripeCustomerId: 'cus_123',
    stripeSubscriptionId: 'sub_123',
    stripeLastEventCreated: 123,
    stripeLastEventId: 'evt_123'
  });
});
