import { Router } from "express";
import crypto from "crypto";
import prisma from "../config/prisma";
import express from "express";
import { deleteCache, CacheKeys } from "../utils/cache";

const router = Router();

const handleWebhook = async (req: express.Request, res: express.Response) => {
  try {
    // req.body is now a string because of express.text()
    const rawBody = req.body;
    
    const signature = req.headers["x-webhook-signature"] as string;
    const timestamp = req.headers["x-webhook-timestamp"] as string;

    if (!signature || !timestamp) {
      return res.status(400).json({ error: "Missing signature" });
    }

    const dataToSign = timestamp + rawBody;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.CASHFREE_WEBHOOK_SECRET || "")
      .update(dataToSign)
      .digest("base64");

    if (signature !== expectedSignature) {
      console.error("Invalid webhook signature");
      return res.status(400).json({ error: "Invalid signature" });
    }

    const payload = JSON.parse(rawBody);

    if (payload.type === "PAYMENT_SUCCESS_WEBHOOK") {
      const orderId = payload.data.order.order_id;
      
      const purchase = await prisma.purchase.findUnique({
        where: { cashfreeOrderId: orderId }
      });
      
      await prisma.purchase.updateMany({
        where: { cashfreeOrderId: orderId },
        data: { status: "SUCCESS" },
      });
      
      if (purchase) {
        await deleteCache(CacheKeys.PURCHASES(purchase.userId));
        // Also invalidate cart just in case they haven't cleared it yet
        await deleteCache(CacheKeys.CART(purchase.userId));
      }
      
      console.log(`Payment successful for order: ${orderId}`);
    }

    res.json({ status: "OK" });

  } catch (error) {
    console.error("Webhook Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

// For webhook we need raw body to verify signature
router.post("/cashfree", express.text({ type: '*/*' }), handleWebhook);

// Alias for plural "webhooks"
router.post("/webhooks/cashfree", express.text({ type: '*/*' }), handleWebhook);

export default router;
