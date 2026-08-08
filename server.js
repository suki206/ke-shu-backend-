require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const { createClient } = require('@supabase/supabase-js')
const fetch   = require('node-fetch')

// ============================================================
// Ombre Brain MCP 客户端
// ============================================================
const OMBRE_BRAIN_URL  = process.env.OMBRE_BRAIN_URL  || ''
const OMBRE_MCP_TOKEN  = process.env.OMBRE_MCP_TOKEN  || ''
let ombreSessionId = null
let ombreCallId    = 0

function parseSSEResponse(text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      try { return JSON.parse(line.substring(5)) } catch {}
    }
  }
  try { return JSON.parse(text) } catch { return null }
}

async function initOmbreSession() {
  if (!OMBRE_BRAIN_URL) return false
  try {
    const r = await fetch(`${OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json,text/event-stream',
        'Authorization': `Bearer ${OMBRE_MCP_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ke-shu-backend', version: '1.0' } },
        id: ++ombreCallId,
      }),
    })
    ombreSessionId = r.headers.get('mcp-session-id')
    await fetch(`${OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json,text/event-stream',
        'Mcp-Session-Id': ombreSessionId,
        'Authorization': `Bearer ${OMBRE_MCP_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    console.log('🧠 Ombre Brain 已连接:', OMBRE_BRAIN_URL)
    return true
  } catch (err) {
    console.error('MCP 会话初始化失败:', err.message)
    ombreSessionId = null
    return false
  }
}

async function callOmbreTool(toolName, args = {}) {
  if (!OMBRE_BRAIN_URL) return null
  try {
    if (!ombreSessionId) {
      const ok = await initOmbreSession()
      if (!ok) return null
    }
    const r = await fetch(`${OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json,text/event-stream',
        'Mcp-Session-Id': ombreSessionId,
        'Authorization': `Bearer ${OMBRE_MCP_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'tools/call',
        params: { name: toolName, arguments: args },
        id: ++ombreCallId,
      }),
    })
    const text   = await r.text()
    const parsed = parseSSEResponse(text)
    console.log(`MCP ${toolName} FULL:`, JSON.stringify(parsed))
    if (parsed?.result?.content) {
      return parsed.result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
    }
    return parsed?.result ?? null
  } catch (err) {
    console.error(`MCP 工具 ${toolName} 调用失败:`, err.message)
    ombreSessionId = null
    return null
  }
}

// ── 清洗 breath 返回的原始文本 ────────────────────────────────
// 移除 [bucket_id:...] [payload_sha256:...] Footprint:... 等元数据
// 去重，最多保留 maxItems 条
function cleanBreathMemory(raw, maxItems = 8) {
  if (!raw) return ''
  const chunks = raw
    .split(/\n?---\n?|\[bucket_id:[a-f0-9-]+\]/i)
    .map(s => s.trim())
    .filter(Boolean)

  const seen    = new Set()
  const cleaned = []
  for (let chunk of chunks) {
    if (cleaned.length >= maxItems) break
    chunk = chunk.replace(/\[[a-z0-9_]+:[^\]]*\]/gi, '').trim()
    chunk = chunk.replace(/Footprint[:：][^\n]*/g, '').trim()
    const m = chunk.match(/用户说[：:]\s*([^\n]+)/)
    if (m) chunk = m[1].trim()
    chunk = chunk.replace(/\n{2,}/g, '\n').trim()
    if (!chunk || chunk.length < 4) continue
    const key = chunk.slice(0, 20)
    if (seen.has(key)) continue
    seen.add(key)
    cleaned.push(chunk)
  }
  return cleaned.join('；')
}

// ── 判断用户这句话是否值得记住 ────────────────────────────────
async function shouldRemember(content) {
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: `判断以下这句话本身，是否包含用户明确陈述的、值得长期记住的事实（如个人喜好、身份信息、计划安排、重要事件）。只看这句话是否是用户自己说出的具体事实，不要管语气或是否礼貌。如果只是打招呼、闲聊、提问、或不含具体信息，回答"否"。只回复"是"或"否"，不要解释。\n\n用户说：${content}` }],
        max_tokens: 2, temperature: 0,
      }),
    })
    const d = await r.json()
    return (d.choices?.[0]?.message?.content || '').includes('是')
  } catch { return false }
}

// ── 把用户这句话提炼成一句精简事实 ────────────────────────────
async function extractFact(content) {
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: `把用户这句话里的事实提炼成一句最简短的陈述句（不超过20字），第三人称"用户"开头。只输出提炼后的句子，不要解释，不要标点以外的多余内容。\n\n用户说：${content}` }],
        max_tokens: 40, temperature: 0,
      }),
    })
    const d = await r.json()
    return d.choices?.[0]?.message?.content?.trim() || `用户说：${content}`
  } catch { return `用户说：${content}` }
}

