require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')
const fetch = require('node-fetch')

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

// ============================================================
// 环境变量与常量
// ============================================================
console.log('=============== 环境检查 ===============')
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? '已读取' : '缺失')
console.log('SUPABASE_KEY:', process.env.SUPABASE_ANON_KEY ? '已读取' : '缺失')
console.log('DEEPSEEK_API_KEY:', process.env.DEEPSEEK_API_KEY ? '已读取' : '缺失')
console.log('========================================')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY
)
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

// ============================================================
// 工具函数
// ============================================================
function estimateToken(text) {
  return Math.ceil(text.length / 4)
}

// ============================================================
// ================ 【新增接口】获取所有会话列表 ================
// ============================================================
app.get('/api/sessions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .order('updated_at', { ascending: false })
    if (error) {
      return res.status(500).json(error)
    }
    res.json(data || [])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// 会话管理接口
// ============================================================
app.post('/api/session/new', async (req, res) => {
  try {
    const now = new Date()
    const { data, error } = await supabase
      .from('sessions')
      .insert([{ title: '新对话', created_at: now, updated_at: now }])
      .select()
    if (error) return res.status(500).json(error)
    res.json(data[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/session/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { title } = req.body
    const { data, error } = await supabase
      .from('sessions')
      .update({ title, updated_at: new Date() })
      .eq('id', id)
      .select()
    if (error) return res.status(500).json(error)
    res.json(data[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/session/:id', async (req, res) => {
  try {
    const { id } = req.params
    await supabase.from('messages').delete().eq('session_id', id)
    await supabase.from('memories').delete().eq('session_id', id)
    const { error } = await supabase.from('sessions').delete().eq('id', id)
    if (error) return res.status(500).json(error)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// 消息接口
// ============================================================
app.get('/api/messages/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params
    const { data, error } = await supabase
      .from('messages')
      .select('role,content,id,created_at,visible')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at')
    if (error) return res.status(500).json(error)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/messages/archived/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params
    const { cursor, limit = 6 } = req.query
    let query = supabase
      .from('messages')
      .select('role,content,id,created_at,visible')
      .eq('session_id', sessionId)
      .eq('visible', false)
      .order('created_at', { ascending: true })
    if (cursor) query = query.lt('id', cursor)
    const { data, error } = await query.range(0, Number(limit))
    if (error) return res.status(500).json(error)
    data.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const hasMore = data.length > Number(limit)
    if (hasMore) data.pop()
    res.json({ list: data, hasMore })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// 设置接口
// ============================================================
app.get('/api/settings', async (req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*')
    if (error) return res.status(500).json(error)
    const config = {}
    data.forEach(item => { config[item.key] = item.value })
    res.json(config)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/settings', async (req, res) => {
  try {
    const updates = req.body
    for (const [key, value] of Object.entries(updates)) {
      const { error } = await supabase
        .from('settings')
        .upsert([{ key, value }], { onConflict: 'key' })
      if (error) return res.status(500).json(error)
    }
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// 记忆压缩
// ============================================================
async function compressHistory(sessionId, oldMsgList, compressPrompt) {
  const contentText = oldMsgList.map(m => `(${m.role}): ${m.content}`).join('\n')
  const messages = [
    { role: 'system', content: compressPrompt },
    { role: 'user', content: `把下面对话总结成长期记忆，保留重要信息：\n${contentText}` }
  ]
  const aiRes = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.3 })
  })
  const aiData = await aiRes.json()
  if (!aiData.choices || !aiData.choices[0]) {
    throw new Error(aiData.error?.message || 'DeepSeek 返回异常')
  }
  const summary = aiData.choices[0].message.content
  await supabase.from('memories').insert({
    session_id: sessionId,
    summary,
    source_msg_ids: oldMsgList.map(m => m.id),
    created_at: new Date()
  })
  await supabase
    .from('messages')
    .update({ visible: false })
    .in('id', oldMsgList.map(m => m.id))
  return summary
}

// ============================================================
// 核心聊天接口
// ============================================================
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, content } = req.body
    if (!sessionId || !content) return res.status(400).json({ msg: '参数缺失' })
    const now = new Date()
    
    const { error: userErr } = await supabase
      .from('messages')
      .insert([{ session_id: sessionId, role: 'user', content, created_at: now, visible: true }])
    if (userErr) return res.status(500).json(userErr)

    const { data: settingRows } = await supabase.from('settings').select('*')
    const settings = {}
    settingRows?.forEach(s => { settings[s.key] = s.value })
    const {
      system_prompt = '你是温柔贴心的AI伴侣，简短自然回复',
      temperature = 0.7,
      compress_threshold = 3000,
      compress_keep_rounds = 4
    } = settings

    const { data: allHistory } = await supabase
      .from('messages')
      .select('id,role,content,created_at,visible')
      .eq('session_id', sessionId)
      .order('created_at')

    let totalTokens = 0
    allHistory?.forEach(m => { totalTokens += estimateToken(m.content) })
    let memorySummary = ''
    const keepCount = Number(compress_keep_rounds) * 2
    if (totalTokens > Number(compress_threshold) && allHistory.length > keepCount) {
      let reserve = keepCount
      if ((allHistory.length - reserve) % 2 !== 0) reserve++
      const oldList = allHistory.slice(0, allHistory.length - reserve)
      try {
        memorySummary = await compressHistory(sessionId, oldList, '你是对话记忆总结助手')
      } catch (err) { console.error('压缩失败，跳过', err) }
    }

    let systemPrompt = system_prompt
    if (memorySummary) systemPrompt += `\n【历史记忆】\n${memorySummary}`

    const sendMessages = [{ role: 'system', content: systemPrompt }]
    const { data: newHistory } = await supabase
      .from('messages')
      .select('role,content')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at')
    sendMessages.push(...newHistory)

    const aiRes = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: sendMessages,
        temperature: Number(temperature)
      })
    })
    const aiData = await aiRes.json()
    if (!aiData.choices || !aiData.choices[0]) return res.status(500).json({ error: aiData.error?.message || 'AI 返回异常' })
    const replyText = aiData.choices[0].message.content

    const { error: aiSaveErr } = await supabase
      .from('messages')
      .insert([{ session_id: sessionId, role: 'assistant', content: replyText, created_at: now, visible: true }])
    if (aiSaveErr) return res.status(500).json({ error: 'AI回复保存失败' })

    await supabase.from('sessions').update({ updated_at: now }).eq('id', sessionId)
    res.json({ reply: replyText })
  } catch (err) {
    console.error('聊天异常:', err)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`🚀 后端服务运行在端口 ${PORT}`)
})