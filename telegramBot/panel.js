function formatConfigMessage(config) {
  return [
    `Bàn: ${config.tableName || "(chưa chọn)"}`,
    `Tổng lãi: ${config.betConfig.total}K`,
    `Tiền cược: ${config.betConfig.betInit}K`,
  ].join("\n");
}

function buildPanelText({
  chatId,
  getChatConfig,
  makeDefaultConfig,
  status,
}) {
  const config =
    getChatConfig(chatId) || makeDefaultConfig();

  return [
    "Panel admin bot",
    "",
    formatConfigMessage(config),
    "",
    status,
    "",
    "Dùng /stop để dừng bot.",
  ].join("\n");
}

function buildPanelKeyboard({
  chatId,
  getChatConfig,
  makeDefaultConfig,
}) {
  const config =
    getChatConfig(chatId) || makeDefaultConfig();

  return {
    inline_keyboard: [
      [
        {
          text: `Bàn: ${config.tableName || "chưa chọn"}`,
          callback_data: "panel:set_table",
        },
      ],
      [
        {
          text: `Tổng lãi: ${config.betConfig.total}K`,
          callback_data: "panel:set_total",
        },
        {
          text: `Tiền cược: ${config.betConfig.betInit}K`,
          callback_data: "panel:set_bet_init",
        },
      ],
      [
        {
          text: "Start",
          callback_data: "panel:start",
        },
        {
          text: "Status",
          callback_data: "panel:status",
        },
      ],
      [
        {
          text: "Refresh",
          callback_data: "panel:refresh",
        },
      ],
    ],
  };
}

module.exports = {
  formatConfigMessage,
  buildPanelText,
  buildPanelKeyboard,
};