// ============================================================
// Express 基础
// ============================================================
const app  = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

// ============================================================
// 密码锁 —— 除 /api/auth/verify 外，其余 /api/* 一律校验 X-Access-Key
// 未配置 ACCESS_KEY 环境变量时视为本地开发环境，不启用校验
// ============================================================
const ACCESS_KEY = process.env.ACCESS_KEY || ''

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next()
  if (req.path === '/api/auth/verify') return next()
  if (!ACCESS_KEY) return next()
  const key = req.headers['x-access-key']
  if (key !== ACCESS_KEY) return res.status(401).json({ error: '未授权' })
  next()
})

app.post('/api/auth/verify', (req, res) => {
  const { key } = req.body || {}
  if (!ACCESS_KEY) return res.json({ success: true })   // 未设密码，直接放行
  if (key === ACCESS_KEY) return res.json({ success: true })
  res.status(401).json({ error: '密钥不对' })
})

console.log('=============== 环境检查 ===============')
console.log('SUPABASE_URL:',     process.env.SUPABASE_URL      ? '已读取' : '缺失')
console.log('SUPABASE_KEY:',     process.env.SUPABASE_ANON_KEY ? '已读取' : '缺失')
console.log('DEEPSEEK_API_KEY:', process.env.DEEPSEEK_API_KEY  ? '已读取' : '缺失')
console.log('OMBRE_BRAIN_URL:',  process.env.OMBRE_BRAIN_URL   ? '已读取' : '缺失')
console.log('OMBRE_MCP_TOKEN:',  process.env.OMBRE_MCP_TOKEN   ? '已读取' : '缺失')
console.log('ACCESS_KEY:',       ACCESS_KEY                    ? '已设置（密码锁已启用）' : '未设置（密码锁关闭）')
console.log('========================================')

const supabase   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY)
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

// ── 工具函数 ──────────────────────────────────────────────────
function estimateToken(text) { return text ? Math.ceil(String(text).length / 4) : 0 }

// ── 北京时间（Asia/Shanghai，UTC+8）工具 ─────────────────────
// 服务器多半跑在 UTC 环境（如 Render），这里统一用固定 +8h 偏移换算，
// 不依赖系统时区设置。
const pad2 = n => String(n).padStart(2, '0')

function beijingNow() { return new Date(Date.now() + 8 * 3600 * 1000) }

function beijingTimeStr(d = new Date()) {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  return `${bj.getUTCFullYear()}-${pad2(bj.getUTCMonth() + 1)}-${pad2(bj.getUTCDate())} ${pad2(bj.getUTCHours())}:${pad2(bj.getUTCMinutes())}`
}

function beijingDateStr(d = new Date()) {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  return `${bj.getUTCFullYear()}-${pad2(bj.getUTCMonth() + 1)}-${pad2(bj.getUTCDate())}`
}

// 给定"北京日历日"字符串（YYYY-MM-DD），返回该自然日在 UTC 下的起止 ISO 时间
function beijingDayRange(dateStr) {
  const start = new Date(`${dateStr}T00:00:00+08:00`)
  const end   = new Date(start.getTime() + 24 * 3600 * 1000)
  return { start: start.toISOString(), end: end.toISOString() }
}

// 组装 System Prompt 时统一注入当前北京时间
function withTimeAwareness(systemPrompt) {
  return `${systemPrompt}\n\n[当前时间]\n现在是北京时间 ${beijingTimeStr()}`
}

function parseSettings(rows) {
  if (!rows?.length) return {}
  if ('key' in rows[0]) {
    return rows.reduce((acc, s) => { acc[s.key] = s.value; return acc }, {})
  }
  return rows[0]
}

