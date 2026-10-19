// ── JWT Utilities ──
// Single sign-on: one token works across MC, VPS, DevBox, WebHost.

import jwt from 'jsonwebtoken';

const SECRET = () => {
  return process.env.JWT_SECRET || 'absoracloud_jwt_secret_production_2026_key';
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
