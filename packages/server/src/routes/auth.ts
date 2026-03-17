import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { verifyToken } from '../middleware/auth.js';
import { PARALEGALS } from 'shared/types.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRY = '24h';

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password required' });
    return;
  }

  const expectedEmail = 'docs@vpatellaw.com';
  const passwordHash = process.env.AUTH_PASSWORD_HASH;

  if (!passwordHash) {
    res.status(500).json({ error: 'Server auth not configured' });
    return;
  }

  if (email !== expectedEmail) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, passwordHash);
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.json({ token });
});

router.get('/me', verifyToken, (req, res) => {
  res.json({ email: req.user!.email, paralegal: req.user!.paralegal || null });
});

router.post('/select-paralegal', verifyToken, (req, res) => {
  const { name } = req.body;

  if (!name || !PARALEGALS.includes(name)) {
    res.status(400).json({ error: `Invalid paralegal. Must be one of: ${PARALEGALS.join(', ')}` });
    return;
  }

  // Re-issue token with paralegal claim
  const token = jwt.sign(
    { email: req.user!.email, paralegal: name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY },
  );
  res.json({ token, paralegal: name });
});

export { router as authRouter };
