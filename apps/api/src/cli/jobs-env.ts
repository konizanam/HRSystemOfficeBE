// Imported first by jobs-run.ts: the CLI runs one job in-process, so the application context
// starts without pg-boss workers or cron schedules (a running API keeps its own). dotenv never
// overrides variables that are already set, so this wins over .env.
process.env.JOBS_ENABLED = 'false';
