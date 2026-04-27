import { Router, Request, Response } from "express";
import { authenticateUser, invalidateUserCache } from "../middlewares/auth";
import prisma from "../config/prisma";
import { deleteCache, CacheKeys } from "../utils/cache";

const router = Router();

// ── Auth Guard ─────────────────────────────────────────────────────────────
const requireAdmin = (req: Request, res: Response, next: any) => {
  if (req.user?.role !== "ADMIN") return res.status(403).json({ error: "Admin access required" });
  next();
};

// ── Stats ──────────────────────────────────────────────────────────────────
router.get("/stats", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const [totalUsers, totalCreators, pendingCreators, pendingVideos, totalPurchases, revenue] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: "CREATOR" } }),
      prisma.user.count({ where: { isVerified: false, legalName: { not: null } } }),
      prisma.video.count({ where: { isVerified: false } }),
      prisma.purchase.count({ where: { status: "SUCCESS" } }),
      prisma.purchase.aggregate({ where: { status: "SUCCESS" }, _sum: { amount: true } }),
    ]);
    res.json({ totalUsers, totalCreators, pendingCreators, pendingVideos, totalPurchases, totalRevenue: revenue._sum.amount || 0 });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// ── Creators (Paginated) ───────────────────────────────────────────────────
router.get("/creators", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = parseInt(req.query.limit as string) || 10;
    const search = (req.query.search as string) || "";
    const filter = (req.query.filter as string) || "all"; // all | verified | pending | student

    const where: any = {
      ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { email: { contains: search, mode: "insensitive" } }] } : {}),
      ...(filter === "verified" ? { role: "CREATOR", isVerified: true } : {}),
      ...(filter === "pending" ? { isVerified: false, legalName: { not: null } } : {}),
      ...(filter === "student" ? { role: "STUDENT" } : {}),
      ...(filter === "all" ? {} : {}),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, email: true, name: true, avatar: true, role: true,
          isVerified: true, legalName: true, phone: true, category: true,
          experience: true, createdAt: true,
          _count: { select: { courses: true, purchases: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ users, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (e) { console.error(e); res.status(500).json({ error: "Server error" }); }
});

// ── Single Creator Detail ──────────────────────────────────────────────────
router.get("/creators/:id", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        courses: {
          include: {
            _count: { select: { modules: true } },
            modules: { include: { _count: { select: { videos: true } } } },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// ── Pending Creators ───────────────────────────────────────────────────────
router.get("/pending-creators", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const pending = await prisma.user.findMany({
      where: { isVerified: false, legalName: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ creators: pending });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// ── Verify Creator ─────────────────────────────────────────────────────────
router.post("/verify-creator/:id", authenticateUser, requireAdmin, async (req, res) => {
  try {
    await prisma.user.update({ where: { id: req.params.id }, data: { isVerified: true, role: "CREATOR" } });
    invalidateUserCache(req.params.id);
    await deleteCache(`cache:user:me:${req.params.id}`);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// ── Revoke Creator ─────────────────────────────────────────────────────────
router.post("/revoke-creator/:id", authenticateUser, requireAdmin, async (req, res) => {
  try {
    await prisma.user.update({ where: { id: req.params.id }, data: { isVerified: false, role: "STUDENT" } });
    invalidateUserCache(req.params.id);
    await deleteCache(`cache:user:me:${req.params.id}`);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// ── Course Detail with Videos ──────────────────────────────────────────────
router.get("/courses/:courseId", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const course = await prisma.course.findUnique({
      where: { id: req.params.courseId },
      include: {
        creator: { select: { id: true, name: true, email: true, avatar: true } },
        modules: {
          orderBy: { order: "asc" },
          include: { videos: { orderBy: { order: "asc" } } },
        },
      },
    });
    if (!course) return res.status(404).json({ error: "Not found" });
    res.json({ course });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// ── Pending Videos ─────────────────────────────────────────────────────────
router.get("/pending-videos", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const pending = await prisma.video.findMany({
      where: { isVerified: false },
      include: { module: { include: { course: { include: { creator: true } } } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ videos: pending });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// ── Verify Video ───────────────────────────────────────────────────────────
router.post("/verify-video/:id", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const video = await prisma.video.update({ where: { id: req.params.id }, data: { isVerified: true }, include: { module: true } });
    await deleteCache(CacheKeys.CREATOR_PROJECT(video.module.courseId));
    await deleteCache(CacheKeys.VIDEO(req.params.id));
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// ── Unverify Video ─────────────────────────────────────────────────────────
router.post("/unverify-video/:id", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const video = await prisma.video.update({ where: { id: req.params.id }, data: { isVerified: false }, include: { module: true } });
    await deleteCache(CacheKeys.CREATOR_PROJECT(video.module.courseId));
    await deleteCache(CacheKeys.VIDEO(req.params.id));
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Server error" }); }
});

// ── Toggle Video Publish ───────────────────────────────────────────────────
router.post("/toggle-video/:id", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const { isPublished } = req.body;
    const video = await prisma.video.update({ where: { id: req.params.id }, data: { isPublished }, include: { module: true } });
    await deleteCache(CacheKeys.CREATOR_PROJECT(video.module.courseId));
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Server error" }); }
});

export default router;
