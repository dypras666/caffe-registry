const jwt = require('jsonwebtoken');

function getSecret() {
  return process.env.JWT_SECRET;
}

function superadminAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, getSecret());
    if (decoded.role !== 'superadmin') return res.status(403).json({ error: 'Forbidden' });
    req.user = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { superadminAuth, getSecret };
