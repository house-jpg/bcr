const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const {
  clearSessionHeartbeats,
  listSessionHeartbeats,
} = require("../servicePuppeteer/sessionHeartbeat");

const SESSION_FILES = [
  "servicePuppeteer/session.js",
  "servicePuppeteer/session2.js",
  "servicePuppeteer/session3.js",
  "servicePuppeteer/session4.js",
  "servicePuppeteer/session5.js",
];

const SESSION_HEARTBEAT_MAX_AGE_MS = Number(
  process.env.SESSION_HEARTBEAT_MAX_AGE_MS || 900000,
);
const SESSION_POLL_INTERVAL_MS = Number(
  process.env.SESSION_POLL_INTERVAL_MS || 3000,
);
const SCREENSHOT_TRIGGER = String(process.env.TRIGGER || "class")
  .trim()
  .toLowerCase();

const managedChildren = [];

function log(message) {
  process.stdout.write(`[pipeline] ${message}\n`);
}

function attachPrefixedLogs(child, prefix) {
  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${prefix}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${prefix}] ${chunk}`);
  });
}

function spawnManagedProcess(prefix, filePath, options = {}) {
  const child = spawn("node", [filePath], {
    cwd: path.resolve(__dirname, ".."),
    env: options.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (options.pipeLogs) {
    attachPrefixedLogs(child, prefix);
  }
  managedChildren.push(child);

  child.once("exit", (code, signal) => {
    log(`${prefix} exited code=${code} signal=${signal}`);
  });

  return child;
}

async function waitForAnySessionHeartbeat() {
  let waitRound = 0;

  while (true) {
    waitRound += 1;
    const heartbeats = await listSessionHeartbeats();
    const now = Date.now();
    const activeHeartbeat = heartbeats.find((entry) => {
      return (
        entry &&
        entry.sessionId &&
        entry.stampTime &&
        now - Number(entry.stampTime) <= SESSION_HEARTBEAT_MAX_AGE_MS
      );
    });

    if (activeHeartbeat) {
      return activeHeartbeat;
    }

    log(
      `waiting for session heartbeat... round=${waitRound} found=${heartbeats.length}`,
    );
    await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_INTERVAL_MS));
  }
}

async function waitForServerReady(apiChild) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const handleStdout = (chunk) => {
      const text = String(chunk || "");
      if (text.includes("Running server http://localhost:")) {
        settled = true;
        apiChild.stdout.off("data", handleStdout);
        resolve();
      }
    };

    apiChild.stdout.on("data", handleStdout);
    apiChild.once("exit", (code) => {
      if (!settled) {
        reject(new Error(`API exited before ready with code ${code}`));
      }
    });
  });
}

async function shutdown(signal) {
  log(`received ${signal}, stopping managed processes`);

  await Promise.allSettled(
    managedChildren.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }

          child.once("exit", () => resolve());
          child.kill("SIGTERM");
        }),
    ),
  );

  process.exit(0);
}

async function main() {
  if (SCREENSHOT_TRIGGER === "api") {
    await clearSessionHeartbeats();
    log("starting session processes");
    SESSION_FILES.forEach((filePath, index) => {
      spawnManagedProcess(`session-${index + 1}`, filePath, { pipeLogs: false });
    });

    log("waiting for first available session heartbeat");
    const heartbeat = await waitForAnySessionHeartbeat();
    log(`session is ready from ${heartbeat.nameService}`);
  } else {
    log(`TRIGGER=${SCREENSHOT_TRIGGER}: skip session bootstrap`);
  }

  if (SCREENSHOT_TRIGGER === "api") {
    log("starting api server");
    const apiChild = spawnManagedProcess("api", "server.js", {
      env: {
        ...process.env,
        SCREENSHOT_INTEGRATED_ENABLED: "false",
      },
      pipeLogs: false,
    });
    await waitForServerReady(apiChild);
  } else {
    log(`TRIGGER=${SCREENSHOT_TRIGGER}: skip api server bootstrap`);
  }

  log("starting telegram bot");
  spawnManagedProcess("telegram-bot", "telegramBot/index.js", { pipeLogs: true });
  log("pipeline is ready");
  log(
    SCREENSHOT_TRIGGER === "api"
      ? "session/api logs are muted here; configure table in the admin panel, then use /start to run the bot and see screenshot flow logs"
      : "session and api bootstrap are disabled for class trigger; configure table in the admin panel, then use /start to run the bot and see screenshot flow logs",
  );
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    process.stderr.write(`[pipeline] shutdown failed: ${error.message}\n`);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    process.stderr.write(`[pipeline] shutdown failed: ${error.message}\n`);
    process.exit(1);
  });
});

main().catch((error) => {
  process.stderr.write(`[pipeline] fatal: ${error.message}\n`);
  shutdown("fatal").catch(() => {
    process.exit(1);
  });
});
