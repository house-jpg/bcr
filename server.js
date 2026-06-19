const axios = require("axios");
const express = require("express");
const app = express();
require("dotenv").config();
const http = require("http");
const server = http.createServer(app);
const socketIO = require("socket.io");
const cors = require("cors");
const { exec } = require("child_process");

const {
  getCurrentTime,
  isValidSession,
  appendToLog,
} = require("./utilities/helper");
const {
  filterData,
  initDatabase,
  checkAndUpdateDatabase,
} = require("./utilities/helperGameSexy");
const { sendTelegramMessage, requestData } = require("./utilities/request");
const { connect } = require("./config/mongo");
const router = require("./routers/index");
const { SESSION_LIST } = require("./config/predictResult.config");
const {
  startIntegratedScreenshotService,
  stopIntegratedScreenshotService,
} = require("./serviceScreenshot/runtime");
const PORT = process.env.SERVER_PORT || 3201;

app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
connect();
router(app);

startIntegratedScreenshotService().catch(async (error) => {
  await appendToLog(
    `Screenshot service start failure: ${error.message}`,
    process.env.LOGS_SERVER_SEXY
  );
});

const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

let sessionList = SESSION_LIST;

io.on("connection", (socket) => {
  socket.on("session", async (payload) => {
    const { sessionId, nameService, stampTime } = payload;

    if (sessionList.session.hasOwnProperty(nameService)) {
      sessionList.session[nameService] = {
        nameService,
        sessionId,
        stampTime: stampTime, // || Date.now()
      };
      console.info(
        `${getCurrentTime().timeFormatted} - ${nameService || "_"} = ${
          sessionId || "_"
        }`
      );
    }

    if (nameService == "NS5") {
      sessionList.sessionFailover.nameService = nameService;
      sessionList.sessionFailover.sessionId = sessionId;
      sessionList.sessionFailover.stampTime = stampTime;
      // console.info(`${getCurrentTime().timeFormatted} - ${nameService} = ${sessionId} - SESSION FAILOVER`);
    }
  });
});

// thời gian khởi động lại service là 8 phút
setInterval(async () => {
  try {
    const timeUnixCurrent = getCurrentTime().timeUnix;

    for (const key in sessionList.session) {
      const session = sessionList.session[key];
      if (
        session.stampTime > 0 &&
        timeUnixCurrent - session.stampTime > 60 * 1000 * 10
      ) {
        await appendToLog(
          `${
            session.nameService || key
          } | QUÁ 10 PHÚT CHƯA ĐƯỢC CẬP NHẬT - YÊU CẦU KHỞI ĐỘNG LẠI`,
          process.env.LOGS_SERVER_SEXY
        );
        if (session.nameService) {
          session.stampTime = timeUnixCurrent - 60 * 1000 * 8;
          // io.emit(`${session.nameService}_restart`, {});
          // console.log(`ĐÃ GỬI YÊU CẦU KHỞI ĐỘNG LẠI => ${session.nameService}`);
          // let cmdReloadPm2 = `pm2 reload ${session.namePm2}`
          switch (session.nameService) {
            case "NS1":
              cmdReloadPm2 = "pm2 reload session_sexy_1";
              break;
            case "NS2":
              cmdReloadPm2 = "pm2 reload session_sexy_2";
              break;
            case "NS3":
              cmdReloadPm2 = "pm2 reload session_sexy_3";
              break;
            case "NS4":
              cmdReloadPm2 = "pm2 reload session_sexy_4";
              break;
          }
          exec(cmdReloadPm2, async (error, stdout, stderr) => {
            if (error) {
              await appendToLog(
                `Lỗi khi reload PM2: ${error.message}`,
                process.env.LOGS_SERVER_SEXY
              );
              return;
            }
            if (stderr) {
              console.error(`stderr: ${stderr}`);
              return;
            }
            await appendToLog(
              `stdout: ${stdout}`,
              process.env.LOGS_SERVER_SEXY
            );
            await appendToLog(
              `(PM2)KHỞI ĐỘNG LẠI SERVICE => ${session.nameService}: ${error.message}`,
              process.env.LOGS_SERVER_SEXY
            );
          });
        }
      }
    }
  } catch (error) {
    await appendToLog(
      `restart service: ${error}`,
      process.env.LOGS_SERVER_SEXY
    );
  }
}, 5000);

setInterval(async () => {
  const sessionKeys = Object.keys(sessionList.session);
  let availableSessions = sessionKeys
    .filter((key) => isValidSession(sessionList.session[key]))
    .map((key) => sessionList.session[key]);

  console.log("check session", availableSessions);

  if (
    availableSessions.length === 0 &&
    sessionList.sessionFailover.nameService
  ) {
    availableSessions.push(sessionList.sessionFailover);
  }

  // if (availableSessions.length === 0 && !sessionList.sessionFailover.nameService) {
  //     await appendToLog(`HẾT SESSION`, process.env.LOGS_SERVER_SEXY)
  //     await sendTelegramMessage(process.env.TOKEN_BOT, process.env.ID_TELEGRAM_RECIPIENT, "HẾT SESSION")
  //     return
  // }

  while (availableSessions.length > 0) {
    const randomIndex = Math.floor(Math.random() * availableSessions.length);
    const selectedSession = availableSessions[randomIndex];
    console.log(`SỬ DỤNG SESSION => ${selectedSession.sessionId}`);
    const data = await requestData(selectedSession.sessionId);
    console.log(data);
    if (!data.tableItems) return;
    const dataTableList = filterData(data.tableItems);

    await initDatabase(dataTableList);
    await checkAndUpdateDatabase(dataTableList);

    // bắn dữ liệu
    // io.emit('test_data', {
    //     data: JSON.stringify(dataTableList),
    //     stampTime: getCurrentTime().timeUnix,
    // });
    // console.log('Bắn dữ liệu socket')
    // const byteSize = Buffer.byteLength(JSON.stringify(dataTableList), 'utf8');
    // console.log(`Dung lượng JSON: ${byteSize} bytes ~ ${(byteSize / 1024).toFixed(2)} KB`);
    return;
  }
}, 1500);

server.listen(PORT, async () => {
  await appendToLog(
    `Running server http://localhost:${PORT}`,
    process.env.LOGS_SERVER_SEXY
  );
  console.info(`Running server http://localhost:${PORT}`);
});

async function shutdown(signal) {
  await appendToLog(
    `Received ${signal}, shutting down server`,
    process.env.LOGS_SERVER_SEXY
  );
  await stopIntegratedScreenshotService();
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error(error);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error(error);
    process.exit(1);
  });
});
