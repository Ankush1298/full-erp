import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import { SegmentedNav } from '../components/ui/SegmentedNav';
import { Spinner } from '../components/ui/Spinner';
import { StatCard } from '../components/ui/StatCard';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import { isApiError, isModuleNotEntitled, isInstitutionSuspended } from '../lib/api/errors';
import { FeatureUnavailableState, InstitutionSuspendedState } from '../components/ui/FeatureUnavailableState';
import {
  fetchTeacherClasses,
  previewRecipients,
  fetchTeacherHomework,
  createHomework,
  publishHomework,
  closeHomework,
  fetchHomeworkSubmissions,
  reviewSubmission,
  fetchStudentHomework,
  submitHomework,
  uploadHomeworkAttachment,
  fetchAvailableDocuments,
  fetchAttachmentDownloadUrl,
  type TeacherClassItem,
  type RecipientPreviewResponse,
  type HomeworkDetailDto,
  type SubmissionListItem,
  type StudentHomeworkItem,
  type AvailableDocumentItem,
} from '../lib/api/homework-api';

const modalOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(34, 26, 54, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 'var(--space-4, 1rem)',
};

const modalCardStyle: React.CSSProperties = {
  backgroundColor: 'var(--color-surface, #ffffff)',
  borderRadius: 'var(--radius-card, 0.5rem)',
  padding: 'var(--space-6, 1.5rem)',
  maxWidth: '42rem',
  width: '100%',
  boxShadow: 'var(--shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.1))',
  maxHeight: '90vh',
  overflowY: 'auto',
};

type TeacherTab = 'all' | 'published' | 'drafts' | 'closed' | 'classes';
type StudentTab = 'all' | 'pending' | 'submitted' | 'reviewed' | 'overdue';

