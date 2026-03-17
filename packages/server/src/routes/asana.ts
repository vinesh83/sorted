import { Router } from 'express';
import { verifyToken } from '../middleware/auth.js';
import { searchProjects, getProjectSections } from '../services/asana.js';

const router = Router();

router.use(verifyToken);

// GET /api/asana/projects?q=X
router.get('/projects', async (req, res) => {
  const q = (req.query.q as string) || '';
  if (!q || q.length < 2) {
    res.json({ projects: [] });
    return;
  }
  try {
    const projects = await searchProjects(q);
    res.json({ projects });
  } catch (err) {
    console.error('[asana] Project search error:', err);
    res.status(500).json({ error: 'Failed to search Asana projects' });
  }
});

// GET /api/asana/projects/:gid/sections
router.get('/projects/:gid/sections', async (req, res) => {
  try {
    const sections = await getProjectSections(req.params.gid);
    res.json({ sections });
  } catch (err) {
    console.error('[asana] Section fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch project sections' });
  }
});

export { router as asanaRouter };
