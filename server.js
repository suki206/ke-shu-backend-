require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')
const fetch = require('node-fetch')

// ===== Ombre Brain MCP 客户端 =====
const OMBRE_BRAIN_URL = process.env.OMBRE_BRAIN_URL || '';
const OMBRE_MCP_TOKEN = process.env.OMBRE_MCP_TOKEN || '';
let ombreSessionId = null;
let ombreCallId = 0;

function parseSSEResponse(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data:')) {
      try { return JSON.parse(line.substring(5)); } catch (e) {}
    }
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function initOmbreSession() {
  if (!OMBRE_BRAIN_URL) return false;
  try {
    const response = await fetch(`${OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json,text/event-stream',
        'Authorization': `Bearer ${OMBRE_MCP_TOKEN}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "ke-shu-backend", version: "1.0" }
        },
        id: ++ombreCallId
      })
    });
    ombreSessionId = response.headers.get('mcp-session-id');
    await fetch(`${OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json,text/event-stream',
        'Mcp-Session-Id': ombreSessionId,
        'Authorization': `Bearer ${OMBRE_MCP_TOKEN}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      })
    });
    console.log('🧠 Ombre Brain 已连接:', OMBRE_BRAIN_URL);
    return true;
  } catch (err) {
    console.error('MCP 会话初始化失败:', err.message);
    ombreSessionId = null;
    return false;
  }
}

async function callOmbreTool(toolName, args = {}) {
  if (!OMBRE_BRAIN_URL) return null;
  try {
    if (!ombreSessionId) {
      const ok = await initOmbreSession();
      if (!ok) return null;
    }
    const response = await fetch(`${OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json,text/event-stream',
        'Mcp-Session-Id': ombreSessionId,
        'Authorization': `Bearer ${OMBRE_MCP_TOKEN}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: toolName, arguments: args },
        id: ++ombreCallId
      })
    });
    const text = await response.text();
    const parsed = parseSSEResponse(text);
    console.log(`MCP ${toolName} FULL:`, JSON.stringify(parsed));

    // content[].text 才是完整正文（多条记忆用 \n---\n 拼接）。
    // structuredContent 是被截断的精简版，绝对不要用它。
    if (parsed?.result?.content) {
      return parsed.result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    }
    return parsed?.result ? parsed.result : null;
  } catch (err) {
    console.error(`MCP 工具 ${toolName} 调用失败:`, err.message);
    ombreSessionId = null;
    return null;
  }
}

// ===== 判断用户这句话是否含有值得记住的事实 =====
// 注意：只看用户自己说了什么，不看 AI 的回复——AI 的回复可能只是猜测、
// 反问或情绪化寒暄，把这些当"事实"存进记忆库会污染以后的检索结果。
async function shouldRemember(content) {
  try {
    const judgePrompt = `判断以下这句话本身，是否包含用户明确陈述的、值得长期记住的事实（如个人喜好、身份信息、计划安排、重要事件）。
只看这句话是否是用户自己说出的具体事实，不要管语气或是否礼貌。
如果只是打招呼、闲聊、提问、或不含具体信息，回答"否"。
只回复"是"或"否"，不要解释。

用户说：${content}`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: judgePrompt }],
        max_tokens: 2,
        temperature: 0
      })
    });
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content || '';
    return answer.includes('是');
  } catch (e) {
    console.error('记忆判断失败:', e.message);
    return false // 判断失败时保守跳过，不乱存
  }
}

