const fs = require("fs");
const path = require("path");

function createStore({
  storePath,
  defaultTableName,
  defaultTotal,
  defaultBetInit,
  logError = () => {},
}) {
  const initialState = {
    version: 2,
    sharedConfig: null,
  };

  const state = loadStore();

  function loadStore() {
    try {
      if (!fs.existsSync(storePath)) {
        return { ...initialState };
      }

      const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));

      if (parsed.sharedConfig) {
        return {
          version: parsed.version || 2,
          sharedConfig: parsed.sharedConfig,
        };
      }

      const configs = parsed.configs || {};
      const configValues = Object.values(configs);
      const privateConfig = configValues.find((entry) => entry?.type === "private");
      const fallbackConfig = privateConfig || configValues[0] || null;

      return {
        version: 2,
        sharedConfig: fallbackConfig
          ? {
              tableName: fallbackConfig.tableName || "",
              betConfig: {
                total: Number(fallbackConfig.betConfig?.total || defaultTotal),
                betInit: Number(
                  fallbackConfig.betConfig?.betInit || defaultBetInit,
                ),
              },
              enabled: Boolean(fallbackConfig.enabled),
              updatedAt:
                fallbackConfig.updatedAt || new Date().toISOString(),
            }
          : null,
      };
    } catch (error) {
      logError(`[telegram-bot] failed to load store: ${error.message}`);
      return { ...initialState };
    }
  }

  function saveStore() {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(state, null, 2));
  }

  function makeDefaultConfig() {
    return {
      tableName: defaultTableName,
      betConfig: {
        total: defaultTotal,
        betInit: defaultBetInit,
      },
      enabled: false,
      updatedAt: new Date().toISOString(),
    };
  }

  function ensureChatConfig() {
    if (!state.sharedConfig) {
      state.sharedConfig = makeDefaultConfig();
      saveStore();
    }

    return state.sharedConfig;
  }

  function getChatConfig() {
    return state.sharedConfig || null;
  }

  function updateChatConfig(_chatId, updater) {
    const existing = state.sharedConfig || makeDefaultConfig();
    const next = updater(existing);
    next.updatedAt = new Date().toISOString();
    state.sharedConfig = next;
    saveStore();
    return next;
  }

  return {
    ensureChatConfig,
    getChatConfig,
    updateChatConfig,
    makeDefaultConfig,
  };
}

module.exports = {
  createStore,
};
