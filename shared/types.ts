// Paralegal names
export const PARALEGALS = ['Dalia', 'Vero', 'Madonna'] as const;
export type ParalegalName = (typeof PARALEGALS)[number];

// Dropbox folder mapping
export const PARALEGAL_FOLDERS: Record<ParalegalName, string> = {
  Dalia: '/New Sort Folder/Dalia',
  Vero: '/New Sort Folder/Vero',
  Madonna: '/New Sort Folder/Madonna',
};

// Event types from "Duplicate of Events 2.0" form
export const EVENT_TYPES = [
  'Received',
  'Sent/Filed',
  'Note/Strategy',
  'Action',
  'Supporting Doc(s)',
  'Criminal Records',
  'Physical Document',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// Asana constants (verified from live workspace)
export const ASANA_WORKSPACE_GID = '1402758609793';
export const EVENT_TYPE_FIELD_GID = '1207717320171878';
export const EVENT_TYPE_ENUM_MAP: Record<EventType, string> = {
  Received: '1207717320171880',
  'Sent/Filed': '1207717320171881',
  'Note/Strategy': '1207717320171879',
  Action: '1207719316111886',
  'Supporting Doc(s)': '1207721537290550',
  'Criminal Records': '1207760249623297',
  'Physical Document': '1207816932746885',
};

// Event type to section name mapping
export const EVENT_TYPE_TO_SECTION: Record<EventType, string | null> = {
  Received: 'Filings and Official Correspondence',
  'Sent/Filed': 'Filings and Official Correspondence',
  'Supporting Doc(s)': 'Client Supporting Documents',
  'Criminal Records': 'Criminal Records/Requests',
  'Physical Document': 'Client Supporting Documents',
  'Note/Strategy': null,
  Action: null,
};

// Document status
export type DocumentStatus = 'pending' | 'unclassified' | 'approved' | 'skipped' | 'sorted' | 'error';
export type ProcessedFileStatus = 'pending' | 'ocr_failed' | 'classified' | 'approved' | 'error';

// Classification result from Claude
export interface ClassificationResult {
  documentLabel: string;
  clientName: string;
  description: string;
  eventType: EventType;
  suggestedSection: string | null;
  documentDate: string | null;
  confidence: number;
  isLegalDocument: boolean;
  isMultipleDocuments: boolean;
  suggestedSplits: SplitSuggestion[];
  reasoning: string;
}

export interface SplitSuggestion {
  pageStart: number;
  pageEnd: number;
  reason: string;
}

// API response types
export interface ProcessedFile {
  id: number;
  dropbox_file_id: string;
  dropbox_path: string;
  file_name: string;
  file_size: number | null;
  mime_type: string | null;
  content_hash: string | null;
  paralegal_name: ParalegalName;
  processed_at: string;
  status: ProcessedFileStatus;
}

export interface Document {
  id: number;
  processed_file_id: number;
  page_start: number | null;
  page_end: number | null;
  split_group_id: string | null;
  extracted_text: string | null;
  ocr_partial: boolean;
  // AI classification
  document_label: string | null;
  client_name: string | null;
  description: string | null;
  event_type: EventType | null;
  suggested_section: string | null;
  document_date: string | null;
  confidence: number | null;
  is_legal_document: boolean;
  classification_error: string | null;
  // Paralegal edits
  edited_label: string | null;
  edited_client_name: string | null;
  edited_description: string | null;
  edited_event_type: EventType | null;
  edited_date: string | null;
  // Asana targeting
  asana_project_gid: string | null;
  asana_project_name: string | null;
  asana_section_gid: string | null;
  asana_section_name: string | null;
  // Concurrency
  claimed_by: string | null;
  claimed_at: string | null;
  // Result
  status: DocumentStatus;
  assigned_paralegal: string | null;
  asana_task_gid: string | null;
  asana_task_url: string | null;
  asana_error: string | null;
  approved_at: string | null;
  created_at: string;
  // Joined from processed_files
  file_name?: string;
  mime_type?: string;
}

export interface AsanaProject {
  gid: string;
  name: string;
}

export interface AsanaSection {
  gid: string;
  name: string;
}

export interface ApproveResult {
  success: boolean;
  taskGid?: string;
  taskUrl?: string;
  taskCreated: boolean;
  sectionMoved: boolean;
  fileAttached: boolean;
  errors: string[];
}

export interface UsageSummary {
  period: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
}

export interface StatusResponse {
  watcherRunning: boolean;
  dropboxConnected: boolean;
  pendingCount: number;
  processingCount: number;
  classifiedCount: number;
  approvedCount: number;
}
