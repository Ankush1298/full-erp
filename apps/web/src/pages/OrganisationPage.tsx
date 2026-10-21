import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
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
  usePageTitle('Organisation Structure');
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
      .catch((err: Error) => {
        setError(err.message || 'Failed to load organization structure.');
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
        .catch((err: Error) => {
          setRoomActionError(err.message || 'Failed to load rooms for this campus.');
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Organisation Structure</h1>
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
      </div>

      <p className="lead">
        Institutional structure records, campuses, academic departments, and physical facilities.
      </p>

      {error && <Alert tone="error">{error}</Alert>}

      {loading ? (
        <Spinner label="Loading organisation structure…" />
      ) : activeTab === 'campuses' ? (
        campuses.length === 0 ? (
          <Card title="No campuses">
            <p className="muted">No campuses have been created yet.</p>
          </Card>
        ) : (
          <div className="grid">
            {campuses.map((c) => (
              <Card key={c.id} title={c.name}>
                <div style={{ marginBottom: 'var(--space-2)' }}>
                  <Badge>{c.status}</Badge>
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
          <Card title="No departments">
            <p className="muted">No departments have been created yet.</p>
          </Card>
        ) : (
          <div className="grid">
            {departments.map((d) => (
              <Card key={d.id} title={d.name}>
                <div style={{ marginBottom: 'var(--space-2)' }}>
                  <Badge>{d.status}</Badge>
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
            <Card title="No rooms">
              <p className="muted">No rooms have been added to this campus yet.</p>
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
