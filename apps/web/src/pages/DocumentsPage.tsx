import { useState } from 'react';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { usePageTitle } from '../components/usePageTitle';

interface DocumentSummary {
  id: string;
  name: string;
  category: string;
  status: 'AVAILABLE' | 'SCANNING' | 'PENDING_UPLOAD' | 'QUARANTINED';
  sizeFormatted: string;
  date: string;
}

export function DocumentsPage() {
  usePageTitle('My Documents');
  const [documents] = useState<DocumentSummary[]>([]);

  return (
    <>
      <h1>My Documents</h1>
      <p className="lead">
        Secure document storage, verification status, and uploaded files for your account.
      </p>

      {documents.length === 0 ? (
        <Card title="No documents uploaded">
          <p className="muted">
            You do not currently have any stored files. When documents are uploaded for your profile
            or applications, they will be listed here after security scanning.
          </p>
        </Card>
      ) : (
        <div className="grid">
          {documents.map((doc) => (
            <Card key={doc.id} title={doc.name}>
              <div style={{ marginBottom: 'var(--space-2)' }}>
                <Badge>{doc.status}</Badge>
              </div>
              <dl className="defs">
                <dt>Classification</dt>
                <dd>{doc.category}</dd>
                <dt>File Size</dt>
                <dd>{doc.sizeFormatted}</dd>
                <dt>Date</dt>
                <dd>{doc.date}</dd>
              </dl>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
