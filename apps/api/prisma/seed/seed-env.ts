// Imported first by prisma/seed.ts: the seed runs the application context without job workers,
// with in-memory email (no real messages to the seeded addresses) and quiet logs. dotenv never
// overrides variables that are already set, so these win over .env.
process.env.JOBS_ENABLED = 'false';
process.env.MAIL_TRANSPORT = 'memory';
process.env.LOG_LEVEL = process.env.SEED_LOG_LEVEL ?? 'warn';
