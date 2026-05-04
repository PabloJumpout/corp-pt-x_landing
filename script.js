const story = document.querySelector("#scrollStory");
const canvas = document.querySelector("#sequenceFrame");
const benefitsCopy = document.querySelector("#benefitsCopy");
const mobileRevealItems = [...document.querySelectorAll(".mobile-reveal-item")];
const sequence2MobileRevealItems = [...document.querySelectorAll(".sequence2-mobile-reveal-item")];
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
const SEQUENCE3_FRAME_COUNT = 151;
const SEQUENCE3_FRAMES = Array.from(
  { length: SEQUENCE3_FRAME_COUNT },
  (_, index) => `./assets/sequence3/frame-${String(index).padStart(4, "0")}.png`,
);

let timeline = [];
let assetMap = new Map();
let frameCache = new Map();
let pendingDecodes = new Map();
let queuedDecodes = new Set();
let decodeQueue = [];
let activeDecodes = 0;
let scrollProgress = 0;
let targetSequenceProgress = 0;
let visualSequenceProgress = 0;
let targetContentProgress = 0;
let visualContentProgress = 0;
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

function isMobileSequence() {
  return activeSequence === "mobile" || isMobileViewport();
}

function isMobileViewport() {
  return (
    document.documentElement.clientWidth <= MOBILE_BREAKPOINT ||
    window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches
  );
}

function getSequenceProgress(progress) {
  return isMobileSequence() ? clamp((progress - 0.06) / 0.82) : progress;
}

function getContentProgress(progress) {
  return isMobileSequence() ? clamp((progress - 0.76) / 0.18) : progress;
}

function shouldShowBenefits(progress) {
  return isMobileSequence() ? progress > 0.62 : progress > 0.64;
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
  const nextSequenceProgress = lerp(visualSequenceProgress, targetSequenceProgress, 0.28);
  const nextContentProgress = lerp(visualContentProgress, targetContentProgress, 0.22);
  visualSequenceProgress =
    Math.abs(nextSequenceProgress - targetSequenceProgress) < 0.001
      ? targetSequenceProgress
      : nextSequenceProgress;
  visualContentProgress =
    Math.abs(nextContentProgress - targetContentProgress) < 0.001
      ? targetContentProgress
      : nextContentProgress;

  document.documentElement.style.setProperty("--stage-progress", visualSequenceProgress.toFixed(4));
  document.documentElement.style.setProperty("--content-progress", visualContentProgress.toFixed(4));
  document.documentElement.style.setProperty("--nav-progress", clamp(scrollProgress / 0.18).toFixed(4));
  setFrame(visualSequenceProgress);
  benefitsCopy.classList.toggle("is-visible", shouldShowBenefits(scrollProgress));

  if (
    Math.abs(visualSequenceProgress - targetSequenceProgress) > 0.001 ||
    Math.abs(visualContentProgress - targetContentProgress) > 0.001 ||
    pendingDecodes.has(activeAssetId)
  ) {
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
  const nextSequenceProgress = getSequenceProgress(nextProgress);
  direction = nextSequenceProgress >= targetSequenceProgress ? 1 : -1;
  scrollProgress = nextProgress;
  targetSequenceProgress = nextSequenceProgress;
  targetContentProgress = getContentProgress(nextProgress);
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

const mobileRevealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      entry.target.classList.toggle("is-visible", entry.isIntersecting);
    });
  },
  {
    root: null,
    threshold: 0.22,
    rootMargin: "0px 0px -10% 0px",
  },
);

mobileRevealItems.forEach((item) => mobileRevealObserver.observe(item));

sequence2MobileRevealItems.forEach((item) => mobileRevealObserver.observe(item));

