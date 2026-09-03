import { config } from "dotenv";
config();

const { W3WPrediction } = await import("@binance/w3w-prediction");

const client = new W3WPrediction({
  configurationRestAPI: {
    apiKey: process.env.BINANCE_LIVE_API_KEY || process.env.BINANCE_PAPER_API_KEY,
    apiSecret: process.env.BINANCE_LIVE_API_SECRET || process.env.BINANCE_PAPER_API_SECRET,
    basePath: "https://api.binance.com",
  },
});

const res = await client.restAPI.listPredictionWallets();
console.log(JSON.stringify(await res.data(), null, 2));