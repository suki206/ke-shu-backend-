require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')
const fetch = require('node-fetch')

const app = express()
const PORT = process.env.PORT || 3000

// 配置跨域和JSON解析
app.use(cors())
app.use(express.json())

// ============================================================
// 环境变量与常量检查
// ============================================================
console.log('=============== 环境检查 ===============')
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? '已读取' : '缺失')
console.log('SUPABASE_KEY:', process.env.SUPABASE_ANON_KEY ? '已读取' : '缺失')
console.log('DEEPSEEK_API_KEY:', process.env.DEEPSEEK_API_KEY ? '已读取' : '缺失')
console.log('========================================')

// Supabase 初始化 (注意：你的环境变量可能叫 SUPABASE_KEY，这里按原代码用 ANON_KEY，确保你在Render后台配置的是 SUPABASE_ANON_KEY)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY
)

// DeepSeek API 接口配置
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

// ============================================================
// 工具函数：估算Token数量
// ============================================================
function estimateToken(text) {
  return Math.ceil(text.length / 4)
}

// ============================================================
// 会话接口
// ============================================================

// 新建会话
app.post('/api/session/new', async (req, res) => {
  try {
    const now = new Date()
    const { data, error } = await supabase
      .from('sessions')
      .insert([{ title: '新对话', created_at: now, updated_at: now }])
      .select()
    if (error) {
      console.error('创建会话失败:', error)
      return res.status(500).json(error)
    }
    res.json(data[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// 重命名会话
app.put('/api/session/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { title } = req.body
    const { data, error } = await supabase
      .from('sessions')
      .update({ title, updated_at: new Date() })
      .eq('id', id)
      .select()
    if (error) {
      return res.status(500).json(error)
    }
    res.json(data[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 删除会话 (修复了路由 :id 缺失斜杠的问题)
app.delete('/api/session/:id', async (req, res) => {
  try {
    const { id } = req.params

    // 删除该会话下所有消息
    await supabase.from('messages').delete().eq('session_id', id)
    // 删除该会话下所有记忆
    await supabase.from('memories').delete().eq('session_id', id)

    const { error } = await supabase.from('sessions').delete().eq('id', id)
    if (error) {
      return res.status(500).json(error)
    }
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// 消息接口
// ============================================================

// 获取可见消息
app.get('/api/messages/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params
    const { data, error } = await supabase
      .from('messages')
      .select('role,content,id,created_at,visible')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at')
    if (error) {
      return res.status(500).json(error)
    }
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 获取归档/不可见消息
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

    if (cursor) {
      query = query.lt('id', cursor)
    }

    const { data, error } = await query.range(0, Number(limit))
    if (error) {
      return res.status(500).json(error)
    }

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
    if (error) {
      return res.status(500).json(error)
    }
    const config = {}
    data.forEach(item => {
      config[item.key] = item.value
    })
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
      if (error) {
        return res.status(500).json(error)
      }
    }
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// 记忆压缩函数
// ============================================================
async function compressHistory(sessionId, oldMsgList, compressPrompt) {
  const contentText = oldMsgList
    .map(m => `(${m.role}): ${m.content}`)
    .join('\n')
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
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      temperature: 0.3
    })
  })

  const aiData = await aiRes.json()
  if (!aiData.choices || !aiData.choices[0]) {
    console.error('DeepSeek 压缩失败:', aiData)
    throw new Error(aiData.error?.message || 'DeepSeek 返回异常')
  }

  const summary = aiData.choices[0].message.content

  // 保存记忆摘要到数据库
  await supabase.from('memories').insert({
    session_id: sessionId,
    summary,
    source_msg_ids: oldMsgList.map(m => m.id),
    created_at: new Date()
  })

  // 将旧的压缩消息标记为不可见
  await supabase
    .from('messages')
    .update({ visible: false })
    .in('id', oldMsgList.map(m => m.id))

  return summary
}

// ============================================================
// 核心聊天接口（修复了吞消息和语法错误）
// ============================================================
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, content } = req.body
    if (!sessionId || !content) {
      return res.status(400).json({ msg: '参数缺失' })
    }

    const now = new Date()

    // 1. 保存用户消息
    const { error: userErr } = await supabase
      .from('messages')
      .insert([{
        session_id: sessionId,
        role: 'user',
        content,
        created_at: now,
        visible: true
      }])
    if (userErr) {
      console.error('保存用户消息失败:', userErr)
      return res.status(500).json(userErr)
    }

    // 2. 获取配置
    const { data: settingRows } = await supabase.from('settings').select('*')
    const settings = {}
    settingRows?.forEach(s => {
      settings[s.key] = s.value
    })

    const {
      system_prompt = '你是温柔贴心的AI伴侣，简短自然回复',
      temperature = 0.7,
      compress_threshold = 3000,
      compress_keep_rounds = 4
    } = settings

    // 3. 获取历史消息
    const { data: allHistory } = await supabase
      .from('messages')
      .select('id,role,content,created_at,visible')
      .eq('session_id', sessionId)
      .order('created_at')

    // 4. Token 估算与记忆压缩（修复了 DEEPSEEK_URL 未定义和 memorySummary 重复声明的问题）
    let totalTokens = 0
    allHistory?.forEach(m => {
      totalTokens += estimateToken(m.content)
    })

    let memorySummary = ''
    const keepCount = Number(compress_keep_rounds) * 2

    if (totalTokens > Number(compress_threshold) && allHistory.length > keepCount) {
      let reserve = keepCount
      if ((allHistory.length - reserve) % 2 !== 0) {
        reserve++
      }
      const oldList = allHistory.slice(0, allHistory.length - reserve)
      try {
        memorySummary = await compressHistory(sessionId, oldList, '你是对话记忆总结助手')
      } catch (err) {
        console.error('压缩失败，跳过压缩步骤:', err)
        // 压缩失败不影响正常对话
      }
    }

    // 5. 组装上下文
    let systemPrompt = system_prompt
    if (memorySummary) {
      systemPrompt += `\n【历史记忆】\n${memorySummary}`
    }

    const sendMessages = [{ role: 'system', content: systemPrompt }]
    const { data: newHistory } = await supabase
      .from('messages')
      .select('role,content')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at')

    sendMessages.push(...newHistory)

    // 6. 调用 DeepSeek API
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
    if (!aiData.choices || !aiData.choices[0]) {
      console.error('DeepSeek 聊天失败:', aiData)
      return res.status(500).json({ error: aiData.error?.message || 'AI 返回异常' })
    }

    const replyText = aiData.choices[0].message.content

    // 7. 保存 AI 回复（修复了保存失败却依然返回成功导致吞消息的问题）
    const { error: aiSaveErr } = await supabase
      .from('messages')
      .insert([{
        session_id: sessionId,
        role: 'assistant',
        content: replyText,
        created_at: now,
        visible: true
      }])

    if (aiSaveErr) {
      console.error('保存 AI 消息失败:', aiSaveErr)
      // 这里必须返回 500 错误，否则前端以为成功了，一刷新会吞消息
      return res.status(500).json({ error: 'AI回复保存失败，请重试' })
    }

    // 更新会话更新时间
    await supabase
      .from('sessions')
      .update({ updated_at: now })
      .eq('id', sessionId)

    // 成功返回
    res.json({ reply: replyText })

  } catch (err) {
    console.error('聊天接口异常:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// 启动服务器
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 后端服务运行在端口 ${PORT}`)
})