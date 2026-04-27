import { Router } from "express";
import { optionalAuth } from "../middlewares/auth";
import prisma from "../config/prisma";
import { getCache, setCache, CacheKeys } from "../utils/cache";

const router = Router();

router.get("/:id", optionalAuth, async (req, res) => {
  try {
    const videoId = req.params.id;
    const user = req.user;
    
    // We include user.id in the cache key because access depends on the user
    const cacheKey = CacheKeys.VIDEO(videoId, user?.id);

    const cachedData = await getCache(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    const video = await prisma.video.findUnique({
      where: { id: videoId },
      include: {
        module: {
          include: {
            videos: { orderBy: { order: "asc" } },
            course: {
              include: {
                modules: {
                  orderBy: { order: "asc" },
                  include: {
                    videos: { orderBy: { order: "asc" } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!video) {
      return res.status(404).json({ error: "Not found" });
    }

    // New Verification Check: Only Admin or Creator of the video can see unverified videos
    const isCreator = user && video.module.course.creatorId === user.id;
    const isAdmin = user && user.role === "ADMIN";
    
    if (!video.isVerified && !isCreator && !isAdmin) {
      return res.status(403).json({ error: "Video is pending admin approval" });
    }

    const courseId = video.module.courseId;
    let hasAccess = video.isFreePreview;

    if (!hasAccess) {
      if (!user) {
        return res.status(401).json({ error: "Unauthorized", courseId });
      }

      const purchase = await prisma.purchase.findUnique({
        where: {
          userId_courseId: {
            userId: user!.id,
            courseId,
          },
        },
      });

      if (purchase?.status === "SUCCESS") {
        hasAccess = true;
      } else {
        return res.status(403).json({ error: "Forbidden", courseId });
      }
    }

    const responseData = {
      video: {
        id: video.id,
        title: video.title,
        videoUrl: video.videoUrl,
        duration: video.duration,
        order: video.order,
        isFreePreview: video.isFreePreview,
      },
      module: {
        id: video.module.id,
        title: video.module.title,
        order: video.module.order,
        videos: video.module.videos,
      },
      course: video.module.course,
      hasAccess,
    };

    // Cache for 5 minutes
    await setCache(cacheKey, responseData, 300);

    res.json(responseData);
  } catch (error) {
    console.error("Video GET Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
