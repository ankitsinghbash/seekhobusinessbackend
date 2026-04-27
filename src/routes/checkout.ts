import { Router } from "express";
import { authenticateUser } from "../middlewares/auth";
import prisma from "../config/prisma";
import { redis } from "../config/redis";

const router = Router();

router.post("/", authenticateUser, async (req, res) => {
  try {
    const user = req.user;
    const { courseId } = req.body;

    await prisma.user.upsert({
      where: { id: user.id },
      update: { email: user.email || "" },
      create: {
        id: user.id,
        email: user.email || "",
        name: user.user_metadata?.full_name || "Student",
      },
    });

    if (!courseId) {
      return res.status(400).json({ error: "Course ID required" });
    }

    let lockKey = `lock:checkout:${user.id}:${courseId}`;
    let isLocked = true;
    
    try {
      if (process.env.REDIS_URL) {
        const result = await redis.set(lockKey, "locked", "EX", 30, "NX");
        isLocked = result === "OK";
      }
    } catch (e) {
      console.warn("Redis is not configured or failed, bypassing lock");
    }

    if (!isLocked) {
      return res.status(429).json({ error: "Transaction already in progress. Please wait." });
    }

    try {
      const course = await prisma.course.findUnique({
        where: { id: courseId },
      });

      if (!course) {
        try { if (process.env.REDIS_URL) await redis.del(lockKey); } catch (e) {}
        return res.status(404).json({ error: "Course not found" });
      }

      const existingPurchase = await prisma.purchase.findUnique({
        where: {
          userId_courseId: {
            userId: user.id,
            courseId: courseId,
          },
        },
      });

      if (existingPurchase && existingPurchase.status === "SUCCESS") {
        try { if (process.env.REDIS_URL) await redis.del(lockKey); } catch (e) {}
        return res.status(400).json({ error: "Already purchased" });
      }

      const orderId = `order_${courseId}_${user.id}_${Date.now()}`;
      const amount = Number(course.price);

      const options = {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-version": "2023-08-01",
          "x-client-id": process.env.CASHFREE_APP_ID || "",
          "x-client-secret": process.env.CASHFREE_SECRET_KEY || "",
        },
        body: JSON.stringify({
          customer_details: {
            customer_id: user.id,
            customer_email: user.email || "student@seekhobusiness.co.in",
            customer_phone: "9999999999", 
            customer_name: user.user_metadata?.full_name || "Student",
          },
          order_meta: {
            return_url: `${process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"}/api/checkout/verify?order_id=${orderId}`,
          },
          order_amount: amount,
          order_currency: "INR",
          order_id: orderId,
          order_note: `Purchase of ${course.title}`,
        }),
      };

      const CASHFREE_URL = "https://sandbox.cashfree.com/pg/orders"; 

      const response = await fetch(CASHFREE_URL, options);
      const data: any = await response.json();

      if (!response.ok) {
        try { if (process.env.REDIS_URL) await redis.del(lockKey); } catch (e) {}
        return res.status(500).json({ error: data.message || "Payment gateway error" });
      }

      await prisma.purchase.upsert({
        where: {
          userId_courseId: {
            userId: user.id,
            courseId: courseId
          }
        },
        update: {
          amount: amount,
          status: "PENDING",
          cashfreeOrderId: orderId,
        },
        create: {
          userId: user.id,
          courseId: courseId,
          amount: amount,
          status: "PENDING",
          cashfreeOrderId: orderId,
        }
      });

      res.json({ paymentSessionId: data.payment_session_id, orderId });

    } catch (innerError) {
      try { if (process.env.REDIS_URL) await redis.del(lockKey); } catch (e) {}
      throw innerError;
    }

  } catch (error) {
    console.error("Checkout POST Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/verify", async (req, res) => {
  const orderId = req.query.order_id as string;
  const frontendUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

  if (!orderId) {
    return res.redirect(`${frontendUrl}/`);
  }

  try {
    const options = {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-api-version": "2023-08-01",
        "x-client-id": process.env.CASHFREE_APP_ID || "",
        "x-client-secret": process.env.CASHFREE_SECRET_KEY || "",
      },
    };

    const response = await fetch(`https://sandbox.cashfree.com/pg/orders/${orderId}`, options);
    const data: any = await response.json();

    const purchase = await prisma.purchase.findFirst({
      where: { cashfreeOrderId: orderId },
      select: { id: true, courseId: true, status: true }
    });

    if (!purchase) {
      return res.redirect(`${frontendUrl}/`);
    }

    if (data.order_status === "PAID") {
      if (purchase.status !== "SUCCESS") {
        await prisma.purchase.update({
          where: { id: purchase.id },
          data: { status: "SUCCESS" },
        });
      }
      return res.redirect(`${frontendUrl}/courses/${purchase.courseId}?payment=success`);
    } else {
      if (purchase.status !== "FAILED" && data.order_status !== "PENDING") {
        await prisma.purchase.update({
          where: { id: purchase.id },
          data: { status: "FAILED" },
        });
      }
      return res.redirect(`${frontendUrl}/courses/${purchase.courseId}?payment=failed`);
    }

  } catch (error) {
    console.error("Verification Error:", error);
    return res.redirect(`${frontendUrl}/`);
  }
});

export default router;
