import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { StatusBadge } from '../components/ui/StatusBadge';
import { TextField } from '../components/ui/TextField';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import {
  createRoom,
  fetchCampuses,
  fetchDepartments,
  fetchRooms,
  type CampusItem,
  type DepartmentItem,
  type RoomItem,
} from '../lib/api/organisation-api';

type Tab = 'campuses' | 'departments' | 'rooms';

export function OrganisationPage() {
  const { client, identity } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('campuses');
  const [campuses, setCampuses] = useState<CampusItem[]>([]);
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [selectedCampusId, setSelectedCampusId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomNotice, setRoomNotice] = useState<string | null>(null);
  const [roomActionError, setRoomActionError] = useState<string | null>(null);

  // Room Creation Form state
  const [showAddRoom, setShowAddRoom] = useState(false);
  const [rCode, setRCode] = useState('');
  const [rKind, setRKind] = useState('');
  const [rName, setRName] = useState('');
  const [rCapacity, setRCapacity] = useState('');
  const [rPending, setRPending] = useState(false);

  const canManageCampus = Boolean(identity && can(identity, 'org.campus.manage'));

  const roles = identity?.roles ?? [];
  const isPrincipal = roles.includes('COLLEGE_ADMIN');
  const isCampusAdmin = roles.includes('CAMPUS_ADMIN');
  const isHOD = roles.includes('HOD') || roles.includes('DEPARTMENT_ADMIN');
  const isTeacher = roles.includes('FACULTY') && !isPrincipal && !isCampusAdmin;
  const isStudentOrParent = (roles.includes('STUDENT') || roles.includes('PARENT')) && !isPrincipal && !isTeacher;

  // Determine dynamic page header title and subtitle based on user role
  let pageTitle = 'Organisation Structure';
  let pageSubtitle = 'Institutional structure records, campuses, academic departments, and physical facilities.';

  if (isPrincipal) {
    pageTitle = 'Organisation Structure & Facilities Administration';
    pageSubtitle = 'Full institutional management: configure campuses, academic departments, rooms, and facility operations.';
  } else if (isCampusAdmin) {
    pageTitle = 'Campus Facilities & Rooms Administration';
    pageSubtitle = 'Campus infrastructure management: configure rooms, facilities, and campus operations.';
  } else if (isHOD) {
    pageTitle = 'Departmental Structure & Facility Directory';
    pageSubtitle = 'Departmental academic structure and allocated classrooms, laboratories, and facilities.';
  } else if (isTeacher) {
    pageTitle = 'Campus & Classroom Facilities Directory';
    pageSubtitle = 'Read-only institutional directory of classrooms, laboratories, lecture halls, and academic departments for timetable reference.';
  } else if (isStudentOrParent) {
    pageTitle = 'Campus & Department Directory';
    pageSubtitle = 'Institutional directory of campuses, departments, and learning facilities.';
  }

  usePageTitle(pageTitle);

  const loadBaseData = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchCampuses(client), fetchDepartments(client)])
      .then(([cList, dList]) => {
        setCampuses(cList);
        setDepartments(dList);
        if (cList.length > 0 && cList[0] && !selectedCampusId) {
          setSelectedCampusId(cList[0].id);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error && err.message && !err.message.startsWith('API ')
            ? err.message
            : 'Failed to load organization structure.',
        );
        setLoading(false);
      });
  }, [client, selectedCampusId]);

  useEffect(() => {
    loadBaseData();
  }, [loadBaseData]);

  const loadRooms = useCallback(
    (campusId: string) => {
      if (!campusId) return;
      setLoadingRooms(true);
      setRoomActionError(null);
      fetchRooms(client, campusId)
        .then((rList) => {
          setRooms(rList);
          setLoadingRooms(false);
        })
        .catch((err: unknown) => {
          setRoomActionError(
            err instanceof Error && err.message && !err.message.startsWith('API ')
              ? err.message
              : 'Failed to load rooms for this campus.',
          );
          setLoadingRooms(false);
        });
    },
    [client],
  );

  useEffect(() => {
    if (activeTab === 'rooms' && selectedCampusId) {
      loadRooms(selectedCampusId);
    }
  }, [activeTab, selectedCampusId, loadRooms]);

  const handleCreateRoom = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedCampusId) return;
    if (!rCode.trim() || !rKind.trim()) {
      setRoomActionError('Room code and kind are required.');
      return;
    }
    setRPending(true);
    setRoomActionError(null);
    setRoomNotice(null);
    try {
      const roomPayload = {
        code: rCode.trim(),
        kind: rKind.trim(),
        ...(rName.trim() ? { name: rName.trim() } : {}),
        ...(rCapacity ? { capacity: parseInt(rCapacity, 10) } : {}),
      };
      await createRoom(client, selectedCampusId, roomPayload);
      setRoomNotice(`Room ${rCode.trim()} created successfully.`);
      setRCode('');
      setRKind('');
      setRName('');
      setRCapacity('');
      setShowAddRoom(false);
      loadRooms(selectedCampusId);
    } catch (err: unknown) {
      setRoomActionError(err instanceof Error ? err.message : 'Failed to create room.');
    } finally {
      setRPending(false);
    }
  };

  return (
    <>
      <PageHeader
        title={pageTitle}
        subtitle={pageSubtitle}
        actions={
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button
              variant={activeTab === 'campuses' ? 'primary' : 'secondary'}
              onClick={() => setActiveTab('campuses')}
              aria-pressed={activeTab === 'campuses'}
            >
              Campuses ({campuses.length})
            </Button>
            <Button
              variant={activeTab === 'departments' ? 'primary' : 'secondary'}
              onClick={() => setActiveTab('departments')}
              aria-pressed={activeTab === 'departments'}
            >
              Departments ({departments.length})
            </Button>
            <Button
              variant={activeTab === 'rooms' ? 'primary' : 'secondary'}
              onClick={() => setActiveTab('rooms')}
              aria-pressed={activeTab === 'rooms'}
            >
              Rooms ({rooms.length})
            </Button>
          </div>
        }
      />

      {/* Role Context Alert Banner */}
      <div style={{ marginBottom: 'var(--space-4)' }}>
        {isPrincipal && (
          <Alert tone="info">
            <strong>Institution Administrator (Principal):</strong> Full administrative access to
            manage campuses, academic departments, and physical facilities. Changes take immediate
            effect across timetables and scheduling.
          </Alert>
        )}
        {isCampusAdmin && (
          <Alert tone="info">
            <strong>Campus Administrator:</strong> Scoped access to manage facilities and physical room
            allocations for this campus.
          </Alert>
        )}
        {isHOD && (
          <Alert tone="info">
            <strong>Department Head (HOD):</strong> Departmental structure view. Physical room
            infrastructure is managed by Campus Operations.
          </Alert>
        )}
        {isTeacher && (
          <Alert tone="info">
            <strong>Teacher / Faculty Directory:</strong> Read-only directory of institutional
            classrooms, laboratories, and lecture halls for timetable reference. Room provisioning
            is restricted to Campus Administrators and Principals.
          </Alert>
        )}
        {isStudentOrParent && (
          <Alert tone="info">
            <strong>Institutional Directory:</strong> Read-only directory of campuses, departments,
            and learning facilities.
          </Alert>
        )}
      </div>

      {error && (
        <ErrorState
          title="Structure error"
          message={error}
          onRetry={loadBaseData}
          retryLabel="Retry"
        />
      )}

      {loading ? (
        <Spinner label="Loading organisation structure…" />
      ) : activeTab === 'campuses' ? (
        campuses.length === 0 ? (
          <EmptyState
            title="No campuses"
            description="No campuses have been created yet."
            compact
          />
        ) : (
          <div className="grid">
            {campuses.map((c) => (
              <Card key={c.id} title={c.name}>
                <div style={{ marginBottom: 'var(--space-2)' }}>
                  <StatusBadge status={c.status} />
                </div>
                <dl className="defs">
                  <dt>Code</dt>
                  <dd>{c.code}</dd>
                  <dt>Timezone</dt>
                  <dd>{c.timezone}</dd>
                </dl>
              </Card>
            ))}
          </div>
        )
      ) : activeTab === 'departments' ? (
        departments.length === 0 ? (
          <EmptyState
            title="No departments"
            description="No departments have been created yet."
            compact
          />
        ) : (
          <div className="grid">
            {departments.map((d) => (
              <Card key={d.id} title={d.name}>
                <div style={{ marginBottom: 'var(--space-2)' }}>
                  <StatusBadge status={d.status} />
                </div>
                <dl className="defs">
                  <dt>Code</dt>
                  <dd>{d.code}</dd>
                  <dt>Campus ID</dt>
                  <dd>{d.campus_id}</dd>
                </dl>
              </Card>
            ))}
          </div>
        )
      ) : (
        /* Rooms Tab */
        <div>
          {roomNotice && <Alert tone="success">{roomNotice}</Alert>}
          {roomActionError && <Alert tone="error">{roomActionError}</Alert>}

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 'var(--space-4)',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <label htmlFor="campus-select">
                <strong>Campus:</strong>
              </label>
              <select
                id="campus-select"
                value={selectedCampusId}
                onChange={(e) => setSelectedCampusId(e.target.value)}
                style={{
                  padding: 'var(--space-1) var(--space-2)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border)',
                }}
              >
                {campuses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.code})
                  </option>
                ))}
              </select>
              {!canManageCampus && (
                <Badge tone="neutral">Read-only facility directory</Badge>
              )}
            </div>

            {canManageCampus && (
              <Button
                variant={showAddRoom ? 'secondary' : 'primary'}
                onClick={() => setShowAddRoom((prev) => !prev)}
              >
                {showAddRoom ? 'Cancel' : 'Add Room'}
              </Button>
            )}
          </div>

          {showAddRoom && canManageCampus && (
            <Card title="Add new room">
              <form
                onSubmit={(e) => {
                  void handleCreateRoom(e);
                }}
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                    gap: 'var(--space-3)',
                  }}
                >
                  <TextField
                    label="Room Code *"
                    value={rCode}
                    onChange={(e) => setRCode(e.target.value)}
                    placeholder="e.g. LH-101"
                    required
                  />
                  <TextField
                    label="Kind *"
                    value={rKind}
                    onChange={(e) => setRKind(e.target.value)}
                    placeholder="e.g. Lecture hall"
                    maxLength={50}
                    required
                  />
                  <TextField
                    label="Name"
                    value={rName}
                    onChange={(e) => setRName(e.target.value)}
                    placeholder="e.g. Lecture Hall 101"
                    maxLength={255}
                  />
                  <TextField
                    label="Capacity"
                    type="number"
                    value={rCapacity}
                    onChange={(e) => setRCapacity(e.target.value)}
                    placeholder="e.g. 60"
                  />
                </div>
                <div>
                  <Button type="submit" variant="primary" pending={rPending}>
                    Save Room
                  </Button>
                </div>
              </form>
            </Card>
          )}

          {loadingRooms ? (
            <Spinner label="Loading rooms…" />
          ) : rooms.length === 0 ? (
            <Card title="No rooms configured">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <p>
                  No classrooms, lecture halls, or laboratories have been registered for this campus yet.
                </p>
                <div style={{ fontSize: '0.9rem', color: 'var(--color-text-muted)' }}>
                  <p style={{ margin: '0 0 var(--space-1) 0' }}>
                    <strong>What are rooms used for?</strong> Rooms represent physical spaces across campuses —
                    such as lecture halls, computer/science laboratories, seminar rooms, and tutorial classrooms.
                    They are linked to academic timetable periods, section assignments, and exam hall seating plans.
                  </p>
                  <p style={{ margin: '0' }}>
                    <strong>Who configures rooms?</strong> Physical room infrastructure is created and maintained by{' '}
                    <strong>Campus Administrators</strong> and <strong>Principals</strong> (<code>org.campus.manage</code>).
                  </p>
                </div>
                {canManageCampus ? (
                  <div style={{ marginTop: 'var(--space-2)' }}>
                    <Button variant="primary" onClick={() => setShowAddRoom(true)}>
                      + Create First Campus Room
                    </Button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
                    <Badge tone="neutral">Restricted to Campus Administrators</Badge>
                    <span className="muted" style={{ fontSize: '0.85rem' }}>
                      Faculty members have read-only access for timetable referencing.
                    </span>
                  </div>
                )}
              </div>
            </Card>
          ) : (
            <div className="grid">
              {rooms.map((r) => (
                <Card key={r.id} title={r.name ?? r.code}>
                  <div style={{ marginBottom: 'var(--space-2)' }}>
                    <Badge>{r.kind}</Badge>
                  </div>
                  <dl className="defs">
                    <dt>Code</dt>
                    <dd>{r.code}</dd>
                    {r.capacity !== null && (
                      <>
                        <dt>Capacity</dt>
                        <dd>{r.capacity}</dd>
                      </>
                    )}
                  </dl>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
