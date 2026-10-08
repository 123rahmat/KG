import test from 'node:test';
import assert from 'node:assert/strict';
import * as selection from '../public/attachment-selection.js';

test('same-name files have independent selection identities', () => {
  const one = new File(['one'], 'notes.txt'), two = new File(['two'], 'notes.txt');
  assert.deepEqual(selection.selectedAttachments([one, two], new Set([two])), [two]);
});

test('an explicit empty attachment selection uploads no files', () => {
  const file = new File(['private'], 'private.txt');
  assert.deepEqual(selection.selectedAttachments([file], new Set()), []);
  assert.deepEqual(selection.selectedAttachments([file], null), [file]);
});

test('submitted attachment selection is a snapshot, independent of later composer changes', () => {
  const file = new File(['chosen'], 'notes.txt'), extra = new File(['later'], 'later.txt');
  const files = [file], chosen = new Set(files);
  const submitted = selection.selectedAttachments(files, chosen);
  files.push(extra); chosen.clear();
  assert.deepEqual(submitted, [file]);
});
