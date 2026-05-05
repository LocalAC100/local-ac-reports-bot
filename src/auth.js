// Login + session middleware.
// Sessions are signed cookies (express-session, in-memory store).
// In-memory is fine for a single-instance Render service; if we ever scale
// beyond 1 instance we'd need Redis or SQLite-backed sessions.
import session from "express-session";
import { Users } from "./db.js";

export function buildSessionMiddleware() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET env var is required. Generate one: openssl rand -hex 32"
    );
  }
  return session({
    name: "controlroom.sid",
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  });
}

// Middleware: require an authenticated user, otherwise redirect to /login.
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
        return res.status(403).send("Forbidden — admin only.");
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  });
}
