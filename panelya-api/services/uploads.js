const path = require('path');

function resolveUploadDir() {
  const raw = String(process.env.UPLOAD_DIR || '').trim();
  if (!raw) {
    return path.join(__dirname, '..', 'uploads');
  }

  // If absolute path, respect it as-is (common on Docker/Railway volumes).
  if (path.isAbsolute(raw)) {
    return raw;
  }

  // Relative values should be stable regardless of process.cwd().
  // We resolve them relative to the API package root.
  return path.resolve(path.join(__dirname, '..', raw));
}

module.exports = {
  resolveUploadDir,
};

