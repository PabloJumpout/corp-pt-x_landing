const story = document.querySelector("#scrollStory");
const canvas = document.querySelector("#sequenceFrame");
const benefitsCopy = document.querySelector("#benefitsCopy");
const context = canvas.getContext("2d", { alpha: false });

const clamp = (value, min = 0, max = 1) => Math.min(Math.max(value, min), max);
const lerp = (from, to, amount) => from + (to - from) * amount;

const MAX_CACHE_SIZE = 30;
const MAX_PARALLEL_DECODES = 4;
const PRELOAD_AHEAD = 18;
const PRELOAD_BEHIND = 8;
const MOBILE_BREAKPOINT = 768;
const SEQUENCES = {
  desktop: "./pt-x_1.json",
  mobile: "./pt-x_1-mobile.json",
};

let timeline = [];
let assetMap = new Map();
let frameCache = new Map();
let pendingDecodes = new Map();
let queuedDecodes = new Set();
let decodeQueue = [];
let activeDecodes = 0;
let targetProgress = 0;
let visualProgress = 0;
let activeFrameIndex = -1;
let activeAssetId = "";
let lastDrawable = null;
let frameFocalX = 0.5;
let direction = 1;
let renderRequested = false;
let activeSequence = "";
let loadingSequence = "";

function getStoryProgress() {
  const maxScroll = story.offsetHeight - window.innerHeight;
  const top = story.getBoundingClientRect().top;
  return clamp(-top / Math.max(maxScroll, 1));
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  frameFocalX = getFrameFocalX();

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    drawActiveFrame(true);
  }
}

function getFrameFocalX() {
  const value = getComputedStyle(canvas).getPropertyValue("--frame-x").trim();
  return clamp(Number.parseFloat(value || "0.5"), 0, 1);
}

function drawCover(drawable) {
  const imageWidth = drawable.width || drawable.naturalWidth;
  const imageHeight = drawable.height || drawable.naturalHeight;
  const outputWidth = canvas.width;
  const outputHeight = canvas.height;
  const imageRatio = imageWidth / imageHeight;
  const outputRatio = outputWidth / outputHeight;

  let sx = 0;
  let sy = 0;
  let sw = imageWidth;
  let sh = imageHeight;

  if (imageRatio > outputRatio) {
    sw = imageHeight * outputRatio;
    sx = (imageWidth - sw) * frameFocalX;
  } else {
    sh = imageWidth / outputRatio;
    sy = (imageHeight - sh) * 0.5;
  }

  context.clearRect(0, 0, outputWidth, outputHeight);
  context.drawImage(drawable, sx, sy, sw, sh, 0, 0, outputWidth, outputHeight);
}

function drawActiveFrame(force = false) {
  const asset = timeline[activeFrameIndex];
  const cached = asset ? frameCache.get(asset.id) : null;
  const drawable = cached?.drawable || lastDrawable?.drawable;

  if (!drawable || (!force && cached?.drawable === lastDrawable?.drawable)) return;

  if (cached) {
    cached.lastUsed = performance.now();
    lastDrawable = cached;
  }

  drawCover(drawable);
  canvas.classList.add("is-ready");
}

function setFrame(progress) {
  if (!timeline.length) return;

  const nextIndex = Math.round(progress * (timeline.length - 1));
  if (nextIndex === activeFrameIndex && frameCache.has(activeAssetId)) return;

  activeFrameIndex = nextIndex;
  const asset = timeline[nextIndex];
  activeAssetId = asset.id;

  if (frameCache.has(asset.id)) {
    drawActiveFrame();
  } else {
    requestDecode(asset, -1000);
  }

  preloadNear(nextIndex);
}

function render() {
  renderRequested = false;
  const nextProgress = lerp(visualProgress, targetProgress, 0.28);
  visualProgress = Math.abs(nextProgress - targetProgress) < 0.001 ? targetProgress : nextProgress;

  document.documentElement.style.setProperty("--stage-progress", visualProgress.toFixed(4));
  document.documentElement.style.setProperty("--nav-progress", clamp(targetProgress / 0.18).toFixed(4));
  setFrame(visualProgress);
  benefitsCopy.classList.toggle("is-visible", targetProgress > 0.64);

  if (Math.abs(visualProgress - targetProgress) > 0.001 || pendingDecodes.has(activeAssetId)) {
    requestRender();
  }
}

function requestRender() {
  if (renderRequested) return;
  renderRequested = true;
  requestAnimationFrame(render);
}

function updateTargetProgress() {
  const nextProgress = getStoryProgress();
  direction = nextProgress >= targetProgress ? 1 : -1;
  targetProgress = nextProgress;
  requestRender();
}

function requestDecode(asset, priority = 0) {
  if (frameCache.has(asset.id) || pendingDecodes.has(asset.id)) return;

  if (queuedDecodes.has(asset.id)) {
    const queued = decodeQueue.find((item) => item.asset.id === asset.id);
    if (queued && priority < queued.priority) {
      queued.priority = priority;
      decodeQueue.sort((a, b) => a.priority - b.priority);
    }
    return;
  }

  queuedDecodes.add(asset.id);
  decodeQueue.push({ asset, priority });
  decodeQueue.sort((a, b) => a.priority - b.priority);
  pumpDecodeQueue();
}

