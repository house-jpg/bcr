const mongoose = require("mongoose");

const {
  screenshotClaimCollection,
  screenshotClaimRetentionMs,
} = require("./config");
const { predictResultSchema } = require("../config/schema/index.schema");
const { buildRoundKey, getLatestRound } = require("./utils");
const { log } = require("./logger");

let screenshotClaims = null;

function getScreenshotClaimsCollection() {
  if (!screenshotClaims) {
    screenshotClaims = mongoose.connection.collection(screenshotClaimCollection);
  }

  return screenshotClaims;
}

async function cleanupOldScreenshotClaims() {
  if (!Number.isFinite(screenshotClaimRetentionMs) || screenshotClaimRetentionMs <= 0) {
    return { deletedCount: 0 };
  }

  const collection = getScreenshotClaimsCollection();
  const cutoff = new Date(Date.now() - screenshotClaimRetentionMs);
  const result = await collection.deleteMany({
    createdAt: { $lt: cutoff },
  });

  if (result.deletedCount > 0) {
    log(
      `Cleaned ${result.deletedCount} old screenshot claim(s) older than ${cutoff.toISOString()}`,
    );
  }

  return result;
}

async function connectMongo() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  await mongoose.connect(process.env.URL_CONNECT_MONGODB, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    authSource: "admin",
  });

  await getScreenshotClaimsCollection().createIndex(
    { latestKey: 1 },
    { unique: true },
  );
  await getScreenshotClaimsCollection().createIndex(
    { createdAt: 1 },
    {
      expireAfterSeconds: Math.max(
        1,
        Math.floor(screenshotClaimRetentionMs / 1000),
      ),
    },
  );

  await cleanupOldScreenshotClaims();

  log("MongoDB connected");
  return mongoose.connection;
}

async function disconnectMongo() {
  await mongoose.disconnect().catch(() => {});
}

async function getLatestTableSnapshot(tableName) {
  const doc = await predictResultSchema
    .findOne({ tableName })
    .select("tableName totalRound statusGame")
    .lean();

  if (!doc) {
    return null;
  }

  return {
    tableName: doc.tableName,
    statusGame: doc.statusGame || "",
    latestKey: buildRoundKey(doc),
    latestRound: getLatestRound(doc.totalRound),
    totalRoundCount: Array.isArray(doc.totalRound) ? doc.totalRound.length : 0,
    hasRounds: Array.isArray(doc.totalRound) && doc.totalRound.length > 0,
  };
}

function watchTableChanges(onChange) {
  return predictResultSchema.watch(
    [
      {
        $match: {
          operationType: { $in: ["insert", "update", "replace"] },
        },
      },
    ],
    {
      fullDocument: "updateLookup",
    },
  ).on("change", onChange);
}

async function claimScreenshotResult({
  latestKey,
  tableName,
  filePath,
  workerId,
}) {
  const collection = getScreenshotClaimsCollection();

  try {
    await collection.insertOne({
      latestKey,
      tableName,
      filePath,
      workerId,
      createdAt: new Date(),
    });

    return { won: true };
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await collection.findOne(
        { latestKey },
        { projection: { _id: 0, latestKey: 1, workerId: 1, filePath: 1, createdAt: 1 } },
      );
      return { won: false, existing };
    }

    throw error;
  }
}

module.exports = {
  claimScreenshotResult,
  connectMongo,
  disconnectMongo,
  getLatestTableSnapshot,
  cleanupOldScreenshotClaims,
  watchTableChanges,
};
