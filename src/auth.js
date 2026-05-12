// Sessions are signed cookies + file-based store (express-session + custom FileStore).
// The file store lives under DATA_DIR (Render persistent disk) so sessions survive
// bot restarts — without it, every deploy or restart logs everyone out.
//
// Exports: buildSessionMiddleware, requireAuth, requireAdmin.

import session from "express-session";
import fs from "node:fs";
import path from "node:path";

const SESSIONS_DIR = path.join(process.env.DATA_DIR || "/var/data", "sessions");
try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

class FileStore extends session.Store {
  get(sid, cb) {
    fs.readFile(path.join(SESSIONS_DIR, sid + ".json"), "utf8", (err, data) => {
      if (err && err.code === "ENOENT") return cb();
      if (err) return cb(err);
      try { cb(null, JSON.parse(data)); } catch (e) { cb(e); }
    });
  }
  set(sid, sess, cb) {
    fs.writeFile(path.join(SESSIONS_DIR, sid + ".json"), JSON.stringify(sess), "utf8", (err) => cb && cb(err));
  }
  destroy(sid, cb) {
    fs.unlink(path.join(SESSIONS_DIR, sid + ".json"), (err) => {
      if (err && err.code !== "ENOENT") return cb && cb(err);
      cb && cb();
    });
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

const sharedStore = new FileStore();

export function buildSessionMiddleware() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET env var is required");
  }
  return session({
    secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: sharedStore,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    },
  });
}

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    if (req.accepts("html")) return res.redirect("/login");
    return res.status(401).json({ error: "unauthorized" });
  }
  const user = Users.findById(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    if (req.accepts("html")) return res.redirect("/login");
    return res.status(401).json({ error: "unauthorized" });
  }
  req.user = user;
  next();
}

// Middleware: require admin role.
export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") {
      if (req.accepts("html"))
        return res.status(403).send("Forbidden â admin only.");
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  });
}
