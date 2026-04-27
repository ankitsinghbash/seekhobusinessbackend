# Seekho Business Backend

Professional Node.js backend for the Seekho Business learning platform.

## Features
- **User Management**: Authentication via Supabase.
- **Creator Studio**: Video upload and management.
- **Course Library**: Search and purchase courses.
- **Admin Panel**: User verification and creator management.
- **Caching**: Redis-powered performance optimization.
- **Database**: PostgreSQL with Prisma ORM.

## Tech Stack
- Node.js & Express
- TypeScript
- Prisma (ORM)
- Supabase (Auth & Storage)
- Redis (Caching)
- Bunny.net (Video Streaming)

## Getting Started
1. Clone the repo.
2. Install dependencies: `npm install`.
3. Set up environment variables in `.env`.
4. Run migrations: `npx prisma migrate dev`.
5. Start development: `npm run dev`.