function createScrollSequence({ storyElement, canvasElement, revealItems, sources }) {
  const canvasContext = canvasElement.getContext("2d", { alpha: false });
  let sequenceTimeline = [];
  let sequenceFrameCache = new Map();
  let sequencePendingDecodes = new Map();
  let sequenceQueuedDecodes = new Set();
  let sequenceDecodeQueue = [];
  let sequenceActiveDecodes = 0;
  let sequenceActiveFrameIndex = -1;
  let sequenceActiveAssetId = "";
  let sequenceLastDrawable = null;
  let sequenceFocalX = 0.5;
  let sequenceDirection = 1;
  let sequenceScrollProgress = 0;
  let sequenceTargetProgress = 0;
  let sequenceVisualProgress = 0;
  let sequenceRenderRequested = false;
  let sequenceActiveName = "";
  let sequenceLoadingName = "";

  function getProgress() {
    const maxScroll = storyElement.offsetHeight - window.innerHeight;
    const top = storyElement.getBoundingClientRect().top;
    const progress = clamp(-top / Math.max(maxScroll, 1));

    if (isMobileViewport()) {
      return clamp((progress + 0.22) / 0.72);
    }

    return progress;
  }

  function getRevealProgress() {
    if (!sequenceTimeline.length) return 0;

    if (!isMobileViewport()) {
      return clamp((sequenceVisualProgress - 0.08) / 0.34);
    }

    const revealFrames = Math.min(50, sequenceTimeline.length);
    const revealStart = 1 - revealFrames / sequenceTimeline.length;
    return clamp((sequenceVisualProgress - revealStart) / Math.max(1 - revealStart, 0.001));
  }

  function getFocalX() {
    const value = getComputedStyle(canvasElement).getPropertyValue("--frame-x").trim();
    return clamp(Number.parseFloat(value || "0.5"), 0, 1);
  }

  function resize() {
    const rect = canvasElement.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    sequenceFocalX = getFocalX();

    if (canvasElement.width !== width || canvasElement.height !== height) {
      canvasElement.width = width;
      canvasElement.height = height;
      draw(true);
    }
  }

  function drawCoverFrame(drawable) {
    const imageWidth = drawable.width || drawable.naturalWidth;
    const imageHeight = drawable.height || drawable.naturalHeight;
    const outputWidth = canvasElement.width;
    const outputHeight = canvasElement.height;
    const imageRatio = imageWidth / imageHeight;
    const outputRatio = outputWidth / outputHeight;

    let sx = 0;
    let sy = 0;
    let sw = imageWidth;
    let sh = imageHeight;

    if (imageRatio > outputRatio) {
      sw = imageHeight * outputRatio;
      sx = (imageWidth - sw) * sequenceFocalX;
    } else {
      sh = imageWidth / outputRatio;
      sy = (imageHeight - sh) * 0.5;
    }

    canvasContext.clearRect(0, 0, outputWidth, outputHeight);
    canvasContext.drawImage(drawable, sx, sy, sw, sh, 0, 0, outputWidth, outputHeight);
  }

  function draw(force = false) {
    const asset = sequenceTimeline[sequenceActiveFrameIndex];
    const cached = asset ? sequenceFrameCache.get(asset.id) : null;
    const drawable = cached?.drawable || sequenceLastDrawable?.drawable;

    if (!drawable || (!force && cached?.drawable === sequenceLastDrawable?.drawable)) return;

    if (cached) {
      cached.lastUsed = performance.now();
      sequenceLastDrawable = cached;
    }

    drawCoverFrame(drawable);
    canvasElement.classList.add("is-ready");
  }

  function prune() {
    if (sequenceFrameCache.size <= MAX_CACHE_SIZE) return;

    const protectedIds = new Set();
    for (let offset = -PRELOAD_BEHIND; offset <= PRELOAD_AHEAD; offset += 1) {
      const asset = sequenceTimeline[sequenceActiveFrameIndex + offset * sequenceDirection];
      if (asset) protectedIds.add(asset.id);
    }
    protectedIds.add(sequenceActiveAssetId);

    [...sequenceFrameCache.entries()]
      .filter(([id]) => !protectedIds.has(id))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, sequenceFrameCache.size - MAX_CACHE_SIZE)
      .forEach(([id, entry]) => {
        entry.close?.();
        sequenceFrameCache.delete(id);
      });
  }

  function pumpQueue() {
    while (sequenceActiveDecodes < MAX_PARALLEL_DECODES && sequenceDecodeQueue.length) {
      const { asset } = sequenceDecodeQueue.shift();
      sequenceQueuedDecodes.delete(asset.id);

      if (asset.sequence !== sequenceActiveName) {
        continue;
      }

      sequenceActiveDecodes += 1;

      const decodePromise = decodeAsset(asset)
        .then((entry) => {
          if (asset.sequence !== sequenceActiveName) {
            entry.close?.();
            return;
          }

          sequenceFrameCache.set(asset.id, entry);
          prune();

          if (asset.id === sequenceActiveAssetId) {
            draw(true);
          }
        })
        .catch((error) => {
          console.warn(`Frame ${asset.id} failed to decode`, error);
        })
        .finally(() => {
          sequenceActiveDecodes -= 1;
          sequencePendingDecodes.delete(asset.id);
          pumpQueue();
        });

      sequencePendingDecodes.set(asset.id, decodePromise);
    }
  }

  function requestSequenceDecode(asset, priority = 0) {
    if (sequenceFrameCache.has(asset.id) || sequencePendingDecodes.has(asset.id)) return;

    if (sequenceQueuedDecodes.has(asset.id)) {
      const queued = sequenceDecodeQueue.find((item) => item.asset.id === asset.id);
      if (queued && priority < queued.priority) {
        queued.priority = priority;
        sequenceDecodeQueue.sort((a, b) => a.priority - b.priority);
      }
      return;
    }

    sequenceQueuedDecodes.add(asset.id);
    sequenceDecodeQueue.push({ asset, priority });
    sequenceDecodeQueue.sort((a, b) => a.priority - b.priority);
    pumpQueue();
  }

  function preload(frameIndex) {
    const forward = sequenceDirection >= 0;

    for (let offset = 0; offset <= PRELOAD_AHEAD; offset += 1) {
      const index = frameIndex + (forward ? offset : -offset);
      const asset = sequenceTimeline[index];
      if (asset) requestSequenceDecode(asset, offset);
    }

    for (let offset = 1; offset <= PRELOAD_BEHIND; offset += 1) {
      const index = frameIndex + (forward ? -offset : offset);
      const asset = sequenceTimeline[index];
      if (asset) requestSequenceDecode(asset, PRELOAD_AHEAD + offset);
    }
  }

  function setSequenceFrame(progress) {
    if (!sequenceTimeline.length) return;

    const nextIndex = Math.round(progress * (sequenceTimeline.length - 1));
    if (nextIndex === sequenceActiveFrameIndex && sequenceFrameCache.has(sequenceActiveAssetId)) return;

    sequenceActiveFrameIndex = nextIndex;
    const asset = sequenceTimeline[nextIndex];
    sequenceActiveAssetId = asset.id;

    if (sequenceFrameCache.has(asset.id)) {
      draw();
    } else {
      requestSequenceDecode(asset, -1000);
    }

    preload(nextIndex);
  }

  function updateRevealState() {
    const progress = getRevealProgress();
    const thresholds = isMobileViewport() ? [0.05, 0.18, 0.36, 0.54] : [0.02, 0.18, 0.34, 0.5];

    revealItems.forEach((item, index) => {
      item.classList.toggle("is-visible", progress >= thresholds[index]);
    });
  }

  function renderSequence() {
    sequenceRenderRequested = false;
    const nextProgress = lerp(sequenceVisualProgress, sequenceTargetProgress, 0.28);
    sequenceVisualProgress =
      Math.abs(nextProgress - sequenceTargetProgress) < 0.001 ? sequenceTargetProgress : nextProgress;

    setSequenceFrame(sequenceVisualProgress);
    updateRevealState();

    if (
      Math.abs(sequenceVisualProgress - sequenceTargetProgress) > 0.001 ||
      sequencePendingDecodes.has(sequenceActiveAssetId)
    ) {
      requestSequenceRender();
    }
  }

  function requestSequenceRender() {
    if (sequenceRenderRequested) return;
    sequenceRenderRequested = true;
    requestAnimationFrame(renderSequence);
  }

  function update() {
    const nextProgress = getProgress();
    sequenceDirection = nextProgress >= sequenceTargetProgress ? 1 : -1;
    sequenceScrollProgress = nextProgress;
    sequenceTargetProgress = sequenceScrollProgress;
    requestSequenceRender();
  }

  function buildSequenceTimeline(lottie, sequence) {
    const assets = lottie.assets
      .filter((asset) => asset.p?.startsWith("data:image"))
      .sort((a, b) => Number(a.id.replace("image_", "")) - Number(b.id.replace("image_", "")))
      .map((asset) => ({
        id: `${sequence}:${asset.id}`,
        rawId: asset.id,
        sequence,
        src: asset.p,
      }));

    const assetsByRawId = new Map(assets.map((asset) => [asset.rawId, asset]));
    const lottieTimeline = [];
    lottie.layers
      ?.filter((layer) => layer.ty === 2 && assetsByRawId.has(layer.refId))
      .sort((a, b) => a.ip - b.ip)
      .forEach((layer) => {
        const duration = Math.max(1, Math.round(layer.op - layer.ip));
        const asset = assetsByRawId.get(layer.refId);

        for (let index = 0; index < duration; index += 1) {
          lottieTimeline.push(asset);
        }
      });

    sequenceTimeline = lottieTimeline.length ? lottieTimeline : assets;
  }

  function getName() {
    return isMobileViewport() ? "mobile" : "desktop";
  }

  function clear() {
    sequenceFrameCache.forEach((entry) => entry.close?.());
    sequenceTimeline = [];
    sequenceFrameCache = new Map();
    sequencePendingDecodes = new Map();
    sequenceQueuedDecodes = new Set();
    sequenceDecodeQueue = [];
    sequenceActiveFrameIndex = -1;
    sequenceActiveAssetId = "";
    sequenceLastDrawable = null;
    sequenceScrollProgress = getProgress();
    sequenceTargetProgress = sequenceScrollProgress;
    sequenceVisualProgress = sequenceTargetProgress;
    canvasElement.classList.remove("is-ready");
    revealItems.forEach((item) => item.classList.remove("is-visible"));
  }

  async function load() {
    const sequence = getName();

    if (sequence === sequenceActiveName || sequence === sequenceLoadingName) {
      return;
    }

    sequenceLoadingName = sequence;
    sequenceActiveName = sequence;
    clear();

    try {
      const response = await fetch(sources[sequence]);
      const lottie = await response.json();

      if (sequence !== sequenceActiveName) return;

      buildSequenceTimeline(lottie, sequence);
      resize();

      if (sequenceTimeline.length) {
        sequenceActiveFrameIndex = 0;
        sequenceActiveAssetId = sequenceTimeline[0].id;
        requestSequenceDecode(sequenceTimeline[0], -1000);
        preload(0);
        update();
      }
    } finally {
      if (sequenceLoadingName === sequence) {
        sequenceLoadingName = "";
      }
    }
  }

  return { load, resize, update };
}

