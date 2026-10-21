export {
  DocumentService,
  INITIATE_UPLOAD_OPERATION,
  type FinalizeScanVerdict,
  type ScannableFile,
} from './document.service.js';
export { registerDocumentRoutes, registerStudentDocumentRoutes } from './document.routes.js';
export {
  DocumentScanWorker,
  type DocumentScanWorkerOptions,
  type ScanWorkerOutcome,
} from './scan-worker.js';
export {
  ClamAvScanner,
  MockMalwareScanner,
  createMalwareScanner,
  type ClamAvScannerOptions,
  type MalwareScanner,
  type ScanResult,
  type ScanVerdict,
} from './scanner.js';
