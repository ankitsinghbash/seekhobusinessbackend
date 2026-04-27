import { Router } from "express";
import { authenticateUser } from "../middlewares/auth";
import prisma from "../config/prisma";

const router = Router();

router.get("/:orderId", authenticateUser, async (req, res) => {
  try {
    const { orderId } = req.params;
    const user = req.user;

    const purchase = await prisma.purchase.findFirst({
      where: {
        cashfreeOrderId: orderId,
        userId: user.id, // Security: only own purchases
      },
      include: {
        course: {
          select: {
            id: true,
            title: true,
            description: true,
            thumbnail: true,
            category: true,
            price: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!purchase) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    if (purchase.status !== "SUCCESS") {
      return res.status(400).json({ error: "Invoice available only for successful payments" });
    }

    const invoice = {
      invoiceNumber: `INV-${purchase.cashfreeOrderId?.replace("order_", "").slice(-8).toUpperCase()}`,
      orderId: purchase.cashfreeOrderId,
      purchaseId: purchase.id,
      issuedAt: purchase.updatedAt,
      customer: {
        name: purchase.user.name || "Student",
        email: purchase.user.email,
        id: purchase.user.id.slice(0, 8).toUpperCase(),
      },
      course: {
        title: purchase.course.title,
        category: purchase.course.category,
        id: purchase.course.id,
      },
      payment: {
        subtotal: purchase.amount,
        tax: 0, 
        total: purchase.amount,
        currency: "INR",
        status: purchase.status,
      },
      company: {
        name: "Seekho Business",
        address: "India",
        email: "support@seekhobusiness.co.in",
        website: "https://seekhobusiness.co.in",
        gstin: "GST_NOT_APPLICABLE", 
      },
    };

    res.json({ invoice });
  } catch (error) {
    console.error("Invoice Generation Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
