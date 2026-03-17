import { useState, useCallback } from 'react';
import { api } from '../api/client';
import type { AsanaProject, AsanaSection } from 'shared/types';

export function useAsanaSearch() {
  const [projects, setProjects] = useState<AsanaProject[]>([]);
  const [searching, setSearching] = useState(false);

  const searchProjects = useCallback(async (query: string) => {
    if (query.length < 2) { setProjects([]); return; }
    setSearching(true);
    try {
      const res = await api.get<{ projects: AsanaProject[] }>(`/asana/projects?q=${encodeURIComponent(query)}`);
      setProjects(res.projects);
    } catch {
      setProjects([]);
    } finally {
      setSearching(false);
    }
  }, []);

  return { projects, searching, searchProjects };
}

export function useAsanaSections(projectGid: string | null) {
  const [sections, setSections] = useState<AsanaSection[]>([]);
  const [loading, setLoading] = useState(false);

  const loadSections = useCallback(async () => {
    if (!projectGid) { setSections([]); return; }
    setLoading(true);
    try {
      const res = await api.get<{ sections: AsanaSection[] }>(`/asana/projects/${projectGid}/sections`);
      setSections(res.sections);
    } catch {
      setSections([]);
    } finally {
      setLoading(false);
    }
  }, [projectGid]);

  return { sections, loading, loadSections };
}