export function HomeworkPage() {
  usePageTitle('Homework & Assignments');
  const { client, identity } = useAuth();

  const isStudent = identity?.actorKind === 'STUDENT';
  const canManage = identity ? can(identity, 'homework.manage') : false;
  const canRead = identity ? can(identity, 'homework.read') : false;

  // View mode: Teacher mode if staff with homework.manage; student mode otherwise
  const [activeTeacherTab, setActiveTeacherTab] = useState<TeacherTab>('all');
  const [activeStudentTab, setActiveStudentTab] = useState<StudentTab>('all');

  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [isNotEntitled, setIsNotEntitled] = useState(false);
  const [isSuspended, setIsSuspended] = useState(false);

  // Teacher State
  const [classes, setClasses] = useState<TeacherClassItem[]>([]);
  const [teacherAssignments, setTeacherAssignments] = useState<HomeworkDetailDto[]>([]);
  const [selectedOfferingFilter, setSelectedOfferingFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Create Homework Modal State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createCourseOfferingId, setCreateCourseOfferingId] = useState('');
  const [createSectionId, setCreateSectionId] = useState('');
  const [createTitle, setCreateTitle] = useState('');
  const [createInstructions, setCreateInstructions] = useState('');
  const [createSubmissionType, setCreateSubmissionType] = useState<'ONLINE' | 'OFFLINE'>('ONLINE');
  const [createDueDate, setCreateDueDate] = useState('');
  const [createDueTime, setCreateDueTime] = useState('17:00');
  const [createMaxMarks, setCreateMaxMarks] = useState<number | ''>(100);
  const [createAllowResubmission, setCreateAllowResubmission] = useState(true);
  const [createAttachmentName, setCreateAttachmentName] = useState('');
  const [createAttachments, setCreateAttachments] = useState<
    { fileId: string; fileName: string; fileSizeBytes: number; mimeType: string }[]
  >([]);
  const teacherFileInputRef = useRef<HTMLInputElement>(null);
  const studentFileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [availableDocs, setAvailableDocs] = useState<AvailableDocumentItem[]>([]);
  const [showDocLibraryModal, setShowDocLibraryModal] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [recipientPreview, setRecipientPreview] = useState<RecipientPreviewResponse | null>(null);
  const [showRecipientList, setShowRecipientList] = useState(false);

  // Review Submissions Modal State
  const [selectedHwForReview, setSelectedHwForReview] = useState<HomeworkDetailDto | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionListItem[]>([]);
  const [activeSubmission, setActiveSubmission] = useState<SubmissionListItem | null>(null);
  const [reviewMarks, setReviewMarks] = useState<number | ''>('');
  const [reviewGrade, setReviewGrade] = useState('');
  const [reviewFeedback, setReviewFeedback] = useState('');
  const [reviewAllowResubmission, setReviewAllowResubmission] = useState(true);

  // Student State
  const [studentAssignments, setStudentAssignments] = useState<StudentHomeworkItem[]>([]);
  const [studentSearchQuery, setStudentSearchQuery] = useState('');
  const [selectedHwForSubmit, setSelectedHwForSubmit] = useState<StudentHomeworkItem | null>(null);
  const [submitText, setSubmitText] = useState('');
  const [submitFileName, setSubmitFileName] = useState('');
  const [submitFiles, setSubmitFiles] = useState<
    { fileId: string; fileName: string; fileSizeBytes: number; mimeType: string }[]
  >([]);
  const [selectedHwForView, setSelectedHwForView] = useState<StudentHomeworkItem | null>(null);

  // Initial Data Load
  const reloadData = async () => {
    setLoading(true);
    setError(null);
    try {
      if (canManage && !isStudent) {
        const [clsList, hwList] = await Promise.all([
          fetchTeacherClasses(client),
          fetchTeacherHomework(client),
        ]);
        setClasses(clsList);
        setTeacherAssignments(hwList);
        if (clsList.length > 0 && !createCourseOfferingId) {
          setCreateCourseOfferingId(clsList[0]!.courseOfferingId);
          setCreateSectionId(clsList[0]!.sectionId || '');
        }
      } else if (canRead || isStudent) {
        const list = await fetchStudentHomework(client);
        setStudentAssignments(list);
      }
    } catch (err: unknown) {
      if (isModuleNotEntitled(err)) {
        setIsNotEntitled(true);
        setError(null);
      } else if (isInstitutionSuspended(err)) {
        setIsSuspended(true);
        setError(null);
      } else {
        setError(isApiError(err) ? err.message : 'Failed to load homework assignments.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reloadData();
  }, [client, canManage, canRead, isStudent]);

  // Recipient preview update when class selection changes in Create Modal
  useEffect(() => {
    if (!showCreateModal || !createCourseOfferingId) {
      setRecipientPreview(null);
      return;
    }
    let mounted = true;
    previewRecipients(client, createCourseOfferingId, createSectionId || undefined)
      .then((res) => {
        if (mounted) setRecipientPreview(res);
      })
      .catch(() => {
        if (mounted) setRecipientPreview(null);
      });
    return () => {
      mounted = false;
    };
  }, [client, showCreateModal, createCourseOfferingId, createSectionId]);

  // Handle Class selection change in Create Homework modal
  const handleClassSelectionChange = (offeringId: string) => {
    setCreateCourseOfferingId(offeringId);
    const cls = classes.find((c) => c.courseOfferingId === offeringId);
    setCreateSectionId(cls?.sectionId || '');
  };

  // Teacher: Handle real file selection from computer
  const handleTeacherFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachmentError(null);

    // Max size: 25MB
    const MAX_SIZE = 25 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      setAttachmentError(`File "${file.name}" exceeds maximum size of 25MB.`);
      if (teacherFileInputRef.current) teacherFileInputRef.current.value = '';
      return;
    }

    setUploadingAttachment(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string)?.split(',')[1] || '';
        try {
          const res = await uploadHomeworkAttachment(client, {
            fileName: file.name,
            fileSizeBytes: file.size,
            mimeType: file.type || 'application/octet-stream',
            contentBase64: base64,
          });
          setCreateAttachments((prev) => [
            ...prev,
            {
              fileId: res.fileId,
              fileName: res.fileName,
              fileSizeBytes: res.fileSizeBytes,
              mimeType: res.mimeType,
            },
          ]);
        } catch (err: unknown) {
          setAttachmentError(err instanceof Error ? err.message : 'Failed to upload attachment.');
        } finally {
          setUploadingAttachment(false);
          if (teacherFileInputRef.current) teacherFileInputRef.current.value = '';
        }
      };
      reader.readAsDataURL(file);
    } catch (err: unknown) {
      setAttachmentError(err instanceof Error ? err.message : 'Error reading file.');
      setUploadingAttachment(false);
    }
  };

  // Open Document Library
  const handleOpenDocLibrary = async () => {
    setShowDocLibraryModal(true);
    setLoadingDocs(true);
    setAttachmentError(null);
    try {
      const docs = await fetchAvailableDocuments(client);
      setAvailableDocs(docs);
    } catch {
      setAttachmentError('Failed to load institutional documents library.');
    } finally {
      setLoadingDocs(false);
    }
  };

  // Select document from library
  const handleSelectExistingDoc = (doc: AvailableDocumentItem) => {
    if (createAttachments.some((a) => a.fileId === doc.id)) {
      setShowDocLibraryModal(false);
      return;
    }
    setCreateAttachments((prev) => [
      ...prev,
      {
        fileId: doc.id,
        fileName: doc.fileName,
        fileSizeBytes: doc.fileSizeBytes,
        mimeType: doc.mimeType,
      },
    ]);
    setShowDocLibraryModal(false);
  };

  // Manual Attach by Name/ID or open file picker if empty
  const handleAddAttachment = async () => {
    if (!createAttachmentName.trim()) {
      teacherFileInputRef.current?.click();
      return;
    }
    setAttachmentError(null);
    const name = createAttachmentName.trim();
    setUploadingAttachment(true);
    try {
      const ext = name.split('.').pop()?.toLowerCase();
      const mime =
        ext === 'pdf'
          ? 'application/pdf'
          : ext === 'docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : ext === 'png'
              ? 'image/png'
              : ext === 'jpg' || ext === 'jpeg'
                ? 'image/jpeg'
                : 'application/octet-stream';
      const res = await uploadHomeworkAttachment(client, {
        fileName: name,
        fileSizeBytes: 124000,
        mimeType: mime,
      });
      setCreateAttachments((prev) => [
        ...prev,
        {
          fileId: res.fileId,
          fileName: res.fileName,
          fileSizeBytes: res.fileSizeBytes,
          mimeType: res.mimeType,
        },
      ]);
      setCreateAttachmentName('');
    } catch (err: unknown) {
      setAttachmentError(err instanceof Error ? err.message : 'Failed to register attachment.');
    } finally {
      setUploadingAttachment(false);
    }
  };

  // Safe file download handler for students and teachers
  const handleDownloadAttachment = async (fileId: string, _fileName: string) => {
    try {
      const res = await fetchAttachmentDownloadUrl(client, fileId);
      if (res?.downloadUrl) {
        window.open(res.downloadUrl, '_blank');
      } else {
        window.open(`/api/v1/homework/attachments/${encodeURIComponent(fileId)}/content`, '_blank');
      }
    } catch {
      window.open(`/api/v1/homework/attachments/${encodeURIComponent(fileId)}/content`, '_blank');
    }
  };

  // Submit Create Homework Form
  const handleCreateSubmit = async (publishNow: boolean) => {
    if (!createTitle.trim()) {
      setError('Please provide a homework title.');
      return;
    }
    if (!createCourseOfferingId) {
      setError('Please select an assigned class offering.');
      return;
    }

    setActionLoading(true);
    setError(null);
    try {
      await createHomework(client, {
        courseOfferingId: createCourseOfferingId,
        sectionId: createSectionId || undefined,
        title: createTitle.trim(),
        instructions: createInstructions.trim(),
        submissionType: createSubmissionType,
        dueDate: createDueDate || undefined,
        dueTime: createDueTime || undefined,
        maxMarks: createMaxMarks === '' ? undefined : Number(createMaxMarks),
        allowResubmission: createAllowResubmission,
        publishNow,
        attachments: createAttachments.length > 0 ? createAttachments : undefined,
      });

      setShowCreateModal(false);
      setCreateTitle('');
      setCreateInstructions('');
      setCreateAttachments([]);
      setFeedbackMessage(
        publishNow
          ? 'Homework published successfully to assigned students!'
          : 'Homework saved as draft.',
      );
      await reloadData();
    } catch (err: unknown) {
      setError(isApiError(err) ? err.message : 'Failed to create homework assignment.');
    } finally {
      setActionLoading(false);
    }
  };

  // Quick Action from My Classes card
  const handleQuickCreateFromClass = (cls: TeacherClassItem) => {
    setCreateCourseOfferingId(cls.courseOfferingId);
    setCreateSectionId(cls.sectionId || '');
    setShowCreateModal(true);
  };

  // Publish Draft
  const handlePublishAssignment = async (hwId: string) => {
    setActionLoading(true);
    setError(null);
    try {
      await publishHomework(client, hwId);
      setFeedbackMessage('Assignment published to students successfully.');
      await reloadData();
    } catch (err: unknown) {
      setError(isApiError(err) ? err.message : 'Failed to publish assignment.');
    } finally {
      setActionLoading(false);
    }
  };

  // Close Assignment
  const handleCloseAssignment = async (hwId: string) => {
    setActionLoading(true);
    setError(null);
    try {
      await closeHomework(client, hwId);
      setFeedbackMessage('Assignment marked as closed. No further new submissions accepted.');
      await reloadData();
    } catch (err: unknown) {
      setError(isApiError(err) ? err.message : 'Failed to close assignment.');
    } finally {
      setActionLoading(false);
    }
  };

  // Open Submissions Review Drawer
  const handleOpenReview = async (hw: HomeworkDetailDto) => {
    setSelectedHwForReview(hw);
    setActionLoading(true);
    setError(null);
    try {
      const subs = await fetchHomeworkSubmissions(client, hw.id);
      setSubmissions(subs);
    } catch (err: unknown) {
      setError(isApiError(err) ? err.message : 'Failed to load assignment submissions.');
    } finally {
      setActionLoading(false);
    }
  };

  // Select student submission to grade
  const handleSelectSubmissionToGrade = (sub: SubmissionListItem) => {
    setActiveSubmission(sub);
    setReviewMarks(sub.marksObtained ?? '');
    setReviewGrade(sub.grade ?? '');
    setReviewFeedback(sub.feedback ?? '');
    setReviewAllowResubmission(sub.resubmissionAllowed ?? true);
  };

  // Submit Review / Grade
  const handleSaveReview = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeSubmission?.id) {
      setError('Cannot review unsubmitted work.');
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      await reviewSubmission(client, activeSubmission.id, {
        status: 'REVIEWED',
        marksObtained: reviewMarks === '' ? undefined : Number(reviewMarks),
        grade: reviewGrade.trim() || undefined,
        feedback: reviewFeedback.trim() || undefined,
        resubmissionAllowed: reviewAllowResubmission,
      });

      setFeedbackMessage(`Graded submission for ${activeSubmission.studentName}.`);
      setActiveSubmission(null);
      if (selectedHwForReview) {
        const updatedSubs = await fetchHomeworkSubmissions(client, selectedHwForReview.id);
        setSubmissions(updatedSubs);
      }
      await reloadData();
    } catch (err: unknown) {
      setError(isApiError(err) ? err.message : 'Failed to save review.');
    } finally {
      setActionLoading(false);
    }
  };

  // Student: Handle real file selection from computer
  const handleStudentFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    const MAX_SIZE = 25 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      setError(`File "${file.name}" exceeds maximum allowed size of 25MB.`);
      if (studentFileInputRef.current) studentFileInputRef.current.value = '';
      return;
    }
    setActionLoading(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string)?.split(',')[1] || '';
        try {
          const res = await uploadHomeworkAttachment(client, {
            fileName: file.name,
            fileSizeBytes: file.size,
            mimeType: file.type || 'application/octet-stream',
            contentBase64: base64,
          });
          setSubmitFiles((prev) => [
            ...prev,
            {
              fileId: res.fileId,
              fileName: res.fileName,
              fileSizeBytes: res.fileSizeBytes,
              mimeType: res.mimeType,
            },
          ]);
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : 'Failed to upload submission file.');
        } finally {
          setActionLoading(false);
          if (studentFileInputRef.current) studentFileInputRef.current.value = '';
        }
      };
      reader.readAsDataURL(file);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error reading submission file.');
      setActionLoading(false);
    }
  };

  // Student: Add file to submission (or open file picker if empty)
  const handleAddSubmitFile = async () => {
    if (!submitFileName.trim()) {
      studentFileInputRef.current?.click();
      return;
    }
    const name = submitFileName.trim();
    setActionLoading(true);
    try {
      const ext = name.split('.').pop()?.toLowerCase();
      const mime =
        ext === 'pdf'
          ? 'application/pdf'
          : ext === 'docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : ext === 'png'
              ? 'image/png'
              : ext === 'jpg' || ext === 'jpeg'
                ? 'image/jpeg'
                : 'application/octet-stream';
      const res = await uploadHomeworkAttachment(client, {
        fileName: name,
        fileSizeBytes: 184000,
        mimeType: mime,
      });
      setSubmitFiles((prev) => [
        ...prev,
        {
          fileId: res.fileId,
          fileName: res.fileName,
          fileSizeBytes: res.fileSizeBytes,
          mimeType: res.mimeType,
        },
      ]);
      setSubmitFileName('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to register submission file.');
    } finally {
      setActionLoading(false);
    }
  };

  // Student: Submit Homework Form
  const handleStudentSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedHwForSubmit) return;
    if (!submitText.trim() && submitFiles.length === 0) {
      setError('Please provide submission answers or attach a document.');
      return;
    }

    setActionLoading(true);
    setError(null);
    try {
      await submitHomework(client, selectedHwForSubmit.id, {
        submissionText: submitText.trim() || undefined,
        files: submitFiles.length > 0 ? submitFiles : undefined,
      });

      setSelectedHwForSubmit(null);
      setSubmitText('');
      setSubmitFiles([]);
      setFeedbackMessage('Your homework submission was uploaded and recorded successfully!');
      await reloadData();
    } catch (err: unknown) {
      setError(isApiError(err) ? err.message : 'Failed to submit homework.');
    } finally {
      setActionLoading(false);
    }
  };

  // Filtering for Teacher
  const filteredTeacherAssignments = useMemo(() => {
    return teacherAssignments.filter((hw) => {
      if (selectedOfferingFilter !== 'ALL' && hw.courseOfferingId !== selectedOfferingFilter) {
        return false;
      }
      if (activeTeacherTab === 'published' && hw.status !== 'PUBLISHED') return false;
      if (activeTeacherTab === 'drafts' && hw.status !== 'DRAFT') return false;
      if (activeTeacherTab === 'closed' && hw.status !== 'CLOSED') return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = hw.title.toLowerCase().includes(q);
        const matchCourse = hw.courseTitle.toLowerCase().includes(q) || hw.courseCode.toLowerCase().includes(q);
        if (!matchTitle && !matchCourse) return false;
      }
      return true;
    });
  }, [teacherAssignments, selectedOfferingFilter, activeTeacherTab, searchQuery]);

  // Teacher Stats
  const teacherStats = useMemo(() => {
    const totalClasses = classes.length;
    const published = teacherAssignments.filter((h) => h.status === 'PUBLISHED').length;
    const drafts = teacherAssignments.filter((h) => h.status === 'DRAFT').length;
    const pendingReview = teacherAssignments.reduce((acc, h) => acc + (h.submittedCount - h.reviewedCount), 0);
    const totalPendingSubmissions = teacherAssignments.reduce((acc, h) => acc + h.pendingCount, 0);
    return { totalClasses, published, drafts, pendingReview, totalPendingSubmissions };
  }, [classes, teacherAssignments]);

  // Filtering for Student
  const filteredStudentAssignments = useMemo(() => {
    return studentAssignments.filter((hw) => {
      const isSub = hw.submissionStatus === 'SUBMITTED' || hw.submissionStatus === 'REVIEWED';
      const isRev = hw.submissionStatus === 'REVIEWED' || hw.evaluatedAt !== null;
      const isOver = hw.submissionStatus === 'OVERDUE';
      const isPen = hw.submissionStatus === 'PENDING';

      if (activeStudentTab === 'pending' && !isPen) return false;
      if (activeStudentTab === 'submitted' && !isSub) return false;
      if (activeStudentTab === 'reviewed' && !isRev) return false;
      if (activeStudentTab === 'overdue' && !isOver) return false;

      if (studentSearchQuery.trim()) {
        const q = studentSearchQuery.toLowerCase();
        const matchTitle = hw.title.toLowerCase().includes(q);
        const matchCourse = hw.courseTitle.toLowerCase().includes(q) || hw.courseCode.toLowerCase().includes(q);
        const matchTeacher = hw.teacherName.toLowerCase().includes(q);
        if (!matchTitle && !matchCourse && !matchTeacher) return false;
      }
      return true;
    });
  }, [studentAssignments, activeStudentTab, studentSearchQuery]);

  // Student Stats
  const studentStats = useMemo(() => {
    const totalAssigned = studentAssignments.length;
    const pending = studentAssignments.filter((h) => h.submissionStatus === 'PENDING').length;
    const submitted = studentAssignments.filter((h) => h.submissionStatus === 'SUBMITTED').length;
    const reviewed = studentAssignments.filter((h) => h.submissionStatus === 'REVIEWED' || h.evaluatedAt !== null).length;
    return { totalAssigned, pending, submitted, reviewed };
  }, [studentAssignments]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header */}
      <PageHeader
        title={canManage && !isStudent ? 'Homework & Assignments' : 'My Homework & Assignments'}
        subtitle={
          canManage && !isStudent
            ? 'Assign coursework, track student submissions, and record academic evaluations.'
            : 'Track coursework assigned to your classes, download materials, and submit your work online.'
        }
        actions={
          !isNotEntitled && !isSuspended && canManage && !isStudent ? (
            <Button
              variant="primary"
              onClick={() => {
                if (classes.length > 0) {
                  setCreateCourseOfferingId(classes[0]!.courseOfferingId);
                  setCreateSectionId(classes[0]!.sectionId || '');
                }
                setShowCreateModal(true);
                setFeedbackMessage(null);
                setError(null);
              }}
            >
              + Create Homework
            </Button>
          ) : undefined
        }
      />

      {isNotEntitled ? (
        <FeatureUnavailableState
          moduleKey="homework"
          moduleName="Homework & Coursework"
        />
      ) : isSuspended ? (
        <InstitutionSuspendedState />
      ) : (
        <>
          {/* Global Alerts */}
      {feedbackMessage && (
        <Alert tone="info">
          {feedbackMessage}
        </Alert>
      )}
      {error && (
        <Alert tone="error">
          {error}
        </Alert>
      )}

      {loading && (
        <div style={{ padding: '3rem', textAlign: 'center' }}>
          <Spinner />
          <p style={{ marginTop: '0.75rem', color: 'var(--color-fg-muted)' }}>
            Loading homework records...
          </p>
        </div>
      )}

      {/* ─── TEACHER EXPERIENCE ─────────────────────────────────────────────────── */}
      {!loading && canManage && !isStudent && (
        <>
          {/* KPI Stat Cards */}
          <div className="anesa-stat-grid anesa-stat-grid--4">
            <StatCard
              label="Assigned Classes"
              value={teacherStats.totalClasses}
              tone="purple"
              helper="Teaching sections"
            />
            <StatCard
              label="Active Homework"
              value={teacherStats.published}
              tone="emerald"
              helper="Published assignments"
            />
            <StatCard
              label="Drafts"
              value={teacherStats.drafts}
              tone="amber"
              helper="Awaiting publish"
            />
            <StatCard
              label="Submissions to Review"
              value={teacherStats.pendingReview}
              tone="coral"
              helper="Ungraded work"
            />
          </div>

          {/* Segmented Navigation */}
          <SegmentedNav
            activeId={activeTeacherTab}
            onChange={(val) => setActiveTeacherTab(val as TeacherTab)}
            items={[
              { id: 'all', label: 'All Assignments', badge: teacherAssignments.length },
              {
                id: 'published',
                label: 'Published',
                badge: teacherAssignments.filter((h) => h.status === 'PUBLISHED').length,
              },
              {
                id: 'drafts',
                label: 'Drafts',
                badge: teacherAssignments.filter((h) => h.status === 'DRAFT').length,
              },
              {
                id: 'closed',
                label: 'Closed',
                badge: teacherAssignments.filter((h) => h.status === 'CLOSED').length,
              },
              { id: 'classes', label: 'My Classes', badge: classes.length },
            ]}
          />

          {/* TAB 1-4: ASSIGNMENTS TABLE */}
          {activeTeacherTab !== 'classes' && (
            <div className="anesa-card">
              <div className="anesa-card-header" style={{ flexWrap: 'wrap', gap: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1, minWidth: '240px' }}>
                  <input
                    type="search"
                    className="anesa-input"
                    placeholder="Search by title or subject..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{
                      maxWidth: '320px',
                      width: '100%',
                      height: '2.5rem',
                      padding: '0 0.75rem',
                      borderRadius: 'var(--radius, 6px)',
                      border: '1px solid var(--color-border)',
                    }}
                  />
                  <select
                    className="anesa-select"
                    aria-label="Filter by class offering"
                    value={selectedOfferingFilter}
                    onChange={(e) => setSelectedOfferingFilter(e.target.value)}
                    style={{
                      height: '2.5rem',
                      padding: '0 0.75rem',
                      borderRadius: 'var(--radius, 6px)',
                      border: '1px solid var(--color-border)',
                      backgroundColor: 'var(--color-surface)',
                    }}
                  >
                    <option value="ALL">All Classes & Sections</option>
                    {classes.map((c) => (
                      <option key={c.courseOfferingId} value={c.courseOfferingId}>
                        {c.courseTitle} {c.sectionName ? `(${c.sectionName})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ fontSize: '0.875rem', color: 'var(--color-fg-muted)' }}>
                  Showing {filteredTeacherAssignments.length} of {teacherAssignments.length} assignments
                </div>
              </div>

              <div className="anesa-card-body" style={{ padding: 0 }}>
                {filteredTeacherAssignments.length > 0 ? (
                  <div className="anesa-table-wrapper">
                    <table className="anesa-table">
                      <thead>
                        <tr>
                          <th>Assignment Title</th>
                          <th>Subject & Section</th>
                          <th>Due Date</th>
                          <th>Type</th>
                          <th>Status</th>
                          <th>Submissions</th>
                          <th style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredTeacherAssignments.map((hw) => (
                          <tr key={hw.id}>
                            <td>
                              <div style={{ fontWeight: 600, color: 'var(--color-text)' }}>{hw.title}</div>
                              {hw.instructions && (
                                <div
                                  style={{
                                    fontSize: '0.8125rem',
                                    color: 'var(--color-fg-muted)',
                                    maxWidth: '300px',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {hw.instructions}
                                </div>
                              )}
                              {hw.attachments.length > 0 && (
                                <div style={{ marginTop: '0.25rem', display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                                  {hw.attachments.map((att) => (
                                    <button
                                      key={att.id}
                                      type="button"
                                      onClick={() => handleDownloadAttachment(att.fileId, att.fileName)}
                                      style={{
                                        background: 'none',
                                        border: '1px solid var(--color-border)',
                                        borderRadius: '4px',
                                        padding: '2px 6px',
                                        fontSize: '0.75rem',
                                        color: 'var(--color-primary, #0969da)',
                                        cursor: 'pointer',
                                      }}
                                    >
                                      ⬇️ {att.fileName}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td>
                              <div style={{ fontWeight: 500 }}>{hw.courseTitle}</div>
                              <div style={{ fontSize: '0.8125rem', color: 'var(--color-fg-muted)' }}>
                                {hw.courseCode} {hw.sectionName ? `• ${hw.sectionName}` : ''}
                              </div>
                            </td>
                            <td>
                              <div style={{ whiteSpace: 'nowrap' }}>
                                {hw.dueDate ? hw.dueDate : <span style={{ color: 'var(--color-fg-muted)' }}>No due date</span>}
                              </div>
                              {hw.dueTime && (
                                <div style={{ fontSize: '0.75rem', color: 'var(--color-fg-muted)' }}>{hw.dueTime}</div>
                              )}
                            </td>
                            <td>
                              <Badge tone={hw.submissionType === 'ONLINE' ? 'info' : 'neutral'}>
                                {hw.submissionType}
                              </Badge>
                            </td>
                            <td>
                              <Badge
                                tone={
                                  hw.status === 'PUBLISHED'
                                    ? 'positive'
                                    : hw.status === 'DRAFT'
                                      ? 'warning'
                                      : 'neutral'
                                }
                              >
                                {hw.status}
                              </Badge>
                            </td>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span style={{ fontWeight: 600 }}>{hw.submittedCount}</span>
                                <span style={{ color: 'var(--color-fg-muted)', fontSize: '0.8125rem' }}>
                                  / {hw.totalRecipients}
                                </span>
                              </div>
                              {hw.reviewedCount > 0 && (
                                <div style={{ fontSize: '0.75rem', color: 'var(--color-emerald-ink)' }}>
                                  {hw.reviewedCount} graded
                                </div>
                              )}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <div style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
                                {hw.status === 'DRAFT' && (
                                  <Button
                                    variant="primary"
                                    onClick={() => handlePublishAssignment(hw.id)}
                                    disabled={actionLoading}
                                  >
                                    Publish
                                  </Button>
                                )}
                                {hw.status === 'PUBLISHED' && (
                                  <>
                                    <Button
                                      variant="secondary"
                                      onClick={() => handleOpenReview(hw)}
                                      disabled={actionLoading}
                                    >
                                      Review ({hw.submittedCount})
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      onClick={() => handleCloseAssignment(hw.id)}
                                      disabled={actionLoading}
                                    >
                                      Close Assignment
                                    </Button>
                                  </>
                                )}
                                {hw.status === 'CLOSED' && (
                                  <Button
                                    variant="secondary"
                                    onClick={() => handleOpenReview(hw)}
                                    disabled={actionLoading}
                                  >
                                    View Submissions
                                  </Button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--color-fg-muted)' }}>
                    No homework assignments match the selected filters.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: MY CLASSES VIEW */}
          {activeTeacherTab === 'classes' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.25rem' }}>
              {classes.map((cls) => (
                <div key={cls.courseOfferingId} className="anesa-card" style={{ display: 'flex', flexDirection: 'column' }}>
                  <div className="anesa-card-header">
                    <div>
                      <h3 style={{ margin: 0, fontSize: '1.0625rem', fontWeight: 600 }}>{cls.courseTitle}</h3>
                      <div style={{ fontSize: '0.8125rem', color: 'var(--color-fg-muted)', marginTop: '0.25rem' }}>
                        {cls.courseCode} • {cls.termName}
                      </div>
                    </div>
                    <Badge tone="purple">{cls.teachingRole}</Badge>
                  </div>
                  <div className="anesa-card-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                      <span style={{ color: 'var(--color-fg-muted)' }}>Section:</span>
                      <span style={{ fontWeight: 600 }}>{cls.sectionName || 'All Sections'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                      <span style={{ color: 'var(--color-fg-muted)' }}>Cohort:</span>
                      <span style={{ fontWeight: 500 }}>{cls.cohortName || 'General'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem' }}>
                      <span style={{ color: 'var(--color-fg-muted)' }}>Enrolled Students:</span>
                      <span style={{ fontWeight: 600, color: 'var(--color-primary)' }}>{cls.studentCount} Students</span>
                    </div>
                    <div style={{ marginTop: 'auto', paddingTop: '1rem' }}>
                      <Button
                        variant="primary"
                        onClick={() => handleQuickCreateFromClass(cls)}
                        style={{ width: '100%' }}
                      >
                        + Assign Homework to Class
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ─── STUDENT EXPERIENCE ─────────────────────────────────────────────────── */}
      {!loading && (isStudent || (!canManage && canRead)) && (
        <>
          {/* KPI Stat Cards */}
          <div className="anesa-stat-grid anesa-stat-grid--4">
            <StatCard
              label="Total Assigned"
              value={studentStats.totalAssigned}
              tone="purple"
              helper="All course tasks"
            />
            <StatCard
              label="Pending Work"
              value={studentStats.pending}
              tone="amber"
              helper="To be submitted"
            />
            <StatCard
              label="Submitted"
              value={studentStats.submitted}
              tone="emerald"
              helper="Awaiting review"
            />
            <StatCard
              label="Graded & Reviewed"
              value={studentStats.reviewed}
              tone="coral"
              helper="With feedback"
            />
          </div>

          {/* Segmented Navigation */}
          <SegmentedNav
            activeId={activeStudentTab}
            onChange={(val) => setActiveStudentTab(val as StudentTab)}
            items={[
              { id: 'all', label: 'All Tasks', badge: studentAssignments.length },
              {
                id: 'pending',
                label: 'Pending',
                badge: studentAssignments.filter((h) => h.submissionStatus === 'PENDING').length,
              },
              {
                id: 'submitted',
                label: 'Submitted',
                badge: studentAssignments.filter((h) => h.submissionStatus === 'SUBMITTED').length,
              },
              {
                id: 'reviewed',
                label: 'Reviewed',
                badge: studentAssignments.filter((h) => h.submissionStatus === 'REVIEWED' || h.evaluatedAt !== null).length,
              },
              {
                id: 'overdue',
                label: 'Overdue',
                badge: studentAssignments.filter((h) => h.submissionStatus === 'OVERDUE').length,
              },
            ]}
          />

          {/* Student Assignments Table */}
          <div className="anesa-card">
            <div className="anesa-card-header" style={{ flexWrap: 'wrap', gap: '1rem' }}>
              <input
                type="search"
                className="anesa-input"
                placeholder="Search homework by subject, title, or teacher..."
                value={studentSearchQuery}
                onChange={(e) => setStudentSearchQuery(e.target.value)}
                style={{
                  maxWidth: '360px',
                  width: '100%',
                  height: '2.5rem',
                  padding: '0 0.75rem',
                  borderRadius: 'var(--radius, 6px)',
                  border: '1px solid var(--color-border)',
                }}
              />
              <div style={{ fontSize: '0.875rem', color: 'var(--color-fg-muted)' }}>
                Showing {filteredStudentAssignments.length} of {studentAssignments.length} tasks
              </div>
            </div>

            <div className="anesa-card-body" style={{ padding: 0 }}>
              {filteredStudentAssignments.length > 0 ? (
                <div className="anesa-table-wrapper">
                  <table className="anesa-table">
                    <thead>
                      <tr>
                        <th>Subject & Teacher</th>
                        <th>Homework Title & Details</th>
                        <th>Due Date</th>
                        <th>Submission Type</th>
                        <th>Status</th>
                        <th>Grade / Score</th>
                        <th style={{ textAlign: 'right' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredStudentAssignments.map((hw) => (
                        <tr key={hw.id}>
                          <td>
                            <div style={{ fontWeight: 600, color: 'var(--brand-primary, #504175)' }}>
                              {hw.courseTitle}
                            </div>
                            <div style={{ fontSize: '0.8125rem', color: 'var(--color-fg-muted)' }}>
                              {hw.teacherName} {hw.sectionName ? `• ${hw.sectionName}` : ''}
                            </div>
                          </td>
                          <td>
                            <div style={{ fontWeight: 600 }}>{hw.title}</div>
                            {hw.instructions && (
                              <div
                                style={{
                                  fontSize: '0.8125rem',
                                  color: 'var(--color-fg-muted)',
                                  maxWidth: '280px',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {hw.instructions}
                              </div>
                            )}
                            {hw.attachments.length > 0 && (
                              <div style={{ marginTop: '0.25rem', display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                                {hw.attachments.map((att) => (
                                  <button
                                    key={att.id}
                                    type="button"
                                    onClick={() => handleDownloadAttachment(att.fileId, att.fileName)}
                                    style={{
                                      background: 'none',
                                      border: '1px solid var(--color-border)',
                                      borderRadius: '4px',
                                      padding: '2px 6px',
                                      fontSize: '0.75rem',
                                      color: 'var(--color-primary, #0969da)',
                                      cursor: 'pointer',
                                    }}
                                  >
                                    ⬇️ {att.fileName}
                                  </button>
                                ))}
                              </div>
                            )}
                          </td>
                          <td>
                            <div style={{ whiteSpace: 'nowrap' }}>
                              {hw.dueDate ? hw.dueDate : <span style={{ color: 'var(--color-fg-muted)' }}>No due date</span>}
                            </div>
                            {hw.dueTime && (
                              <div style={{ fontSize: '0.75rem', color: 'var(--color-fg-muted)' }}>{hw.dueTime}</div>
                            )}
                          </td>
                          <td>
                            <Badge tone={hw.submissionType === 'ONLINE' ? 'info' : 'neutral'}>
                              {hw.submissionType}
                            </Badge>
                          </td>
                          <td>
                            <Badge
                              tone={
                                hw.submissionStatus === 'SUBMITTED'
                                  ? 'info'
                                  : hw.submissionStatus === 'REVIEWED'
                                    ? 'positive'
                                    : hw.submissionStatus === 'OVERDUE'
                                      ? 'danger'
                                      : 'warning'
                              }
                            >
                              {hw.submissionStatus}
                            </Badge>
                          </td>
                          <td>
                            {hw.marksObtained !== null && hw.marksObtained !== undefined ? (
                              <div>
                                <span style={{ fontWeight: 700, color: 'var(--color-emerald-ink)' }}>
                                  {hw.marksObtained}
                                </span>
                                {hw.maxMarks && (
                                  <span style={{ color: 'var(--color-fg-muted)', fontSize: '0.8125rem' }}>
                                    {' '}/ {hw.maxMarks}
                                  </span>
                                )}
                                {hw.grade && (
                                  <span style={{ marginLeft: '0.5rem' }}>
                                    <Badge tone="positive">{hw.grade}</Badge>
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span style={{ color: 'var(--color-fg-muted)', fontSize: '0.8125rem' }}>
                                {hw.submissionStatus === 'SUBMITTED' ? 'Under Evaluation' : '—'}
                              </span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {hw.submissionType === 'ONLINE' && (hw.submissionStatus === 'PENDING' || hw.resubmissionAllowed) ? (
                              <Button
                                variant="primary"
                                onClick={() => {
                                  setSelectedHwForSubmit(hw);
                                  setSubmitText(hw.mySubmissionText || '');
                                  setSubmitFiles([]);
                                }}
                              >
                                {hw.submissionStatus === 'PENDING' ? 'Submit Work' : 'Resubmit'}
                              </Button>
                            ) : (
                              <Button
                                variant="secondary"
                                onClick={() => setSelectedHwForView(hw)}
                              >
                                View Details
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--color-fg-muted)' }}>
                  No homework assignments match the selected tab.
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ─── MODAL: CREATE HOMEWORK (TEACHER) ─────────────────────────────────────── */}
      {showCreateModal && (
        <div style={modalOverlayStyle} onClick={() => setShowCreateModal(false)}>
          <div style={modalCardStyle} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>Create Homework Assignment</h2>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleCreateSubmit(true);
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
            >
              {/* Class & Section Selection */}
              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.375rem' }}>
                  Assigned Class & Section *
                </label>
                <select
                  className="anesa-select"
                  aria-label="Assigned Class & Section"
                  value={createCourseOfferingId}
                  onChange={(e) => handleClassSelectionChange(e.target.value)}
                  style={{
                    width: '100%',
                    height: '2.5rem',
                    padding: '0 0.75rem',
                    borderRadius: 'var(--radius, 6px)',
                    border: '1px solid var(--color-border)',
                  }}
                  required
                >
                  {classes.map((c) => (
                    <option key={c.courseOfferingId} value={c.courseOfferingId}>
                      {c.courseTitle} — {c.sectionName || 'All Sections'} ({c.studentCount} students)
                    </option>
                  ))}
                </select>
              </div>

              {/* Recipient Preview Box */}
              {recipientPreview && (
                <div
                  style={{
                    padding: '0.75rem 1rem',
                    borderRadius: 'var(--radius-sm, 6px)',
                    backgroundColor: 'var(--color-primary-soft, #f2eef9)',
                    border: '1px solid var(--color-border)',
                    fontSize: '0.875rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>
                      🎯 <strong>{recipientPreview.totalCount} Students</strong> in{' '}
                      {recipientPreview.courseTitle}{' '}
                      {recipientPreview.sectionName ? `(${recipientPreview.sectionName})` : ''} will receive this homework.
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowRecipientList(!showRecipientList)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--color-primary)',
                        cursor: 'pointer',
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                      }}
                    >
                      {showRecipientList ? 'Hide List' : 'Preview Students'}
                    </button>
                  </div>
                  {showRecipientList && (
                    <div
                      style={{
                        marginTop: '0.75rem',
                        maxHeight: '120px',
                        overflowY: 'auto',
                        padding: '0.5rem',
                        backgroundColor: '#ffffff',
                        borderRadius: '4px',
                        border: '1px solid var(--color-border)',
                      }}
                    >
                      <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.8125rem' }}>
                        {recipientPreview.students.map((st) => (
                          <li key={st.studentId}>
                            {st.displayName} ({st.admissionNumber}) {st.rollNumber ? `• Roll: ${st.rollNumber}` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Title */}
              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.375rem' }}>
                  Homework Title *
                </label>
                <input
                  type="text"
                  className="anesa-input"
                  placeholder="e.g. Chapter 4 Problem Set: Linear Equations"
                  value={createTitle}
                  onChange={(e) => setCreateTitle(e.target.value)}
                  style={{
                    width: '100%',
                    height: '2.5rem',
                    padding: '0 0.75rem',
                    borderRadius: 'var(--radius, 6px)',
                    border: '1px solid var(--color-border)',
                  }}
                  required
                />
              </div>

              {/* Instructions */}
              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.375rem' }}>
                  Instructions & Guidelines
                </label>
                <textarea
                  className="anesa-textarea"
                  rows={4}
                  placeholder="Detailed instructions for students, reading references, submission requirements..."
                  value={createInstructions}
                  onChange={(e) => setCreateInstructions(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.625rem',
                    borderRadius: 'var(--radius, 6px)',
                    border: '1px solid var(--color-border)',
                    fontFamily: 'inherit',
                  }}
                />
              </div>

              {/* Submission Type Toggle */}
              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.375rem' }}>
                  Submission Mode
                </label>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <label
                    style={{
                      flex: 1,
                      padding: '0.625rem 1rem',
                      borderRadius: 'var(--radius, 6px)',
                      border: `1.5px solid ${createSubmissionType === 'ONLINE' ? 'var(--color-primary)' : 'var(--color-border)'}`,
                      backgroundColor: createSubmissionType === 'ONLINE' ? 'var(--color-primary-soft)' : 'transparent',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      fontWeight: 500,
                      fontSize: '0.875rem',
                    }}
                  >
                    <input
                      type="radio"
                      name="submissionType"
                      checked={createSubmissionType === 'ONLINE'}
                      onChange={() => setCreateSubmissionType('ONLINE')}
                    />
                    Online Submission (Files / Text)
                  </label>
                  <label
                    style={{
                      flex: 1,
                      padding: '0.625rem 1rem',
                      borderRadius: 'var(--radius, 6px)',
                      border: `1.5px solid ${createSubmissionType === 'OFFLINE' ? 'var(--color-primary)' : 'var(--color-border)'}`,
                      backgroundColor: createSubmissionType === 'OFFLINE' ? 'var(--color-primary-soft)' : 'transparent',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      fontWeight: 500,
                      fontSize: '0.875rem',
                    }}
                  >
                    <input
                      type="radio"
                      name="submissionType"
                      checked={createSubmissionType === 'OFFLINE'}
                      onChange={() => setCreateSubmissionType('OFFLINE')}
                    />
                    Offline / In-Class Submission
                  </label>
                </div>
              </div>

              {/* Due Date & Time, Max Marks */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.375rem' }}>
                    Due Date
                  </label>
                  <input
                    type="date"
                    className="anesa-input"
                    value={createDueDate}
                    onChange={(e) => setCreateDueDate(e.target.value)}
                    style={{
                      width: '100%',
                      height: '2.5rem',
                      padding: '0 0.5rem',
                      borderRadius: 'var(--radius, 6px)',
                      border: '1px solid var(--color-border)',
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.375rem' }}>
                    Due Time
                  </label>
                  <input
                    type="time"
                    className="anesa-input"
                    value={createDueTime}
                    onChange={(e) => setCreateDueTime(e.target.value)}
                    style={{
                      width: '100%',
                      height: '2.5rem',
                      padding: '0 0.5rem',
                      borderRadius: 'var(--radius, 6px)',
                      border: '1px solid var(--color-border)',
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.375rem' }}>
                    Maximum Marks
                  </label>
                  <input
                    type="number"
                    min="0"
                    className="anesa-input"
                    value={createMaxMarks}
                    onChange={(e) => setCreateMaxMarks(e.target.value === '' ? '' : Number(e.target.value))}
                    style={{
                      width: '100%',
                      height: '2.5rem',
                      padding: '0 0.5rem',
                      borderRadius: 'var(--radius, 6px)',
                      border: '1px solid var(--color-border)',
                    }}
                  />
                </div>
              </div>

              {/* Allow Resubmission */}
              {createSubmissionType === 'ONLINE' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={createAllowResubmission}
                    onChange={(e) => setCreateAllowResubmission(e.target.checked)}
                  />
                  <span>Allow students to resubmit if revisions are requested</span>
                </label>
              )}

              {/* Attachments Section */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem' }}>
                  Teacher Attachments (Worksheets, Reference PDFs, Reading Materials)
                </label>
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-fg-muted)' }}>
                  Upload worksheets or materials directly from your computer (PDF, Word, Images, max 25MB) or attach from your institution library.
                </p>

                {/* Hidden native file input */}
                <input
                  type="file"
                  ref={teacherFileInputRef}
                  onChange={handleTeacherFileSelected}
                  accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
                  style={{ display: 'none' }}
                />

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => teacherFileInputRef.current?.click()}
                    disabled={uploadingAttachment}
                  >
                    {uploadingAttachment ? 'Uploading...' : '📁 Upload from Computer'}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleOpenDocLibrary}
                    disabled={uploadingAttachment}
                  >
                    📚 Select from Library
                  </Button>
                </div>

                {/* Manual Reference Entry */}
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                  <input
                    type="text"
                    className="anesa-input"
                    placeholder="Or enter document name / file ID (e.g. worksheet_algebra.pdf)"
                    value={createAttachmentName}
                    onChange={(e) => setCreateAttachmentName(e.target.value)}
                    style={{
                      flex: 1,
                      height: '2.5rem',
                      padding: '0 0.75rem',
                      borderRadius: 'var(--radius, 6px)',
                      border: '1px solid var(--color-border)',
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleAddAttachment}
                    disabled={uploadingAttachment}
                  >
                    + Add File
                  </Button>
                </div>

                {attachmentError && (
                  <Alert tone="error">{attachmentError}</Alert>
                )}

                {/* Attached Files List */}
                {createAttachments.length > 0 && (
                  <div
                    style={{
                      marginTop: '0.5rem',
                      padding: '0.75rem',
                      backgroundColor: 'var(--color-surface-sunken, #f8f9fa)',
                      borderRadius: 'var(--radius, 6px)',
                      border: '1px solid var(--color-border)',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '0.8125rem', marginBottom: '0.5rem' }}>
                      Attached Files ({createAttachments.length}):
                    </div>
                    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                      {createAttachments.map((att, idx) => (
                        <li
                          key={idx}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '0.375rem 0.5rem',
                            backgroundColor: 'var(--color-surface, #ffffff)',
                            borderRadius: '4px',
                            border: '1px solid var(--color-border)',
                            fontSize: '0.8125rem',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', overflow: 'hidden' }}>
                            <span>📄</span>
                            <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {att.fileName}
                            </span>
                            <span style={{ color: 'var(--color-fg-muted)', fontSize: '0.75rem' }}>
                              ({(att.fileSizeBytes / 1024).toFixed(1)} KB)
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setCreateAttachments(createAttachments.filter((_, i) => i !== idx))}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--color-danger, #b42318)',
                              cursor: 'pointer',
                              fontSize: '0.75rem',
                              fontWeight: 600,
                            }}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Modal Actions */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}>
                <Button type="button" variant="ghost" onClick={() => setShowCreateModal(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => handleCreateSubmit(false)}
                  disabled={actionLoading}
                >
                  Save as Draft
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => handleCreateSubmit(true)}
                  disabled={actionLoading}
                >
                  Publish Now
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── MODAL: INSTITUTIONAL DOCUMENT LIBRARY ─────────────────────────────────── */}
      {showDocLibraryModal && (
        <div style={modalOverlayStyle} onClick={() => setShowDocLibraryModal(false)}>
          <div style={{ ...modalCardStyle, maxWidth: '38rem' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>
                Select Institutional Document
              </h2>
              <button
                type="button"
                onClick={() => setShowDocLibraryModal(false)}
                style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>
            <p style={{ margin: '0 0 1rem', fontSize: '0.875rem', color: 'var(--color-fg-muted)' }}>
              Choose a verified document from your institution's central files to attach to this homework assignment.
            </p>
            {loadingDocs ? (
              <Spinner label="Loading documents..." />
            ) : availableDocs.length === 0 ? (
              <p style={{ color: 'var(--color-fg-muted)', fontSize: '0.875rem' }}>No institutional documents available.</p>
            ) : (
              <div style={{ maxHeight: '20rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {availableDocs.map((doc) => (
                  <div
                    key={doc.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.625rem 0.75rem',
                      borderRadius: 'var(--radius, 6px)',
                      border: '1px solid var(--color-border)',
                      backgroundColor: 'var(--color-surface, #ffffff)',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>📄 {doc.fileName}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--color-fg-muted)' }}>
                        {(doc.fileSizeBytes / 1024).toFixed(1)} KB • {doc.mimeType}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => handleSelectExistingDoc(doc)}
                    >
                      Attach
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <Button type="button" variant="ghost" onClick={() => setShowDocLibraryModal(false)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: REVIEW SUBMISSIONS (TEACHER) ─────────────────────────────────── */}
      {selectedHwForReview && (
        <div style={modalOverlayStyle} onClick={() => setSelectedHwForReview(null)}>
          <div style={{ ...modalCardStyle, maxWidth: '54rem' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>
                  Submissions: {selectedHwForReview.title}
                </h2>
                <div style={{ fontSize: '0.8125rem', color: 'var(--color-fg-muted)', marginTop: '0.25rem' }}>
                  {selectedHwForReview.courseTitle} {selectedHwForReview.sectionName ? `(${selectedHwForReview.sectionName})` : ''} • Due: {selectedHwForReview.dueDate || 'None'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedHwForReview(null)}
                style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            {/* Submission Stats Pill */}
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
              <div style={{ padding: '0.5rem 0.875rem', borderRadius: '6px', backgroundColor: 'var(--color-primary-soft)', fontSize: '0.875rem' }}>
                Total: <strong>{selectedHwForReview.totalRecipients}</strong>
              </div>
              <div style={{ padding: '0.5rem 0.875rem', borderRadius: '6px', backgroundColor: 'var(--color-emerald-soft)', fontSize: '0.875rem' }}>
                Submitted: <strong>{selectedHwForReview.submittedCount}</strong>
              </div>
              <div style={{ padding: '0.5rem 0.875rem', borderRadius: '6px', backgroundColor: 'var(--color-amber-soft)', fontSize: '0.875rem' }}>
                Pending: <strong>{selectedHwForReview.pendingCount}</strong>
              </div>
              <div style={{ padding: '0.5rem 0.875rem', borderRadius: '6px', backgroundColor: 'var(--color-coral-soft)', fontSize: '0.875rem' }}>
                Graded: <strong>{selectedHwForReview.reviewedCount}</strong>
              </div>
            </div>

            {/* If grading a specific student */}
            {activeSubmission ? (
              <div
                style={{
                  padding: '1.25rem',
                  borderRadius: 'var(--radius, 8px)',
                  border: '1.5px solid var(--color-primary)',
                  backgroundColor: 'var(--color-primary-soft)',
                  marginBottom: '1.25rem',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                  <h3 style={{ margin: 0, fontSize: '1.0625rem', fontWeight: 600 }}>
                    Grade Submission: {activeSubmission.studentName} ({activeSubmission.admissionNumber})
                  </h3>
                  <Button variant="ghost" onClick={() => setActiveSubmission(null)}>
                    Back to List
                  </Button>
                </div>

                {/* Submitted Content Display */}
                <div style={{ backgroundColor: '#ffffff', padding: '1rem', borderRadius: '6px', marginBottom: '1rem', border: '1px solid var(--color-border)' }}>
                  <div style={{ fontSize: '0.8125rem', color: 'var(--color-fg-muted)', marginBottom: '0.5rem' }}>
                    Submitted: {activeSubmission.submittedAt ? new Date(activeSubmission.submittedAt).toLocaleString() : '—'}
                  </div>
                  {activeSubmission.submissionText && (
                    <div style={{ marginBottom: '0.75rem' }}>
                      <strong>Student Answers:</strong>
                      <p style={{ marginTop: '0.25rem', whiteSpace: 'pre-wrap', fontSize: '0.875rem' }}>
                        {activeSubmission.submissionText}
                      </p>
                    </div>
                  )}
                  {activeSubmission.files.length > 0 && (
                    <div>
                      <strong>Attached Documents:</strong>
                      <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem', fontSize: '0.875rem' }}>
                        {activeSubmission.files.map((f) => (
                          <li key={f.id}>
                            📄 {f.fileName} ({(f.fileSizeBytes / 1024).toFixed(1)} KB)
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Grading Form */}
                <form onSubmit={handleSaveReview} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
                    <div>
                      <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.25rem' }}>
                        Marks Obtained (Max: {selectedHwForReview.maxMarks || 100})
                      </label>
                      <input
                        type="number"
                        min="0"
                        max={selectedHwForReview.maxMarks || 100}
                        className="anesa-input"
                        value={reviewMarks}
                        onChange={(e) => setReviewMarks(e.target.value === '' ? '' : Number(e.target.value))}
                        style={{
                          width: '100%',
                          height: '2.5rem',
                          padding: '0 0.5rem',
                          borderRadius: 'var(--radius, 6px)',
                          border: '1px solid var(--color-border)',
                        }}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.25rem' }}>
                        Letter Grade (Optional)
                      </label>
                      <input
                        type="text"
                        className="anesa-input"
                        placeholder="e.g. A+, 95%, Excellent"
                        value={reviewGrade}
                        onChange={(e) => setReviewGrade(e.target.value)}
                        style={{
                          width: '100%',
                          height: '2.5rem',
                          padding: '0 0.75rem',
                          borderRadius: 'var(--radius, 6px)',
                          border: '1px solid var(--color-border)',
                        }}
                      />
                    </div>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.25rem' }}>
                      Teacher Feedback & Remarks
                    </label>
                    <textarea
                      className="anesa-textarea"
                      rows={3}
                      placeholder="Feedback for student..."
                      value={reviewFeedback}
                      onChange={(e) => setReviewFeedback(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.5rem',
                        borderRadius: 'var(--radius, 6px)',
                        border: '1px solid var(--color-border)',
                        fontFamily: 'inherit',
                      }}
                    />
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={reviewAllowResubmission}
                      onChange={(e) => setReviewAllowResubmission(e.target.checked)}
                    />
                    <span>Allow student to resubmit updated work</span>
                  </label>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                    <Button type="button" variant="ghost" onClick={() => setActiveSubmission(null)}>
                      Cancel
                    </Button>
                    <Button type="submit" variant="primary" disabled={actionLoading}>
                      Save Evaluation
                    </Button>
                  </div>
                </form>
              </div>
            ) : null}

            {/* Submissions List */}
            <div className="anesa-table-wrapper" style={{ maxHeight: '380px', overflowY: 'auto' }}>
              <table className="anesa-table">
                <thead>
                  <tr>
                    <th>Student Name & Admission</th>
                    <th>Roll No</th>
                    <th>Status</th>
                    <th>Submitted At</th>
                    <th>Files & Text</th>
                    <th>Marks / Grade</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((sub) => (
                    <tr key={sub.studentId}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{sub.studentName}</div>
                        <div style={{ fontSize: '0.8125rem', color: 'var(--color-fg-muted)' }}>{sub.admissionNumber}</div>
                      </td>
                      <td>{sub.rollNumber || '—'}</td>
                      <td>
                        <Badge
                          tone={
                            sub.status === 'SUBMITTED'
                              ? 'info'
                              : sub.status === 'REVIEWED'
                                ? 'positive'
                                : 'neutral'
                          }
                        >
                          {sub.status}
                        </Badge>
                      </td>
                      <td style={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>
                        {sub.submittedAt ? new Date(sub.submittedAt).toLocaleDateString() : '—'}
                      </td>
                      <td style={{ fontSize: '0.8125rem' }}>
                        {sub.files.length > 0 ? (
                          <span>📎 {sub.files.length} file{sub.files.length > 1 ? 's' : ''}</span>
                        ) : sub.submissionText ? (
                          <span>📝 Text provided</span>
                        ) : (
                          <span style={{ color: 'var(--color-fg-muted)' }}>None</span>
                        )}
                      </td>
                      <td>
                        {sub.marksObtained !== null && sub.marksObtained !== undefined ? (
                          <span style={{ fontWeight: 600, color: 'var(--color-emerald-ink)' }}>
                            {sub.marksObtained} {sub.grade ? `(${sub.grade})` : ''}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--color-fg-muted)' }}>—</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {sub.status !== 'PENDING' ? (
                          <Button
                            variant="secondary"
                            onClick={() => handleSelectSubmissionToGrade(sub)}
                          >
                            Grade / Feedback
                          </Button>
                        ) : (
                          <span style={{ color: 'var(--color-fg-muted)', fontSize: '0.8125rem' }}>Unsubmitted</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
              <Button variant="primary" onClick={() => setSelectedHwForReview(null)}>
                Done
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MODAL: SUBMIT HOMEWORK (STUDENT) ────────────────────────────────────── */}
      {selectedHwForSubmit && (
        <div style={modalOverlayStyle} onClick={() => setSelectedHwForSubmit(null)}>
          <div style={modalCardStyle} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>Submit Homework</h2>
                <div style={{ fontSize: '0.8125rem', color: 'var(--color-fg-muted)', marginTop: '0.25rem' }}>
                  {selectedHwForSubmit.courseTitle} • Teacher: {selectedHwForSubmit.teacherName}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedHwForSubmit(null)}
                style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            <form onSubmit={handleStudentSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Assignment Overview */}
              <div
                style={{
                  padding: '1rem',
                  borderRadius: 'var(--radius, 6px)',
                  backgroundColor: 'var(--color-primary-soft)',
                  border: '1px solid var(--color-border)',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{selectedHwForSubmit.title}</div>
                <div style={{ fontSize: '0.875rem', color: 'var(--color-text)', whiteSpace: 'pre-wrap' }}>
                  {selectedHwForSubmit.instructions}
                </div>
                {selectedHwForSubmit.attachments.length > 0 && (
                  <div style={{ marginTop: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid var(--color-border)' }}>
                    <span style={{ fontSize: '0.8125rem', fontWeight: 600 }}>Teacher Documents:</span>
                    <ul style={{ margin: '0.25rem 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                      {selectedHwForSubmit.attachments.map((att) => (
                        <li
                          key={att.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '0.375rem 0.5rem',
                            backgroundColor: 'var(--color-surface, #ffffff)',
                            borderRadius: '4px',
                            border: '1px solid var(--color-border)',
                          }}
                        >
                          <span style={{ fontSize: '0.8125rem', fontWeight: 500 }}>
                            📎 {att.fileName} <span style={{ color: 'var(--color-fg-muted)', fontSize: '0.75rem' }}>({(att.fileSizeBytes / 1024).toFixed(1)} KB)</span>
                          </span>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => handleDownloadAttachment(att.fileId, att.fileName)}
                          >
                            ⬇️ Download
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Text Submission */}
              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.375rem' }}>
                  Your Answers / Solution Notes
                </label>
                <textarea
                  className="anesa-textarea"
                  rows={4}
                  placeholder="Type your answers, solutions, or explanation..."
                  value={submitText}
                  onChange={(e) => setSubmitText(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.625rem',
                    borderRadius: 'var(--radius, 6px)',
                    border: '1px solid var(--color-border)',
                    fontFamily: 'inherit',
                  }}
                />
              </div>

              {/* File Upload Dropzone / Input */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.875rem' }}>
                  Upload Completed Files (PDF, DOCX, Images, ZIP)
                </label>

                {/* Hidden student file input */}
                <input
                  type="file"
                  ref={studentFileInputRef}
                  onChange={handleStudentFileSelected}
                  accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.zip"
                  style={{ display: 'none' }}
                />

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => studentFileInputRef.current?.click()}
                    disabled={actionLoading}
                  >
                    📁 Upload from Device
                  </Button>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    type="text"
                    className="anesa-input"
                    placeholder="Or enter file name / reference ID (e.g. physics_ans.pdf)"
                    value={submitFileName}
                    onChange={(e) => setSubmitFileName(e.target.value)}
                    style={{
                      flex: 1,
                      height: '2.5rem',
                      padding: '0 0.75rem',
                      borderRadius: 'var(--radius, 6px)',
                      border: '1px solid var(--color-border)',
                    }}
                  />
                  <Button type="button" variant="secondary" onClick={handleAddSubmitFile} disabled={actionLoading}>
                    + Attach File
                  </Button>
                </div>
                {submitFiles.length > 0 && (
                  <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem', fontSize: '0.8125rem' }}>
                    {submitFiles.map((file, idx) => (
                      <li key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span>📄 {file.fileName}</span>
                        <button
                          type="button"
                          onClick={() => setSubmitFiles(submitFiles.filter((_, i) => i !== idx))}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--color-danger, #b42318)',
                            cursor: 'pointer',
                            fontSize: '0.75rem',
                          }}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Academic Integrity Check */}
              <div
                style={{
                  padding: '0.75rem 1rem',
                  borderRadius: '6px',
                  backgroundColor: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  fontSize: '0.8125rem',
                  color: 'var(--color-fg-muted)',
                }}
              >
                🔒 <strong>Academic Honesty:</strong> By submitting, you confirm that this homework submission represents your own academic work in accordance with institutional policy.
              </div>

              {/* Modal Actions */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
                <Button type="button" variant="ghost" onClick={() => setSelectedHwForSubmit(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={actionLoading}>
                  Submit Assignment
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── MODAL: VIEW DETAILS & FEEDBACK (STUDENT) ────────────────────────────── */}
      {selectedHwForView && (
        <div style={modalOverlayStyle} onClick={() => setSelectedHwForView(null)}>
          <div style={modalCardStyle} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>{selectedHwForView.title}</h2>
                <div style={{ fontSize: '0.8125rem', color: 'var(--color-fg-muted)', marginTop: '0.25rem' }}>
                  {selectedHwForView.courseTitle} • Instructor: {selectedHwForView.teacherName}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedHwForView(null)}
                style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {/* Instructions */}
              <div>
                <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem', fontWeight: 600 }}>Instructions</h4>
                <div
                  style={{
                    padding: '0.875rem',
                    borderRadius: '6px',
                    backgroundColor: '#fafafa',
                    border: '1px solid var(--color-border)',
                    fontSize: '0.875rem',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {selectedHwForView.instructions || 'No special instructions.'}
                </div>
              </div>

              {/* Evaluation / Feedback Box */}
              {(selectedHwForView.evaluatedAt || selectedHwForView.marksObtained !== null || selectedHwForView.feedback) && (
                <div
                  style={{
                    padding: '1rem',
                    borderRadius: 'var(--radius, 6px)',
                    backgroundColor: 'var(--color-emerald-soft)',
                    border: '1px solid var(--color-emerald-hover)',
                  }}
                >
                  <h4 style={{ margin: '0 0 0.5rem', color: 'var(--color-emerald-ink)', fontWeight: 600 }}>
                    Teacher Evaluation & Feedback
                  </h4>
                  <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.5rem', alignItems: 'center' }}>
                    {selectedHwForView.marksObtained !== null && (
                      <span style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--color-emerald-ink)' }}>
                        Score: {selectedHwForView.marksObtained} {selectedHwForView.maxMarks ? `/ ${selectedHwForView.maxMarks}` : ''}
                      </span>
                    )}
                    {selectedHwForView.grade && (
                      <Badge tone="positive">{selectedHwForView.grade}</Badge>
                    )}
                  </div>
                  {selectedHwForView.feedback && (
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.875rem', color: 'var(--color-emerald-ink)' }}>
                      <strong>Remarks:</strong> {selectedHwForView.feedback}
                    </p>
                  )}
                </div>
              )}

              {/* Your Submission */}
              <div>
                <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem', fontWeight: 600 }}>Your Submitted Work</h4>
                <div
                  style={{
                    padding: '0.875rem',
                    borderRadius: '6px',
                    backgroundColor: '#ffffff',
                    border: '1px solid var(--color-border)',
                    fontSize: '0.875rem',
                  }}
                >
                  <div style={{ fontSize: '0.8125rem', color: 'var(--color-fg-muted)', marginBottom: '0.5rem' }}>
                    Status: <Badge tone="info">{selectedHwForView.submissionStatus}</Badge>{' '}
                    {selectedHwForView.submittedAt && `• Submitted on ${new Date(selectedHwForView.submittedAt).toLocaleString()}`}
                  </div>
                  {selectedHwForView.mySubmissionText && (
                    <p style={{ margin: '0.5rem 0', whiteSpace: 'pre-wrap' }}>
                      {selectedHwForView.mySubmissionText}
                    </p>
                  )}
                  {selectedHwForView.mySubmissionFiles.length > 0 && (
                    <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
                      {selectedHwForView.mySubmissionFiles.map((f) => (
                        <li key={f.id}>
                          📄 {f.fileName} ({(f.fileSizeBytes / 1024).toFixed(1)} KB)
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                {selectedHwForView.resubmissionAllowed && (
                  <Button
                    variant="primary"
                    onClick={() => {
                      setSelectedHwForSubmit(selectedHwForView);
                      setSubmitText(selectedHwForView.mySubmissionText || '');
                      setSubmitFiles([]);
                      setSelectedHwForView(null);
                    }}
                  >
                    Resubmit Work
                  </Button>
                )}
                <Button variant="secondary" onClick={() => setSelectedHwForView(null)}>
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}
