// `pnpm audit:verify [--from=ISO] [--to=ISO]`: recomputes the audit hash chain (section 9.3).
import 'reflect-metadata';
import { AuditService } from '../audit/audit.service';
import { env } from '../config/env';
import { DbService } from '../prisma/db.service';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const db = DbService.forUrl(env().DATABASE_URL);
  const audit = new AuditService(db);
  const from = arg('from');
  const to = arg('to');
  try {
    const result = await audit.verify({
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`Audit chain BROKEN at id ${result.firstBrokenId}: ${result.reason}`);
      process.exitCode = 1;
    } else {
      console.log(`Audit chain OK (${result.checked} rows)`);
    }
  } finally {
    await db.prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
