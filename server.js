require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')
const fetch = require('node-fetch')

const app = express()
const PORT = 3000

app.use(cors())
app.use(express.json())

// 初始化Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

// AI接口配置
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'

// 健康检测接口
app.get('/health', (req, res) => {
  res.json({ status: 'ok', msg: '后端服务运行正常' })
})

// ====================== 会话接口 ======================
// 新建会话
app.post('/api/session/new', async (req, res) => {
  const now = new Date()
  const { data, error } = await supabase
    .from('sessions')
    .insert([{ title: '新对话', created_at: now, updated_at: now }])
    .select()
  if (error) return res.status(500).json(error)
  res.json(data[0])
})

// 获取所有会话列表
app.get('/api/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) return res.status(500).json(error)
  res.json(data)
})

// ============【新增】重命名会话接口 ============
app.put('/api/session/:id', async (req, res) => {
  const { id } = req.params
  const { title } = req.body
  const { data, error } = await supabase
    .from('sessions')
    .update({ title, updated_at: new Date() })
    .eq('id', id)
    .select()
  if (error) return res.status(500).json(error)
  res.json(data[0])
})

// ============【新增】删除会话接口 ============
app.delete('/api/session/:id', async (req, res) => {
  const { id } = req.params
  // 先删除该会话下所有消息、记忆，再删除会话本体
  await supabase.from('messages').delete().eq('session_id', id)
  await supabase.from('memories').delete().eq('session_id', id)
  const { error } = await supabase.from('sessions').delete().eq('id', id)
  if (error) return res.status(500).json(error)
  res.json({ success: true })
})

// 获取单一会话【仅visible=true可见消息】PDF标准
app.get('/api/messages/:sessionId', async (req, res) => {
  const { sessionId } = req.params
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, id, created_at, visible')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at')
  if (error) return res.status(500).json(error)
  res.json(data)
})

// 分页获取会话已归档消息 visible=false，分段加载更早历史（修复：单批次内部强制时间正序）
app.get('/api/messages/archived/:sessionId', async (req, res) => {
  const { sessionId } = req.params
  const { cursor, limit = 6 } = req.query

  let query = supabase
    .from('messages')
    .select('role, content, id, created_at, visible')
    .eq('session_id', sessionId)
    .eq('visible', false)
    .order('created_at', { ascending: true })

  if (cursor) {
    query = query.lt('id', cursor)
  }

  const { data, error } = await query.range(0, Number(limit))
  if (error) return res.status(500).json(error)

  // 强制单批次内按时间从小到大排序，保证一问一答连贯
  data.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))

  const hasMore = data.length > Number(limit)
  if (hasMore) data.pop()

  res.json({
    list: data,
    hasMore: hasMore
  })
})

// ====================== 配置接口 ======================
// 获取全局配置
app.get('/api/settings', async (req, res) => {
  const { data, error } = await supabase.from('settings').select('*')
  if (error) return res.status(500).json(error)
  const config = {}
  data.forEach(item => {
    config[item.key] = item.value
  })
  res.json(config)
})

// 更新配置
app.post('/api/settings', async (req, res) => {
  const updates = req.body
  for (const [key, value] of Object.entries(updates)) {
    const { error } = await supabase
      .from('settings')
      .upsert([{ key, value }], { onConflict: 'key' })
    if (error) return res.status(500).json(error)
  }
  res.json({ success: true })
})

// ====================== 记忆压缩工具函数 ======================
// 简单估算token（粗略估算，满足本地测试）
function estimateToken(text) {
  return Math.ceil(text.length / 4)
}

// 触发对话压缩，生成摘要存入memories（PDF规范：只标记隐藏，不删除消息）
async function compressHistory(sessionId, oldMsgList, compressPrompt) {
  const contentText = oldMsgList.map(m => `${m.role}: ${m.content}`).join('\n')
  const messages = [
    { role: 'system', content: compressPrompt },
    { role: 'user', content: `把下面这段对话精简成一段长期记忆摘要，保留关键信息：\n${contentText}` }
  ]

  const aiRes = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      temperature: 0.3
    })
  })
  const aiData = await aiRes.json()
  const summary = aiData.choices[0].message.content

  // 存入记忆表
  await supabase.from('memories').insert([{
    session_id: sessionId,
    summary,
    source_msg_ids: oldMsgList.map(m => m.id),
    created_at: new Date()
  }])

  // PDF规范：不删除旧消息，仅标记 visible=false 隐藏
  const ids = oldMsgList.map(m => m.id)
  await supabase.from('messages')
    .update({ visible: false })
    .in('id', ids)

  return summary
}