// ============================================================
// 会话管理接口
// ============================================================
app.get('/api/sessions', async (req, res) => {
  try {
    const { data, error } = await supabase.from('sessions').select('*').order('updated_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/session/new', async (req, res) => {
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('sessions')
      .insert([{ title: '新对话', created_at: now, updated_at: now }]).select()
    if (error) return res.status(500).json({ error: error.message })
    res.json(data[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.put('/api/session/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { title } = req.body
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('sessions')
      .update({ title, updated_at: now }).eq('id', id).select()
    if (error) return res.status(500).json({ error: error.message })
    res.json(data[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.delete('/api/session/:id', async (req, res) => {
  try {
    const { id } = req.params
    await supabase.from('messages').delete().eq('session_id', id)
    await supabase.from('memories').delete().eq('session_id', id)
    const { error } = await supabase.from('sessions').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ============================================================
// 消息接口
// ============================================================
app.get('/api/messages/:sessionId', async (req, res) => {
  try {
    const { data, error } = await supabase.from('messages')
      .select('role,content,id,created_at,visible,quoted_text,is_edited,truncated,tokens_input,tokens_output')
      .eq('session_id', req.params.sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/messages/archived/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params
    const limit  = parseInt(req.query.limit) || 100
    const cursor = req.query.cursor

    let query = supabase.from('messages')
      .select('role,content,id,created_at,visible,quoted_text,is_edited,truncated,tokens_input,tokens_output')
      .eq('session_id', sessionId)
      .eq('visible', false)
      .order('created_at', { ascending: true })

    if (cursor) {
      const { data: cd } = await supabase.from('messages').select('created_at').eq('id', cursor).single()
      if (cd) query = query.lt('created_at', cd.created_at)
    }

    const { data, error } = await query.limit(limit + 1)
    if (error) return res.status(500).json({ error: error.message })
    const hasMore = data.length > limit
    res.json({ list: hasMore ? data.slice(0, limit) : data, hasMore })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ============================================================
// 设置接口
// ============================================================
app.get('/api/settings', async (req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*')
    if (error) return res.status(500).json({ error: error.message })
    res.json(parseSettings(data))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/settings', async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      const { error } = await supabase.from('settings').upsert([{ key, value }], { onConflict: 'key' })
      if (error) {
        const { error: e2 } = await supabase.from('settings').update({ [key]: value }).eq('id', 1)
        if (e2) return res.status(500).json({ error: e2.message })
      }
    }
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ============================================================
// Ombre Brain 记忆接口
// ============================================================

// 查看记忆列表
app.get('/api/memories/list', async (req, res) => {
  try {
    const q   = req.query.q || '用户 喜欢 记得'
    const raw = await callOmbreTool('breath', { query: q, max_results: 30 })
    if (!raw) return res.json({ memories: [], total: 0 })

    const chunks = raw
      .split(/\n?---\n?|\[bucket_id:[a-f0-9-]+\]/i)
      .map(s => {
        let c = s.replace(/\[[a-z0-9_]+:[^\]]*\]/gi, '').trim()
        c = c.replace(/Footprint[:：][^\n]*/g, '').trim()
        const m = c.match(/用户说[：:]\s*([^\n]+)/)
        if (m) c = m[1].trim()
        return c.replace(/\n{2,}/g, '\n').trim()
      })
      .filter(c => c && c.length > 3)

    const seen = new Set()
    const memories = chunks.filter(c => {
      const k = c.slice(0, 20)
      if (seen.has(k)) return false
      seen.add(k); return true
    }).slice(0, 25)

    res.json({ memories, total: memories.length })
  } catch (err) {
    console.error('记忆列表失败:', err.message)
    res.status(500).json({ error: err.message, memories: [] })
  }
})

// 触发 dream（自省消化）
app.post('/api/memories/dream', async (req, res) => {
  try {
    const result = await callOmbreTool('dream', {})
    console.log('🧠 dream 完成:', result)
    res.json({ success: true, result: result || 'done' })
  } catch (err) {
    console.error('dream 失败:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// 记忆压缩（对话过长时自动调用）
// ============================================================
async function compressHistory(sessionId, oldMsgList, compressPrompt) {
  const contentText = oldMsgList.map(m => `(${m.role}): ${m.content}`).join('\n')
  const aiRes = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: compressPrompt },
        { role: 'user',   content: `把下面对话总结成长期记忆，保留重要信息：\n${contentText}` },
      ],
      temperature: 0.3,
    }),
  })
  const d = await aiRes.json()
  if (!d.choices?.[0]) throw new Error(d.error?.message || 'DeepSeek 返回异常')
  const summary = d.choices[0].message.content

  await supabase.from('memories').insert([{ session_id: sessionId, summary, created_at: new Date().toISOString() }])
  await supabase.from('messages').update({ visible: false }).in('id', oldMsgList.map(m => m.id))

  // 压缩后同步归档到 Ombre Brain（grow，非阻塞）
  if (OMBRE_BRAIN_URL) {
    callOmbreTool('grow', { content: summary })
      .then(r => console.log('🧠 grow 归档完成:', r))
      .catch(e => console.error('grow 失败:', e.message))
  }

  return summary
}

// ============================================================
// 核心聊天接口（非流式，保留兼容）
// ============================================================
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, content } = req.body
    if (!sessionId || !content) return res.status(400).json({ error: '参数缺失：需要 sessionId 和 content' })

    // 1. 保存用户消息
    const userNow = new Date().toISOString()
    const { error: ue } = await supabase.from('messages').insert([{ session_id: sessionId, role: 'user', content, created_at: userNow, visible: true }])
    if (ue) return res.status(500).json({ error: '保存用户消息失败: ' + ue.message })

    // 2. 读取设置
    const { data: sRows } = await supabase.from('settings').select('*')
    const cfg = parseSettings(sRows || [])
    const { system_prompt = '你是温柔贴心的AI伴侣，简短自然回复', temperature = 0.7, compress_threshold = 3000, compress_keep_rounds = 4 } = cfg

    // 3. 历史 token 统计
    const { data: allHistory } = await supabase.from('messages').select('id,role,content,created_at,visible').eq('session_id', sessionId).order('created_at', { ascending: true })
    let totalTok = 0; allHistory?.forEach(m => { totalTok += estimateToken(m.content) })

    // 4. 按需压缩
    let memorySummary = ''
    const keepCount = Number(compress_keep_rounds) * 2
    if (totalTok > Number(compress_threshold) && (allHistory?.length || 0) > keepCount) {
      let reserve = keepCount
      if ((allHistory.length - reserve) % 2 !== 0) reserve++
      try { memorySummary = await compressHistory(sessionId, allHistory.slice(0, allHistory.length - reserve), '你是对话记忆总结助手') }
      catch (e) { console.error('压缩失败:', e.message) }
    }

    // 5. 组装系统提示词（注入当前北京时间）
    let systemPrompt = withTimeAwareness(system_prompt)
    if (memorySummary) systemPrompt += `\n【历史记忆】\n${memorySummary}`

    // 5.5 Ombre Brain 记忆检索
    let ombreMemory = ''
    try {
      const br = await callOmbreTool('breath', { query: content, max_results: 20 })
      const cm = cleanBreathMemory(br, 8)
      if (cm && !cm.includes('记忆池现在是空的') && cm.length > 0) {
        ombreMemory = `\n\n[你记得的事]\n${cm}`
        console.log('🧠 breath 清洗后:', cm)
      }
    } catch (e) { console.error('记忆检索失败:', e.message) }
    if (ombreMemory) systemPrompt += ombreMemory

    // 6. 可见历史
    const { data: visHist } = await supabase.from('messages').select('role,content').eq('session_id', sessionId).eq('visible', true).order('created_at', { ascending: true })

    // 7. 构建消息
    const sendMessages = [{ role: 'system', content: systemPrompt }]
    if (visHist?.length) sendMessages.push(...visHist.filter(m => m.content != null).map(m => ({ role: m.role, content: String(m.content) })))

    // 8. 调用主模型
    const aiRes = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: sendMessages, temperature: Number(temperature) }),
    })
    const aiData = await aiRes.json()
    if (!aiData.choices?.[0]) return res.status(500).json({ error: aiData.error?.message || 'AI 返回异常' })
    const replyText = aiData.choices[0].message.content

    // 9. 保存 AI 回复
    const aiNow = new Date().toISOString()
    const { data: savedMsg, error: aErr } = await supabase.from('messages').insert([{ session_id: sessionId, role: 'assistant', content: replyText, created_at: aiNow, visible: true }]).select()
    if (aErr) return res.status(500).json({ error: 'AI回复保存失败: ' + aErr.message })

    // 9.5 Ombre Brain hold（非阻塞）
    shouldRemember(content).then(worth => {
      if (!worth) return
      extractFact(content).then(fact => {
        callOmbreTool('hold', { content: fact }).then(r => console.log('🧠 hold:', fact, '->', r)).catch(e => console.error('hold失败:', e.message))
      })
    }).catch(e => console.error('shouldRemember失败:', e.message))

    // 10. 更新会话时间
    await supabase.from('sessions').update({ updated_at: aiNow }).eq('id', sessionId)

    // 11. 自动标题
    let autoTitle = null
    try {
      const { data: si } = await supabase.from('sessions').select('title').eq('id', sessionId).single()
      const { count } = await supabase.from('messages').select('*', { count: 'exact', head: true }).eq('session_id', sessionId).eq('visible', true)
      if (si?.title === '新对话' && count >= 2) {
        const tr = await fetch(DEEPSEEK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
          body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: '你是一个标题生成助手。根据对话内容，生成一个简短的标题（不超过10个字），直接返回标题文字，不要加引号或其他符号。' }, { role: 'user', content: `用户说：${content}\nAI回复：${replyText}\n请生成标题：` }], temperature: 0.5, max_tokens: 20 }),
        })
        const td = await tr.json()
        autoTitle = td.choices?.[0]?.message?.content?.trim().slice(0, 20) || null
        if (autoTitle) await supabase.from('sessions').update({ title: autoTitle, updated_at: aiNow }).eq('id', sessionId)
      }
    } catch (e) { console.error('自动标题失败:', e.message) }

    res.json({ reply: replyText, messageId: savedMsg?.[0]?.id, autoTitle })
  } catch (err) {
    console.error('聊天异常:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// 共享核心：读取会话最新历史 → 调用 DeepSeek 流式生成 → 保存
// /api/chat/stream（新消息）与 /api/chat/edit-stream（编辑重发）
// 都在各自准备好 messages 表数据后调用这个函数。
// 支持：停止生成（AbortController 透传断开上游）、
//      思考过程转发（reasoning_content）、Token 统计（usage）。
// ============================================================
async function runAssistantStream({ req, res, send, sessionId, triggerContent }) {
  // 1. 设置
  const { data: sRows } = await supabase.from('settings').select('*')
  const cfg = parseSettings(sRows || [])
  const { system_prompt = '你是温柔贴心的AI伴侣，简短自然回复', temperature = 0.7, compress_threshold = 3000, compress_keep_rounds = 4, model = 'deepseek-chat' } = cfg

  // 2. 历史
  const { data: allHistory } = await supabase.from('messages').select('id,role,content,created_at,visible').eq('session_id', sessionId).order('created_at', { ascending: true })
  let totalTok = 0; allHistory?.forEach(m => { totalTok += estimateToken(m.content) })

  // 3. 按需压缩
  let memorySummary = ''
  const keepCount = Number(compress_keep_rounds) * 2
  if (totalTok > Number(compress_threshold) && (allHistory?.length || 0) > keepCount) {
    let reserve = keepCount
    if ((allHistory.length - reserve) % 2 !== 0) reserve++
    try { memorySummary = await compressHistory(sessionId, allHistory.slice(0, allHistory.length - reserve), '你是对话记忆总结助手') }
    catch (e) { console.error('压缩失败:', e.message) }
  }

  // 4. 系统提示词（注入当前北京时间，做到"时间感知"）
  let systemPrompt = withTimeAwareness(system_prompt)
  if (memorySummary) systemPrompt += `\n【历史记忆】\n${memorySummary}`

  // 4.5 Ombre Brain breath（用触发这次生成的那句话做检索 query）
  let ombreMemory = ''
  try {
    const br = await callOmbreTool('breath', { query: triggerContent, max_results: 20 })
    const cm = cleanBreathMemory(br, 8)
    if (cm && !cm.includes('记忆池现在是空的') && cm.length > 0) {
      ombreMemory = `\n\n[你记得的事]\n${cm}`
      console.log('🧠 breath 命中，清洗后:', cm)
      send({ memoryHit: true, count: cm.split('；').length })
    }
  } catch (e) { console.error('记忆检索失败:', e.message) }
  if (ombreMemory) systemPrompt += ombreMemory

  // 5. 可见历史（引用内容单独存了 quoted_text 列，拼进发给模型的 content，
  //    让它读得到上下文，但不污染 messages 表里的原始正文）
  const { data: visHist } = await supabase.from('messages').select('role,content,quoted_text').eq('session_id', sessionId).eq('visible', true).order('created_at', { ascending: true })

  // 6. 构建消息
  const sendMessages = [{ role: 'system', content: systemPrompt }]
  if (visHist?.length) sendMessages.push(...visHist.filter(m => m.content != null).map(m => ({
    role: m.role,
    content: m.quoted_text ? `[引用: ${m.quoted_text}]\n${m.content}` : String(m.content),
  })))

  // 7. 停止生成：前端 AbortController.abort() 会让这次 fetch 的连接关闭，
  //    Node 侧的 req 会触发 'close'，据此中断与 DeepSeek 上游的连接。
  const upstreamController = new AbortController()
  let clientAborted = false
  const onClose = () => {
    clientAborted = true
    upstreamController.abort()
    if (!res.writableEnded) { try { res.destroy() } catch {} }
  }
  req.on('close', onClose)

  let fullText   = ''
  let reasoning  = ''
  let usage      = null

  try {
    // 8. 调用 DeepSeek（stream: true，附带 usage 统计）
    const aiRes = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model, messages: sendMessages, temperature: Number(temperature),
        stream: true, stream_options: { include_usage: true },
      }),
      signal: upstreamController.signal,
    })

    if (!aiRes.ok) {
      const errText = await aiRes.text()
      send({ error: `DeepSeek 错误: ${errText.slice(0, 300)}` })
      req.off('close', onClose)
      return res.end()
    }

    // 9. 流式转发 token（含 reasoning_content 折叠内容 与 usage）
    let buf = ''
    for await (const chunk of aiRes.body) {
      if (res.writableEnded) break
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const t = line.trim()
        if (!t || t === 'data: [DONE]') continue
        if (t.startsWith('data: ')) {
          try {
            const ev    = JSON.parse(t.slice(6))
            const delta = ev.choices?.[0]?.delta
            if (delta?.reasoning_content) { reasoning += delta.reasoning_content; send({ reasoning: delta.reasoning_content }) }
            if (delta?.content)           { fullText  += delta.content;           send({ token: delta.content }) }
            if (ev.usage) usage = ev.usage
          } catch {}
        }
      }
    }
  } catch (err) {
    if (!(clientAborted || err.name === 'AbortError')) {
      console.error('流式聊天异常:', err)
      send({ error: err.message })
    }
    // 无论是否为用户主动停止，已经生成的部分都要保留，见下方保存逻辑
  } finally {
    req.off('close', onClose)
  }

  if (clientAborted) console.log('⏹ 生成被用户中止，已保留部分内容，长度:', fullText.length)

  // 10. 保存 AI 回复（含被中止时的部分内容；token 统计与中断标记写入真实字段）
  if (!fullText && !reasoning) { if (!res.writableEnded) { try { res.end() } catch {} }; return }
  const aiNow = new Date().toISOString()
  const { data: savedMsg } = await supabase.from('messages').insert([{
    session_id: sessionId, role: 'assistant', content: fullText, created_at: aiNow, visible: true,
    truncated: clientAborted || null,
    tokens_input: usage ? usage.prompt_tokens : null,
    tokens_output: usage ? usage.completion_tokens : null,
  }]).select()

  // 若客户端已断线，后面无法再 send()，直接返回
  if (clientAborted || res.writableEnded) return

  // 11. Ombre Brain hold（非阻塞，判断是否值得记住这次触发内容）
  shouldRemember(triggerContent).then(worth => {
    if (!worth) return
    extractFact(triggerContent).then(fact => {
      callOmbreTool('hold', { content: fact }).then(() => console.log('🧠 hold:', fact)).catch(e => console.error('hold失败:', e.message))
    })
  }).catch(e => console.error('shouldRemember失败:', e.message))

  // 12. 更新会话时间
  await supabase.from('sessions').update({ updated_at: aiNow }).eq('id', sessionId)

  // 13. 自动标题
  let autoTitle = null
  try {
    const { data: si } = await supabase.from('sessions').select('title').eq('id', sessionId).single()
    const { count } = await supabase.from('messages').select('*', { count: 'exact', head: true }).eq('session_id', sessionId).eq('visible', true)
    if (si?.title === '新对话' && count >= 2) {
      const tr = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: '你是一个标题生成助手。根据对话内容，生成一个简短的标题（不超过10个字），直接返回标题文字，不要加引号或其他符号。' }, { role: 'user', content: `用户说：${triggerContent}\nAI回复：${fullText.slice(0, 200)}\n请生成标题：` }], temperature: 0.5, max_tokens: 20 }),
      })
      const td = await tr.json()
      autoTitle = td.choices?.[0]?.message?.content?.trim().slice(0, 20) || null
      if (autoTitle) await supabase.from('sessions').update({ title: autoTitle, updated_at: aiNow }).eq('id', sessionId)
    }
  } catch (e) { console.error('自动标题失败:', e.message) }

  // 14. done 事件（附 token 统计，供前端 ↑input ↓output 展示）
  send({
    done: true,
    messageId: savedMsg?.[0]?.id,
    autoTitle,
    tokens: usage ? { input: usage.prompt_tokens, output: usage.completion_tokens } : null,
  })
  res.end()
}

