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
const SESSION_REQUIRED_COUNT = Math.max(
  1,
  Number(process.env.SESSION_REQUIRED_COUNT || SESSION_FILES.length),
);

const managedChildren = [];

function log(message) {
  process.stdout.write(`[api-bootstrap] ${message}\n`);
}

function spawnManagedProcess(prefix, filePath, options = {}) {
  const child = spawn("node", [filePath], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${prefix}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${prefix}] ${chunk}`);
  });

  managedChildren.push(child);
  child.once("exit", (code, signal) => {
    log(`${prefix} exited code=${code} signal=${signal}`);
  });

  return child;
}

async function waitForSessionHeartbeats(requiredCount) {
  let waitRound = 0;

  while (true) {
    waitRound += 1;
    const heartbeats = await listSessionHeartbeats();
    const now = Date.now();
    const activeHeartbeats = heartbeats.filter((entry) => {
      return (
        entry &&
        entry.nameService &&
        entry.sessionId &&
        entry.stampTime &&
        now - Number(entry.stampTime) <= SESSION_HEARTBEAT_MAX_AGE_MS
      );
    });

    if (activeHeartbeats.length >= requiredCount) {
      return activeHeartbeats;
    }

    log(
      `waiting for session heartbeats... round=${waitRound} active=${activeHeartbeats.length}/${requiredCount}`,
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
  const requiredSessionCount = Math.min(
    SESSION_FILES.length,
    SESSION_REQUIRED_COUNT,
  );

  await clearSessionHeartbeats();
  log("starting session processes");
  SESSION_FILES.forEach((filePath, index) => {
    spawnManagedProcess(`session-${index + 1}`, filePath);
  });

  log(
    `waiting for ${requiredSessionCount} session heartbeat(s) before starting server`,
  );
  const activeHeartbeats = await waitForSessionHeartbeats(requiredSessionCount);
  log(
    `session bootstrap is ready: ${activeHeartbeats
      .map((entry) => entry.nameService)
      .join(", ")}`,
  );

  log("starting api server");
  const apiChild = spawnManagedProcess("api", "server.js", {
    env: {
      SCREENSHOT_INTEGRATED_ENABLED: "false",
    },
  });
  await waitForServerReady(apiChild);
  log("api bootstrap is ready");
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    process.stderr.write(`[api-bootstrap] shutdown failed: ${error.message}\n`);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    process.stderr.write(`[api-bootstrap] shutdown failed: ${error.message}\n`);
    process.exit(1);
  });
});

main().catch((error) => {
  process.stderr.write(`[api-bootstrap] fatal: ${error.message}\n`);
  shutdown("fatal").catch(() => {
    process.exit(1);
  });
});
