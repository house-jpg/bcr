const { sendTelegramPhoto } = require("../utilities/request");
const {
  getBetDisplay,
  removeFileIfExists,
} = require("../serviceScreenshot/utils");

const BET_INIT_AMOUNT = Number(process.env.SCREENSHOT_BET_INIT_AMOUNT || 5000);

function pickRandomBetSide() {
  return Math.random() < 0.5 ? "B" : "P";
}

function formatAmountK(amount) {
  return `${Number(amount || 0)}K`;
}

function resolveRoadFormat(snapshot) {
  return String(snapshot.latestRound?.roadFormat || "").toUpperCase();
}

function resolveRoundFormatFromTriggerWinner(triggerWinner) {
  const normalized = String(triggerWinner || "").toUpperCase();

  if (normalized === "P" || normalized === "B" || normalized === "T") {
    return normalized;
  }

  return "UNKNOWN";
}

function buildBetPayload(roundFormat, state) {
  const normalizedRoundFormat = String(roundFormat || "").toUpperCase();
  const isTie = normalizedRoundFormat === "T";
  const currentBetSide = state.pendingBetSide;
  const currentBetAmount = state.pendingBetAmount;
  const totalProfitBefore = state.totalProfit;
  const didWin = !isTie && normalizedRoundFormat === currentBetSide;
  const outcomeDisplay = isTie
    ? "🤝 HOÀ"
    : didWin
      ? "✅ THẮNG"
      : "❌ THUA";

  if (!isTie) {
    state.totalProfit += didWin
      ? currentBetAmount
      : -currentBetAmount;
  }

  const nextBetAmount = isTie
    ? currentBetAmount
    : didWin
      ? BET_INIT_AMOUNT
      : BET_INIT_AMOUNT * 2;
  const nextBetSide = isTie ? currentBetSide : pickRandomBetSide();

  const caption = [
    `KẾT QUẢ: ${outcomeDisplay}`,
    `TỔNG LÃI: ${formatAmountK(state.totalProfit)}`,
    "LỆNH TIẾP THEO",
    `${getBetDisplay(nextBetSide)} ${formatAmountK(nextBetAmount)}`,
    "-------»---★---«-------",
    "‼️ Phân Chia Mức Cược Theo Vốn Của Bạn",
    "➡️ Nên nhớ đi lệnh : 5% -10% để an toàn vốn",
    "👉 Liên hệ admin",
    "=============",
  ].join("\n");

  state.pendingBetSide = nextBetSide;
  state.pendingBetAmount = nextBetAmount;

  return {
    caption,
    betLog: {
      roundFormat: normalizedRoundFormat,
      outcomeDisplay,
      currentBetSide,
      currentBetDisplay: getBetDisplay(currentBetSide),
      currentBetAmount,
      nextBetSide,
      nextBetDisplay: getBetDisplay(nextBetSide),
      nextBetAmount,
      totalProfitBefore,
      totalProfitAfter: state.totalProfit,
      isTie,
      didWin,
    },
  };
}

function buildTelegramCaptionFromApi(snapshot, state) {
  return buildBetPayload(resolveRoadFormat(snapshot), state);
}

function buildTelegramCaptionFromClass(triggerWinner, state) {
  return buildBetPayload(resolveRoundFormatFromTriggerWinner(triggerWinner), state);
}

async function sendScreenshotToTelegramInternal({
  snapshot,
  filePath,
  state,
  log,
  captionPayload,
}) {
  const token = process.env.TOKEN_BOT;
  const idRecipient =
    process.env.SCREENSHOT_TELEGRAM_CHAT_ID ||
    process.env.ID_TELEGRAM_RECIPIENT;

  if (!token || !idRecipient) {
    log(
      "Telegram screenshot delivery skipped: missing TOKEN_BOT or recipient chat id",
    );
    return false;
  }

  const { caption, betLog } = captionPayload;

  log("Bet state before Telegram send", {
    tableName: snapshot.tableName,
    latestKey: snapshot.latestKey,
    roundFormat: betLog.roundFormat || "unknown",
    outcome: betLog.outcomeDisplay,
    currentBetSide: betLog.currentBetSide,
    currentBetDisplay: betLog.currentBetDisplay,
    currentBetAmount: betLog.currentBetAmount,
    totalProfitBefore: betLog.totalProfitBefore,
    totalProfitAfter: betLog.totalProfitAfter,
    nextBetSide: betLog.nextBetSide,
    nextBetDisplay: betLog.nextBetDisplay,
    nextBetAmount: betLog.nextBetAmount,
    isTie: betLog.isTie,
    didWin: betLog.didWin,
  });

  const sent = await sendTelegramPhoto(token, idRecipient, filePath, {
    caption,
  });

  if (sent) {
    await removeFileIfExists(filePath);
    log(`Telegram photo sent: ${filePath}`);
    return true;
  }

  log(`Telegram photo send failed: ${filePath}`);
  return false;
}

async function sendScreenshotToTelegramByApi({ snapshot, filePath, state, log }) {
  return sendScreenshotToTelegramInternal({
    snapshot,
    filePath,
    state,
    log,
    captionPayload: buildTelegramCaptionFromApi(snapshot, state),
  });
}

async function sendScreenshotToTelegramByClass({
  snapshot,
  filePath,
  state,
  log,
  triggerWinner,
}) {
  return sendScreenshotToTelegramInternal({
    snapshot,
    filePath,
    state,
    log,
    captionPayload: buildTelegramCaptionFromClass(triggerWinner, state),
  });
}

module.exports = {
  BET_INIT_AMOUNT,
  pickRandomBetSide,
  buildTelegramCaptionFromApi,
  buildTelegramCaptionFromClass,
  sendScreenshotToTelegramByApi,
  sendScreenshotToTelegramByClass,
};