// ===== 把用户这句话提炼成一句精简事实，再存进 Ombre Brain =====
// 只存"用户喜欢西瓜"这种一句话结论，不存整段用户原话+AI回复。
// 这样存储的记忆本身更短，breath 检索时塞回 system prompt 的 token 也更少。
async function extractFact(content) {
  try {
    const prompt = `把用户这句话里的事实提炼成一句最简短的陈述句（不超过20字），第三人称"用户"开头。
只输出提炼后的句子，不要解释，不要标点以外的多余内容。

用户说：${content}`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 40,
        temperature: 0
      })
    });
    const data = await response.json();
    const fact = data.choices?.[0]?.message?.content?.trim()
    return fact || `用户说：${content}`
  } catch (e) {
    console.error('事实提炼失败:', e.message)
    return `用户说：${content}` // 提炼失败就退回存原话，不影响功能
  }
}

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
console.log('OMBRE_BRAIN_URL:', process.env.OMBRE_BRAIN_URL ? '已读取' : '缺失')
console.log('OMBRE_MCP_TOKEN:', process.env.OMBRE_MCP_TOKEN ? '已读取' : '缺失')
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
  if (!text) return 0
  return Math.ceil(String(text).length / 4)
}

// 兼容两种 settings 表结构
function parseSettings(settingRows) {
  if (!settingRows || settingRows.length === 0) return {}
  // 如果是 key-value 结构
  if ('key' in settingRows[0]) {
    const settings = {}
    settingRows.forEach(s => { settings[s.key] = s.value })
    return settings
  }
  // 如果是单行多字段结构（教程默认）
  return settingRows[0]
}

