import { Router } from "express";
import prisma from "../config/prisma";
import { getCache, setCache, CacheKeys } from "../utils/cache";

const router = Router();

type SortOption = "newest" | "oldest" | "price_asc" | "price_desc";

const ORDER_MAP: Record<SortOption, any> = {
  newest:     { createdAt: "desc" },
  oldest:     { createdAt: "asc"  },
  price_asc:  { price:     "asc"  },
  price_desc: { price:     "desc" },
};

router.get("/", async (req, res) => {
  const query    = (req.query.q as string)        || "";
  const category = (req.query.category as string) || "";
  const price    = (req.query.price as string)    || "all";
  const sort     = ((req.query.sort as string)    || "newest") as SortOption;
  const page     = Math.max(1, parseInt((req.query.page as string) || "1", 10));
  const pageSize = 12;

  // Generate a unique cache key based on query params
  const cacheKey = CacheKeys.SEARCH(`${query}_${category}_${price}_${sort}_${page}`);
  
  try {
    const cachedData = await getCache(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    const orderBy = ORDER_MAP[sort] ?? ORDER_MAP.newest;

    const where: any = {
      isPublished: true,
      ...(query ? {
        OR: [
          { title:       { contains: query, mode: "insensitive" } },
          { description: { contains: query, mode: "insensitive" } },
          { category:    { contains: query, mode: "insensitive" } },
        ],
      } : {}),
      ...(category ? { category: { equals: category, mode: "insensitive" } } : {}),
      ...(price === "free" ? { price: { lte: 0 } } : {}),
      ...(price === "paid" ? { price: { gt:  0 } } : {}),
    };

    const [courses, total, allCategories] = await Promise.all([
      prisma.course.findMany({
        where,
        select: {
          id:          true,
          title:       true,
          description: true,
          category:    true,
          thumbnail:   true,
          price:       true,
        },
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.course.count({ where }),
      prisma.course.findMany({
        where:   { isPublished: true },
        select:  { category: true },
        distinct: ["category"],
        orderBy:  { category: "asc" },
      }),
    ]);

    const responseData = {
      courses,
      total,
      page,
      pageSize,
      totalPages:    Math.ceil(total / pageSize),
      allCategories: allCategories.map((c: any) => c.category),
    };

    // Cache the response for 1 hour (3600 seconds)
    await setCache(cacheKey, responseData, 3600);

    res.json(responseData);
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
