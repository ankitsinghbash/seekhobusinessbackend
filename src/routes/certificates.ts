import { Router } from "express";
import { authenticateUser } from "../middlewares/auth";
import prisma from "../config/prisma";

const router = Router();

router.get("/", authenticateUser, async (req, res) => {
  try {
    const user = req.user;

    const purchases = await prisma.purchase.findMany({
      where: { userId: user.id, status: "SUCCESS" },
      include: {
        course: {
          include: {
            modules: {
              include: {
                videos: { select: { id: true } },
              },
            },
          },
        },
      },
    });

    const completedProgress = await prisma.progress.findMany({
      where: { userId: user.id, isCompleted: true },
      select: { videoId: true },
    });
    const completedVideoIds = new Set(completedProgress.map((p) => p.videoId));

    const certificates = purchases.map((purchase) => {
      const allVideoIds = purchase.course.modules.flatMap((m) =>
        m.videos.map((v) => v.id)
      );
      const totalVideos = allVideoIds.length;
      const completedVideos = allVideoIds.filter((id) =>
        completedVideoIds.has(id)
      ).length;
      const completionPercent =
        totalVideos > 0 ? Math.round((completedVideos / totalVideos) * 100) : 0;
      const isEligible = completionPercent === 100 && totalVideos > 0;

      return {
        courseId: purchase.course.id,
        courseTitle: purchase.course.title,
        courseCategory: purchase.course.category,
        courseThumbnail: purchase.course.thumbnail,
        totalVideos,
        completedVideos,
        completionPercent,
        isEligible,
        purchasedAt: purchase.createdAt,
        issuedAt: isEligible ? purchase.updatedAt : null,
      };
    });

    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { name: true, email: true },
    });

    res.json({
      certificates,
      userName: dbUser?.name || user.user_metadata?.full_name || user.email?.split("@")[0] || "Student",
    });
  } catch (error) {
    console.error("Certificates API Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