// ============================================================
// 会话管理接口
// ============================================================
app.get('/api/sessions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .order('updated_at', { ascending: false })
    if (error) {
      console.error('获取会话列表失败:', error)
      return res.status(500).json({ error: error.message })
    }
    res.json(data || [])
  } catch (err) {
    console.error('获取会话列表异常:', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/session/new', async (req, res) => {
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('sessions')
      .insert([{ title: '新对话', created_at: now, updated_at: now }])
      .select()
    if (error) {
      console.error('新建会话失败:', error)
      return res.status(500).json({ error: error.message })
    }
    res.json(data[0])
  } catch (err) {
    console.error('新建会话异常:', err)
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/session/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { title } = req.body
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('sessions')
      .update({ title, updated_at: now })
      .eq('id', id)
      .select()
    if (error) {
      console.error('更新会话失败:', error)
      return res.status(500).json({ error: error.message })
    }
    res.json(data[0])
  } catch (err) {
    console.error('更新会话异常:', err)
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/session/:id', async (req, res) => {
  try {
    const { id } = req.params
    await supabase.from('messages').delete().eq('session_id', id)
    await supabase.from('memories').delete().eq('session_id', id)
    const { error } = await supabase.from('sessions').delete().eq('id', id)
    if (error) {
      console.error('删除会话失败:', error)
      return res.status(500).json({ error: error.message })
    }
    res.json({ success: true })
  } catch (err) {
    console.error('删除会话异常:', err)
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
      .order('created_at', { ascending: true })
    if (error) {
      console.error('获取消息失败:', error)
      return res.status(500).json({ error: error.message })
    }
    res.json(data || [])
  } catch (err) {
    console.error('获取消息异常:', err)
    res.status(500).json({ error: err.message })
  }
})
// ============================================================
// 归档消息接口（被压缩隐藏的历史消息）
// ============================================================
app.get('/api/messages/archived/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params
    const limit = parseInt(req.query.limit) || 100
    const cursor = req.query.cursor
    
    let query = supabase
      .from('messages')
      .select('role,content,id,created_at,visible')
      .eq('session_id', sessionId)
      .eq('visible', false)
      .order('created_at', { ascending: true })
    
    // 如果传了 cursor，加载比该消息更早的
    if (cursor) {
      const { data: cursorData, error: cursorErr } = await supabase
        .from('messages')
        .select('created_at')
        .eq('id', cursor)
        .single()
      
      if (!cursorErr && cursorData) {
        query = query.lt('created_at', cursorData.created_at)
      }
    }
    
    const { data, error } = await query.limit(limit + 1)
    
    if (error) {
      console.error('获取归档消息失败:', error)
      return res.status(500).json({ error: error.message })
    }
    
    const hasMore = data.length > limit
    const list = hasMore ? data.slice(0, limit) : data
    
    res.json({ list: list || [], hasMore })
  } catch (err) {
    console.error('获取归档消息异常:', err)
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
      console.error('获取设置失败:', error)
      return res.status(500).json({ error: error.message })
    }
    const config = parseSettings(data)
    res.json(config)
  } catch (err) {
    console.error('获取设置异常:', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/settings', async (req, res) => {
  try {
    const updates = req.body
    // 兼容 key-value 结构
    for (const [key, value] of Object.entries(updates)) {
      const { error } = await supabase
        .from('settings')
        .upsert([{ key, value }], { onConflict: 'key' })
      if (error) {
        // 如果 key-value 结构失败，尝试直接更新单行
        const { error: updateErr } = await supabase
          .from('settings')
          .update({ [key]: value })
          .eq('id', 1)
        if (updateErr) {
          console.error('保存设置失败:', error, updateErr)
          return res.status(500).json({ error: error.message })
        }
      }
    }
    res.json({ success: true })
  } catch (err) {
    console.error('保存设置异常:', err)
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
  await supabase.from('memories').insert([{
    session_id: sessionId,
    summary,
    created_at: new Date().toISOString()
  }])
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
    if (!sessionId || !content) {
      return res.status(400).json({ error: '参数缺失：需要 sessionId 和 content' })
    }

    // 1. 保存用户消息（使用当前时间）
    const userNow = new Date().toISOString()
    const { error: userErr } = await supabase
      .from('messages')
      .insert([{
        session_id: sessionId,
        role: 'user',
        content,
        created_at: userNow,
        visible: true
      }])
    if (userErr) {
      console.error('保存用户消息失败:', userErr)
      return res.status(500).json({ error: '保存用户消息失败: ' + userErr.message })
    }

    // 2. 读取设置
    const { data: settingRows, error: settingsErr } = await supabase.from('settings').select('*')
    if (settingsErr) {
      console.error('读取设置失败:', settingsErr)
    }
    const settings = parseSettings(settingRows)
    const {
      system_prompt = '你是温柔贴心的AI伴侣，简短自然回复',
      temperature = 0.7,
      compress_threshold = 3000,
      compress_keep_rounds = 4
    } = settings

    // 3. 读取完整历史用于 token 估算
    const { data: allHistory, error: histErr } = await supabase
      .from('messages')
      .select('id,role,content,created_at,visible')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
    if (histErr) {
      console.error('读取历史失败:', histErr)
    }

    // 4. 检查是否需要压缩
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
        console.log('记忆压缩完成:', memorySummary.substring(0, 50) + '...')
      } catch (err) {
        console.error('压缩失败，跳过:', err.message)
      }
    }

    // 5. 组装系统提示词
    let systemPrompt = system_prompt
    if (memorySummary) {
      systemPrompt += `\n【历史记忆】\n${memorySummary}`
    }

// 清洗 breath 返回的原始文本：去掉 [bucket_id:...] [payload_sha256:...] Footprint:... 等
// 对模型毫无意义、纯粹浪费 token 的元数据标记，只留下用户事实本身，
// 并按内容去重（同一件事的多条相似记忆只保留一条）。
// maxItems：塞进 system prompt 的记忆条数上限，防止一次检索太多记忆把 token 堆爆。
function cleanBreathMemory(raw, maxItems = 8) {
  if (!raw) return ''
  // 按 \n---\n 或独立的 [bucket_id:xxx] 行切分出每条记忆
  const chunks = raw.split(/\n?---\n?|\[bucket_id:[a-f0-9]+\]/).map(s => s.trim()).filter(Boolean)

  const seen = new Set()
  const cleaned = []
  for (let chunk of chunks) {
    if (cleaned.length >= maxItems) break // 够数了就不再处理，省token也省计算

    // 去掉所有中括号元数据标记，如 [content_role:xxx] [payload_sha256:...] [boundary_id:...] 等
    chunk = chunk.replace(/\[[a-z0-9_]+:[^\]]*\]/gi, '').trim()
    // 去掉 Footprint 溯源行（对当前对话没用）
    chunk = chunk.replace(/Footprint[:：][^\n]*/g, '').trim()

    // 旧记忆是"用户说：xxx\n\n你回复：一大段"格式，AI回复对判断事实没用，
    // 只留用户说的那句话；新存的记忆本身就是一句话事实，这一步对它们不影响
    // （因为它们不含"用户说："这个前缀，匹配不上，chunk 保持原样）。
    const userLineMatch = chunk.match(/用户说[：:]\s*([^\n]+)/)
    if (userLineMatch) {
      chunk = userLineMatch[1].trim()
    }

    chunk = chunk.replace(/\n{2,}/g, '\n').trim()
    if (!chunk || chunk.length < 4) continue

    const dedupeKey = chunk.slice(0, 20)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    cleaned.push(chunk)
  }
  return cleaned.join('；')
}

        // 5.5 从 Ombre Brain 检索相关记忆
    // 说明：breath 本身返回的就是记忆正文，直接用即可。
    // max_results 调大一些避免高频记忆挤掉低频但相关的记忆，
    // 但最终只挑前 8 条清洗后的事实塞进 prompt（cleanBreathMemory 的 maxItems），控制 token。
    let ombreMemory = ''
    try {
      const breathResult = await callOmbreTool('breath', { query: content, max_results: 20 })
      const cleanedMemory = cleanBreathMemory(breathResult, 8)
      console.log('🧠 breath 清洗后:', cleanedMemory)

      if (cleanedMemory && cleanedMemory.length > 0 && !cleanedMemory.includes('记忆池现在是空的')) {
        ombreMemory = `\n\n[你记得的事]\n${cleanedMemory}`
        console.log('🧠 检索到记忆条数:', cleanedMemory.split('；').length)
      }
    } catch (e) { console.error('记忆检索失败:', e.message) }
    if (ombreMemory) systemPrompt += ombreMemory

    // 6. 读取可见历史消息（用于发送给模型）
    const { data: newHistory, error: visibleErr } = await supabase
      .from('messages')
      .select('role,content')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true })
    if (visibleErr) {
      console.error('读取可见消息失败:', visibleErr)
    }

    // 7. 构建消息数组（清洗字段，确保顺序正确）
    const sendMessages = [{ role: 'system', content: systemPrompt }]
    if (newHistory && newHistory.length > 0) {
      // 过滤掉 content 为 null 的，只保留 API 需要的字段
      const cleanHistory = newHistory
        .filter(m => m.content != null)
        .map(m => ({ role: m.role, content: String(m.content) }))
      sendMessages.push(...cleanHistory)
    }

    console.log('发送给模型的消息数:', sendMessages.length)
    console.log('最后一条角色:', sendMessages[sendMessages.length - 1]?.role)

    // 8. 调用主模型
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
      console.error('AI 返回异常:', aiData)
      return res.status(500).json({ error: aiData.error?.message || 'AI 返回异常' })
    }
    const replyText = aiData.choices[0].message.content

       // 9. 保存 AI 回复（使用新的时间戳，确保与用户消息有时间差）
    const aiNow = new Date().toISOString()
    const { data: savedMsg, error: aiSaveErr } = await supabase
      .from('messages')
      .insert([{
        session_id: sessionId,
        role: 'assistant',
        content: replyText,
        created_at: aiNow,
        visible: true
      }])
      .select()
    if (aiSaveErr) {
      console.error('保存AI回复失败:', aiSaveErr)
      return res.status(500).json({ error: 'AI回复保存失败: ' + aiSaveErr.message })
    }

        // 9.5 存储到 Ombre Brain
    // 只看用户这句话本身是否含事实（不看AI回复，AI回复可能是猜测），
    // 值得存的话，先提炼成一句短陈述句再 hold——存储和检索都更省 token。
    try {
      const worthIt = await shouldRemember(content);
      if (worthIt) {
        const fact = await extractFact(content)
        const holdResult = await callOmbreTool('hold', { content: fact })
        console.log('🧠 记忆已存储:', fact, '→', holdResult)
      } else {
        console.log('🧠 判断为不重要，跳过存储')
      }
    } catch (e) { console.error('记忆存储失败:', e.message) }

    // 10. 更新会话时间
    await supabase.from('sessions').update({ updated_at: aiNow }).eq('id', sessionId)

    // 11. 自动标题生成（如果标题还是"新对话"且已有2条以上消息）
    let autoTitle = null
    try {
      const { data: sessionInfo } = await supabase.from('sessions').select('title').eq('id', sessionId).single()
      const { count } = await supabase.from('messages').select('*', { count: 'exact', head: true }).eq('session_id', sessionId).eq('visible', true)
      if (sessionInfo?.title === '新对话' && count >= 2) {
        const titleRes = await fetch(DEEPSEEK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: '你是一个标题生成助手。根据对话内容，生成一个简短的标题（不超过10个字），直接返回标题文字，不要加引号或其他符号。' },
              { role: 'user', content: `用户说：${content}\nAI回复：${replyText}\n请生成标题：` }
            ],
            temperature: 0.5,
            max_tokens: 20
          })
        })
        const titleData = await titleRes.json()
        const generatedTitle = titleData.choices?.[0]?.message?.content?.trim().slice(0, 20)
        if (generatedTitle) {
          await supabase.from('sessions').update({ title: generatedTitle, updated_at: aiNow }).eq('id', sessionId)
          autoTitle = generatedTitle
        }
      }
    } catch (e) { console.error('自动标题生成失败:', e.message) }

    res.json({ reply: replyText, messageId: savedMsg?.[0]?.id, autoTitle })
  } catch (err) {
    console.error('聊天异常:', err)
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

    // 1. 读取设置
    const { data: settingRows, error: settingsErr } = await supabase.from('settings').select('*')
    if (settingsErr) console.error('读取设置失败:', settingsErr)
    const settings = parseSettings(settingRows)
    const { system_prompt = '你是温柔贴心的AI伴侣，简短自然回复', temperature = 0.7 } = settings

    // 2. 获取该会话所有可见消息
    const { data: allMessages, error: msgErr } = await supabase
      .from('messages')
      .select('id,role,content,created_at')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true })
    
    if (msgErr || !allMessages || allMessages.length === 0) {
      return res.status(400).json({ error: '没有可重新生成的消息' })
    }

    // 3. 找到最后一条AI消息
    const lastMsg = allMessages[allMessages.length - 1]
    if (lastMsg.role !== 'assistant') {
      return res.status(400).json({ error: '最后一条消息不是AI回复' })
    }

    // 4. 构建上下文（不包含最后一条AI消息）
    const contextMessages = allMessages.slice(0, -1)
    const sendMessages = [{ role: 'system', content: system_prompt }]
    const cleanHistory = contextMessages
      .filter(m => m.content != null)
      .map(m => ({ role: m.role, content: String(m.content) }))
    sendMessages.push(...cleanHistory)

    // 5. 调用AI重新生成
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
      return res.status(500).json({ error: aiData.error?.message || 'AI 返回异常' })
    }
    const replyText = aiData.choices[0].message.content

    // 6. 更新最后一条AI消息的内容
    const now = new Date().toISOString()
    const { error: updateErr } = await supabase
      .from('messages')
      .update({ content: replyText, created_at: now })
      .eq('id', lastMsg.id)
    
    if (updateErr) {
      return res.status(500).json({ error: '更新消息失败: ' + updateErr.message })
    }

    // 7. 更新会话时间
    await supabase.from('sessions').update({ updated_at: now }).eq('id', sessionId)

    res.json({ reply: replyText })
  } catch (err) {
    console.error('重新生成异常:', err)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`🚀 后端服务运行在端口 ${PORT}`)
})
