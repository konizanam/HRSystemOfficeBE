// `pnpm jobs:run [name] [json-data]`: runs one registered job now, in-process, exactly as the
// scheduler would (the run is audited SYSTEM.JOB_RUN with its counts). Without a name it lists the
// jobs and their schedules. Use it to re-run a failed or missed job (see docs/RUNBOOK.md).
import './jobs-env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { JobsService } from '../jobs/jobs.service';

async function main(): Promise<void> {
  const [name, json] = process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const jobs = app.get(JobsService);
    if (!name) {
      for (const job of jobs.registeredJobs())
        console.log(`${job.name.padEnd(36)} ${job.cron ?? '(on demand)'}`);
      return;
    }
    const data: unknown = json ? JSON.parse(json) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('The job data must be a JSON object, for example {"asOf":"2026-10-01"}');
    }
    const counts = await jobs.runNow(name, data as Record<string, unknown>);
    console.log(`Job ${name} finished`, JSON.stringify(counts));
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
