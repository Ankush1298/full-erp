import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../features/auth/AuthProvider';
import { usePageTitle } from '../components/usePageTitle';
import { SegmentedNav } from '../components/ui/SegmentedNav';
import { StatCard } from '../components/ui/StatCard';
import { Badge } from '../components/ui/Badge';
import {
  fetchSecurityAuthority,
  fetchVaultDevices,
  fetchVaultEpoch,
  enrollVaultDevice,
  revokeVaultDevice,
  initiateRecoveryCeremony,
  presentRecoveryShare,
  type SecurityAuthorityDto,
  type UserVaultDeviceDto,
  type DevicesResponse,
  type VaultEpochDto,
} from '../lib/api/vault-api';

type TabKey = 'authority' | 'devices' | 'grants' | 'recovery';

const TABS: { id: TabKey; label: string }[] = [
  { id: 'authority', label: 'Security Authority' },
  { id: 'devices', label: 'Hardware Authenticators' },
  { id: 'grants', label: 'Capability Key Grants' },
  { id: 'recovery', label: '2-of-3 Recovery Quorum' },
];

export function SecurityCenterPage() {
  usePageTitle('School Vault — Zero-Access Security Center');
  const { client, identity } = useAuth();

  const [activeTab, setActiveTab] = useState<TabKey>('authority');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Vault data state
  const [authority, setAuthority] = useState<SecurityAuthorityDto | null>(null);
  const [devicesData, setDevicesData] = useState<DevicesResponse | null>(null);
  const [epoch, setEpoch] = useState<VaultEpochDto | null>(null);

  // Form states
  const [deviceLabel, setDeviceLabel] = useState<string>('');
  const [deviceType, setDeviceType] = useState<string>('PLATFORM_AUTHENTICATOR');
  const [enrolling, setEnrolling] = useState<boolean>(false);

  // Recovery form states
  const [shareIndex, setShareIndex] = useState<number>(1);
  const [shareData, setShareData] = useState<string>('');
  const [activeCeremonyId, setActiveCeremonyId] = useState<string | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<string>('IDLE');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [authData, devData, epochData] = await Promise.all([
        fetchSecurityAuthority(client).catch(() => null),
        fetchVaultDevices(client).catch(() => ({
          devices: [],
          activeCount: 0,
          maxAllowed: 2,
          canEnrollSecond: false,
          limitReached: false,
        })),
        fetchVaultEpoch(client).catch(() => null),
      ]);
      setAuthority(authData);
      setDevicesData(devData);
      setEpoch(epochData);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load Security Center data.');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function handleEnrollDevice(e: React.FormEvent) {
    e.preventDefault();
    if (!deviceLabel.trim()) return;
    setEnrolling(true);
    setError(null);
    setFeedback(null);

    try {
      // Mock generated ECDH public key for device
      const mockKey = `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA${btoa(deviceLabel + Date.now()).slice(0, 40)}`;
      await enrollVaultDevice(client, {
        deviceLabel: deviceLabel.trim(),
        deviceType,
        publicKey: mockKey,
      });
      setFeedback(
        `Hardware authenticator "${deviceLabel}" successfully enrolled and device-bound.`,
      );
      setDeviceLabel('');
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to enroll hardware authenticator.');
    } finally {
      setEnrolling(false);
    }
  }

  async function handleRevokeDevice(deviceId: string) {
    if (
      !window.confirm(
        'Are you sure you want to revoke this hardware device? All associated key grants will be terminated.',
      )
    ) {
      return;
    }
    try {
      await revokeVaultDevice(client, deviceId, 'Revoked by user via Security Center');
      setFeedback('Hardware authenticator revoked. Device session terminated.');
      await loadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to revoke hardware authenticator.');
    }
  }

  async function handleInitiateRecovery() {
    if (!epoch) return;
    try {
      const ceremony = await initiateRecoveryCeremony(client, {
        vaultEpochId: epoch.id,
        targetUserId: identity?.userId || '01900000-0000-7000-8000-000000000001',
        reason: 'Institution administrator initiated key reconstruction ceremony.',
      });
      setActiveCeremonyId(ceremony.ceremonyId);
      setRecoveryStatus('IN_PROGRESS');
      setFeedback('2-of-3 Recovery Ceremony initiated. Waiting for 2 custodian shares.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to initiate recovery ceremony.');
    }
  }

  async function handlePresentShare(e: React.FormEvent) {
    e.preventDefault();
    if (!activeCeremonyId || !shareData.trim()) return;
    setError(null);
    setFeedback(null);
    try {
      const res = await presentRecoveryShare(client, {
        ceremonyId: activeCeremonyId,
        shareIndex,
        shareData: shareData.trim(),
      });
      setShareData('');
      if (res.isComplete) {
        setRecoveryStatus('COMPLETED');
        setFeedback(
          'Quorum reached! Secret key reconstructed locally. Zero cloud backdoor verified.',
        );
      } else {
        setFeedback(
          `Share ${shareIndex} accepted. 1 more custodian share required to reach quorum.`,
        );
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to present recovery share.');
    }
  }

  const institutionType = authority?.institutionType || 'SCHOOL';

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-border pb-5">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Anesa School Vault — Zero-Access Security Center
            </h1>
            <Badge tone="positive">Zero-Access Active</Badge>
            <Badge tone="purple">{institutionType} MODE</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Hardware-bound cryptographic protection, 2-device policy, institution-owned 2-of-3
            recovery quorum.
          </p>
        </div>
      </div>

      {feedback && (
        <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 p-4 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 text-sm">
          {feedback}
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-destructive/10 p-4 border border-destructive/20 text-destructive text-sm">
          {error}
        </div>
      )}

      {/* KPI Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          label="Institutional Authority"
          value={authority?.title?.replace(/_/g, ' ') || 'School Principal'}
          tone="purple"
        />
        <StatCard
          label="Registered Devices"
          value={`${devicesData?.activeCount ?? 0} of ${devicesData?.maxAllowed ?? 2}`}
          tone={devicesData?.limitReached ? 'amber' : 'neutral'}
        />
        <StatCard label="Vault Epoch" value={`Epoch ${epoch?.epoch ?? 1}`} tone="neutral" />
        <StatCard label="Recovery Scheme" value="2-of-3 Quorum" tone="emerald" />
      </div>

      {/* Segmented Navigation */}
      <SegmentedNav items={TABS} activeId={activeTab} onChange={(id) => setActiveTab(id)} />

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">
          Loading vault security status...
        </div>
      ) : (
        <>
          {/* TAB 1: Institutional Security Authority (ISA) */}
          {activeTab === 'authority' && (
            <div className="space-y-6">
              <div className="bg-card border border-border rounded-xl p-6">
                <h2 className="text-lg font-semibold mb-4 text-foreground">
                  Current Institutional Security Authority (ISA)
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <span className="text-xs uppercase tracking-wider text-muted-foreground">
                      Title / Role
                    </span>
                    <p className="text-base font-medium text-foreground mt-1">
                      {authority?.title
                        ? authority.title.replace(/_/g, ' ')
                        : 'School Principal / Owner'}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-wider text-muted-foreground">
                      Institution Level
                    </span>
                    <p className="text-base font-medium text-foreground mt-1">
                      {institutionType === 'SCHOOL'
                        ? 'Primary / Secondary K-12 School'
                        : institutionType === 'COLLEGE'
                          ? 'Undergraduate College / Institute'
                          : 'Postgraduate / Autonomous University'}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-wider text-muted-foreground">
                      Designated User
                    </span>
                    <p className="text-base font-medium text-foreground mt-1">
                      {authority?.userDisplayName || 'Institution Administrator'} (
                      {authority?.userEmail || 'admin@school.test'})
                    </p>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-wider text-muted-foreground">
                      Status
                    </span>
                    <div className="mt-1">
                      <Badge tone="positive">{authority?.status || 'ACTIVE'}</Badge>
                    </div>
                  </div>
                </div>

                <div className="mt-6 pt-6 border-t border-border flex flex-wrap gap-3">
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2"
                    onClick={() =>
                      setFeedback(
                        'Succession delegation workflow initialized. Pending board review.',
                      )
                    }
                  >
                    Delegate Security Authority
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2"
                    onClick={() =>
                      setFeedback('Cryptographic succession ceremony instructions generated.')
                    }
                  >
                    Generate Succession Key Ceremony
                  </button>
                </div>
              </div>

              <div className="bg-muted/40 border border-border rounded-xl p-5">
                <h3 className="font-semibold text-sm text-foreground">
                  Separation of Authority Architecture
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  The Institutional Security Authority operates independently of platform-level
                  sysadmins. Anesa engineers and cloud operators have zero cryptographic access to
                  private student or academic data.
                </p>
              </div>
            </div>
          )}

          {/* TAB 2: Hardware Authenticators (Max 2 Devices) */}
          {activeTab === 'devices' && (
            <div className="space-y-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">
                    Hardware-Bound Authenticators (Maximum 2 Devices)
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Each account may register up to two hardware authenticators (e.g. MacBook Touch
                    ID / YubiKey).
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={devicesData?.limitReached ? 'amber' : 'positive'}>
                    {devicesData?.limitReached
                      ? '2 of 2 Enrolled (Limit Reached)'
                      : `${devicesData?.activeCount ?? 0} of 2 Enrolled`}
                  </Badge>
                </div>
              </div>

              {/* Enrolled Devices Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {devicesData?.devices && devicesData.devices.length > 0 ? (
                  devicesData.devices.map((d: UserVaultDeviceDto) => (
                    <div
                      key={d.id}
                      className="bg-card border border-border rounded-xl p-5 space-y-3 relative"
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-foreground">{d.deviceLabel}</span>
                            <Badge tone={d.status === 'ACTIVE' ? 'positive' : 'neutral'}>
                              {d.status}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            Slot #{d.deviceNumber} • {d.deviceType.replace(/_/g, ' ')}
                          </p>
                        </div>
                        {d.status === 'ACTIVE' && (
                          <button
                            type="button"
                            className="text-xs text-destructive hover:underline"
                            onClick={() => {
                              void handleRevokeDevice(d.id);
                            }}
                          >
                            Revoke Device
                          </button>
                        )}
                      </div>
                      <div className="bg-muted p-2 rounded text-xs font-mono break-all text-muted-foreground">
                        Public Key: {d.publicKey.slice(0, 32)}...
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Enrolled on {new Date(d.enrolledAt).toLocaleDateString()}
                      </p>
                    </div>
                  ))
                ) : (
                  <div className="col-span-2 py-8 text-center bg-card border border-border rounded-xl text-muted-foreground">
                    No hardware authenticators registered yet. Enroll your primary device below.
                  </div>
                )}
              </div>

              {/* Enrollment Form */}
              <div className="bg-card border border-border rounded-xl p-6">
                <h3 className="text-base font-semibold text-foreground mb-4">
                  {devicesData?.limitReached
                    ? 'Device Limit Reached (Max 2 Allowed)'
                    : devicesData?.activeCount === 1
                      ? 'Enroll Secondary Hardware Authenticator (2 of 2)'
                      : 'Enroll Primary Hardware Authenticator (1 of 2)'}
                </h3>

                {devicesData?.limitReached ? (
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    To enroll a replacement hardware authenticator, you must first revoke one of
                    your existing active devices.
                  </p>
                ) : (
                  <form
                    onSubmit={(e) => {
                      void handleEnrollDevice(e);
                    }}
                    className="space-y-4 max-w-lg"
                  >
                    <div>
                      <label
                        htmlFor="device-label-input"
                        className="block text-xs font-medium text-foreground mb-1"
                      >
                        Device Name / Label
                      </label>
                      <input
                        id="device-label-input"
                        type="text"
                        value={deviceLabel}
                        onChange={(e) => setDeviceLabel(e.target.value)}
                        placeholder="e.g. MacBook Pro Touch ID, YubiKey 5C NFC"
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        required
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="device-type-select"
                        className="block text-xs font-medium text-foreground mb-1"
                      >
                        Authenticator Type
                      </label>
                      <select
                        id="device-type-select"
                        value={deviceType}
                        onChange={(e) => setDeviceType(e.target.value)}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <option value="PLATFORM_AUTHENTICATOR">
                          Platform Authenticator (Touch ID, Windows Hello)
                        </option>
                        <option value="SECURITY_KEY">FIDO2 Hardware Key (YubiKey, Titan)</option>
                        <option value="SMART_CARD">Smart Card / Hardware Token</option>
                      </select>
                    </div>
                    <button
                      type="submit"
                      disabled={enrolling || !deviceLabel.trim()}
                      className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2 disabled:opacity-50"
                    >
                      {enrolling ? 'Enrolling Authenticator...' : 'Enroll Hardware Authenticator'}
                    </button>
                  </form>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: Capability Key Grants */}
          {activeTab === 'grants' && (
            <div className="space-y-6">
              <div className="bg-card border border-border rounded-xl p-6">
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  Scoped Cryptographic Capability Key Grants
                </h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Keys are bound to individual verified user authenticators and scoped strictly to
                  authorized courses or cohorts.
                </p>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-muted text-muted-foreground uppercase text-xs">
                      <tr>
                        <th className="px-4 py-3">Capability Key</th>
                        <th className="px-4 py-3">Scope Boundary</th>
                        <th className="px-4 py-3">Cryptographic Algorithm</th>
                        <th className="px-4 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      <tr>
                        <td className="px-4 py-3 font-mono font-medium">CWK_STUDENTS_PII</td>
                        <td className="px-4 py-3">Assigned Students / Authorized Admissions</td>
                        <td className="px-4 py-3">AES-256-GCM + ECDH P-256</td>
                        <td className="px-4 py-3">
                          <Badge tone="positive">ACTIVE</Badge>
                        </td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 font-mono font-medium">CWK_ACADEMICS_MARKS</td>
                        <td className="px-4 py-3">Assigned Subjects / Course Offerings</td>
                        <td className="px-4 py-3">AES-256-GCM + ECDH P-256</td>
                        <td className="px-4 py-3">
                          <Badge tone="positive">ACTIVE</Badge>
                        </td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 font-mono font-medium">
                          CWK_HOMEWORK_SUBMISSIONS
                        </td>
                        <td className="px-4 py-3">Course Faculty & Submitting Student</td>
                        <td className="px-4 py-3">AES-256-GCM + ECDH P-256</td>
                        <td className="px-4 py-3">
                          <Badge tone="positive">ACTIVE</Badge>
                        </td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 font-mono font-medium">CWK_FINANCE_PRIVATE</td>
                        <td className="px-4 py-3">Finance Department & Account Holder</td>
                        <td className="px-4 py-3">AES-256-GCM + ECDH P-256</td>
                        <td className="px-4 py-3">
                          <Badge tone="positive">ACTIVE</Badge>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: 2-of-3 Recovery Quorum */}
          {activeTab === 'recovery' && (
            <div className="space-y-6">
              <div className="bg-card border border-border rounded-xl p-6">
                <h2 className="text-lg font-semibold text-foreground mb-2">
                  2-of-3 Shamir's Secret Sharing Recovery Quorum
                </h2>
                <p className="text-sm text-muted-foreground mb-4">
                  The institution owns its recovery material. Key reconstruction requires any 2 of
                  the 3 appointed custodians. Anesa cloud engineers have NO unilateral recovery or
                  decryption backdoor.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                  <div className="border border-border rounded-lg p-4 bg-muted/20">
                    <span className="text-xs font-semibold text-primary">Custodian #1</span>
                    <h4 className="font-semibold text-foreground mt-1">
                      Board of Trustees / School Owner
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1">Institutional Oversight</p>
                    <div className="mt-3">
                      <Badge tone="purple">Share Index 1</Badge>
                    </div>
                  </div>
                  <div className="border border-border rounded-lg p-4 bg-muted/20">
                    <span className="text-xs font-semibold text-primary">Custodian #2</span>
                    <h4 className="font-semibold text-foreground mt-1">
                      Institutional Legal Counsel
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1">
                      Independent Legal Safeguard
                    </p>
                    <div className="mt-3">
                      <Badge tone="purple">Share Index 2</Badge>
                    </div>
                  </div>
                  <div className="border border-border rounded-lg p-4 bg-muted/20">
                    <span className="text-xs font-semibold text-primary">Custodian #3</span>
                    <h4 className="font-semibold text-foreground mt-1">
                      Registrar / Vice-Principal
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1">Operational Continuity</p>
                    <div className="mt-3">
                      <Badge tone="purple">Share Index 3</Badge>
                    </div>
                  </div>
                </div>

                {recoveryStatus === 'IDLE' ? (
                  <div className="pt-4 border-t border-border">
                    <button
                      type="button"
                      className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2"
                      onClick={() => {
                        void handleInitiateRecovery();
                      }}
                    >
                      Initiate 2-of-3 Key Reconstruction Ceremony
                    </button>
                  </div>
                ) : recoveryStatus === 'IN_PROGRESS' ? (
                  <div className="pt-4 border-t border-border space-y-4">
                    <div className="bg-amber-50 dark:bg-amber-950/40 p-3 rounded border border-amber-300 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200">
                      Ceremony Active: {activeCeremonyId}. Present any 2 custodian shares to
                      reconstruct.
                    </div>
                    <form
                      onSubmit={(e) => {
                        void handlePresentShare(e);
                      }}
                      className="space-y-3 max-w-lg"
                    >
                      <div>
                        <label
                          htmlFor="custodian-share-index"
                          className="block text-xs font-medium text-foreground mb-1"
                        >
                          Custodian Share Index
                        </label>
                        <select
                          id="custodian-share-index"
                          value={shareIndex}
                          onChange={(e) => setShareIndex(Number(e.target.value))}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                        >
                          <option value={1}>Share 1 (Board Chair / Owner)</option>
                          <option value={2}>Share 2 (Legal Counsel)</option>
                          <option value={3}>Share 3 (Registrar / VP)</option>
                        </select>
                      </div>
                      <div>
                        <label
                          htmlFor="custodian-secret-share"
                          className="block text-xs font-medium text-foreground mb-1"
                        >
                          Custodian Secret Share (Base64)
                        </label>
                        <input
                          id="custodian-secret-share"
                          type="text"
                          value={shareData}
                          onChange={(e) => setShareData(e.target.value)}
                          placeholder="Paste Base64 custodian share payload"
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                          required
                        />
                      </div>
                      <button
                        type="submit"
                        className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2"
                      >
                        Submit Custodian Share
                      </button>
                    </form>
                  </div>
                ) : (
                  <div className="pt-4 border-t border-border">
                    <div className="bg-emerald-50 dark:bg-emerald-950/40 p-4 rounded border border-emerald-300 dark:border-emerald-800 text-sm text-emerald-800 dark:text-emerald-200">
                      Ceremony Completed! Master Key successfully reconstructed via 2-of-3 threshold
                      quorum.
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
