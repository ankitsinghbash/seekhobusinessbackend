import { Router } from "express";
import { authenticateUser } from "../middlewares/auth";
import prisma from "../config/prisma";
import { getCache, setCache, CacheKeys } from "../utils/cache";

const router = Router();

router.get("/", authenticateUser, async (req, res) => {
  try {
    const user = req.user!;
    const cacheKey = CacheKeys.PURCHASES(user.id);

    const cachedData = await getCache(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    const purchases = await prisma.purchase.findMany({
      where: { userId: user.id },
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
      },
      orderBy: { createdAt: "desc" },
    });

    const totalSpent = purchases
      .filter((p) => p.status === "SUCCESS")
      .reduce((sum, p) => sum + p.amount, 0);

    const successCount = purchases.filter((p) => p.status === "SUCCESS").length;

    const responseData = {
      purchases,
      stats: {
        totalSpent,
        totalCourses: successCount,
      },
    };

    await setCache(cacheKey, responseData, 1800); // cache for 30 minutes

    res.json(responseData);
  } catch (error) {
    console.error("Purchase History Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
