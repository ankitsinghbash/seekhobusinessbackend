import { Router, Request, Response, NextFunction } from "express";
import { authenticateUser } from "../middlewares/auth";
import prisma from "../config/prisma";
import { getCache, setCache, deleteCache, deleteCachePattern, CacheKeys, TTL } from "../utils/cache";
import https from "https";

const router = Router();

// Middleware to ensure user is CREATOR or ADMIN
const requireCreator = (req: Request, res: Response, next: NextFunction) => {
  const user = req.user;
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (user.role !== "CREATOR" && user.role !== "ADMIN") {
    return res.status(403).json({ error: "Creator access required" });
  }
  next();
};

// GET /api/creator/projects
router.get("/projects", authenticateUser, requireCreator, async (req, res) => {
  try {
    const user = req.user!; // requireCreator ensures user exists
    const cacheKey = CacheKeys.CREATOR_PROJECTS(user.id);
    
    const cachedData = await getCache(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    const projects = await prisma.course.findMany({
      where: { creatorId: user.id },
      include: {
        _count: { select: { modules: true } },
        modules: {
          include: { _count: { select: { videos: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const enriched = projects.map((p) => ({
      ...p,
      totalVideos: p.modules.reduce((acc, m) => acc + m._count.videos, 0),
    }));

    const responseData = { projects: enriched };
    await setCache(cacheKey, responseData, 600); // cache for 10 minutes

    res.json(responseData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/creator/projects
router.post("/projects", authenticateUser, requireCreator, async (req, res) => {
  try {
    const user = req.user!;
    const { title, description, category, price, outcomes } = req.body;
    
    if (!title || !category) {
      return res.status(400).json({ error: "title and category required" });
    }

    const project = await prisma.course.create({
      data: {
        title,
        description: description || "",
        category,
        price: price ? parseFloat(price) : 0,
        outcomes: outcomes || [],
        isPublished: false,
        creatorId: user.id,
      },
    });

    // Invalidate caches
    await deleteCache(CacheKeys.CREATOR_PROJECTS(user.id));
    await deleteCachePattern("cache:search:*");

    res.status(201).json({ project });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/creator/projects/:id
router.get("/projects/:id", authenticateUser, requireCreator, async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const cacheKey = CacheKeys.CREATOR_PROJECT(id);

    const cachedData = await getCache(cacheKey);
    if (cachedData) {
      // Still enforce ownership even if cached
      if (cachedData.project.creatorId !== user.id && user.role !== "ADMIN") {
        return res.status(403).json({ error: "Forbidden" });
      }
      return res.json(cachedData);
    }

    const project = await prisma.course.findUnique({
      where: { id },
      include: {
        modules: {
          orderBy: { order: 'asc' },
          include: {
            videos: {
              orderBy: { order: 'asc' }
            }
          }
        }
      }
    });

    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.creatorId !== user.id && user.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const responseData = { project };
    await setCache(cacheKey, responseData, 600);

    res.json(responseData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT or PATCH /api/creator/projects/:id
const updateProject = async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { title, description, category, price, outcomes, thumbnail, isPublished } = req.body;

    const project = await prisma.course.findUnique({ where: { id } });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.creatorId !== user.id && user.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const updated = await prisma.course.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(category !== undefined && { category }),
        ...(price !== undefined && { price: parseFloat(price) }),
        ...(outcomes !== undefined && { outcomes }),
        ...(thumbnail !== undefined && { thumbnail }),
        ...(isPublished !== undefined && { isPublished }),
      }
    });

    // Invalidate caches
    await deleteCache(CacheKeys.CREATOR_PROJECTS(user.id));
    await deleteCache(CacheKeys.CREATOR_PROJECT(id));
    await deleteCachePattern("cache:search:*");

    res.json({ project: updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
};

router.put("/projects/:id", authenticateUser, requireCreator, updateProject);
router.patch("/projects/:id", authenticateUser, requireCreator, updateProject);

// DELETE /api/creator/projects/:id
router.delete("/projects/:id", authenticateUser, requireCreator, async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;

    const project = await prisma.course.findUnique({ where: { id } });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.creatorId !== user.id && user.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Delete related records (Prisma will handle Cascade if set in schema, otherwise we do it manually)
    // Assuming we want to keep purchases but delete course structure
    await prisma.course.delete({ where: { id } });

    // Invalidate caches
    await deleteCache(CacheKeys.CREATOR_PROJECTS(user.id));
    await deleteCache(CacheKeys.CREATOR_PROJECT(id));
    await deleteCachePattern("cache:search:*");

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

const LIBRARY_ID = process.env.BUNNY_LIBRARY_ID || "645588";
const API_KEY    = process.env.BUNNY_STREAM_API_KEY || "682128ff-78af-48f1-a9e70913d121-3e4d-45b3";
const CDN_HOST   = process.env.BUNNY_CDN_HOSTNAME || "vz-82a5778a-b1c.b-cdn.net";

function createBunnySlot(title: string, collectionId?: string): Promise<{ guid: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ title, ...(collectionId ? { collectionId } : {}) });
    const req = https.request({
      hostname: "video.bunnycdn.com",
      path: `/library/${LIBRARY_ID}/videos`,
      method: "POST",
      headers: { AccessKey: API_KEY, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// POST /api/creator/projects/:id/videos
router.post("/projects/:id/videos", authenticateUser, requireCreator, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { id: courseId } = req.params;

    const course = await prisma.course.findFirst({ where: { id: courseId, creatorId: user.id } });
    if (!course) return res.status(404).json({ error: "Project not found" });

    const { title, duration, isFreePreview, thumbnailUrl, bunnyVideoId: existingBunnyId, moduleTitle } = req.body;
    if (!title) return res.status(400).json({ error: "title required" });

    let bunnyVideoId = existingBunnyId;
    let embedUrl = "";
    let autoThumbUrl = "";

    if (!bunnyVideoId) {
      const bunnyTitle = `${user.id}/${course.category}/${course.title}/${moduleTitle || "Part-1"}/${title}`;
      const slot = await createBunnySlot(bunnyTitle);
      if (!slot?.guid) return res.status(500).json({ error: "Bunny slot creation failed" });
      bunnyVideoId = slot.guid;
    }

    embedUrl     = `https://iframe.mediadelivery.net/embed/${LIBRARY_ID}/${bunnyVideoId}`;
    autoThumbUrl = thumbnailUrl || `https://${CDN_HOST}/${bunnyVideoId}/thumbnail.jpg`;

    const modTitle = moduleTitle || "Part 1";
    let mod = await prisma.module.findFirst({ where: { courseId, title: modTitle } });
    if (!mod) {
      const modCount = await prisma.module.count({ where: { courseId } });
      mod = await prisma.module.create({
        data: { title: modTitle, order: modCount + 1, courseId },
      });
    }

    const videoCount = await prisma.video.count({ where: { moduleId: mod.id } });
    const video = await prisma.video.create({
      data: {
        title,
        videoUrl: embedUrl,
        duration: duration ? parseInt(duration) : null,
        order: videoCount + 1,
        isFreePreview: isFreePreview === true,
        moduleId: mod.id,
        isVerified: user.isVerified || false, // Auto-verify if creator is already verified
      },
    });

    if (!course.thumbnail) {
      await prisma.course.update({ where: { id: courseId }, data: { thumbnail: autoThumbUrl } });
    }

    // Invalidate caches
    await deleteCache(CacheKeys.CREATOR_PROJECTS(user.id));
    await deleteCache(CacheKeys.CREATOR_PROJECT(courseId));
    await deleteCachePattern("cache:search:*");

    res.status(201).json({
      video,
      bunnyVideoId,
      embedUrl,
      streamUrl: `https://${CDN_HOST}/${bunnyVideoId}/playlist.m3u8`,
      thumbnailUrl: autoThumbUrl,
      uploadUrl: `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/${bunnyVideoId}`,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/creator/projects/:id/videos
router.get("/projects/:id/videos", authenticateUser, requireCreator, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { id: courseId } = req.params;

    const course = await prisma.course.findFirst({
      where: { id: courseId, creatorId: user.id },
      include: {
        modules: {
          orderBy: { order: "asc" },
          include: { videos: { orderBy: { order: "asc" } } },
        },
      },
    });
    if (!course) return res.status(404).json({ error: "Not found" });
    res.json({ course });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /api/creator/videos/:videoId
router.patch("/videos/:videoId", authenticateUser, requireCreator, async (req, res) => {
  try {
    const user = req.user!;
    const { videoId } = req.params;
    const { title, isPublished, isFreePreview, order } = req.body;

    // Verify ownership
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      include: { module: { include: { course: true } } }
    });

    if (!video) return res.status(404).json({ error: "Video not found" });
    if (video.module.course.creatorId !== user.id && user.role !== "ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const updated = await prisma.video.update({
      where: { id: videoId },
      data: {
        ...(title !== undefined && { title }),
        ...(isPublished !== undefined && { isPublished }),
        ...(isFreePreview !== undefined && { isFreePreview }),
        ...(order !== undefined && { order }),
      }
    });

    // Invalidate project cache
    await deleteCache(CacheKeys.CREATOR_PROJECT(video.module.course.id));

    res.json({ video: updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
