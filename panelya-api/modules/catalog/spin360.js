const { extractMediaAssetId } = require('../../services/mediaAssets');

function normalizeSpin360(value) {
  if (value == null) return null;
  const frames = value.frames;
  if (!Array.isArray(frames) || frames.length < 2 || frames.length > 72
    || value.frameCount !== frames.length || new Set(frames).size !== frames.length
    || value.poster !== frames[0]
    || !frames.every((url) => typeof url === 'string' && /^\/api\/media\//.test(url)
      && /\/detail$/.test(url) && extractMediaAssetId(url))) {
    throw Object.assign(new Error('360 derece seti sirali, benzersiz yonetilen gorseller ve ilk kare posteri gerektirir'), { status: 400 });
  }
  return { frameCount: frames.length, poster: frames[0], frames: [...frames] };
}

module.exports = { normalizeSpin360 };
