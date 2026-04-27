import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function updateDB() {
  const course = await prisma.course.findFirst({
    where: { title: { contains: 'History of Modern India' } }
  });
  
  if (course) {
    await prisma.course.update({
      where: { id: course.id },
      data: { thumbnail: 'https://skills.sikhobusiness.com/wp-content/uploads/2025/02/17-768x1067.png' }
    });
    console.log('Updated course thumbnail for:', course.title);
  } else {
    console.log('Course not found');
  }
}

updateDB().catch(console.error).finally(() => {
  prisma.$disconnect();
});
