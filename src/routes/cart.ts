import { Router } from "express";
import { authenticateUser } from "../middlewares/auth";
import prisma from "../config/prisma";
import { getCache, setCache, deleteCache, CacheKeys } from "../utils/cache";

const router = Router();

router.get("/", authenticateUser, async (req, res) => {
  try {
    const user = req.user!;
    const cacheKey = CacheKeys.CART(user.id);

    const cachedData = await getCache(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    const cart = await prisma.cart.findUnique({
      where: { userId: user.id },
      include: {
        items: {
          include: {
            course: true,
          },
          orderBy: {
            createdAt: 'desc'
          }
        },
      },
    });

    const responseData = cart?.items || [];
    await setCache(cacheKey, responseData, 600); // cache for 10 minutes

    res.json(responseData);
  } catch (error) {
    console.error("Cart GET Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/", authenticateUser, async (req, res) => {
  try {
    const user = req.user!;
    const { courseId } = req.body;

    // Ensure user exists in Prisma
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
      return res.status(400).json({ error: "courseId is required" });
    }

    const course = await prisma.course.findUnique({
      where: { id: courseId }
    });

    if (!course) {
      return res.status(404).json({ error: "Course not found" });
    }

    let cart = await prisma.cart.findUnique({
      where: { userId: user.id },
    });

    if (!cart) {
      cart = await prisma.cart.create({
        data: { userId: user.id },
      });
    }

    const cartItem = await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        courseId,
      },
      include: {
        course: true,
      },
    });

    // Invalidate cart cache
    await deleteCache(CacheKeys.CART(user.id));

    res.json(cartItem);
  } catch (error: any) {
    console.error("Cart POST Error:", error);
    if (error.code === 'P2002') {
      return res.status(400).json({ error: "Item already in cart" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/", authenticateUser, async (req, res) => {
  try {
    const user = req.user!;
    const cartItemId = req.query.id as string;

    if (!cartItemId) {
      return res.status(400).json({ error: "id is required" });
    }

    await prisma.cartItem.deleteMany({
      where: {
        id: cartItemId,
        cart: {
          userId: user.id
        }
      }
    });

    // Invalidate cart cache
    await deleteCache(CacheKeys.CART(user.id));

    res.json({ success: true });
  } catch (error) {
    console.error("Cart DELETE Error:", error);
    res.status(500).json({ error: "Failed to remove item" });
  }
});

export default router;
