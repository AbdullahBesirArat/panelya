const ACTIVITY_LOG_WRITER_CAPABILITY = 'tenant-aware-v1';

function capabilities() {
  return { activityLogWriter: ACTIVITY_LOG_WRITER_CAPABILITY };
}

module.exports = { ACTIVITY_LOG_WRITER_CAPABILITY, capabilities };
