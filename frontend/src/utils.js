// Money is always integer cents past this boundary - see the "Eighth
// round" section in the README for why. These two functions are the only
// place euros and cents ever convert into each other on the frontend.
export function formatEuro(cents) {
  return `\u20ac${(cents / 100).toFixed(2)}`;
}

export function eurosToCents(eurosString) {
  const n = Number(eurosString);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// Polls fetchFn a few times until checkFn passes or attempts run out - used
// to pick up the AI auto-reply, which now arrives after the send request
// has already returned (see backend/messages/controller.js).
export async function pollUntil(fetchFn, checkFn, { attempts = 5, delayMs = 1200 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const result = await fetchFn();
    if (checkFn(result)) return result;
  }
  return null; // gave up - the AI reply (or a failure) will still show up next time the thread is opened
}

export function compressImage(file, maxDim = 640, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not load image"));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
