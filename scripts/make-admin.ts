import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = "nietlab123@gmail.com";

  const user = await prisma.user.updateMany({
    where: { email },
    data: { role: "ADMIN", isVerified: true },
  });

  if (user.count === 0) {
    console.log(`❌ No user found with email: ${email}`);
    console.log("   Make sure the user has logged in at least once first.");
  } else {
    console.log(`✅ Successfully granted ADMIN role to: ${email}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
