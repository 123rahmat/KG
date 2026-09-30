import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptField, encryptJson, decryptFieldWithKeys, decryptJsonWithKeys } from '../src/data-protection.js';

const previousKey = Buffer.from('previous-key-32-bytes-long-00000');
const currentKey = Buffer.from('current-key-32-bytes-long-000000');

test('private-data key rings support safe rotation', () => {
  const old = encryptJson(previousKey, 'workspace-billing-v1', { billingEmail: 'rotate@example.com' });
  const decoded = decryptJsonWithKeys([currentKey, previousKey], 'workspace-billing-v1', old);
  assert.equal(decoded.keyIndex, 1);
  assert.equal(decoded.value.billingEmail, 'rotate@example.com');

  const fresh = encryptJson(currentKey, 'workspace-billing-v1', decoded.value);
  assert.equal(decryptJsonWithKeys([currentKey, previousKey], 'workspace-billing-v1', fresh).keyIndex, 0);

  const oldField = encryptField(previousKey, 'workspace-billing-v1', 'x');
  assert.equal(decryptFieldWithKeys([currentKey, previousKey], 'workspace-billing-v1', oldField).keyIndex, 1);
  assert.throws(() => decryptFieldWithKeys([currentKey], 'workspace-billing-v1', oldField));
});
