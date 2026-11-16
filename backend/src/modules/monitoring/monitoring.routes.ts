import type { FastifyInstance } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { MonitoringService } from './monitoring.service.js';

export function registerMonitoringRoutes(
  app: FastifyInstance,
  deps: { db: Database; backupDir?: string },
): void {
  const service = new MonitoringService(deps.db, deps.backupDir);

  // Authenticated operational telemetry endpoint
  app.get(
    '/telemetry',
    {
      config: {
        permission: 'org.settings.read',
      },
    },
    async () => {
      const telemetry = await service.collectTelemetry();
      return { success: true, data: telemetry };
    },
  );

  // Operator liveness and backup freshness summary probe
  app.get(
    '/health',
    {
      config: {
        permission: 'org.settings.read',
      },
    },
    async (_req, reply) => {
      const telemetry = await service.collectTelemetry();
      if (telemetry.status === 'CRITICAL') {
        return reply.status(503).send({
          status: 'UNHEALTHY',
          database: telemetry.database.status,
          backups: telemetry.backups.status,
          storage: telemetry.storage.status,
        });
      }
      return {
        status: telemetry.status,
        database: telemetry.database.status,
        backups: telemetry.backups.status,
        storage: telemetry.storage.status,
        uptimeSeconds: telemetry.api.uptimeSeconds,
      };
    },
  );
}
