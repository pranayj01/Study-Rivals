import 'dotenv/config'
import express from 'express'
import cors from 'cors'
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
const dataDir = path.resolve('data'); fs.mkdirSync(dataDir, { recursive: true })
const db = new Database(path.join(dataDir, 'study-rivals.db'))
db.pragma('journal_mode = WAL')
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT UNIQUE, password_hash TEXT, xp INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, last_session_date TEXT, daily_target INTEGER DEFAULT 120, status TEXT DEFAULT 'offline');
CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, user_id INTEGER, minutes INTEGER, completed_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS challenges (id INTEGER PRIMARY KEY, title TEXT, description TEXT, xp_reward INTEGER, target INTEGER, unit TEXT, week_key TEXT, claimed_by INTEGER, completed_at TEXT);
`)

const configuredUsers = [
  [process.env.PLAYER_ONE_NAME || 'Player One', process.env.PLAYER_ONE_PASSWORD || 'focus1'],
  [process.env.PLAYER_TWO_NAME || 'Player Two', process.env.PLAYER_TWO_PASSWORD || 'focus2']
]
for (const [name, password] of configuredUsers) {
  if (!db.prepare('SELECT id FROM users WHERE name=?').get(name)) db.prepare('INSERT INTO users(name,password_hash) VALUES(?,?)').run(name, bcrypt.hashSync(password, 10))
}
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
const app = express(); app.use(cors()); app.use(express.json())
const server = http.createServer(app); const io = new Server(server, { cors: { origin: '*' } })
const safeUsers = () => db.prepare(`SELECT id,name,xp,streak,daily_target AS dailyTarget,status,
  (SELECT COALESCE(SUM(minutes),0) FROM sessions s WHERE s.user_id=users.id AND date(s.completed_at,'localtime')=date('now','localtime')) AS todayMinutes,
  (SELECT COUNT(*) FROM sessions s WHERE s.user_id=users.id AND datetime(s.completed_at)>=datetime('now','-6 days')) AS weekSessions
  FROM users ORDER BY id`).all()
const snapshot = () => ({ users: safeUsers(), sessions: db.prepare(`SELECT s.id,s.minutes,s.completed_at AS completedAt,u.name FROM sessions s JOIN users u ON u.id=s.user_id ORDER BY s.id DESC LIMIT 12`).all(), challenges: db.prepare('SELECT * FROM challenges WHERE week_key=?').all(weekKey()), discordUrl: process.env.DISCORD_INVITE_URL || '' })
const broadcast = () => io.emit('snapshot', snapshot())

app.post('/api/login', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE name=?').get(req.body.name) as any
  if (!user || !bcrypt.compareSync(req.body.password || '', user.password_hash)) return res.status(401).json({ error: 'Wrong player or passcode.' })
  res.json({ token: jwt.sign({ id: user.id }, secret, { expiresIn: '30d' }), user: { id: user.id, name: user.name } })
})
app.get('/api/state', auth, (_req, res) => res.json(snapshot()))
app.patch('/api/profile', auth, (req: AuthReq, res) => { const target = Math.max(15, Math.min(720, Number(req.body.dailyTarget))); db.prepare('UPDATE users SET daily_target=? WHERE id=?').run(target, req.userId); broadcast(); res.json({ ok: true }) })
app.post('/api/status', auth, (req: AuthReq, res) => { const valid = ['focusing','break','online']; const status = valid.includes(req.body.status) ? req.body.status : 'online'; db.prepare('UPDATE users SET status=? WHERE id=?').run(status, req.userId); broadcast(); res.json({ ok: true }) })
app.post('/api/sessions', auth, async (req: AuthReq, res) => {
  const minutes = Math.max(1, Math.min(240, Number(req.body.minutes || 25))); const today = new Date().toISOString().slice(0,10)
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.userId) as any
  const streak = user.last_session_date === today ? user.streak : user.last_session_date === new Date(Date.now()-86400000).toISOString().slice(0,10) ? user.streak + 1 : 1
  db.transaction(() => { db.prepare('INSERT INTO sessions(user_id,minutes) VALUES(?,?)').run(req.userId, minutes); db.prepare('UPDATE users SET xp=xp+?,streak=?,last_session_date=?,status=? WHERE id=?').run(minutes*5, streak, today, 'online', req.userId) })()
  await discordNotify(`🎯 **${user.name}** completed a ${minutes}-minute focus session and earned **${minutes*5} XP**!`); broadcast(); res.json({ ok: true })
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
const dist = path.resolve('dist'); if (fs.existsSync(dist)) { app.use(express.static(dist)); app.use((req,res,next) => req.method === 'GET' && !req.path.startsWith('/api') ? res.sendFile(path.join(dist,'index.html')) : next()) }
server.listen(port, '0.0.0.0', () => console.log(`Study Rivals ready on http://0.0.0.0:${port}`))
