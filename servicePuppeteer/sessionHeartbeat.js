const fs = require("fs").promises;
const path = require("path");

const SESSION_STATE_DIR = path.resolve(__dirname, "../runtime/session-state");

async function ensureSessionStateDir() {
  await fs.mkdir(SESSION_STATE_DIR, { recursive: true });
}

function buildSessionStatePath(nameService) {
  return path.join(SESSION_STATE_DIR, `${String(nameService || "unknown")}.json`);
}

async function persistSessionHeartbeat(payload = {}) {
  const { nameService } = payload;

  if (!nameService) {
    return;
  }

  await ensureSessionStateDir();
  await fs.writeFile(
    buildSessionStatePath(nameService),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
}

async function listSessionHeartbeats() {
  await ensureSessionStateDir();

  const fileNames = await fs.readdir(SESSION_STATE_DIR).catch(() => []);
  const entries = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .map(async (fileName) => {
        try {
          const filePath = path.join(SESSION_STATE_DIR, fileName);
          const content = await fs.readFile(filePath, "utf8");
          return JSON.parse(content);
        } catch (_error) {
          return null;
        }
      }),
  );

  return entries.filter(Boolean);
}

async function clearSessionHeartbeats() {
  await ensureSessionStateDir();

  const fileNames = await fs.readdir(SESSION_STATE_DIR).catch(() => []);
  await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .map((fileName) =>
        fs.unlink(path.join(SESSION_STATE_DIR, fileName)).catch(() => {}),
      ),
  );
}

module.exports = {
  SESSION_STATE_DIR,
  clearSessionHeartbeats,
  persistSessionHeartbeat,
  listSessionHeartbeats,
};