const sequence2Controller = createScrollSequence({
  storyElement: document.querySelector("#launchScenario"),
  canvasElement: document.querySelector("#sequence2Frame"),
  revealItems: [...document.querySelectorAll(".sequence2-reveal-item")],
  sources: {
    desktop: "./pt-x_sequence2-desktop.json",
    mobile: "./pt-x_sequence2-mobile.json",
  },
});

function createPngScrollSequence({ storyElement, canvasElement, frameSources }) {
  const canvasContext = canvasElement.getContext("2d", { alpha: true });
  const frames = frameSources.map((src, index) => ({
    id: `sequence3:${index}`,
    sequence: "sequence3",
    src,
  }));
  let imageCache = new Map();
  let pendingImages = new Map();
  let queuedImages = new Set();
  let imageQueue = [];
  let activeImageLoads = 0;
  let activeIndex = -1;
  let activeId = "";
  let lastEntry = null;
  let targetProgress = 0;
  let visualProgress = 0;
  let scrollDirection = 1;
  let renderQueued = false;

  function getProgress() {
    const maxScroll = storyElement.offsetHeight - window.innerHeight;
    const top = storyElement.getBoundingClientRect().top;
    return clamp(-top / Math.max(maxScroll, 1));
  }

  function getThemeProgress() {
    const rect = storyElement.getBoundingClientRect();

    if (rect.top > window.innerHeight) return 0;
    if (rect.bottom < 0) return 1;

    return visualProgress;
  }

  function resize() {
    const rect = canvasElement.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));

    if (canvasElement.width !== width || canvasElement.height !== height) {
      canvasElement.width = width;
      canvasElement.height = height;
      draw(true);
    }
  }

  function drawContainFrame(drawable) {
    const imageWidth = drawable.width || drawable.naturalWidth;
    const imageHeight = drawable.height || drawable.naturalHeight;
    const outputWidth = canvasElement.width;
    const outputHeight = canvasElement.height;
    const scale = Math.min(outputWidth / imageWidth, outputHeight / imageHeight);
    const width = imageWidth * scale;
    const height = imageHeight * scale;
    const x = (outputWidth - width) * 0.5;
    const y = (outputHeight - height) * 0.5;

    canvasContext.clearRect(0, 0, outputWidth, outputHeight);
    canvasContext.drawImage(drawable, x, y, width, height);
  }

  function draw(force = false) {
    const frame = frames[activeIndex];
    const cached = frame ? imageCache.get(frame.id) : null;
    const drawable = cached?.drawable || lastEntry?.drawable;

    if (!drawable || (!force && cached?.drawable === lastEntry?.drawable)) return;

    if (cached) {
      cached.lastUsed = performance.now();
      lastEntry = cached;
    }

    drawContainFrame(drawable);
    canvasElement.classList.add("is-ready");
  }

  function prune() {
    if (imageCache.size <= MAX_CACHE_SIZE) return;

    const protectedIds = new Set([activeId]);
    for (let offset = -PRELOAD_BEHIND; offset <= PRELOAD_AHEAD; offset += 1) {
      const frame = frames[activeIndex + offset * scrollDirection];
      if (frame) protectedIds.add(frame.id);
    }

    [...imageCache.entries()]
      .filter(([id]) => !protectedIds.has(id))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, imageCache.size - MAX_CACHE_SIZE)
      .forEach(([id, entry]) => {
        entry.close?.();
        if (entry === lastEntry) {
          lastEntry = null;
        }
        imageCache.delete(id);
      });
  }

  function pumpQueue() {
    while (activeImageLoads < MAX_PARALLEL_DECODES && imageQueue.length) {
      const { frame } = imageQueue.shift();
      queuedImages.delete(frame.id);
      activeImageLoads += 1;

      const loadPromise = decodeAsset(frame)
        .then((entry) => {
          imageCache.set(frame.id, entry);
          prune();

          if (frame.id === activeId) {
            draw(true);
          }
        })
        .catch((error) => {
          console.warn(`PNG frame ${frame.id} failed to decode`, error);
        })
        .finally(() => {
          activeImageLoads -= 1;
          pendingImages.delete(frame.id);
          pumpQueue();
        });

      pendingImages.set(frame.id, loadPromise);
    }
  }

  function requestImage(frame, priority = 0) {
    if (imageCache.has(frame.id) || pendingImages.has(frame.id)) return;

    if (queuedImages.has(frame.id)) {
      const queued = imageQueue.find((item) => item.frame.id === frame.id);
      if (queued && priority < queued.priority) {
        queued.priority = priority;
        imageQueue.sort((a, b) => a.priority - b.priority);
      }
      return;
    }

    queuedImages.add(frame.id);
    imageQueue.push({ frame, priority });
    imageQueue.sort((a, b) => a.priority - b.priority);
    pumpQueue();
  }

  function preload(frameIndex) {
    const forward = scrollDirection >= 0;

    for (let offset = 0; offset <= PRELOAD_AHEAD; offset += 1) {
      const frame = frames[frameIndex + (forward ? offset : -offset)];
      if (frame) requestImage(frame, offset);
    }

    for (let offset = 1; offset <= PRELOAD_BEHIND; offset += 1) {
      const frame = frames[frameIndex + (forward ? -offset : offset)];
      if (frame) requestImage(frame, PRELOAD_AHEAD + offset);
    }
  }

  function setFrame(progress) {
    const nextIndex = Math.round(progress * (frames.length - 1));
    if (nextIndex === activeIndex && imageCache.has(activeId)) return;

    activeIndex = nextIndex;
    const frame = frames[nextIndex];
    activeId = frame.id;

    if (imageCache.has(frame.id)) {
      draw();
    } else {
      requestImage(frame, -1000);
    }

    preload(nextIndex);
  }

  function render() {
    renderQueued = false;
    const nextProgress = lerp(visualProgress, targetProgress, 0.24);
    visualProgress = Math.abs(nextProgress - targetProgress) < 0.001 ? targetProgress : nextProgress;

    document.documentElement.style.setProperty("--sequence3-progress", visualProgress.toFixed(4));
    document.body.classList.toggle("is-light-theme", getThemeProgress() > 0.5);
    setFrame(visualProgress);

    if (Math.abs(visualProgress - targetProgress) > 0.001 || pendingImages.has(activeId)) {
      requestRender();
    }
  }

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  function update() {
    const nextProgress = getProgress();
    scrollDirection = nextProgress >= targetProgress ? 1 : -1;
    targetProgress = nextProgress;
    requestRender();
  }

  function load() {
    resize();
    if (activeIndex === -1 && frames.length) {
      activeIndex = 0;
      activeId = frames[0].id;
      requestImage(frames[0], -1000);
      preload(0);
    }
    update();
  }

  return { load, resize, update };
}

