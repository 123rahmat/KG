import test from 'node:test';
import assert from 'node:assert/strict';
import { screenshotSize, captureSelectedTab } from '../public/workspace-screenshot.js';

test('screenshots preserve ratio and never upscale huge UI frames', () => {
  assert.deepEqual(screenshotSize(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(screenshotSize(300, 200), { width: 300, height: 200 });
  assert.deepEqual(screenshotSize(1080, 2160), { width: 540, height: 1080 });
  assert.throws(() => screenshotSize(0, 10), /dimensions/);
});

test('user-selected screenshot captures a single image and stops the stream', async () => {
  let stopped = 0;
  let drawn = null;
  let captureOptions;
  const frame = { videoWidth: 1280, videoHeight: 720, play: async () => {},
    srcObject: null, muted: false, playsInline: false };
  const mediaDevices = { getDisplayMedia: async options => {
    captureOptions = options;
    return { getTracks: () => [{ stop: () => { stopped++; } }] };
  }};
  const documentRef = { createElement: tag => tag === 'video' ? frame : {
    width: 0, height: 0, getContext: () => ({
      drawImage: (...args) => { drawn = args; }
    }), toBlob: callback => callback(new Blob(['png'], { type: 'image/png' }))
  }};
  const result = await captureSelectedTab({
    mediaDevices, documentRef, date: new Date('2026-10-10T00:00:00Z'),
    createFile: (parts, name, options) => ({ parts, name, options })
  });
  assert.equal(captureOptions.audio, false);
  assert.equal(captureOptions.video.displaySurface, 'browser');
  assert.equal(result.options.type, 'image/png');
  assert.match(result.name, /^workspace-ui-2026-10-10/);
  assert.deepEqual(drawn.slice(1), [0, 0, 1280, 720]);
  assert.equal(stopped, 1);
  assert.equal(frame.srcObject, null);
});

test('capture refuses silently recording unsupported browser', async () => {
  await assert.rejects(captureSelectedTab({ mediaDevices: {} }), /unavailable/);
});
