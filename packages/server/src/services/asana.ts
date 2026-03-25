import {
  ASANA_WORKSPACE_GID,
  EVENT_TYPE_FIELD_GID,
  EVENT_TYPE_ENUM_MAP,
  type EventType,
} from 'shared/types.js';

const ASANA_API = 'https://app.asana.com/api/1.0';

function getToken(): string {
  const pat = process.env.ASANA_PAT;
  if (!pat) throw new Error('ASANA_PAT not configured');
  return pat;
}

async function asanaGet(path: string): Promise<unknown> {
  const res = await fetch(`${ASANA_API}${path}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Asana GET ${path} failed: ${err}`);
  }
  const json = (await res.json()) as { data: unknown };
  return json.data;
}

async function asanaPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${ASANA_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: body }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Asana POST ${path} failed: ${err}`);
  }
  const json = (await res.json()) as { data: unknown };
  return json.data;
}

export interface AsanaProject {
  gid: string;
  name: string;
}

export interface AsanaSection {
  gid: string;
  name: string;
}

// Search projects by name using typeahead
export async function searchProjects(query: string): Promise<AsanaProject[]> {
  const data = (await asanaGet(
    `/workspaces/${ASANA_WORKSPACE_GID}/typeahead?resource_type=project&query=${encodeURIComponent(query)}&count=10`,
  )) as AsanaProject[];
  return data.map((p) => ({ gid: p.gid, name: p.name }));
}

// Get sections for a project
export async function getProjectSections(projectGid: string): Promise<AsanaSection[]> {
  const data = (await asanaGet(`/projects/${projectGid}/sections`)) as AsanaSection[];
  return data.map((s) => ({ gid: s.gid, name: s.name }));
}

// Create a task in Asana with the form's exact output format
export async function createTask(params: {
  name: string;
  paralegalName: string;
  eventType: EventType;
  documentLabel: string;
  projectGid: string;
  sectionGid?: string | null;
  dateReceived?: string | null;
}): Promise<{ gid: string; url: string }> {
  const enumGid = EVENT_TYPE_ENUM_MAP[params.eventType];

  const receivedLine = params.dateReceived ? `\n\n<strong>Date Received by Office:</strong>\n${params.dateReceived}` : '';
  const htmlNotes = `<body><strong>User:</strong>\n${params.paralegalName}\n\n<strong>Event Type:</strong>\n${params.eventType}\n\n<strong>Document:</strong>\n${params.documentLabel}${receivedLine}\n\n———————————————\nThis task was submitted through <strong>Doc Triage</strong></body>`;

  const taskData = {
    name: params.name,
    html_notes: htmlNotes,
    projects: [params.projectGid],
    custom_fields: {
      [EVENT_TYPE_FIELD_GID]: enumGid,
    },
  };

  const task = (await asanaPost('/tasks', taskData)) as { gid: string; permalink_url: string };
  return { gid: task.gid, url: task.permalink_url };
}

// Move task to a section
export async function moveTaskToSection(taskGid: string, sectionGid: string): Promise<void> {
  await asanaPost(`/sections/${sectionGid}/addTask`, { task: taskGid });
}

// Attach a file to a task (multipart upload)
export async function attachFile(
  taskGid: string,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<void> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(fileBuffer)], { type: mimeType });
  formData.append('file', blob, fileName);

  const res = await fetch(`${ASANA_API}/tasks/${taskGid}/attachments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Asana file attachment failed: ${err}`);
  }
}