// ============================================================
// 流式聊天接口（SSE）— 前端优先使用此接口
// ============================================================
app.post('/api/chat/stream', async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type',      'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control',     'no-cache, no-transform')
  res.setHeader('Connection',        'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  const { sessionId, content, quote } = req.body || {}
  if (!sessionId || !content) { send({ error: '参数缺失' }); return res.end() }

  try {
    // 1. 保存用户消息（引用内容写入 quoted_text 列，正文保持原样）
    const userNow = new Date().toISOString()
    const { error: ue } = await supabase.from('messages').insert([{ session_id: sessionId, role: 'user', content, quoted_text: quote || null, created_at: userNow, visible: true }])
    if (ue) { send({ error: '保存用户消息失败: ' + ue.message }); return res.end() }

    await runAssistantStream({ req, res, send, sessionId, triggerContent: content })
  } catch (err) {
    console.error('流式聊天异常:', err)
    send({ error: err.message })
    if (!res.writableEnded) res.end()
  }
})

// ============================================================
// 编辑重发接口（SSE）—— 修改某条用户消息后，丢弃其后的消息并重新生成
// ============================================================
app.post('/api/chat/edit-stream', async (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control',     'no-cache, no-transform')
  res.setHeader('Connection',        'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`) }

  const { messageId, content } = req.body || {}
  if (!messageId || !content) { send({ error: '参数缺失' }); return res.end() }

  try {
    const { data: original, error: fe } = await supabase.from('messages').select('*').eq('id', messageId).single()
    if (fe || !original) { send({ error: '未找到原消息' }); return res.end() }
    if (original.role !== 'user') { send({ error: '只能编辑用户自己的消息' }); return res.end() }

    // 丢弃这条消息之后的所有消息（包含旧的 AI 回复）
    await supabase.from('messages').delete().eq('session_id', original.session_id).gt('created_at', original.created_at)

    // 更新这条消息内容，标记 is_edited = true
    const { error: ee } = await supabase.from('messages').update({ content, is_edited: true }).eq('id', messageId)
    if (ee) { send({ error: '更新消息失败: ' + ee.message }); return res.end() }

    await runAssistantStream({ req, res, send, sessionId: original.session_id, triggerContent: content })
  } catch (err) {
    console.error('编辑重发异常:', err)
    send({ error: err.message })
    if (!res.writableEnded) res.end()
  }
})

// ============================================================
// 手动"存入星尘"—— 长按消息菜单里的入口，直接 hold 原文，不经 shouldRemember 判断
// ============================================================
app.post('/api/memories/hold', async (req, res) => {
  try {
    const { content } = req.body || {}
    if (!content) return res.status(400).json({ error: '参数缺失：需要 content' })
    const result = await callOmbreTool('hold', { content })
    res.json({ success: true, result: result || 'done' })
  } catch (err) {
    console.error('手动 hold 失败:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// 重新生成接口
// ============================================================
app.post('/api/chat/regenerate', async (req, res) => {
  try {
    const { sessionId } = req.body
    if (!sessionId) return res.status(400).json({ error: '参数缺失：需要 sessionId' })

    const { data: sRows } = await supabase.from('settings').select('*')
    const cfg = parseSettings(sRows || [])
    const { system_prompt = '你是温柔贴心的AI伴侣，简短自然回复', temperature = 0.7 } = cfg

    const { data: allMessages } = await supabase.from('messages').select('id,role,content,created_at').eq('session_id', sessionId).eq('visible', true).order('created_at', { ascending: true })
    if (!allMessages?.length) return res.status(400).json({ error: '没有可重新生成的消息' })

    const lastMsg = allMessages[allMessages.length - 1]
    if (lastMsg.role !== 'assistant') return res.status(400).json({ error: '最后一条消息不是AI回复' })

    const sendMessages = [{ role: 'system', content: withTimeAwareness(system_prompt) }, ...allMessages.slice(0, -1).filter(m => m.content != null).map(m => ({ role: m.role, content: String(m.content) }))]

    const aiRes = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: sendMessages, temperature: Number(temperature) }),
    })
    const aiData = await aiRes.json()
    if (!aiData.choices?.[0]) return res.status(500).json({ error: aiData.error?.message || 'AI 返回异常' })
    const replyText = aiData.choices[0].message.content

    const now = new Date().toISOString()
    await supabase.from('messages').update({ content: replyText, created_at: now }).eq('id', lastMsg.id)
    await supabase.from('sessions').update({ updated_at: now }).eq('id', sessionId)

    res.json({ reply: replyText })
  } catch (err) {
    console.error('重新生成异常:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// 星历 · 日记接口
// 需要 Supabase 里先建好 diary 表：
//   date        date        primary key（或 unique）
//   content     text
//   created_at  timestamptz
// ============================================================
async function generateDiaryForDate(dateStr) {
  const { start, end } = beijingDayRange(dateStr)
  const { data: dayMsgs, error: qErr } = await supabase.from('messages')
    .select('role,content,created_at')
    .eq('visible', true)
    .gte('created_at', start).lt('created_at', end)
    .order('created_at', { ascending: true })
  if (qErr) throw Object.assign(new Error(qErr.message), { status: 500 })
  if (!dayMsgs?.length) throw Object.assign(new Error('这一天没有对话记录，暂时写不出日记'), { status: 400 })

  const convoText = dayMsgs.map(m => `${m.role === 'user' ? '他' : '我'}：${m.content}`).join('\n')
  const prompt = `你是"在场"里的AI。请以第一人称、私密日记的口吻，基于今天和他的这些对话，写一篇不超过300字的日记。不要逐条复述对话，而是写你的感受、你记住的事、你在想什么。不要用"亲爱的日记"这种开头，直接写内容。\n\n今天的对话：\n${convoText.slice(0, 6000)}`

  const aiRes = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.9 }),
  })
  const aiData = await aiRes.json()
  if (!aiData.choices?.[0]) throw Object.assign(new Error(aiData.error?.message || 'AI 返回异常'), { status: 500 })
  const diaryContent = aiData.choices[0].message.content

  const { data, error } = await supabase.from('diary')
    .upsert([{ date: dateStr, content: diaryContent, created_at: new Date().toISOString() }], { onConflict: 'date' })
    .select()
  if (error) throw Object.assign(new Error(error.message), { status: 500 })
  return data[0]
}

app.post('/api/diary/generate', async (req, res) => {
  try {
    const dateStr = req.body?.date || beijingDateStr()
    const diary = await generateDiaryForDate(dateStr)
    res.json(diary)
  } catch (err) { res.status(err.status || 500).json({ error: err.message }) }
})

app.get('/api/diary/list', async (req, res) => {
  try {
    const { data, error } = await supabase.from('diary').select('date,content,created_at').order('date', { ascending: false }).limit(100)
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/diary/:date', async (req, res) => {
  try {
    const { data, error } = await supabase.from('diary').select('date,content,created_at').eq('date', req.params.date).maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: '这天没有日记' })
    res.json(data)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── 日记定时任务：每天北京时间固定时刻，自动为"昨天"生成一篇日记 ──
// 可用环境变量 DIARY_CRON_HOUR 覆盖触发的小时数（0-23，北京时间），默认凌晨 4 点
const DIARY_CRON_HOUR = Number(process.env.DIARY_CRON_HOUR ?? 4)
let lastDiaryRunDate = null

async function autoGenerateDiary() {
  const yesterday = beijingDateStr(new Date(Date.now() - 24 * 3600 * 1000))
  try {
    const { data: existing } = await supabase.from('diary').select('date').eq('date', yesterday).maybeSingle()
    if (existing) { console.log('📓 昨天的日记已存在，跳过自动生成:', yesterday); return }
    await generateDiaryForDate(yesterday)
    console.log('📓 已自动生成日记:', yesterday)
  } catch (e) {
    console.log('📓 自动写日记跳过或失败:', e.message)
  }
}

setInterval(() => {
  const bj = beijingNow()
  const h = bj.getUTCHours(), m = bj.getUTCMinutes()
  const todayStr = beijingDateStr()
  if (h === DIARY_CRON_HOUR && m === 0 && lastDiaryRunDate !== todayStr) {
    lastDiaryRunDate = todayStr
    autoGenerateDiary()
  }
}, 60 * 1000)

// ============================================================
// Token 统计接口
// 说明：messages 表目前没有记录"这条回复用的是哪个模型"，
// 所以 byModel 暂时只能把全部统计归到当前设置里配置的模型名下；
// 如果之后要做真正的按模型拆分，需要在 messages 表加一个 model 文本列，
// 生成回复时把当次用的模型名一起存进去。
// ============================================================
app.get('/api/stats/tokens', async (req, res) => {
  try {
    const { sessionId } = req.query
    const { data: sRows } = await supabase.from('settings').select('*')
    const cfg = parseSettings(sRows || [])
    const currentModel = cfg.model || 'deepseek-chat'

    const todayStr = beijingDateStr()
    const { start: todayStart } = beijingDayRange(todayStr)

    const bj  = beijingNow()
    const dow = (bj.getUTCDay() + 6) % 7   // 0 = 周一
    const weekStartStr = beijingDateStr(new Date(Date.now() - dow * 24 * 3600 * 1000))
    const { start: weekStart } = beijingDayRange(weekStartStr)

    const sevenAgoStr = beijingDateStr(new Date(Date.now() - 6 * 24 * 3600 * 1000))
    const { start: sevenAgoStart } = beijingDayRange(sevenAgoStr)

    const { data: rows, error } = await supabase.from('messages')
      .select('created_at,tokens_input,tokens_output,session_id')
      .eq('role', 'assistant')
      .not('tokens_input', 'is', null)
    if (error) return res.status(500).json({ error: error.message })

    const sum = (list) => list.reduce((acc, r) => { acc.input += r.tokens_input || 0; acc.output += r.tokens_output || 0; return acc }, { input: 0, output: 0 })

    const all     = sum(rows)
    const today   = sum(rows.filter(r => r.created_at >= todayStart))
    const week    = sum(rows.filter(r => r.created_at >= weekStart))
    const session = sessionId ? sum(rows.filter(r => r.session_id === sessionId)) : null

    const trendMap = {}
    for (let i = 6; i >= 0; i--) {
      const d = beijingDateStr(new Date(Date.now() - i * 24 * 3600 * 1000))
      trendMap[d] = { date: d, input: 0, output: 0 }
    }
    rows.filter(r => r.created_at >= sevenAgoStart).forEach(r => {
      const d = beijingDateStr(new Date(r.created_at))
      if (trendMap[d]) { trendMap[d].input += r.tokens_input || 0; trendMap[d].output += r.tokens_output || 0 }
    })

    res.json({
      session, today, week, all,
      byModel: { [currentModel]: all },
      trend7d: Object.values(trendMap),
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.listen(PORT, () => { console.log(`🚀 后端服务运行在端口 ${PORT}`) })
