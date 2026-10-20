import { Controller, Get, Header, HttpCode, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { JobsService } from '../jobs/jobs.service';
import { metricsRegistry } from '../metrics/registry';
import { DbService } from '../prisma/db.service';

/** Liveness, readiness and Prometheus metrics (section 15). Served outside /api/v1. */
@ApiExcludeController()
@Controller()
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsService,
  ) {}

  @Get('health')
  @HttpCode(200)
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ready'; db: 'ok'; queue: 'ok' | 'disabled' }> {
    try {
      await this.db.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException('Database is not reachable');
    }
    if (!this.jobs.isHealthy()) throw new ServiceUnavailableException('Job queue is not running');
    return { status: 'ready', db: 'ok', queue: this.jobs.registeredJobs().length ? 'ok' : 'disabled' };
  }

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4')
  async metrics(): Promise<string> {
    return metricsRegistry.metrics();
  }
}