function pumpDecodeQueue() {
  while (activeDecodes < MAX_PARALLEL_DECODES && decodeQueue.length) {
    const { asset } = decodeQueue.shift();
    queuedDecodes.delete(asset.id);

    if (asset.sequence !== activeSequence) {
      continue;
    }

    activeDecodes += 1;

    const decodePromise = decodeAsset(asset)
      .then((entry) => {
        if (asset.sequence !== activeSequence) {
          entry.close?.();
          return;
        }

        frameCache.set(asset.id, entry);
        pruneCache();

        if (asset.id === activeAssetId) {
          drawActiveFrame(true);
        }
      })
      .catch((error) => {
        console.warn(`Frame ${asset.id} failed to decode`, error);
      })
      .finally(() => {
        activeDecodes -= 1;
        pendingDecodes.delete(asset.id);
        pumpDecodeQueue();
      });

    pendingDecodes.set(asset.id, decodePromise);
  }
}

function decodeAsset(asset) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = async () => {
      try {
        const drawable = window.createImageBitmap ? await createImageBitmap(image) : image;
        resolve({
          close: drawable.close?.bind(drawable),
          drawable,
          lastUsed: performance.now(),
        });
      } catch {
        resolve({
          close: null,
          drawable: image,
          lastUsed: performance.now(),
        });
      }
    };
    image.onerror = reject;
    image.src = asset.src;
  });
}

function preloadNear(frameIndex) {
  const forward = direction >= 0;

  for (let offset = 0; offset <= PRELOAD_AHEAD; offset += 1) {
    const index = frameIndex + (forward ? offset : -offset);
    const asset = timeline[index];
    if (asset) requestDecode(asset, offset);
  }

  for (let offset = 1; offset <= PRELOAD_BEHIND; offset += 1) {
    const index = frameIndex + (forward ? -offset : offset);
    const asset = timeline[index];
    if (asset) requestDecode(asset, PRELOAD_AHEAD + offset);
  }
}

function pruneCache() {
  if (frameCache.size <= MAX_CACHE_SIZE) return;

  const protectedIds = new Set();
  for (let offset = -PRELOAD_BEHIND; offset <= PRELOAD_AHEAD; offset += 1) {
    const asset = timeline[activeFrameIndex + offset * direction];
    if (asset) protectedIds.add(asset.id);
  }
  protectedIds.add(activeAssetId);

  [...frameCache.entries()]
    .filter(([id]) => !protectedIds.has(id))
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    .slice(0, frameCache.size - MAX_CACHE_SIZE)
    .forEach(([id, entry]) => {
      entry.close?.();
      frameCache.delete(id);
    });
}

function buildTimeline(lottie, sequence) {
  const assets = lottie.assets
    .filter((asset) => asset.p?.startsWith("data:image"))
    .sort((a, b) => Number(a.id.replace("image_", "")) - Number(b.id.replace("image_", "")))
    .map((asset) => ({
      id: `${sequence}:${asset.id}`,
      rawId: asset.id,
      sequence,
      src: asset.p,
    }));

  assetMap = new Map(assets.map((asset) => [asset.rawId, asset]));

  const lottieTimeline = [];
  lottie.layers
    ?.filter((layer) => layer.ty === 2 && assetMap.has(layer.refId))
    .sort((a, b) => a.ip - b.ip)
    .forEach((layer) => {
      const duration = Math.max(1, Math.round(layer.op - layer.ip));
      const asset = assetMap.get(layer.refId);

      for (let index = 0; index < duration; index += 1) {
        lottieTimeline.push(asset);
      }
    });

  timeline = lottieTimeline.length ? lottieTimeline : assets;
}

function getSequenceName() {
  return window.innerWidth <= MOBILE_BREAKPOINT ? "mobile" : "desktop";
}

function clearSequenceState() {
  frameCache.forEach((entry) => entry.close?.());
  timeline = [];
  assetMap = new Map();
  frameCache = new Map();
  pendingDecodes = new Map();
  queuedDecodes = new Set();
  decodeQueue = [];
  activeFrameIndex = -1;
  activeAssetId = "";
  lastDrawable = null;
  canvas.classList.remove("is-ready");
}

async function loadSequence() {
  const sequence = getSequenceName();

  if (sequence === activeSequence || sequence === loadingSequence) {
    return;
  }

  loadingSequence = sequence;
  activeSequence = sequence;
  clearSequenceState();

  try {
    const response = await fetch(SEQUENCES[sequence]);
    const lottie = await response.json();

    if (sequence !== activeSequence) return;

    buildTimeline(lottie, sequence);
    resizeCanvas();

    if (timeline.length) {
      activeFrameIndex = 0;
      activeAssetId = timeline[0].id;
      requestDecode(timeline[0], -1000);
      preloadNear(0);
      updateTargetProgress();
    }
  } finally {
    if (loadingSequence === sequence) {
      loadingSequence = "";
    }
  }
}

window.addEventListener("scroll", updateTargetProgress, { passive: true });
window.addEventListener("resize", () => {
  loadSequence().catch((error) => {
    console.error("Sequence loading failed", error);
  });
  updateTargetProgress();
  resizeCanvas();
});

loadSequence().catch((error) => {
  console.error("Sequence loading failed", error);
});