const sequence3Controller = createPngScrollSequence({
  storyElement: document.querySelector("#lightTransition"),
  canvasElement: document.querySelector("#sequence3Frame"),
  frameSources: SEQUENCE3_FRAMES,
});

function getSequenceName() {
  return isMobileViewport() ? "mobile" : "desktop";
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
  targetSequenceProgress = getSequenceProgress(scrollProgress);
  visualSequenceProgress = targetSequenceProgress;
  targetContentProgress = getContentProgress(scrollProgress);
  visualContentProgress = targetContentProgress;
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

window.addEventListener(
  "scroll",
  () => {
    updateTargetProgress();
    sequence2Controller.update();
    sequence3Controller.update();
  },
  { passive: true },
);
window.addEventListener("resize", () => {
  loadSequence().catch((error) => {
    console.error("Sequence loading failed", error);
  });
  sequence2Controller.load().catch((error) => {
    console.error("Second sequence loading failed", error);
  });
  sequence3Controller.load();
  updateTargetProgress();
  sequence2Controller.update();
  sequence3Controller.update();
  resizeCanvas();
  sequence2Controller.resize();
  sequence3Controller.resize();
});

loadSequence().catch((error) => {
  console.error("Sequence loading failed", error);
});

sequence2Controller.load().catch((error) => {
  console.error("Second sequence loading failed", error);
});

sequence3Controller.load();
