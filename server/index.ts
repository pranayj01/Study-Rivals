import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { Server } from 'socket.io'
import { Client, GatewayIntentBits } from 'discord.js'

const port = Number(process.env.PORT || 3001)
const secret = process.env.JWT_SECRET || 'development-only-change-me'
const isProduction = process.env.NODE_ENV === 'production'
if (isProduction && secret === 'development-only-change-me') throw new Error('JWT_SECRET must be set in production')
const allowedOrigins = (process.env.APP_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean)
const dataDir = path.resolve(process.env.DATA_DIR || 'data'); fs.mkdirSync(dataDir, { recursive: true })
const db = new Database(path.join(dataDir, 'study-rivals.db'))
db.pragma('journal_mode = WAL')
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT UNIQUE, password_hash TEXT, xp INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, last_session_date TEXT, daily_target INTEGER DEFAULT 120, status TEXT DEFAULT 'offline', player_slot INTEGER, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, user_id INTEGER, minutes INTEGER, completed_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS challenges (id INTEGER PRIMARY KEY, title TEXT, description TEXT, xp_reward INTEGER, target INTEGER, unit TEXT, week_key TEXT, claimed_by INTEGER, completed_at TEXT);
CREATE TABLE IF NOT EXISTS timers (user_id INTEGER PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'focus', duration_seconds INTEGER NOT NULL DEFAULT 1500, remaining_seconds INTEGER NOT NULL DEFAULT 1500, running INTEGER NOT NULL DEFAULT 0, ends_at INTEGER);
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, tracked_seconds INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0, active_since INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, FOREIGN KEY(user_id) REFERENCES users(id));
`)

const userColumns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[]
if (!userColumns.some(column => column.name === 'player_slot')) db.exec('ALTER TABLE users ADD COLUMN player_slot INTEGER')
if (!userColumns.some(column => column.name === 'active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1')
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_player_slot ON users(player_slot) WHERE player_slot IS NOT NULL')
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_user ON tasks(user_id) WHERE active=1')
const timerColumns = db.prepare('PRAGMA table_info(timers)').all() as { name: string }[]
if (!timerColumns.some(column => column.name === 'task_id')) db.exec('ALTER TABLE timers ADD COLUMN task_id INTEGER')
if (!timerColumns.some(column => column.name === 'started_at')) db.exec('ALTER TABLE timers ADD COLUMN started_at INTEGER')

const configuredUsers: [string, string][] = [
  [process.env.PLAYER_ONE_NAME || 'Player One', process.env.PLAYER_ONE_PASSWORD || 'focus1'],
  [process.env.PLAYER_TWO_NAME || 'Player Two', process.env.PLAYER_TWO_PASSWORD || 'focus2']
]
db.transaction(() => {
  db.prepare('UPDATE users SET player_slot=NULL,active=0,status=\'offline\'').run()
  configuredUsers.forEach(([name, password], index) => {
    const slot = index + 1
    const user = db.prepare('SELECT id FROM users WHERE name=?').get(name) as { id: number } | undefined
    if (user) db.prepare('UPDATE users SET password_hash=?,player_slot=?,active=1 WHERE id=?').run(bcrypt.hashSync(password, 10), slot, user.id)
    else db.prepare('INSERT INTO users(name,password_hash,player_slot,active) VALUES(?,?,?,1)').run(name, bcrypt.hashSync(password, 10), slot)
  })
})()
const weekKey = () => { const d = new Date(); const start = new Date(d.getFullYear(), 0, 1); return `${d.getFullYear()}-W${Math.ceil((((+d - +start) / 86400000) + start.getDay() + 1) / 7)}` }
if (!db.prepare('SELECT id FROM challenges WHERE week_key=?').get(weekKey())) {
  const add = db.prepare('INSERT INTO challenges(title,description,xp_reward,target,unit,week_key) VALUES(?,?,?,?,?,?)')
  add.run('Deep Work Duel', 'Complete 4 focus sessions this week.', 250, 4, 'sessions', weekKey())
  add.run('Century Club', 'Study for 100 focused minutes.', 180, 100, 'minutes', weekKey())
}

type AuthReq = express.Request & { userId?: number }
const auth = (req: AuthReq, res: express.Response, next: express.NextFunction) => {
  try { req.userId = Number((jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), secret) as { id: number }).id); next() }
  catch { res.status(401).json({ error: 'Please sign in again.' }) }
}
const originAllowed = (origin?: string) => !origin || !isProduction || allowedOrigins.includes(origin)
const corsOptions: cors.CorsOptions = { origin: (origin, done) => originAllowed(origin) ? done(null, true) : done(new Error('Origin not allowed')) }
const app = express(); app.set('trust proxy', 1); app.disable('x-powered-by'); app.use(helmet({ crossOriginResourcePolicy: false })); app.use(cors(corsOptions)); app.use(express.json({ limit: '32kb' }))
const server = http.createServer(app); const io = new Server(server, { cors: corsOptions, transports: ['websocket', 'polling'] })
const safeUsers = () => db.prepare(`SELECT users.id,users.name,users.xp,users.streak,users.daily_target AS dailyTarget,users.status,
  (SELECT COALESCE(SUM(minutes),0) FROM sessions s WHERE s.user_id=users.id AND date(s.completed_at,'localtime')=date('now','localtime')) AS todayMinutes,
  (SELECT COUNT(*) FROM sessions s WHERE s.user_id=users.id AND datetime(s.completed_at)>=datetime('now','-6 days')) AS weekSessions,
  timers.mode AS timerMode,timers.running AS timerRunning,timers.duration_seconds AS timerDurationSeconds,
  timers.remaining_seconds AS timerRemainingSeconds,timers.ends_at AS timerEndsAt
  FROM users LEFT JOIN timers ON timers.user_id=users.id WHERE users.active=1 ORDER BY users.player_slot`).all()
const safeTasks = () => {
  return (db.prepare(`SELECT tasks.id,tasks.user_id AS userId,users.name AS userName,tasks.title,tasks.progress,
    tasks.tracked_seconds AS trackedSeconds,tasks.active,tasks.active_since AS activeSince,tasks.completed_at AS completedAt,
    timers.running AS timerRunning,timers.mode AS timerMode,timers.task_id AS timerTaskId,timers.started_at AS timerStartedAt,timers.ends_at AS timerEndsAt
    FROM tasks JOIN users ON users.id=tasks.user_id LEFT JOIN timers ON timers.user_id=tasks.user_id
    WHERE users.active=1 ORDER BY tasks.active DESC,tasks.completed_at IS NOT NULL,tasks.id DESC`).all() as any[]).map(task => ({
      id: task.id, userId: task.userId, userName: task.userName, title: task.title, progress: task.progress,
      trackedSeconds: task.trackedSeconds,
      trackingStartedAt: task.timerRunning && task.timerMode === 'focus' && task.timerTaskId === task.id ? task.timerStartedAt : null,
      trackingEndsAt: task.timerRunning && task.timerMode === 'focus' && task.timerTaskId === task.id ? task.timerEndsAt : null,
      active: Boolean(task.active), activeSince: task.activeSince, completedAt: task.completedAt
    }))
}
const snapshot = () => ({
  users: safeUsers(),
  sessions: db.prepare(`SELECT s.id,s.minutes,s.completed_at AS completedAt,u.name FROM sessions s JOIN users u ON u.id=s.user_id ORDER BY s.id DESC LIMIT 12`).all(),
  tasks: safeTasks(),
  studyHistory: db.prepare(`SELECT s.user_id AS userId,date(s.completed_at,'localtime') AS date,SUM(s.minutes) AS minutes
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE u.active=1 AND date(s.completed_at,'localtime')>=date('now','localtime','-370 days')
    GROUP BY s.user_id,date(s.completed_at,'localtime') ORDER BY date`).all(),
  challenges: db.prepare('SELECT * FROM challenges WHERE week_key=?').all(weekKey()),
  discordUrl: process.env.DISCORD_INVITE_URL || ''
})
const broadcast = () => io.emit('snapshot', snapshot())

type TimerRow = { user_id:number; mode:'focus'|'break'; duration_seconds:number; remaining_seconds:number; running:number; ends_at:number|null; task_id:number|null; started_at:number|null }
const timerDuration = (mode: 'focus'|'break') => mode === 'focus' ? 25 * 60 : 5 * 60
const ensureTimer = (userId: number) => db.prepare(`INSERT INTO timers(user_id) VALUES(?) ON CONFLICT(user_id) DO NOTHING`).run(userId)
const publicTimer = (row: TimerRow) => ({
  mode: row.mode,
  durationSeconds: row.duration_seconds,
  remainingSeconds: row.running && row.ends_at ? Math.max(0, Math.ceil((row.ends_at - Date.now()) / 1000)) : row.remaining_seconds,
  running: Boolean(row.running),
  endsAt: row.ends_at
})
const creditTaskTime = (timer: TimerRow, stopAt = Date.now()) => {
  if (!timer.running || timer.mode !== 'focus' || !timer.task_id || !timer.started_at) return
  const effectiveStop = timer.ends_at ? Math.min(stopAt, timer.ends_at) : stopAt
  const elapsed = Math.max(0, Math.floor((effectiveStop - timer.started_at) / 1000))
  if (elapsed) db.prepare('UPDATE tasks SET tracked_seconds=tracked_seconds+? WHERE id=? AND user_id=?').run(elapsed, timer.task_id, timer.user_id)
}
const recordFocusSession = (userId: number, minutes: number) => {
  const today = new Date().toISOString().slice(0,10)
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId) as any
  if (!user) return null
  const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10)
  const streak = user.last_session_date === today ? user.streak : user.last_session_date === yesterday ? user.streak + 1 : 1
  db.prepare('INSERT INTO sessions(user_id,minutes) VALUES(?,?)').run(userId, minutes)
  db.prepare('UPDATE users SET xp=xp+?,streak=?,last_session_date=?,status=? WHERE id=?').run(minutes*5, streak, today, 'online', userId)
  return user
}
const finalizeExpiredTimers = () => {
  const completed: { userName:string; minutes:number }[] = []
  const expired = db.prepare('SELECT * FROM timers WHERE running=1 AND ends_at<=?').all(Date.now()) as TimerRow[]
  for (const timer of expired) db.transaction(() => {
    const current = db.prepare('SELECT * FROM timers WHERE user_id=?').get(timer.user_id) as TimerRow | undefined
    if (!current || !current.running || !current.ends_at || current.ends_at > Date.now()) return
    creditTaskTime(current, current.ends_at)
    if (current.mode === 'focus') {
      const minutes = Math.max(1, Math.round(current.duration_seconds / 60))
      const user = recordFocusSession(current.user_id, minutes)
      if (user) completed.push({ userName: user.name, minutes })
    }
    db.prepare('UPDATE timers SET running=0,remaining_seconds=0,ends_at=NULL,task_id=NULL,started_at=NULL WHERE user_id=?').run(current.user_id)
  })()
  return completed
}
const announceCompletedTimers = async () => {
  const completed = finalizeExpiredTimers()
  if (!completed.length) return
  broadcast()
  for (const session of completed) await discordNotify(`🎯 **${session.userName}** completed a ${session.minutes}-minute focus session and earned **${session.minutes*5} XP**!`)
}

app.get('/api/health', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok', service: 'study-rivals', time: new Date().toISOString() }) })
app.get('/api/players', (_req, res) => res.json({ players: (db.prepare('SELECT name FROM users WHERE active=1 ORDER BY player_slot').all() as { name: string }[]).map(user => user.name) }))
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many login attempts. Try again in 15 minutes.' } })
app.post('/api/login', loginLimiter, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE name=? AND active=1').get(req.body.name) as any
  if (!user || !bcrypt.compareSync(req.body.password || '', user.password_hash)) return res.status(401).json({ error: 'Wrong player or passcode.' })
  res.json({ token: jwt.sign({ id: user.id }, secret, { expiresIn: '30d' }), user: { id: user.id, name: user.name } })
})
app.get('/api/state', auth, (_req, res) => res.json(snapshot()))
app.get('/api/timer', auth, async (req: AuthReq, res) => {
  await announceCompletedTimers(); ensureTimer(req.userId!)
  res.json(publicTimer(db.prepare('SELECT * FROM timers WHERE user_id=?').get(req.userId) as TimerRow))
})
app.post('/api/timer/start', auth, async (req: AuthReq, res) => {
  await announceCompletedTimers(); ensureTimer(req.userId!)
  const timer = db.prepare('SELECT * FROM timers WHERE user_id=?').get(req.userId) as TimerRow
  const remaining = timer.remaining_seconds > 0 ? timer.remaining_seconds : timer.duration_seconds
  const endsAt = Date.now() + remaining * 1000
  const activeTask = timer.mode === 'focus' ? db.prepare('SELECT id FROM tasks WHERE user_id=? AND active=1 AND completed_at IS NULL').get(req.userId) as { id:number } | undefined : undefined
  db.prepare('UPDATE timers SET running=1,remaining_seconds=?,ends_at=?,task_id=?,started_at=? WHERE user_id=?').run(remaining, endsAt, activeTask?.id || null, Date.now(), req.userId)
  db.prepare('UPDATE users SET status=? WHERE id=?').run(timer.mode === 'focus' ? 'focusing' : 'break', req.userId)
  broadcast()
  res.json(publicTimer(db.prepare('SELECT * FROM timers WHERE user_id=?').get(req.userId) as TimerRow))
})
app.post('/api/timer/pause', auth, async (req: AuthReq, res) => {
  await announceCompletedTimers(); ensureTimer(req.userId!)
  const timer = db.prepare('SELECT * FROM timers WHERE user_id=?').get(req.userId) as TimerRow
  const remaining = timer.running && timer.ends_at ? Math.max(0, Math.ceil((timer.ends_at - Date.now()) / 1000)) : timer.remaining_seconds
  creditTaskTime(timer)
  db.prepare('UPDATE timers SET running=0,remaining_seconds=?,ends_at=NULL,task_id=NULL,started_at=NULL WHERE user_id=?').run(remaining, req.userId)
  db.prepare("UPDATE users SET status='online' WHERE id=?").run(req.userId)
  broadcast()
  res.json(publicTimer(db.prepare('SELECT * FROM timers WHERE user_id=?').get(req.userId) as TimerRow))
})
app.post('/api/timer/reset', auth, (req: AuthReq, res) => {
  ensureTimer(req.userId!)
  const current = db.prepare('SELECT * FROM timers WHERE user_id=?').get(req.userId) as TimerRow
  creditTaskTime(current)
  const mode: 'focus'|'break' = req.body.mode === 'break' ? 'break' : 'focus'
  const requestedMinutes = Number(req.body.durationMinutes)
  const maxMinutes = mode === 'focus' ? 240 : 120
  const duration = Number.isFinite(requestedMinutes) ? Math.max(1, Math.min(maxMinutes, requestedMinutes)) * 60 : timerDuration(mode)
  db.prepare(`INSERT INTO timers(user_id,mode,duration_seconds,remaining_seconds,running,ends_at,task_id,started_at) VALUES(?,?,?,?,0,NULL,NULL,NULL)
    ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode,duration_seconds=excluded.duration_seconds,remaining_seconds=excluded.remaining_seconds,running=0,ends_at=NULL,task_id=NULL,started_at=NULL`).run(req.userId, mode, duration, duration)
  db.prepare('UPDATE users SET status=? WHERE id=?').run(mode === 'break' ? 'break' : 'online', req.userId)
  broadcast()
  res.json(publicTimer(db.prepare('SELECT * FROM timers WHERE user_id=?').get(req.userId) as TimerRow))
})
app.patch('/api/profile', auth, (req: AuthReq, res) => { const target = Math.max(15, Math.min(720, Number(req.body.dailyTarget))); db.prepare('UPDATE users SET daily_target=? WHERE id=?').run(target, req.userId); broadcast(); res.json({ ok: true }) })
app.post('/api/status', auth, (req: AuthReq, res) => { const valid = ['focusing','break','online']; const status = valid.includes(req.body.status) ? req.body.status : 'online'; db.prepare('UPDATE users SET status=? WHERE id=?').run(status, req.userId); broadcast(); res.json({ ok: true }) })
app.post('/api/sessions', auth, async (req: AuthReq, res) => {
  const minutes = Math.max(1, Math.min(240, Number(req.body.minutes || 25)))
  const user = db.transaction(() => recordFocusSession(req.userId!, minutes))()
  if (!user) return res.status(404).json({ error: 'Player not found.' })
  await discordNotify(`🎯 **${user.name}** completed a ${minutes}-minute focus session and earned **${minutes*5} XP**!`); broadcast(); res.json({ ok: true })
})
app.post('/api/tasks', auth, (req: AuthReq, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120)
  if (!title) return res.status(400).json({ error: 'Task title is required.' })
  const count = (db.prepare('SELECT COUNT(*) count FROM tasks WHERE user_id=? AND completed_at IS NULL').get(req.userId) as { count:number }).count
  if (count >= 30) return res.status(400).json({ error: 'Complete or remove an active task before adding more.' })
  const result = db.prepare('INSERT INTO tasks(user_id,title) VALUES(?,?)').run(req.userId, title)
  broadcast(); res.status(201).json({ id: result.lastInsertRowid })
})
app.patch('/api/tasks/:id', auth, (req: AuthReq, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(req.params.id, req.userId) as any
  if (!task) return res.status(404).json({ error: 'Task not found.' })
  const title = req.body.title === undefined ? task.title : String(req.body.title).trim().slice(0, 120)
  const progress = Math.max(0, Math.min(100, Number(req.body.progress ?? task.progress)))
  if (!title) return res.status(400).json({ error: 'Task title is required.' })
  const completedAt = progress >= 100 ? new Date().toISOString() : null
  db.transaction(() => {
    if (completedAt) {
      const timer = db.prepare('SELECT * FROM timers WHERE user_id=?').get(req.userId) as TimerRow | undefined
      if (timer && timer.task_id === task.id) { creditTaskTime(timer); db.prepare('UPDATE timers SET task_id=NULL,started_at=NULL WHERE user_id=?').run(req.userId) }
    }
    db.prepare('UPDATE tasks SET title=?,progress=?,completed_at=?,active=CASE WHEN ? IS NULL THEN active ELSE 0 END,active_since=CASE WHEN ? IS NULL THEN active_since ELSE NULL END WHERE id=?').run(title, progress, completedAt, completedAt, completedAt, task.id)
  })()
  broadcast(); res.json({ ok: true })
})
app.post('/api/tasks/:id/select', auth, (req: AuthReq, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=? AND completed_at IS NULL').get(req.params.id, req.userId) as any
  if (!task) return res.status(404).json({ error: 'Active task not found.' })
  db.transaction(() => {
    ensureTimer(req.userId!)
    const timer = db.prepare('SELECT * FROM timers WHERE user_id=?').get(req.userId) as TimerRow
    creditTaskTime(timer)
    db.prepare('UPDATE tasks SET active=0,active_since=NULL WHERE user_id=?').run(req.userId)
    db.prepare('UPDATE tasks SET active=1,active_since=? WHERE id=?').run(Date.now(), task.id)
    if (timer.running && timer.mode === 'focus') db.prepare('UPDATE timers SET task_id=?,started_at=? WHERE user_id=?').run(task.id, Date.now(), req.userId)
  })()
  broadcast(); res.json({ ok: true })
})
app.delete('/api/tasks/:id', auth, (req: AuthReq, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(req.params.id, req.userId) as any
  if (!task) return res.status(404).json({ error: 'Task not found.' })
  db.transaction(() => {
    const timer = db.prepare('SELECT * FROM timers WHERE user_id=?').get(req.userId) as TimerRow | undefined
    if (timer && timer.task_id === task.id) { creditTaskTime(timer); db.prepare('UPDATE timers SET task_id=NULL,started_at=NULL WHERE user_id=?').run(req.userId) }
    db.prepare('DELETE FROM tasks WHERE id=?').run(task.id)
  })()
  broadcast(); res.json({ ok: true })
})
app.post('/api/challenges/:id/claim', auth, async (req: AuthReq, res) => {
  const challenge = db.prepare('SELECT * FROM challenges WHERE id=? AND claimed_by IS NULL').get(req.params.id) as any
  if (!challenge) return res.status(409).json({ error: 'This bounty was already claimed.' })
  const progress = challenge.unit === 'minutes' ? db.prepare(`SELECT COALESCE(SUM(minutes),0) v FROM sessions WHERE user_id=? AND datetime(completed_at)>=datetime('now','-6 days')`).get(req.userId) as any : db.prepare(`SELECT COUNT(*) v FROM sessions WHERE user_id=? AND datetime(completed_at)>=datetime('now','-6 days')`).get(req.userId) as any
  if (progress.v < challenge.target) return res.status(400).json({ error: `You need ${challenge.target - progress.v} more ${challenge.unit}.` })
  db.transaction(() => { db.prepare('UPDATE challenges SET claimed_by=?,completed_at=CURRENT_TIMESTAMP WHERE id=?').run(req.userId, challenge.id); db.prepare('UPDATE users SET xp=xp+? WHERE id=?').run(challenge.xp_reward, req.userId) })()
  const user = db.prepare('SELECT name FROM users WHERE id=?').get(req.userId) as any; await discordNotify(`🏆 **${user.name}** claimed **${challenge.title}** for ${challenge.xp_reward} XP!`); broadcast(); res.json({ ok: true })
})

io.use((socket, next) => { try { const data = jwt.verify(socket.handshake.auth.token, secret) as { id: number }; socket.data.userId = data.id; next() } catch { next(new Error('unauthorized')) } })
io.on('connection', socket => { db.prepare("UPDATE users SET status='online' WHERE id=?").run(socket.data.userId); socket.emit('snapshot', snapshot()); broadcast(); socket.on('disconnect', () => setTimeout(() => { if (![...io.sockets.sockets.values()].some(s => s.data.userId === socket.data.userId)) { db.prepare("UPDATE users SET status='offline' WHERE id=?").run(socket.data.userId); broadcast() } }, 1500)) })

let discord: Client | null = null
async function discordNotify(message: string) { if (!discord || !process.env.DISCORD_CHANNEL_ID) return; try { const channel = await discord.channels.fetch(process.env.DISCORD_CHANNEL_ID); if (channel?.isTextBased() && 'send' in channel) await channel.send(message) } catch (e) { console.error('Discord notification failed', e) } }
if (process.env.DISCORD_BOT_TOKEN) { discord = new Client({ intents: [GatewayIntentBits.Guilds] }); discord.login(process.env.DISCORD_BOT_TOKEN).catch(console.error) }
const timerSweep = setInterval(() => { announceCompletedTimers().catch(console.error) }, 5_000)
const dist = path.resolve('dist'); if (fs.existsSync(dist)) { app.use(express.static(dist)); app.use((req,res,next) => req.method === 'GET' && !req.path.startsWith('/api') ? res.sendFile(path.join(dist,'index.html')) : next()) }
server.listen(port, '127.0.0.1', () => console.log(`Study Rivals ready on http://127.0.0.1:${port}`))

const shutdown = (signal: string) => {
  console.log(`${signal} received; shutting down`)
  clearInterval(timerSweep)
  io.close()
  server.close(() => { discord?.destroy(); db.close(); process.exit(0) })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
