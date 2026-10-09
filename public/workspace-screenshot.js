/**
 * User-approved tab screenshot. No server-side page navigation, arbitrary URL
 * fetching or silent screen recording. The browser itself asks which tab to
 * share; only one still frame is kept, locally as an attachment draft.
 */
export function screenshotSize(width, height, maxWidth = 1920, maxHeight = 1080) {
  if (![width, height, maxWidth, maxHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Screenshot dimensions are unavailable.');
  }
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function captureSelectedTab({
  mediaDevices = globalThis.navigator?.mediaDevices,
  documentRef = globalThis.document,
  createFile = (parts, name, options) => new File(parts, name, options),
  date = new Date()
} = {}) {
  if (typeof mediaDevices?.getDisplayMedia !== 'function') {
    throw new Error('Tab capture is unavailable in this browser. Use HTTPS or localhost, or attach an existing screenshot.');
  }
  if (!documentRef?.createElement) throw new Error('A browser document is required to capture the selected tab.');
  let stream = null;
  let video = null;
  try {
    // Display capture requires a user gesture and prompts the user to select a
    // tab. It is intentionally not an automatic recorder of other applications.
    stream = await mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: false,
      preferCurrentTab: true
    });
    video = documentRef.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error('The chosen tab did not provide a video frame.');
    }
    const { width, height } = screenshotSize(video.videoWidth, video.videoHeight);
    const canvas = documentRef.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas capture is not supported by this browser.');
    context.drawImage(video, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(
      result => result ? resolve(result) : reject(new Error('Screenshot encoding failed.')),
      'image/png'
    ));
    const stamp = date instanceof Date && !Number.isNaN(date.valueOf())
      ? date.toISOString().replace(/[:.]/g, '-') : 'captured';
    return createFile([blob], 'workspace-ui-' + stamp + '.png', { type: 'image/png' });
  } finally {
    for (const track of stream?.getTracks?.() ?? []) track.stop();
    if (video) video.srcObject = null;
  }
}
