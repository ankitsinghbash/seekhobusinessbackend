import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

const allowedOrigins = [
  "http://localhost:3000",
  "https://sikhobusiness.com",
  "https://seekho-business.vercel.app",
  process.env.FRONTEND_URL
].filter(Boolean) as string[];

app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true
}));

// Root route
app.get("/", (req, res) => {
  res.json({ 
    message: "Welcome to Seekho Business API",
    version: "1.0.0",
    status: "running"
  });
});

import webhookRouter from "./routes/webhook";

// Webhook needs raw body, so mount it BEFORE express.json()
app.use("/api/webhook", webhookRouter);

app.use(express.json());

import userRouter from "./routes/user";
import cartRouter from "./routes/cart";
import creatorRouter from "./routes/creator";
import certificatesRouter from "./routes/certificates";
import checkoutRouter from "./routes/checkout";
import invoiceRouter from "./routes/invoice";
import purchasesRouter from "./routes/purchases";
import searchRouter from "./routes/search";
import videoRouter from "./routes/video";
import adminRouter from "./routes/admin";
import { getCacheStats, isRedisReady } from "./utils/cache";

app.use("/api/user", userRouter);
app.use("/api/cart", cartRouter);
app.use("/api/creator", creatorRouter);
app.use("/api/certificates", certificatesRouter);
app.use("/api/checkout", checkoutRouter);
app.use("/api/invoice", invoiceRouter);
app.use("/api/purchases", purchasesRouter);
app.use("/api/search", searchRouter);
app.use("/api/video", videoRouter);
app.use("/api/admin", adminRouter);

// ── Health / Debug endpoint ───────────────────────────────────────────────
app.get("/health", (_req, res) => {
  const stats = getCacheStats();
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    redis: isRedisReady() ? "connected" : "unavailable",
    cache: stats,
    memory: {
      heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
    },
  });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Redis URL loaded: ${process.env.REDIS_URL ? "Yes" : "No"}`);
});

