// Shrinks a picture on the phone before it is sent: decode it, draw it on a canvas no bigger than
// maxEdge on its longest side (on white, so transparent PNGs don't turn black) and re-encode as JPEG.
// Throws if the browser can't decode the picture (for example EMF, or HEIC where unsupported).

export async function toJpeg(blob, maxEdge, quality = 0.82) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    if (!sourceWidth || !sourceHeight) throw new Error('empty image');
    const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    canvas.width = 0; // release the canvas memory right away (iOS is strict about it)
    canvas.height = 0;
    if (!jpeg) throw new Error('could not encode JPEG');
    return { blob: jpeg, width, height, sourceWidth, sourceHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}
