import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type { Document } from 'shared/types';

export function useDocuments(paralegal: string | null, status: string = 'pending') {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!paralegal) return;
    try {
      setLoading(true);
      const res = await api.get<{ documents: Document[] }>(
        `/documents?paralegal=${paralegal}&status=${status}`,
      );
      setDocuments(res.documents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, [paralegal, status]);

  useEffect(() => {
    refresh();
    // Poll every 10 seconds for new documents
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { documents, loading, error, refresh };
}

export function useDocument(id: number | null) {
  const [document, setDocument] = useState<Document | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!id) { setDocument(null); return; }
    setLoading(true);
    try {
      const res = await api.get<{ document: Document }>(`/documents/${id}`);
      setDocument(res.document);
    } catch {
      setDocument(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const updateField = useCallback(async (fields: Record<string, unknown>) => {
    if (!id) return;
    const res = await api.patch<{ document: Document }>(`/documents/${id}`, fields);
    setDocument(res.document);
    return res.document;
  }, [id]);

  const claim = useCallback(async () => {
    if (!id) return;
    await api.post(`/documents/${id}/claim`);
  }, [id]);

  const skip = useCallback(async () => {
    if (!id) return;
    await api.post(`/documents/${id}/skip`);
  }, [id]);

  const approve = useCallback(async () => {
    if (!id) return null;
    const res = await api.post<{
      result: {
        success: boolean;
        taskGid?: string;
        taskUrl?: string;
        taskCreated: boolean;
        sectionMoved: boolean;
        fileAttached: boolean;
        errors: string[];
      };
    }>(`/documents/${id}/approve`);
    return res.result;
  }, [id]);

  const retryClassify = useCallback(async () => {
    if (!id) return;
    const res = await api.post<{ document: Document }>(`/documents/${id}/retry-classify`);
    setDocument(res.document);
  }, [id]);

  const retryAttach = useCallback(async () => {
    if (!id) return;
    await api.post(`/documents/${id}/retry-attach`);
  }, [id]);

  return { document, loading, load, updateField, claim, skip, approve, retryClassify, retryAttach };
}
