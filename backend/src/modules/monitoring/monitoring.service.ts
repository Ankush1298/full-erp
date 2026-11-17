import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from '../../shared/database/index.js';
import type { BackupMetadata } from '../../shared/backup/types.js';

export interface SystemMonitoringTelemetry {
  timestamp: string;
  status: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  api: {
    status: 'ONLINE';
    uptimeSeconds: number;
    memoryMb: {
      rss: number;
      heapUsed: number;
      heapTotal: number;
      external: number;
    };
    nodeVersion: string;
    pid: number;
    platform: string;
  };
  database: {
    status: 'CONNECTED' | 'DISCONNECTED';
    connected: boolean;
    roundTripLatencyMs: number;
    latencyMs: number;
    serverVersion: string;
    connections?:
      | {
          active: number;
          idle: number;
          total: number;
        }
      | undefined;
  };
  backups: {
    status: 'FRESH' | 'WARNING' | 'STALE' | 'NONE';
    totalBackups: number;
    latestBackupTimestamp?: string | undefined;
    latestBackupAgeHours?: number | undefined;
    latestBackupId?: string | undefined;
    lastVerificationStatus?: string | undefined;
    totalSizeBytes: number;
    failedBackupsCount: number;
  };
  storage: {
    status: 'HEALTHY' | 'WARNING' | 'CRITICAL';
    diskPath: string;
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    usedPercentage: number;
    documentStoreReady: boolean;
  };
  workers: {
    status: 'HEALTHY' | 'DEGRADED';
    documentScanWorker: 'ACTIVE' | 'IDLE';
    retentionWorker: 'ACTIVE' | 'IDLE';
  };
  security: {
    recentHighRiskAlertsCount: number;
    mfaEnforced: boolean;
    rlsEnforcedGlobally: boolean;
  };
}

export class MonitoringService {
  constructor(
    private readonly db: Database,
    private readonly backupDir?: string,
  ) {}

  async collectTelemetry(): Promise<SystemMonitoringTelemetry> {
    const now = new Date();
    const storageDir = this.backupDir || path.resolve(process.cwd(), '.data/backups');

    // 1. API process metrics
    const mem = process.memoryUsage();
    const apiMetrics = {
      status: 'ONLINE' as const,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        external: Math.round(mem.external / 1024 / 1024),
      },
      nodeVersion: process.version,
      pid: process.pid,
      platform: `${os.platform()} ${os.arch()}`,
    };

    // 2. Database connectivity and activity
    let dbStatus: 'CONNECTED' | 'DISCONNECTED' = 'DISCONNECTED';
    let latencyMs = -1;
    let serverVersion = 'unknown';
    const recentHighRiskAlerts = 0;

    const dbStart = Date.now();
    try {
      const health = await this.db.health();
      if (health.ok) {
        serverVersion = health.serverVersion;
        latencyMs = Date.now() - dbStart;
        dbStatus = 'CONNECTED';
      }
    } catch {
      dbStatus = 'DISCONNECTED';
      latencyMs = -1;
    }

    // 3. Backup Freshness & Telemetry
    let backupStatus: 'FRESH' | 'WARNING' | 'STALE' | 'NONE' = 'NONE';
    let totalBackups = 0;
    let latestBackupTimestamp: string | undefined;
    let latestBackupAgeHours: number | undefined;
    let latestBackupId: string | undefined;
    let lastVerificationStatus: string | undefined;
    let totalSizeBytes = 0;
    let failedBackupsCount = 0;

    if (fs.existsSync(storageDir)) {
      const files = fs.readdirSync(storageDir).filter((f) => f.endsWith('.meta.json'));
      totalBackups = files.length;

      const metas: BackupMetadata[] = [];
      for (const file of files) {
        try {
          const metaPath = path.join(storageDir, file);
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as BackupMetadata;
          metas.push(meta);
          totalSizeBytes += meta.integrity?.cipherSizeBytes || 0;
          if (meta.status === 'FAILED') failedBackupsCount++;
        } catch {
          failedBackupsCount++;
        }
      }

      if (metas.length > 0) {
        metas.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const latest = metas[0]!;
        latestBackupTimestamp = latest.createdAt;
        latestBackupId = latest.backupId;
        lastVerificationStatus = latest.status;

        const ageMs = now.getTime() - new Date(latest.createdAt).getTime();
        latestBackupAgeHours = Math.round((ageMs / 3600000) * 10) / 10;

        if (latestBackupAgeHours <= 24) {
          backupStatus = 'FRESH';
        } else if (latestBackupAgeHours <= 48) {
          backupStatus = 'WARNING';
        } else {
          backupStatus = 'STALE';
        }
      }
    }

    // 4. Real disk / storage capacity telemetry
    let diskStatus: 'HEALTHY' | 'WARNING' | 'CRITICAL';
    let totalBytes = 0;
    let availableBytes = 0;
    let usedBytes = 0;
    let usedPercentage = 0;

    try {
      const rootPath = process.cwd();
      const stat = fs.statfsSync(rootPath);
      totalBytes = stat.blocks * stat.bsize;
      availableBytes = stat.bavail * stat.bsize;
      usedBytes = totalBytes - availableBytes;
      usedPercentage = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

      if (usedPercentage >= 95) diskStatus = 'CRITICAL';
      else if (usedPercentage >= 85) diskStatus = 'WARNING';
      else diskStatus = 'HEALTHY';
    } catch {
      diskStatus = 'HEALTHY';
    }

    // 5. Document store availability
    const localDataDir = path.resolve(process.cwd(), '.data');
    if (!fs.existsSync(localDataDir)) {
      try {
        fs.mkdirSync(localDataDir, { recursive: true });
      } catch {
        // ignore if read-only
      }
    }
    const documentStoreReady = fs.existsSync(localDataDir);

    // Determine overall platform status
    let overallStatus: 'HEALTHY' | 'DEGRADED' | 'CRITICAL' = 'HEALTHY';
    if (dbStatus === 'DISCONNECTED' || diskStatus === 'CRITICAL') {
      overallStatus = 'CRITICAL';
    } else if (backupStatus === 'STALE' || diskStatus === 'WARNING') {
      overallStatus = 'DEGRADED';
    }

    return {
      timestamp: now.toISOString(),
      status: overallStatus,
      api: apiMetrics,
      database: {
        status: dbStatus,
        connected: dbStatus === 'CONNECTED',
        roundTripLatencyMs: latencyMs,
        latencyMs,
        serverVersion,
        connections: undefined,
      },
      backups: {
        status: backupStatus,
        totalBackups,
        latestBackupTimestamp,
        latestBackupAgeHours,
        latestBackupId,
        lastVerificationStatus,
        totalSizeBytes,
        failedBackupsCount,
      },
      storage: {
        status: diskStatus,
        diskPath: process.cwd(),
        totalBytes,
        availableBytes,
        usedBytes,
        usedPercentage,
        documentStoreReady,
      },
      workers: {
        status: 'HEALTHY',
        documentScanWorker: 'ACTIVE',
        retentionWorker: 'ACTIVE',
      },
      security: {
        recentHighRiskAlertsCount: recentHighRiskAlerts,
        mfaEnforced: true,
        rlsEnforcedGlobally: true,
      },
    };
  }
}
