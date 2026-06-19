const fs = require("fs").promises;
const path = require("path");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRoundKey(tableDoc) {
  const rounds = Array.isArray(tableDoc?.totalRound) ? tableDoc.totalRound : [];
  if (rounds.length === 0) {
    return `${tableDoc?.tableName || "unknown"}:empty`;
  }

  const latestRound = getLatestRound(rounds);

  return [
    tableDoc.tableName,
    Number(latestRound?.stampTime || 0),
    String(latestRound?.roadFormat || latestRound?.roundFormat || "unknown"),
    Number(latestRound?.id || 0),
  ].join(":");
}

function getLatestRound(rounds) {
  const list = Array.isArray(rounds) ? rounds : [];

  return list.reduce((latest, current) => {
    if (!latest) return current;
    if (Number(current.stampTime) > Number(latest.stampTime)) return current;
    if (
      Number(current.stampTime) === Number(latest.stampTime) &&
      Number(current.id || 0) > Number(latest.id || 0)
    ) {
      return current;
    }

    return latest;
  }, null);
}

function getRoundResultLabel(roundFormat) {
  switch (String(roundFormat || "").toUpperCase()) {
    case "P":
      return "TAY CON";
    case "B":
      return "NHA CAI";
    case "T":
      return "TIE";
    default:
      return "Unknown";
  }
}

function getBetDisplay(roundFormat) {
  switch (String(roundFormat || "").toUpperCase()) {
    case "P":
      return "TAY CON 🔵";
    case "B":
      return "NHÀ CÁI 🔴";
    case "T":
      return "TIE ⚪";
    default:
      return "KHÔNG XÁC ĐỊNH";
  }
}

function buildRoundKeyFromRound(tableName, round) {
  return [
    tableName,
    Number(round?.stampTime || 0),
    String(round?.roadFormat || round?.roundFormat || "unknown"),
    Number(round?.id || 0),
  ].join(":");
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function moveFile(sourcePath, targetPath) {
  await ensureDir(path.dirname(targetPath));
  await fs.rename(sourcePath, targetPath);
}

async function removeFileIfExists(filePath) {
  await fs.unlink(filePath).catch(() => {});
}

module.exports = {
  sleep,
  buildRoundKey,
  buildRoundKeyFromRound,
  getBetDisplay,
  getLatestRound,
  getRoundResultLabel,
  ensureDir,
  moveFile,
  removeFileIfExists,
};