// ====================== 核心对话接口 ======================
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, content } = req.body
    if (!sessionId || !content) return res.status(400).json({ msg: '参数缺失' })
    const now = new Date()

    // 1. 插入用户消息，自带visible:true
    const { data: userMsg, error: userErr } = await supabase
      .from('messages')
      .insert([{ session_id: sessionId, role: 'user', content, created_at: now, visible: true }])
      .select()
    if (userErr) return res.status(500).json(userErr)

    // 2. 读取全局配置
    const { data: settingRows } = await supabase.from('settings').select('*')
    const settings = {}
    settingRows.forEach(s => settings[s.key] = s.value)
    const {
      system_prompt = '你是温柔贴心的AI伴侣，简短自然回复',
      temperature = 0.7,
      compress_threshold = 3000,
      compress_keep_rounds = 4
    } = settings

    // 3. 获取当前会话全部历史消息（包含已隐藏visible=false，用于统计token压缩）
    const { data: allHistory } = await supabase
      .from('messages')
      .select('id, role, content, created_at, visible')
      .eq('session_id', sessionId)
      .order('created_at')

    // 4. 计算总token，判断是否需要压缩【修复：保证保留消息为完整问答，不会奇数断层】
    let totalTokens = 0
    allHistory.forEach(m => totalTokens += estimateToken(m.content))
    let memorySummary = ''

    // 一轮对话 = user + assistant 2条消息
    const keepMsgCount = compress_keep_rounds * 2
    console.log(`【压缩检测】总Token:${totalTokens} 阈值:${compress_threshold}`)
    console.log(`【压缩检测】消息总数:${allHistory.length} 最少需要大于:${keepMsgCount}`)

    if (totalTokens > compress_threshold && allHistory.length > keepMsgCount) {
      console.log("✅ 条件达成，执行记忆压缩")
      const totalMsg = allHistory.length
      let reserveNum = keepMsgCount
      // 修复：如果剩余消息是奇数，多保留1条，保证末尾是完整AI回复，不会截断用户提问
      if ((totalMsg - reserveNum) % 2 !== 0) {
        reserveNum += 1
      }
      const needCompress = allHistory.slice(0, allHistory.length - reserveNum)
      memorySummary = await compressHistory(sessionId, needCompress, '你是对话记忆总结助手')
      console.log("✅ 压缩完成，摘要：", memorySummary)
    } else {
      console.log("❌ 不满足压缩条件，跳过")
    }

    // 5. 组装发给AI的上下文（优化：人设+摘要合并单条system，强化人格不跑偏）
    const sendMessages = []
    let fullSystemPrompt = system_prompt
    // 把记忆摘要合并进同一条系统提示
    if (memorySummary) {
      fullSystemPrompt += `
【历史对话摘要参考，不要遗忘】
${memorySummary}
`
    }
    // 只使用单条system消息，人设永远置顶
    sendMessages.push({ role: 'system', content: fullSystemPrompt })

    // 仅读取可见消息作为上下文
    const { data: newHistory } = await supabase
      .from('messages')
      .select('role, content, created_at')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at')
    sendMessages.push(...newHistory)

    // 6. 调用DeepSeek生成回复
    const aiRes = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: sendMessages,
        temperature
      })
    })
    const aiData = await aiRes.json()
    const replyText = aiData.choices[0].message.content

    // 7. 保存AI回复入库，自带visible:true
    await supabase
      .from('messages')
      .insert([{ session_id: sessionId, role: 'assistant', content: replyText, created_at: now, visible: true }])

    // 更新会话最后更新时间
    await supabase
      .from('sessions')
      .update({ updated_at: now })
      .eq('id', sessionId)

    res.json({ reply: replyText })
  } catch (err) {
    console.error('对话接口异常：', err)
    res.status(500).json({ error: 'AI调用失败，请检查密钥或数据库' })
  }
})

app.listen(PORT, () => {
  console.log(`后端服务启动：http://localhost:${PORT}`)
})
