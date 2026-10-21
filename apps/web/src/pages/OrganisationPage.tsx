import { useCallback, useEffect, useState } from 'react';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import {
  fetchCampuses,
  fetchDepartments,
  type CampusItem,
  type DepartmentItem,
} from '../lib/api/organisation-api';

export function OrganisationPage() {
  usePageTitle('Organisation Structure');
  const { client } = useAuth();
  const [activeTab, setActiveTab] = useState<'campuses' | 'departments'>('campuses');
  const [campuses, setCampuses] = useState<CampusItem[]>([]);
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchCampuses(client), fetchDepartments(client)])
      .then(([cList, dList]) => {
        setCampuses(cList);
        setDepartments(dList);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message || 'Failed to load organization structure.');
        setLoading(false);
      });
  }, [client]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
        </div>
      </div>

      <p className="lead">
        Institutional structure records, campuses, and academic departments configured for this
        tenant.
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
      ) : departments.length === 0 ? (
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
      )}
    </>
  );
}
