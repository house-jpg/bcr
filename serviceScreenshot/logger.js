function log(message, meta) {
  const timestamp = new Date().toISOString();
  if (meta) {
    console.log(`[SCREENSHOT-WATCHER] ${timestamp} ${message}`, meta);
    return;
  }

  console.log(`[SCREENSHOT-WATCHER] ${timestamp} ${message}`);
}

module.exports = { log };
