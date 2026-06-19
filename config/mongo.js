const mongoose = require("mongoose");
mongoose.set("strictQuery", true);
require("dotenv").config();

async function connect() {
  try {
    mongoose
      .connect(process.env.URL_CONNECT_MONGODB, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        authSource: "admin",
      })
      .then(() => console.info(`🛢️🛢️🛢️ connect database db_bacarat success`))
      .catch((err) => console.error("🛠🛠🛠 MongoDB connection error: " + err));
  } catch (error) {
    console.info(`❌❌❌ connect DB failure`);
    console.error(error);
  }
}

module.exports = { connect };
