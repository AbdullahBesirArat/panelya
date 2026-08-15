function instagramError(code, status, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details && status < 500) error.details = details;
  return error;
}

module.exports = { instagramError };
