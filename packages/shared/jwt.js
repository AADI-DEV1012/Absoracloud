// ── JWT Utilities ──
// Single sign-on: one token works across MC, VPS, DevBox, WebHost.

import jwt from 'jsonwebtoken';

const SECRET = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('Missing JWT_SECRET env var');
  return s;
};

export function signToken(payload, expiresIn = '24h') {
  return jwt.sign(payload, SECRET(), { expiresIn });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET());
  } catch (e) {
    return null;
  }
}

export function decodeToken(token) {
  return jwt.decode(token);
}
