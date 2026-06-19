const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { ScreenshotWatcher } = require("./watcher");
const { log } = require("./logger");

async function main() {
  const watcher = new ScreenshotWatcher();

  const shutdown = async (signal) => {
    log(`Received ${signal}, shutting down`);
    await watcher.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      log(`Shutdown failed: ${error.message}`);
      process.exit(1);
    });
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      log(`Shutdown failed: ${error.message}`);
      process.exit(1);
    });
  });

  try {
    await watcher.start();
  } catch (error) {
    log(`Watcher failed to start: ${error.message}`);
    await watcher.shutdown();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
