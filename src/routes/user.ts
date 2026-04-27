import { Router } from "express";
import { authenticateUser } from "../middlewares/auth";
import prisma from "../config/prisma";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import { getCache, setCache, deleteCache } from "../utils/cache";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

router.get("/me", authenticateUser, async (req, res) => {
  try {
    const user = req.user!;
    const cacheKey = `cache:user:me:full:${user.id}`;
    
    const cachedData = await getCache(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }
    
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
    });

    if (!dbUser) return res.status(404).json({ error: "User not found" });

    const responseData = {
      user: {
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        role: dbUser.role,
        avatar: dbUser.avatar,
        about: dbUser.about,
        phone: dbUser.phone,
        address: dbUser.address,
        legalName: dbUser.legalName,
        instagram: dbUser.instagram,
        youtube: dbUser.youtube,
        category: dbUser.category,
        experience: dbUser.experience,
        upiId: dbUser.upiId,
        bankAccount: dbUser.bankAccount,
      },
      pending: dbUser.role === "STUDENT" && !!dbUser.legalName,
    };

    await setCache(cacheKey, responseData, 300); // 5 min cache (lower for updates)

    res.json(responseData);
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/upgrade", authenticateUser, async (req, res) => {
  try {
    const user = req.user!;
    const { upiId, bankAccount, phone, address, legalName, instagram, youtube, category, experience } = req.body;

    await prisma.user.update({
      where: { id: user.id },
      data: { 
        // We don't grant CREATOR role here anymore, Admin will do it.
        isVerified: false,
        ...(upiId && { upiId }),
        ...(bankAccount && { bankAccount }),
        ...(phone && { phone }),
        ...(address && { address }),
        ...(legalName && { legalName }),
        ...(instagram && { instagram }),
        ...(youtube && { youtube }),
        ...(category && { category }),
        ...(experience && { experience }),
      }
    });

    // Invalidate cache
    await deleteCache(`cache:user:me:${user.id}`);

    res.json({ success: true });
  } catch (error: any) {
    console.error("Upgrade error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

router.put("/profile", authenticateUser, upload.single("file"), async (req, res) => {
  try {
    const user = req.user!;
    const { name, about } = req.body;
    const file = req.file;

    let avatarUrl = undefined;

    if (file && file.size > 0) {
      const fileExt = file.originalname.split('.').pop();
      const fileName = `${user.id}-${Date.now()}.${fileExt}`;
      
      try {
        await supabase.storage.createBucket('avatars', { public: true });
      } catch (e) {}

      const { error } = await supabase.storage
        .from('avatars')
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          cacheControl: '3600',
          upsert: true
        });

      if (error) {
        return res.status(500).json({ error: "Image upload failed." });
      }

      const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(fileName);
        
      avatarUrl = publicUrl;
    }

    const updateData: any = {};
    if (name) updateData.name = name;
    if (about !== undefined) updateData.about = about;
    if (avatarUrl) updateData.avatar = avatarUrl;

    if (Object.keys(updateData).length > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: updateData
      });
    }

    // Invalidate cache
    await deleteCache(`cache:user:me:${user.id}`);

    res.json({ success: true, avatarUrl, name });
  } catch (error: any) {
    console.error("Update profile error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
