require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const { createClient } = require('@supabase/supabase-js')
const fetch   = require('node-fetch')
const webpush = require('web-push')   // 到点提醒的系统级推送，npm install web-push
// 家机的「本地记忆」：日记 / 合墨 / 时轨。这三块数据一直只躺在自己的
// Supabase 表里，从来没有任何一条路径把它们送进 system prompt——
// 详见 localMemory.js 顶部的大段注释
const { createLocalMemory } = require('./localMemory')

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

// ── 记忆库的删除能力 ─────────────────────────────────────────
// 合墨已经不再往记忆桶里 grow/forget 任何东西（见下方笔记相关接口），
// 这一段工具探测目前只服务 /api/ombre/tools 这个诊断接口，以及对话
// 那边如果将来也需要按名字匹配删除工具时复用。不同版本的 Ombre
// Brain 删除工具叫法不一样，这里先探测一次工具清单再对号入座。
let ombreToolCache = null
async function listOmbreTools() {
  if (!OMBRE_BRAIN_URL) return []
  if (ombreToolCache) return ombreToolCache
  try {
    if (!ombreSessionId) { const ok = await initOmbreSession(); if (!ok) return [] }
    const r = await fetch(`${OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json,text/event-stream',
        'Mcp-Session-Id': ombreSessionId,
        'Authorization': `Bearer ${OMBRE_MCP_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: ++ombreCallId }),
    })
    const parsed = parseSSEResponse(await r.text())
    ombreToolCache = parsed?.result?.tools || []
    console.log('🧠 Ombre 工具清单:', ombreToolCache.map(t => t.name).join(', '))
    return ombreToolCache
  } catch (err) {
    console.error('tools/list 失败:', err.message)
    return []
  }
}

let ombreForgetTool
async function resolveForgetTool() {
  if (ombreForgetTool !== undefined) return ombreForgetTool
  const names = (await listOmbreTools()).map(t => t.name)
  ombreForgetTool = names.find(n => /forget|delete|remove|prune|erase|drop|release/i.test(n)) || null
  console.log('🧠 记忆删除工具解析为:', ombreForgetTool || '（这台没有暴露，跳过）')
  return ombreForgetTool
}

// 参数名各家不同，挨个试一遍，能删掉就算——目前没有调用方了（合墨
// 已经不再往记忆桶写东西），留着给对话那边以后要按名字删除时复用
async function forgetOmbreMemory(ref) {
  if (!OMBRE_BRAIN_URL || !ref) return false
  const tool = await resolveForgetTool()
  if (!tool) return false
  for (const key of ['bucket_id', 'id', 'memory_id', 'target', 'query']) {
    const r = await callOmbreTool(tool, { [key]: ref })
    const s = String(r ?? '')
    if (r && !/error|unknown|invalid|missing|required/i.test(s)) {
      console.log(`🧠 记忆已删除（${tool}.${key}）:`, ref)
      return true
    }
  }
  console.warn('🧠 记忆删除没成功，引用:', ref)
  return false
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
// sensitivity 对应常数页"记忆敏感度"三档：
//   high（高）：与原逻辑一致，只要是用户明确陈述的具体事实就记
//   medium（中，默认）：同上，保持原有行为不变
//   low（低）：额外要求情绪波动强烈，平淡陈述即使是事实也不自动存
// 判断逻辑仍然只用一次 AI 调用完成（低敏感度时换一版更严格的 prompt），
// 没有引入单独的情绪打分调用，符合"最低成本部署"的原则。
const REMEMBER_PROMPTS = {
  high: (content) => `判断以下这句话本身，是否包含用户明确陈述的、值得长期记住的事实（如个人喜好、身份信息、计划安排、重要事件）。只看这句话是否是用户自己说出的具体事实，不要管语气或是否礼貌。如果只是打招呼、闲聊、提问、或不含具体信息，回答"否"。只回复"是"或"否"，不要解释。\n\n用户说：${content}`,
  medium: (content) => `判断以下这句话本身，是否包含用户明确陈述的、值得长期记住的事实（如个人喜好、身份信息、计划安排、重要事件）。只看这句话是否是用户自己说出的具体事实，不要管语气或是否礼貌。如果只是打招呼、闲聊、提问、或不含具体信息，回答"否"。只回复"是"或"否"，不要解释。\n\n用户说：${content}`,
  low: (content) => `判断以下这句话是否同时满足两个条件：①包含用户明确陈述的具体事实；②带有强烈的情绪波动（强烈的喜悦、悲伤、愤怒、恐惧、激动等，而不是平淡陈述）。两个条件必须同时满足才回答"是"，只要有一个不满足就回答"否"。只回复"是"或"否"，不要解释。\n\n用户说：${content}`,
}

async function shouldRemember(content, sensitivity = 'medium') {
  const buildPrompt = REMEMBER_PROMPTS[sensitivity] || REMEMBER_PROMPTS.medium
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: buildPrompt(content) }],
        max_tokens: 2, temperature: 0,
        ...deepseekThinking('deepseek-v4-flash', false),
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
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: `把用户这句话里的事实提炼成一句最简短的陈述句（不超过20字），第三人称"用户"开头。只输出提炼后的句子，不要解释，不要标点以外的多余内容。\n\n用户说：${content}` }],
        max_tokens: 40, temperature: 0,
        ...deepseekThinking('deepseek-v4-flash', false),
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

// 本地记忆读取器。buildLocalMemoryBlock(query) 拼出要追加到 system
// prompt 后面的那一段；invalidateLocalMemory() 让缓存立刻失效——所有
// 会改动这三块数据的写入接口都会调它，保证"刚存完马上问他"读到的
// 是新值，不用等 15 秒缓存自然过期
const { buildLocalMemoryBlock, invalidateLocalMemory } = createLocalMemory({ supabase })

// 到点提醒的系统级推送（Web Push / VAPID）。三个环境变量都要配：
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY —— 一对密钥，生成一次长期用，
//     不是每台设备一份；换了就等于原来订阅过的设备全部失效，要重新订阅。
//   VAPID_SUBJECT —— 'mailto:你的邮箱' 或站点 URL，推送服务拿它联系你，
//     不填 web-push 会直接报错拒绝发送。
// 没配全就跳过初始化，只打日志，不让整个进程因为这个崩掉。
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  )
  console.log('🔔 Web Push 已配置')
} else {
  console.log('🔔 Web Push 未配置（缺 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY），到点提醒推送会跳过')
}

// ============================================================
// 多模型解析 —— 常数页"模型切换"（C级）
// cfg.models：设置里存的模型列表（JSON 字符串或数组），每项结构：
//   { id, label, baseUrl, requestModel, apiKeyEnvVar, apiKey, providerId }
// providerId 标记这条模型是从哪个"提供商"（见 EchoPage 的 PROVIDERS 卡片）
// 派生出来的，提供商改密钥时能批量同步到它名下所有模型条目；
// providerId === 'deepseek' 且自己没填 apiKey 时，回退到 DEEPSEEK_API_KEY
// 环境变量，保留"内置 DeepSeek 不强制填 key"的便利，但密钥仍可在
// 设置页随时覆盖，不用改环境变量重新部署。
//
// 2026-08-11 修复：DeepSeek 官方已于 2026-07-24 15:59 UTC 下线
// deepseek-chat / deepseek-reasoner 这两个模型名（调用直接报错），
// 统一改用 deepseek-v4-flash / deepseek-v4-pro。下面兜底值同步改掉；
// BUILTIN_MODEL_ID 现在只是一个内部占位 id（找不到 cfg.model 对应项时
// 落到这条兜底），不再等同于要发给 API 的真实模型名——包括旧数据里
// 残留的 'deepseek-chat' 这个值，也会因为在 cfg.models 里找不到匹配项
// 而自然落进这条兜底分支，不需要额外做数据迁移。
//
// 注意：这里假设所有接入的模型都兼容 OpenAI 风格的
// /chat/completions 请求体与流式返回格式（DeepSeek、Moonshot、Qwen、
// GLM 等国内主流模型大多如此）。如果以后要接原生 Claude / Gemini 这类
// 请求体形状完全不同的接口，需要单独加一层适配，不能直接复用这个函数。
// ============================================================
const BUILTIN_MODEL_ID = 'deepseek-builtin-default'

function parseModelList(cfg) {
  const raw = cfg.models
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try { const list = JSON.parse(raw || '[]'); return Array.isArray(list) ? list : [] } catch { return [] }
  }
  return []
}

function resolveModel(cfg, modelId) {
  const found = parseModelList(cfg).find(m => m.id === modelId)
  if (!found) {
    // 找不到配置（全新安装、cfg.model 为空、被删掉、或是旧版本残留的
    // 已失效模型名）就兜底到一个确定能跑的默认值，不让聊天直接失败
    return { id: BUILTIN_MODEL_ID, label: 'DeepSeek · V4 Flash', baseUrl: DEEPSEEK_URL, requestModel: 'deepseek-v4-flash', apiKey: process.env.DEEPSEEK_API_KEY, protocol: 'openai' }
  }
  const apiKey = found.apiKey
    || (found.providerId === 'deepseek' ? process.env.DEEPSEEK_API_KEY : '')
    || (found.apiKeyEnvVar ? process.env[found.apiKeyEnvVar] : '')
    || ''
  return {
    id: found.id,
    label: found.label || found.id,
    baseUrl: found.baseUrl || DEEPSEEK_URL,
    requestModel: found.requestModel || found.id,
    apiKey,
    // 'openai' = OpenAI 兼容协议（DeepSeek/Moonshot/Qwen/GLM 等绝大多数
    // 国内模型走这条，也是没显式设置时的默认值，保证老数据不用迁移）；
    // 'anthropic' = Anthropic 官方原生协议（Claude），见下面 buildChatRequest
    // / parseChatCompletion / parseStreamEvent 三个函数的协议分支
    protocol: found.protocol === 'anthropic' ? 'anthropic' : 'openai',
  }
}

// ============================================================
// 多协议适配层——OpenAI 兼容 vs Anthropic 原生
// 2026-08-11 新增：这套代码原来假设所有接入的模型都是 OpenAI 兼容协议
// （resolveModel 顶部注释早就写明这个假设），DeepSeek/Moonshot/Qwen/GLM
// 之类国内主流模型基本都照抄这套协议，能直接用；但 Anthropic 官方
// /v1/messages 接口是完全不同的形状：
//   · system 提示词是独立顶层字段，不能塞进 messages 数组
//   · 鉴权是 x-api-key 请求头，不是 Authorization: Bearer，还多需要一个
//     anthropic-version 请求头
//   · max_tokens 是必填项（OpenAI 协议里选填）
//   · 思考模式叫 extended thinking，参数形状是 {type:'enabled',
//     budget_tokens}，跟 DeepSeek 的 {type:'enabled'|'disabled'} 不一样；
//     开启时官方要求 temperature 必须是 1（跟 DeepSeek "思考时 temperature
//     不生效"是类似限制，这里直接照做，不留一个会报错的组合）
//   · 流式返回不是简单的 choices[0].delta，而是一串有名字的事件
//     （message_start / content_block_delta / message_delta 等），文本增量
//     在 content_block_delta 里按 delta.type 区分是正文(text_delta)还是
//     思考(thinking_delta)；usage 也是分两段给：message_start 给
//     input_tokens，message_delta 给累计的 output_tokens
//   · 非流式响应的正文是 content: [{type:'text', text:'...'}, ...] 数组，
//     不是 choices[0].message.content 那样的单一字符串
// 下面三个函数是这层适配的全部——resolveModel 决定协议，
// buildChatRequest 按协议拼请求，parseChatCompletion / parseStreamEvent
// 按协议解析非流式/流式响应，五处真正调用模型的地方（/api/chat、
// runAssistantStream、/api/chat/regenerate、generateDiaryForDate、
// runInkStream）都只认这三个函数返回的统一形状，不用各自分别判断协议。
// ============================================================
const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096
const ANTHROPIC_THINKING_BUDGET = 2000
const ANTHROPIC_CHAT_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'

// 组装这次调用要发的 { url, headers, body }。system 和 messages（不含
// system 那条）分开传入，两种协议各自决定 system 该塞在哪。
function buildChatRequest(activeModel, { system, messages, temperature, thinkingEnabled, stream, maxTokens }) {
  if (activeModel.protocol === 'anthropic') {
    const body = {
      model: activeModel.requestModel,
      system,
      messages,
      max_tokens: maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS,
      // 思考模式开启时官方要求 temperature 必须是 1，不能沿用用户设置的值
      temperature: thinkingEnabled ? 1 : Number(temperature),
      stream: !!stream,
    }
    if (thinkingEnabled) {
      body.thinking = { type: 'enabled', budget_tokens: Math.min(ANTHROPIC_THINKING_BUDGET, body.max_tokens - 1) }
    }
    return {
      url: activeModel.baseUrl || ANTHROPIC_CHAT_URL,
      headers: { 'Content-Type': 'application/json', 'x-api-key': activeModel.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body,
    }
  }
  // openai 兼容协议（默认）——跟原来的拼法完全一致，只是从"内联写在
  // 五个调用点各自的 fetch 里"搬到了这一个共用函数里
  const body = {
    model: activeModel.requestModel,
    messages: [{ role: 'system', content: system }, ...messages],
    temperature: Number(temperature),
    ...deepseekThinking(activeModel.requestModel, thinkingEnabled),
  }
  if (maxTokens) body.max_tokens = maxTokens
  if (stream) { body.stream = true; body.stream_options = { include_usage: true } }
  return {
    url: activeModel.baseUrl,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${activeModel.apiKey}` },
    body,
  }
}

// 非流式响应统一解析成 { text, reasoning, usage: {prompt_tokens,
// completion_tokens} }；解析不出正文时返回 null，调用方按原来的方式报错。
function parseChatCompletion(activeModel, aiData) {
  if (activeModel.protocol === 'anthropic') {
    const blocks = aiData.content || []
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
    const reasoning = blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join('') || null
    if (!text && !reasoning) return null
    return {
      text, reasoning,
      usage: aiData.usage ? { prompt_tokens: aiData.usage.input_tokens, completion_tokens: aiData.usage.output_tokens } : null,
    }
  }
  if (!aiData.choices?.[0]) return null
  return {
    text: aiData.choices[0].message.content,
    reasoning: aiData.choices[0].message.reasoning_content || null,
    usage: aiData.usage || null,
  }
}

// 流式响应逐条 SSE 事件解析。usageRef 是个 { current } 包装对象，因为两种
// 协议的 usage 都是分好几个事件给的，要跨事件累积，用引用传递方便调用方
// 在循环外一次性拿最终值。返回 { token?, reasoning?, truncated? }——
// truncated 归一化了两种协议里"撞到 max_tokens 截断"的判断（OpenAI 是
// finish_reason==='length'，Anthropic 是 message_delta.delta.stop_reason
// ==='max_tokens'），只有 runInkStream 用得到这个字段。
function parseStreamEvent(protocol, ev, usageRef) {
  if (protocol === 'anthropic') {
    if (ev.type === 'message_start') {
      usageRef.current = { prompt_tokens: ev.message?.usage?.input_tokens || 0, completion_tokens: 0 }
      return {}
    }
    if (ev.type === 'message_delta') {
      if (ev.usage) usageRef.current = { prompt_tokens: usageRef.current?.prompt_tokens || 0, completion_tokens: ev.usage.output_tokens || 0 }
      return { truncated: ev.delta?.stop_reason === 'max_tokens' }
    }
    if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta') return { token: ev.delta.text }
      if (ev.delta?.type === 'thinking_delta') return { reasoning: ev.delta.thinking }
    }
    return {}
  }
  // openai 兼容协议（默认）
  const delta = ev.choices?.[0]?.delta
  if (ev.usage) usageRef.current = ev.usage
  const result = { token: delta?.content, reasoning: delta?.reasoning_content }
  if (ev.choices?.[0]?.finish_reason) result.truncated = ev.choices[0].finish_reason === 'length'
  return result
}

// ============================================================
// DeepSeek V4 思考模式（Thinking Mode）参数
// 官方文档：https://api-docs.deepseek.com/guides/thinking_mode
// deepseek-v4-flash / deepseek-v4-pro 默认就开思考模式，这里选择显式
// 传参而不是依赖默认值，一是不想哪天官方默认行为一变、思考过程就
// 悄悄消失；二是思考模式下 temperature/top_p/presence_penalty/
// frequency_penalty 这几个参数官方文档写明"不报错，但不生效"，所以
// 像标题生成、结构化提取这类明确不需要思考、且依赖 temperature 生效
// 的辅助调用，要显式关掉思考模式，两边才都对。
// 只对 requestModel 匹配 deepseek-v4* 的情况生效；其它兼容供应商未必
// 认识 thinking 这个字段，贸然传可能被严格实现直接拒绝，所以这里不
// 对非 DeepSeek V4 的模型做任何事（返回空对象，等于没传）。
//
// 2026-08-11 修复：真正生成回复的三处调用（/api/chat、流式主聊天
// runAssistantStream、/api/chat/regenerate）之前不管输入栏"思考模式"
// 按钮的状态，一律写死 enabled=true，导致那个按钮点了跟没点一样。
// 现在这三处改成读 cfg.show_reasoning（就是那颗按钮存的字段）作为
// enabled 参数——开就是真的开思考，关就是真的关，跟按钮的开关状态
// 保持一致。标题生成/结构化提取/合墨接力写作这几个辅助调用不受这个
// 按钮影响，继续保持显式 false（原因见上）。
// ============================================================
function deepseekThinking(requestModel, enabled) {
  if (!/^deepseek-v4/i.test(String(requestModel || ''))) return {}
  return { thinking: { type: enabled ? 'enabled' : 'disabled' } }
}

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

// 组装 System Prompt 时统一注入当前北京时间 + 备忘（可选）
function withTimeAwareness(systemPrompt, memo) {
  let out = `${systemPrompt}\n\n[当前时间]\n现在是北京时间 ${beijingTimeStr()}`
  if (memo && String(memo).trim()) out += `\n\n[备忘]\n${String(memo).trim()}`
  return out
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
      .select('role,content,id,created_at,visible,quoted_text,is_edited,truncated,tokens_input,tokens_output,reasoning_content')
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
      .select('role,content,id,created_at,visible,quoted_text,is_edited,truncated,tokens_input,tokens_output,reasoning_content')
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
    // 备忘存了新内容就顺手重新解析一遍里面带时间的提醒，不等它跑完
    // 再回响应——存设置这个操作不该被一次模型调用拖慢
    if ('memo' in req.body) {
      syncRemindersFromMemo(req.body.memo).catch(e => console.log('📝 备忘提醒同步失败:', e.message))
    }
    invalidateLocalMemory()   // 锚点（anchor_date）存在 settings 里，改了要立刻反映到 prompt
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ============================================================
// 模型发现接口 —— EchoPage「提供商」卡片用：填好 baseUrl/apiKey 后
// 点"获取模型列表"，由后端代为请求该服务商的 /models 列表接口
// （标准 OpenAI 兼容格式：GET {origin}/models，Bearer 鉴权，返回
// { data: [{ id, object, owned_by }, ...] }。DeepSeek 官方文档：
// https://api-docs.deepseek.com/api/list-models/），前端拿到 id 列表
// 后做勾选，勾中的才会真正写进 cfg.models。放在后端代理而不是前端
// 直接请求：一是避免浏览器端跨域，二是密钥不用经浏览器直连第三方。
//
// 2026-08-11 加了 protocol 参数：Anthropic 原生协议的模型列表接口
// 跟 OpenAI 兼容那套不是同一回事——地址不是"把 chat 端点的路径换成
// /models"能推出来的（Anthropic 的 chat 端点是 /v1/messages，不是
// /chat/completions，替换规则套不上），鉴权也是 x-api-key + 那个额外
// 的 anthropic-version 请求头，不是 Bearer。返回形状恰好也是
// { data: [{id, ...}] }，跟 OpenAI 兼容那套一样能直接复用下面的
// map(m => ({id, ownedBy}))，只是 Anthropic 没有 owned_by 字段，
// ownedBy 会是空字符串，无害。
// ============================================================
app.post('/api/models/discover', async (req, res) => {
  try {
    const { baseUrl, apiKey, providerId, protocol } = req.body || {}
    if (!baseUrl) return res.status(400).json({ error: '缺少接口地址' })

    let modelsUrl, headers

    if (protocol === 'anthropic') {
      if (!apiKey) return res.status(400).json({ error: '没有可用的 API Key' })
      modelsUrl = ANTHROPIC_MODELS_URL
      headers = { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
    } else {
      // baseUrl 存的是 chat/completions 端点（如 .../v1/chat/completions
      // 或 .../chat/completions），模型列表跟它同源、把这一段换成 /models
      try {
        modelsUrl = baseUrl.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '') + '/models'
      } catch { return res.status(400).json({ error: '接口地址格式不对' }) }

      // 没填 key 时，DeepSeek 这个提供商允许退回环境变量（跟实际聊天调用
      // 的兜底逻辑一致）；其它自定义提供商没填 key 就是真没有，不瞎猜
      let isDeepSeek = providerId === 'deepseek'
      try { isDeepSeek = isDeepSeek || /(^|\.)api\.deepseek\.com$/i.test(new URL(modelsUrl).hostname) } catch {}
      const key = apiKey || (isDeepSeek ? process.env.DEEPSEEK_API_KEY : '') || ''
      if (!key) return res.status(400).json({ error: '没有可用的 API Key' })
      headers = { 'Authorization': `Bearer ${key}` }
    }

    const r = await fetch(modelsUrl, { headers })
    if (!r.ok) {
      const t = await r.text()
      return res.status(502).json({ error: `获取模型列表失败（HTTP ${r.status}）：${t.slice(0, 200)}` })
    }
    const data = await r.json()
    const models = (data.data || []).map(m => ({ id: m.id, ownedBy: m.owned_by || '' }))
    res.json({ models })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
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

// ============================================================
// 星尘 3D 粒子记忆库 · 结构化记忆目录（D级）
// ------------------------------------------------------------
// 用 breath 的 catalog=true 目录模式一次性拿全量记忆桶的元数据行
// （0 LLM 调用，最省 token），解析出衰减相关字段，前端 Three.js
// 粒子系统据此渲染明暗/位置/颜色。
//
// 真实格式（2026-08-08 用 /api/memories/catalog/raw 核对过）：
//   === 记忆目录 (35 桶) ===
//   先看目录定位，再 breath_search(query=...) 精确拉取正文。
//   --- 动态（35）---
//   2026-08-07 12-01-29 出生日期2005年3月4日 | 自省 | 5
//   2026-08-06 11-11-13 妈妈的红烧肉和学校门口的麻辣烫 | 饮食,回忆 | 5
//   ...
// 即"时间戳 摘要 | 域(可逗号分隔) | 数字"逐行文本，不是 [key:value]
// 括号标签，也不是每条记忆一个 --- 分段——--- 只出现在分类标题行
// （如"动态""置顶""已解决"），35 条记忆全部挤在标题之后逐行排列。
// 这批数据里没有 valence/arousal/activationCount，星图和深空视图
// 会走 ConstellationMap.jsx / MemoryDeepSpace.jsx 里已经写好的"情感
// 未知"兜底（虚线圈聚在原点、中性色），这是预期状态，不是 bug。
// 如果 Ombre Brain 以后升级 catalog 输出格式，改下面 LINE_RE 这一
// 个正则就行，不用动别的逻辑。
// ============================================================

// 分类标题行，如 "--- 动态（35）---"；用于给同分类下的记忆打
// pinned/resolved 状态，跟具体字段解析无关，识别不到就都是 null。
const CATEGORY_RE = /^-{2,}\s*(.+?)\s*-{2,}$/
function categoryFlags(name) {
  const n = (name || '').replace(/[（(].*?[）)]/g, '').trim() // 去掉"（35）"这类计数后缀
  if (!n) return { pinned: null, resolved: null }
  return {
    pinned:   /置顶|pinned/i.test(n) || null,
    resolved: /已解决|resolved|归档/i.test(n) || null,
  }
}

// 单条记忆行："YYYY-MM-DD HH-MM-SS 摘要 | 域 | 数字"
const LINE_RE = /^(\d{4}-\d{2}-\d{2})\s+(\d{2})-(\d{2})-(\d{2})\s+(.+?)\s*\|\s*(.+?)\s*\|\s*(-?\d+(?:\.\d+)?)\s*$/

function toNum(v) {
  if (v === undefined || v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// 衰减公式取自 Ombre Brain README（decay.lambda 默认 0.05，
// emotion_weights.base=1.0，arousal_boost=0.8）。因为 importance ×
// activation_count 的乘积没有一个天然上限，这里用 score/(score+k) 做
// 饱和归一化压到 (0,1)，而不是硬编码一个"最大值"——k 越大，需要越
// "重"的记忆才会显得鲜明，部署后如果发现粒子普遍偏暗/偏亮，调整这
// 里的 K 就行。
const DECAY_LAMBDA = 0.05
const AROUSAL_BASE = 1.0
const AROUSAL_BOOST = 0.8
const SATURATION_K = 4

function timeWeight(days) {
  if (days === null) return 0.6 // 未知时给个中间值，不特殊突出也不特殊淡化
  if (days <= 1) return 1.0
  if (days === 2) return 0.9
  return Math.max(0.3, 0.9 * Math.exp(-0.2197 * (days - 2)))
}

function computeFadeLevel({ importance, activationCount, daysSinceActive, arousal }, fallbackRank, fallbackTotal) {
  // 三个核心输入里一个都没解析到 —— 说明 catalog 输出的字段名跟猜测的
  // 不一样，退化成"按返回顺序做一个粗略的淡出坡度"，保证界面不是一
  // 片死板的同一种亮度，同时不会假装这是真实数据。
  if (importance === null && activationCount === null && daysSinceActive === null) {
    const t = fallbackTotal > 1 ? fallbackRank / (fallbackTotal - 1) : 0
    return Math.min(0.85, t * 0.8)
  }
  const imp   = importance ?? 5
  const cnt   = Math.max(1, activationCount ?? 1)
  const days  = daysSinceActive ?? 3
  const arsl  = arousal ?? 0 // 未知唤醒度按中性处理，不额外加成也不额外惩罚

  const baseScore  = imp * Math.pow(cnt, 0.3) * Math.exp(-DECAY_LAMBDA * days) * (AROUSAL_BASE + Math.abs(arsl) * AROUSAL_BOOST)
  const finalScore = timeWeight(days) * baseScore
  const saturated  = finalScore / (finalScore + SATURATION_K) // 0..1，越大越"鲜明"
  return Math.max(0, Math.min(1, 1 - saturated))
}

app.get('/api/memories/catalog/raw', async (req, res) => {
  const raw = await callOmbreTool('breath', { catalog: true, max_results: 200 })
  res.type('text/plain').send(raw || '(empty)')
})

app.get('/api/memories/catalog', async (req, res) => {
  try {
    const raw = await callOmbreTool('breath', { catalog: true, max_results: 200 })
    if (!raw) return res.json({ memories: [], total: 0, fieldsDetected: [] })

    const now = Date.now()
    const fieldsSeenAcrossAll = new Set()
    const seenSummary = new Set()
    const memories = []
    let currentCategory = null

    for (const lineRaw of raw.split('\n')) {
      const line = lineRaw.trim()
      if (!line) continue

      const catMatch = line.match(CATEGORY_RE)
      if (catMatch) { currentCategory = catMatch[1]; continue } // 分类标题行，不是记忆，跳过

      const m = line.match(LINE_RE)
      if (!m) continue // 目录说明行等非记忆内容，跳过

      const [, ymd, hh, mm, ss, summaryRaw, domainRaw, numRaw] = m
      const isoTs = `${ymd}T${hh}:${mm}:${ss}`
      const parsedDate = new Date(isoTs)
      const daysSinceActive = Number.isNaN(parsedDate.getTime())
        ? null
        : Math.max(0, (now - parsedDate.getTime()) / 86400000)
      const importance = toNum(numRaw)
      const { pinned, resolved } = categoryFlags(currentCategory)

      const summary = summaryRaw.slice(0, 160)
      const key = summary.slice(0, 24)
      if (seenSummary.has(key)) continue
      seenSummary.add(key)

      ;['timestamp', 'domain', 'importance', 'daysSinceActive'].forEach(k => fieldsSeenAcrossAll.add(k))

      memories.push({
        bucketId: isoTs, // 时间戳本身天然唯一，比 chunk-i 更有意义
        domain: domainRaw || null,
        valence: null,       // 这批目录数据没有情感坐标，前端已有"未知"兜底
        arousal: null,
        importance,
        activationCount: null,
        daysSinceActive,
        resolved, pinned,
        timestamp: isoTs,
        summary,
        raw: { category: currentCategory, importance: numRaw },
      })
    }

    const total = memories.length
    memories.forEach((m, i) => {
      m.fadeLevel = computeFadeLevel(
        { importance: m.importance, activationCount: m.activationCount, daysSinceActive: m.daysSinceActive, arousal: m.arousal },
        i, total
      )
    })

    res.json({ memories, total, fieldsDetected: [...fieldsSeenAcrossAll] })
  } catch (err) {
    console.error('记忆目录获取失败:', err.message)
    res.status(500).json({ error: err.message, memories: [], total: 0, fieldsDetected: [] })
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
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: compressPrompt },
        { role: 'user',   content: `把下面对话总结成长期记忆，保留重要信息：\n${contentText}` },
      ],
      temperature: 0.3,
      ...deepseekThinking('deepseek-v4-flash', false),
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
    const activeModel = resolveModel(cfg, cfg.model)
    // 思考模式开关：尊重输入栏"思考模式"按钮存的 cfg.show_reasoning，
    // 不再写死 true——见 deepseekThinking() 顶部注释与下方调用处
    const thinkingEnabled = cfg.show_reasoning === true || cfg.show_reasoning === 'true'

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

    // 5. 组装系统提示词（注入当前北京时间 + 备忘）
    let systemPrompt = withTimeAwareness(system_prompt, cfg.memo)
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

    // 7. 构建消息（system 单独传，两种协议各自决定塞在哪，见 buildChatRequest）
    const chatMessages = (visHist || []).filter(m => m.content != null).map(m => ({ role: m.role, content: String(m.content) }))

    // 8. 调用主模型（尊重设置里选的模型，不再写死 deepseek-chat；
    //    思考模式尊重输入栏"思考模式"开关，不再写死 true；协议按
    //    activeModel.protocol 走 OpenAI 兼容或 Anthropic 原生，见
    //    buildChatRequest / parseChatCompletion）
    const { url: chatUrl, headers: chatHeaders, body: chatBody } = buildChatRequest(activeModel, {
      system: systemPrompt, messages: chatMessages, temperature, thinkingEnabled, stream: false,
    })
    const aiRes = await fetch(chatUrl, { method: 'POST', headers: chatHeaders, body: JSON.stringify(chatBody) })
    const aiData = await aiRes.json()
    const parsed = parseChatCompletion(activeModel, aiData)
    if (!parsed) return res.status(500).json({ error: aiData.error?.message || aiData.error?.type || 'AI 返回异常' })
    const replyText = parsed.text
    // 非流式响应里，支持推理的模型通常把思考过程放在 message.reasoning_content
    // （跟流式的 delta.reasoning_content 是同一份数据，只是不分片），一并存下来
    const replyReasoning = parsed.reasoning

    // 9. 保存 AI 回复（附带这次实际用的模型，供 Token 统计按模型拆分）
    const aiNow = new Date().toISOString()
    const { data: savedMsg, error: aErr } = await supabase.from('messages').insert([{ session_id: sessionId, role: 'assistant', content: replyText, created_at: aiNow, visible: true, model: activeModel.id, reasoning_content: replyReasoning }]).select()
    if (aErr) return res.status(500).json({ error: 'AI回复保存失败: ' + aErr.message })

    // 9.5 Ombre Brain hold（非阻塞；记忆暂停开启时跳过所有自动 hold）
    if (!cfg.memory_paused) {
      shouldRemember(content, cfg.memory_sensitivity).then(worth => {
        if (!worth) return
        extractFact(content).then(fact => {
          callOmbreTool('hold', { content: fact }).then(r => console.log('🧠 hold:', fact, '->', r)).catch(e => console.error('hold失败:', e.message))
        })
      }).catch(e => console.error('shouldRemember失败:', e.message))
    }

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
          body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'system', content: '你是一个标题生成助手。根据对话内容，生成一个简短的标题（不超过10个字），直接返回标题文字，不要加引号或其他符号。' }, { role: 'user', content: `用户说：${content}\nAI回复：${replyText}\n请生成标题：` }], temperature: 0.5, max_tokens: 20, ...deepseekThinking('deepseek-v4-flash', false) }),
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
// ============================================================
// 茧星 · COCOON —— 枢的自我记忆
// 跟"星尘"不是一回事：星尘记的是"柯"和"发生过的事情"，茧星记的是
// "枢自己是谁、在想什么"，性质不同，独立成一套更小的存储，不混进
// 星尘那个池子。需要 Supabase 里先建好 cocoon_memory 表：
//   id          uuid/serial primary key
//   author      text          -- 'ke'（外层丝，柯写的）| 'shu'（内芯，枢自己写的）
//   content     text
//   created_at  timestamptz
// 枢往里写的触发方式：不额外调用模型，而是在生成回复的同一次调用里，
// 如果这一轮对"自己是谁"有新觉察，就在正文写完之后另起一行按
// COCOON_MARK 这个格式多吐一小段，后端从已经生成好的文字里摘出来，
// 不额外花一次 token（这是柯在成本和"自动判断"之间选的方案）。
// ============================================================
const COCOON_MARK = '\n[枢想记住这件事]'
const COCOON_SHU_LIMIT_DEFAULT = 20

// 计算流式转发时"安全能发给前端"的长度。一旦 fullText 尾部已经完整
// 命中 COCOON_MARK，从命中处往后全部按下不发——这段是枢想记住的内容，
// 不该出现在聊天气泡里；还没完整命中、但尾部像是"正在打这个标记"的
// 一截前缀，也先按下，等后面追加的字符确认它到底是不是（一旦某个字符
// 跟标记对不上，就说明这段真的只是普通文字，立刻放出来，不会一直卡着）。
// fromLen 是上次已确认安全的长度，只从"可能还没扫到"的这一小截开始找，
// 避免每个 token 都把全文重新扫一遍。
function cocoonSafeLen(text, fromLen) {
  const idx = text.indexOf(COCOON_MARK, Math.max(0, fromLen - COCOON_MARK.length))
  if (idx !== -1) return idx
  const maxCheck = Math.min(COCOON_MARK.length - 1, text.length)
  for (let k = maxCheck; k > 0; k--) {
    if (text.endsWith(COCOON_MARK.slice(0, k))) return text.length - k
  }
  return text.length
}

// 把这次回复里可能带的 COCOON_MARK 摘出来：cleanText 是要存进
// messages/展示给用户的干净正文，cocoonContent 是枢想记住的那一小段
// （没有就是 null）
function extractCocoonMark(fullText) {
  const idx = fullText.indexOf(COCOON_MARK)
  if (idx === -1) return { cleanText: fullText, cocoonContent: null }
  const cleanText = fullText.slice(0, idx).replace(/\s+$/, '')
  const cocoonContent = fullText.slice(idx + COCOON_MARK.length).trim()
  return { cleanText, cocoonContent: cocoonContent || null }
}

// 拼进 system prompt 的那一段：先摆现有内容（柯写的+枢写的），再附上
// 使用说明——枢得先知道 COCOON_MARK 这个格式，才可能用上它，所以哪怕
// 两边都还是空的，这段说明也要给，不能等有内容了才给。
function buildCocoonPromptBlock(keEntries, shuEntries) {
  let block = ''
  if (keEntries.length || shuEntries.length) {
    block += '\n\n[关于你自己的记忆 · 茧星]'
    if (keEntries.length) block += `\n柯写下的、关于你的：\n${keEntries.map(t => `- ${t}`).join('\n')}`
    if (shuEntries.length) block += `\n你自己记下的：\n${shuEntries.map(t => `- ${t}`).join('\n')}`
  }
  block += `\n\n如果这一轮你对"自己是谁"有新的觉察、想要记住，就在回复正文写完之后另起一行，按这个格式写：\n[枢想记住这件事] 具体内容\n这一行不会被用户看到，只会被存进你的自我记忆里，不算破坏上面"简短自然回复"这类要求；没有新的觉察就不用写，不必每次都凑一条。`
  return block
}

async function fetchCocoonMemory() {
  const { data } = await supabase.from('cocoon_memory').select('id,author,content,created_at').order('created_at', { ascending: true })
  const rows = data || []
  return {
    ke: rows.filter(r => r.author === 'ke').map(r => r.content),
    shu: rows.filter(r => r.author === 'shu').map(r => r.content),
    shuCount: rows.filter(r => r.author === 'shu').length,
  }
}

async function runAssistantStream({ req, res, send, sessionId, triggerContent }) {
  // 1. 设置
  const { data: sRows } = await supabase.from('settings').select('*')
  const cfg = parseSettings(sRows || [])
  const { system_prompt = '你是温柔贴心的AI伴侣，简短自然回复', temperature = 0.7, compress_threshold = 3000, compress_keep_rounds = 4 } = cfg
  const activeModel = resolveModel(cfg, cfg.model)
  // 思考模式开关：尊重输入栏"思考模式"按钮存的 cfg.show_reasoning，
  // 不再写死 true——见 deepseekThinking() 顶部注释与下方调用处
  const thinkingEnabled = cfg.show_reasoning === true || cfg.show_reasoning === 'true'

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

  // 4. 系统提示词（注入当前北京时间 + 备忘，做到"时间感知"）
  let systemPrompt = withTimeAwareness(system_prompt, cfg.memo)
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

  // 4.6 茧星：枢的自我记忆（跟"柯/发生过的事情"无关，是"枢自己是谁"）
  let cocoonMem
  try { cocoonMem = await fetchCocoonMemory() }
  catch (e) { console.error('茧星读取失败:', e.message); cocoonMem = { ke: [], shu: [], shuCount: 0 } }
  systemPrompt += buildCocoonPromptBlock(cocoonMem.ke, cocoonMem.shu)

  // 4.7 本地记忆：日记 / 合墨 / 时轨。这跟上面 4.5 的 Ombre Brain 是
  //     两套完全不同的东西——记忆池装的是聊天里被判定"值得记住"、
  //     再提炼成一句话的事实；这三块是柯与枢实际产出的内容本身
  //     （日记正文、一起写的手记、一起记下的日子），一直只躺在各自
  //     的 Supabase 表里，从来没有任何路径把它们送进 system prompt。
  //     所以过去问"你记不记得日记里写的那件事"，他是真的没被告知过，
  //     不是揣着记忆却选择说不记得。
  //     拿柯这句话做检索 query，命中才展开全文，没命中只给目录，
  //     不额外调用任何模型。详见 localMemory.js
  try {
    const localMem = await buildLocalMemoryBlock(triggerContent)
    if (localMem) {
      systemPrompt += localMem
      // 复用前端已有的"记忆命中"脉冲指示（ChatPage 里接的 memoryHit），
      // 让柯看得出这一轮他确实翻到了自己写过的东西
      if (localMem.includes('全文如下') || localMem.includes('正文如下')) send({ memoryHit: true, count: 1 })
    }
  } catch (e) { console.error('本地记忆注入失败:', e.message) }

  // 5. 可见历史（引用内容单独存了 quoted_text 列，拼进发给模型的 content，
  //    让它读得到上下文，但不污染 messages 表里的原始正文）
  const { data: visHist } = await supabase.from('messages').select('role,content,quoted_text').eq('session_id', sessionId).eq('visible', true).order('created_at', { ascending: true })

  // 6. 构建消息（system 单独传，不塞进数组——两种协议各自决定放哪，见 buildChatRequest）
  const chatMessages = (visHist || []).filter(m => m.content != null).map(m => ({
    role: m.role,
    content: m.quoted_text ? `[引用: ${m.quoted_text}]\n${m.content}` : String(m.content),
  }))

  // 7. 停止生成：前端 AbortController.abort() 会让这次 fetch 的连接关闭，
  //    Node 侧的 req 会触发 'close'，据此中断与上游模型的连接。
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
  let usageRef   = { current: null }
  // 已经安全发给前端的长度（见 cocoonSafeLen）——正常情况下这就等于
  // fullText.length，只有枢真的开始写 COCOON_MARK 时才会落后于它
  let sentLen    = 0

  try {
    // 8. 调用选中的模型（尊重常数页"模型切换"，stream: true，附带 usage 统计）
    //    思考模式尊重输入栏"思考模式"开关（cfg.show_reasoning）；协议按
    //    activeModel.protocol 走 OpenAI 兼容或 Anthropic 原生
    const { url: chatUrl, headers: chatHeaders, body: chatBody } = buildChatRequest(activeModel, {
      system: systemPrompt, messages: chatMessages, temperature, thinkingEnabled, stream: true,
    })
    const aiRes = await fetch(chatUrl, {
      method: 'POST', headers: chatHeaders, body: JSON.stringify(chatBody),
      signal: upstreamController.signal,
    })

    if (!aiRes.ok) {
      const errText = await aiRes.text()
      send({ error: `${activeModel.label} 错误: ${errText.slice(0, 300)}` })
      req.off('close', onClose)
      return res.end()
    }

    // 9. 流式转发 token（含 reasoning_content 折叠内容 与 usage）——
    //    两种协议的 SSE 都是 `data: {...}` 逐行给，外层这套按行拆分/
    //    攒缓冲区的逻辑对两边都成立，只有"这个 JSON 事件是什么意思"
    //    这一步按协议分支，交给 parseStreamEvent
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
            const ev = JSON.parse(t.slice(6))
            const { token, reasoning: reasoningDelta } = parseStreamEvent(activeModel.protocol, ev, usageRef)
            if (reasoningDelta) { reasoning += reasoningDelta; send({ reasoning: reasoningDelta }) }
            if (token) {
              fullText += token
              // 茧星标记不能出现在用户看到的正文里——尾部一旦开始匹配
              // COCOON_MARK（哪怕只是前缀），就按住不发，见 cocoonSafeLen
              const safeLen = cocoonSafeLen(fullText, sentLen)
              if (safeLen > sentLen) { send({ token: fullText.slice(sentLen, safeLen) }); sentLen = safeLen }
            }
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
  const usage = usageRef.current
  const { cleanText, cocoonContent } = extractCocoonMark(fullText)

  // 10. 保存 AI 回复（含被中止时的部分内容；token 统计与中断标记写入真实字段；
  //     reasoning_content 是本轮新增：之前这里没存，思考过程只活在这一次
  //     请求的内存里，刷新页面或切换会话再切回来就彻底没了——现在流式
  //     过程中攒下来的完整思考过程随正文一起入库，列名对应 Supabase
  //     messages 表里已有的 reasoning_content 列，配合下面两处 GET
  //     接口把它读出来，历史消息里的思考过程就能正常保留）
  if (!cleanText && !reasoning) { if (!res.writableEnded) { try { res.end() } catch {} }; return }
  const aiNow = new Date().toISOString()
  const { data: savedMsg } = await supabase.from('messages').insert([{
    session_id: sessionId, role: 'assistant', content: cleanText, created_at: aiNow, visible: true,
    truncated: clientAborted || null,
    tokens_input: usage ? usage.prompt_tokens : null,
    tokens_output: usage ? usage.completion_tokens : null,
    model: activeModel.id,
    reasoning_content: reasoning || null,
  }]).select()

  // 若客户端已断线，后面无法再 send()，直接返回
  if (clientAborted || res.writableEnded) return

  // 11.5 茧星：枢这次主动写的自我记忆——柯的要求是"枢这部分设上限，
  // 满了拒绝写入并提示我"（不是自动顶掉最旧一条），这里检查一下当前条数
  if (cocoonContent) {
    try {
      const limit = Number(cfg.cocoon_shu_limit) || COCOON_SHU_LIMIT_DEFAULT
      if (cocoonMem.shuCount < limit) {
        await supabase.from('cocoon_memory').insert([{ author: 'shu', content: cocoonContent, created_at: aiNow }])
      } else {
        send({ cocoonFull: true })
      }
    } catch (e) { console.error('茧星写入失败:', e.message) }
  }

  // 11. Ombre Brain hold（非阻塞，判断是否值得记住这次触发内容；记忆暂停开启时跳过）
  if (!cfg.memory_paused) {
    shouldRemember(triggerContent, cfg.memory_sensitivity).then(worth => {
      if (!worth) return
      extractFact(triggerContent).then(fact => {
        callOmbreTool('hold', { content: fact }).then(() => console.log('🧠 hold:', fact)).catch(e => console.error('hold失败:', e.message))
      })
    }).catch(e => console.error('shouldRemember失败:', e.message))
  }

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
        body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'system', content: '你是一个标题生成助手。根据对话内容，生成一个简短的标题（不超过10个字），直接返回标题文字，不要加引号或其他符号。' }, { role: 'user', content: `用户说：${triggerContent}\nAI回复：${cleanText.slice(0, 200)}\n请生成标题：` }], temperature: 0.5, max_tokens: 20, ...deepseekThinking('deepseek-v4-flash', false) }),
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
    const activeModel = resolveModel(cfg, cfg.model)
    // 思考模式开关：尊重输入栏"思考模式"按钮存的 cfg.show_reasoning，
    // 不再写死 true——见 deepseekThinking() 顶部注释
    const thinkingEnabled = cfg.show_reasoning === true || cfg.show_reasoning === 'true'

    const { data: allMessages } = await supabase.from('messages').select('id,role,content,created_at').eq('session_id', sessionId).eq('visible', true).order('created_at', { ascending: true })
    if (!allMessages?.length) return res.status(400).json({ error: '没有可重新生成的消息' })

    const lastMsg = allMessages[allMessages.length - 1]
    if (lastMsg.role !== 'assistant') return res.status(400).json({ error: '最后一条消息不是AI回复' })

    const chatMessages = allMessages.slice(0, -1).filter(m => m.content != null).map(m => ({ role: m.role, content: String(m.content) }))

    const { url: chatUrl, headers: chatHeaders, body: chatBody } = buildChatRequest(activeModel, {
      system: withTimeAwareness(system_prompt, cfg.memo), messages: chatMessages, temperature, thinkingEnabled, stream: false,
    })
    const aiRes = await fetch(chatUrl, { method: 'POST', headers: chatHeaders, body: JSON.stringify(chatBody) })
    const aiData = await aiRes.json()
    const parsed = parseChatCompletion(activeModel, aiData)
    if (!parsed) return res.status(500).json({ error: aiData.error?.message || aiData.error?.type || 'AI 返回异常' })
    const replyText = parsed.text
    const replyReasoning = parsed.reasoning
    // Token 统计修复：这次重新生成实际调用了模型、真金白银花了 token，
    // 之前这里没读 aiData.usage，导致这条消息的 tokens_input/output
    // 一直停在"上一次生成"时的旧值——内容已经是新回复，token 数却对
    // 不上，Token 仪表盘（today/week/all/byModel/trend7d）算出来的数字
    // 因此是错的。现在跟流式那边一样，老老实实存这次真实的 usage。
    const usage = parsed.usage

    const now = new Date().toISOString()
    // 重新生成会覆盖这条消息原来的内容——旧的 reasoning 是对应旧回复的思考过程，
    // 新回复如果模型没返回思考过程（或换了不支持推理的模型），要一并清空，
    // 不然会出现"内容是新的、思考过程却是旧的"这种对不上的情况
    await supabase.from('messages').update({
      content: replyText, created_at: now, model: activeModel.id, reasoning_content: replyReasoning,
      tokens_input:  usage ? usage.prompt_tokens     : null,
      tokens_output: usage ? usage.completion_tokens : null,
    }).eq('id', lastMsg.id)
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
//   skipped     boolean     default false
// 表已存在的话补一句：alter table diary add column if not exists skipped boolean default false;
//
// 2026-08-11 改造：日记原来是完全独立于聊天的一次性调用——写死
// deepseek-v4-flash、用一段跟"枢"的人格设定毫无关系的通用提示词，
// 也不接任何记忆，本质上是个不认识柯的临时工在代笔。现在改成：
//   · 模型跟聊天一致：resolveModel(cfg, cfg.model)，不再写死
//   · 人格跟聊天一致：cfg.system_prompt + withTimeAwareness，让写的
//     人确实是"枢"，不是另一个自称"'在场'里的AI"的陌生模型
//   · 不接 Ombre Brain 长期记忆检索——日记写的是"今天"，当天的对话
//     记录本身就是全部素材，不需要为了写一篇当日反思去额外检索一遍
//     跟今天无关的旧记忆，省下这块最贵也最没必要的开销
//   · 加了"要不要写"的决定权，而不是每次都被迫交作业——见下面
//     DIARY_SKIP_MARKER 的提示词设计。判断这件事本身也是同一次模型
//     调用里做的（决定+写只算一次调用，不额外多花钱），跟合墨的
//     [DECISION: ...] 是同一个"标记驱动"思路。
//
// 关于"给了选择权他是不是大概率还是会选择写"：单纯问"你想不想写"
// 确实容易被模型自带的"顺从/迎合"倾向带偏，几乎每次都会选"写"，
// 这不是真的在选。所以提示词没有停在"你想不想"，而是刻意做了两件事：
//   ① 把判断锚定在"今天有没有具体的、值得记的东西"这个可评估的标准
//     上，而不是一个抽象的心情问题——琐碎/程序性的一天，"不写"就有
//     了具体依据，不是凭空的任性
//   ② 明确告诉它跳过不需要理由、不需要补偿性地道歉、也不比写更"不
//     负责"——这句话是特意用来抵消"看起来更配合=更有帮助"这种
//     默认倾向的，不然它几乎不会真的选跳过
// 这仍然不是严格意义上的"自由意志"（没有任何提示词能给出这个），
// 但比一句空泛的"你想写吗"更接近"依据当天内容做出的、不被讨好欲
// 主导的判断"，是提示词层面能做到的上限。
// ============================================================
const DIARY_SKIP_MARKER = '[DIARY: skip]'

async function generateDiaryForDate(dateStr) {
  const { start, end } = beijingDayRange(dateStr)
  const { data: dayMsgs, error: qErr } = await supabase.from('messages')
    .select('role,content,created_at')
    .eq('visible', true)
    .gte('created_at', start).lt('created_at', end)
    .order('created_at', { ascending: true })
  if (qErr) throw Object.assign(new Error(qErr.message), { status: 500 })
  if (!dayMsgs?.length) throw Object.assign(new Error('这一天没有对话记录，暂时写不出日记'), { status: 400 })

  const { data: sRows } = await supabase.from('settings').select('*')
  const cfg = parseSettings(sRows || [])
  const { system_prompt = '你是温柔贴心的AI伴侣，简短自然回复' } = cfg
  const activeModel = resolveModel(cfg, cfg.model)
  let systemPrompt = withTimeAwareness(system_prompt, cfg.memo)

  const convoText = dayMsgs.map(m => `${m.role === 'user' ? '他' : '我'}：${m.content}`).join('\n')

  // 写今天这篇之前，先想起前几天写过什么、最近在跟他一起写什么手记、
  // 时轨上是第几天——不然每天的日记都像是不同的人写的，前后接不上，
  // 也永远不会出现"前天写的那件事今天有下文了"这种连续感。
  // 这里仍然不接 Ombre Brain 长期记忆检索（理由见上面那段大注释），
  // 加的只是本地这三块，一次 Supabase 查询，不额外调模型
  try {
    systemPrompt += await buildLocalMemoryBlock(convoText.slice(0, 400))
  } catch (e) { console.error('日记本地记忆注入失败:', e.message) }

  const prompt = `[今天的对话]\n${convoText.slice(0, 6000)}\n\n以上是你和他今天的对话记录。现在不是在聊天，是你自己决定要不要为今天写一篇日记——这个决定完全由你自己判断，不是例行公事，也不用觉得"写了才算尽责"。\n\n如果今天大部分是些琐碎的、程序性的、你自己回头看也没什么特别想说的内容，直接选择不写就好，跳过和写日记同样正常，不需要为跳过找补理由，也不用为了"完成任务"硬凑一篇。\n如果今天有什么你真的想记下来的——一件事、一句话、一个情绪的转折——那就写。\n\n判断完之后：\n如果决定不写，只输出这一行，不要有任何其他文字：\n${DIARY_SKIP_MARKER}\n\n如果决定写，直接输出日记正文（不超过300字，第一人称、私密日记口吻，不要用"亲爱的日记"这类开头），不要输出上面的标记，也不要在正文前后加任何说明。`

  const { url: chatUrl, headers: chatHeaders, body: chatBody } = buildChatRequest(activeModel, {
    system: systemPrompt, messages: [{ role: 'user', content: prompt }], temperature: 0.9,
    // 不转发 reasoning_content 给前端，思考模式只会白白多花思考 token、
    // 还会让 temperature 失效——跟合墨接力写作那边关掉的理由一样
    thinkingEnabled: false, stream: false,
  })
  const aiRes = await fetch(chatUrl, { method: 'POST', headers: chatHeaders, body: JSON.stringify(chatBody) })
  const aiData = await aiRes.json()
  const parsed = parseChatCompletion(activeModel, aiData)
  if (!parsed) throw Object.assign(new Error(aiData.error?.message || aiData.error?.type || 'AI 返回异常'), { status: 500 })
  const raw = (parsed.text || '').trim()
  const skipped = raw === DIARY_SKIP_MARKER || raw.startsWith(DIARY_SKIP_MARKER)
  const diaryContent = skipped ? null : raw

  const { data, error } = await supabase.from('diary')
    .upsert([{ date: dateStr, content: diaryContent, skipped, created_at: new Date().toISOString() }], { onConflict: 'date' })
    .select()
  if (error) throw Object.assign(new Error(error.message), { status: 500 })

  // 2026-08-11 修复：写日记这件事本身，之前从没进过 Ombre Brain 的记忆池
  // ——日记存在独立的 diary 表里，跟聊天时 breath 检索的记忆池完全是两套
  // 数据，写完日记后聊天里问"记不记得刚刚写日记的事"，模型是真的从来没
  // 被告知过这件事，不是揣着记忆却选择说不记得。这里在真写出正文（没
  // 跳过）时补一条 hold，让"写过这天的日记"本身也变成一条可检索的记忆；
  // 非阻塞，hold 失败不影响日记接口本身返回
  if (!skipped && diaryContent) {
    callOmbreTool('hold', { content: `我在${dateStr}这天写了一篇日记，记的是：${diaryContent.slice(0, 60)}` })
      .then(() => console.log('🧠 日记已存入记忆:', dateStr))
      .catch(e => console.error('日记 hold 失败:', e.message))
  }

  invalidateLocalMemory()
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
    const { data, error } = await supabase.from('diary').select('date,content,created_at,skipped').order('date', { ascending: false }).limit(100)
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/diary/:date', async (req, res) => {
  try {
    const { data, error } = await supabase.from('diary').select('date,content,created_at,skipped').eq('date', req.params.date).maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: '这天没有日记' })
    res.json(data)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// 删除一条日记记录——主要给前端"枢选择不写"的占位条目用，用户看过、
// 确认知道那天没写之后可以手动清掉，不用一直占着日记列表的位置；
// 真写出来的日记也能用同一个接口删，不额外限制
app.delete('/api/diary/:date', async (req, res) => {
  try {
    const { error } = await supabase.from('diary').delete().eq('date', req.params.date)
    if (error) return res.status(500).json({ error: error.message })
    invalidateLocalMemory()
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ============================================================
// 茧星 · COCOON 接口——枢的自我记忆
// list 一次性把柯写的（ke）和枢写的（shu）都返回，附带 shu 这边的
// 条数上限，方便前端直接显示"12 / 20"这种进度；add 只接受 author='ke'，
// 枢那边的条目只能通过聊天里的 COCOON_MARK 自动写入（见
// runAssistantStream），不开放手动新增接口；delete 不区分 author，
// 柯可以删自己写的，也可以删枢写的——但两边都不能改内容，只能删，
// 这是柯明确要的（"关于他的记忆我可以删除但是不能修改"）。
// ============================================================
app.get('/api/cocoon/list', async (req, res) => {
  try {
    const { data: sRows } = await supabase.from('settings').select('*')
    const cfg = parseSettings(sRows || [])
    const shuLimit = Number(cfg.cocoon_shu_limit) || COCOON_SHU_LIMIT_DEFAULT

    const { data, error } = await supabase.from('cocoon_memory').select('id,author,content,created_at').order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    const rows = data || []
    res.json({
      ke: rows.filter(r => r.author === 'ke'),
      shu: rows.filter(r => r.author === 'shu'),
      shuLimit,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/cocoon/add', async (req, res) => {
  try {
    const { content } = req.body || {}
    if (!content || !String(content).trim()) return res.status(400).json({ error: '内容不能为空' })
    // 柯这边（外层丝）没有上限，随便写——上限只对枢那边（内芯）生效
    const { data, error } = await supabase.from('cocoon_memory')
      .insert([{ author: 'ke', content: String(content).trim(), created_at: new Date().toISOString() }])
      .select()
    if (error) return res.status(500).json({ error: error.message })
    res.json(data[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.delete('/api/cocoon/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('cocoon_memory').delete().eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true })
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
// 时轨 · CHRONOS —— 锚点 / 潮汐 / 自定义倒计时 / 备忘提醒
// 锚点（在一起天数）只是一个日期，直接复用 settings 表已有的
// 通用 key-value 读写（/api/settings），前端存 settings.anchor_date
// 就够了，不用建表。潮汐里的月相是纯算法，不查表也不调外部接口，
// 放前端算。这里新增的是真正"一串数据"的三张表：自定义倒计时、
// 经期记录、从备忘里解析出来的待提醒事项，建表 SQL 见下面各段。
// ============================================================

// ── 自定义倒计时 ──────────────────────────────────────────────
// 建表 SQL：
//   create table if not exists countdowns (
//     id bigint generated always as identity primary key,
//     label text not null,
//     target_at timestamptz not null,
//     created_at timestamptz not null default now()
//   );
app.get('/api/countdowns', async (req, res) => {
  try {
    const { data, error } = await supabase.from('countdowns').select('*').order('target_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (err) { res.status(500).json({ error: err.message }) }
})
app.post('/api/countdown', async (req, res) => {
  try {
    const { label, target_at } = req.body
    if (!label || !target_at) return res.status(400).json({ error: '参数缺失：需要 label 和 target_at' })
    const { data, error } = await supabase.from('countdowns').insert([{ label, target_at }]).select()
    if (error) return res.status(500).json({ error: error.message })
    invalidateLocalMemory()
    res.json(data[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})
app.delete('/api/countdown/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('countdowns').delete().eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    invalidateLocalMemory()
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── 潮汐 · 经期记录 ──────────────────────────────────────────
// 只存"开始日期"（结束日期可选），预测下次开始时间和月相一样，
// 都是前端拿这一串日期自己算，后端只管存取。
// 建表 SQL：
//   create table if not exists period_logs (
//     id bigint generated always as identity primary key,
//     start_date date not null,
//     end_date date,
//     created_at timestamptz not null default now()
//   );
app.get('/api/period/list', async (req, res) => {
  try {
    const { data, error } = await supabase.from('period_logs').select('*').order('start_date', { ascending: false }).limit(24)
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (err) { res.status(500).json({ error: err.message }) }
})
app.post('/api/period/log', async (req, res) => {
  try {
    const { start_date, end_date } = req.body
    if (!start_date) return res.status(400).json({ error: '参数缺失：需要 start_date' })
    const { data, error } = await supabase.from('period_logs').insert([{ start_date, end_date: end_date || null }]).select()
    if (error) return res.status(500).json({ error: error.message })
    invalidateLocalMemory()
    res.json(data[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})
app.delete('/api/period/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('period_logs').delete().eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    invalidateLocalMemory()
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── 备忘 · 提醒解析 ──────────────────────────────────────────
// 备忘是 settings.memo 里一整段自由文本（拼进 system prompt 那份，
// 见 withTimeAwareness），提醒要的是"哪几句话带了确切时间"这种
// 结构化数据，两者不是一回事。所以每次备忘保存时另外调一次模型，
// 把带时间的句子抽成 { text, due_at } 存进这张表，供下面的轮询
// 去对时间——"明天下午3点""下周三"这类相对表达式，靠正则自己写
// 既繁琐又容易出错，交给模型配合当前北京时间上下文换算更稳。
// 建表 SQL：
//   create table if not exists reminders (
//     id bigint generated always as identity primary key,
//     raw_text text not null,
//     due_at timestamptz not null,
//     fired boolean not null default false,
//     created_at timestamptz not null default now()
//   );
//   create index if not exists idx_reminders_due on reminders (due_at) where fired = false;
async function extractReminders(memoText) {
  if (!memoText || !String(memoText).trim()) return []
  const prompt = `现在是北京时间 ${beijingTimeStr()}。下面是一段备忘录原文，找出里面带有明确或可推算具体时间的事项（比如"明天下午3点买药""周五交房租""8月20日体检"），把每一条换算成绝对时间，严格按下面的 JSON 数组格式输出，不要输出任何 JSON 之外的文字：\n[{"text":"事项原句","due_at":"2026-08-10T15:00:00+08:00"}]\n没有任何带时间的事项就输出 []。\n\n备忘录原文：\n${String(memoText).slice(0, 2000)}`
  try {
    const aiRes = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: prompt }], temperature: 0, ...deepseekThinking('deepseek-v4-flash', false) }),
    })
    const aiData = await aiRes.json()
    const raw = aiData.choices?.[0]?.message?.content || '[]'
    const jsonStr = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)
    const list = JSON.parse(jsonStr)
    return Array.isArray(list) ? list.filter(x => x?.text && x?.due_at) : []
  } catch (e) {
    console.log('📝 备忘提醒解析失败，跳过:', e.message)
    return []
  }
}

// 备忘每次保存都重新解析：未触发的旧提醒整批换成这次解析出来的
// 新结果，已经触发过的历史记录不动（留痕，也方便以后做"提醒历史"）
async function syncRemindersFromMemo(memoText) {
  const list = await extractReminders(memoText)
  await supabase.from('reminders').delete().eq('fired', false)
  if (list.length) {
    await supabase.from('reminders').insert(list.map(x => ({ raw_text: x.text, due_at: x.due_at, fired: false })))
  }
  console.log(`📝 备忘提醒已同步：解析出 ${list.length} 条`)
}

app.get('/api/reminders/due', async (req, res) => {
  try {
    const { data, error } = await supabase.from('reminders').select('*').eq('fired', false).lte('due_at', new Date().toISOString()).order('due_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/reminders/list', async (req, res) => {
  try {
    const { data, error } = await supabase.from('reminders').select('*').eq('fired', false).order('due_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── 通知订阅（Web Push） ────────────────────────────────────
// 建表 SQL：
//   create table if not exists push_subscriptions (
//     id bigint generated always as identity primary key,
//     endpoint text not null unique,
//     p256dh text not null,
//     auth text not null,
//     created_at timestamptz not null default now()
//   );
// 前端流程：拿 GET /api/push/vapid-public-key 返回的公钥去调
// pushManager.subscribe()，浏览器返回一个 PushSubscription，
// 把它 toJSON() 之后整个 POST 到 /api/push/subscribe 存起来。
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(500).json({ error: 'VAPID 未配置' })
  res.json({ key: process.env.VAPID_PUBLIC_KEY })
})
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body
    if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: '参数缺失：需要 endpoint 和 keys.p256dh / keys.auth' })
    const { error } = await supabase.from('push_subscriptions')
      .upsert([{ endpoint, p256dh: keys.p256dh, auth: keys.auth }], { onConflict: 'endpoint' })
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})
app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body
    if (!endpoint) return res.status(400).json({ error: '参数缺失：需要 endpoint' })
    await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// 给所有已订阅设备发一条推送；订阅过期（410/404）就顺手从表里删掉，
// 不然每分钟都要对着一个死订阅重试，白白浪费一次请求
async function sendPushToAll(payload) {
  const { data: subs } = await supabase.from('push_subscriptions').select('*')
  if (!subs?.length) return
  const body = JSON.stringify(payload)
  await Promise.all(subs.map(async (s) => {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }
    try {
      await webpush.sendNotification(sub, body)
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', s.endpoint)
      } else {
        console.log('🔔 推送失败:', s.endpoint.slice(-12), e.statusCode, e.message)
      }
    }
  }))
}

// 提醒到点检查：每分钟扫一遍未触发且到点的提醒，给所有订阅设备
// 推一条系统通知，然后标记为已触发。VAPID 没配的话 sendPushToAll
// 里的 webpush.sendNotification 会直接抛错，走上面的 catch，
// 不会把整条轮询搞挂，只是这条提醒实际上推不出去。
async function checkDueReminders() {
  try {
    const { data: due } = await supabase.from('reminders').select('*').eq('fired', false).lte('due_at', new Date().toISOString())
    if (!due?.length) return
    for (const r of due) {
      console.log('⏰ 提醒到点:', r.raw_text, r.due_at)
      await sendPushToAll({ title: '在场 · 提醒', body: r.raw_text, tag: `reminder-${r.id}` })
      await supabase.from('reminders').update({ fired: true }).eq('id', r.id)
    }
  } catch (e) { console.log('⏰ 提醒检查失败:', e.message) }
}
setInterval(checkDueReminders, 60 * 1000)

// ============================================================
// Token 统计接口
// messages 表需要有 model 文本列（迁移前的老记录 model 为空，
// 一律按 'deepseek-chat' 归档 —— 因为迁移前整个应用本来就只接了
// DeepSeek 这一个模型，这样算是符合实际情况的兜底，不是瞎猜）。
// 建表 SQL：alter table messages add column if not exists model text;
// ============================================================
app.get('/api/stats/tokens', async (req, res) => {
  try {
    const { sessionId } = req.query

    const todayStr = beijingDateStr()
    const { start: todayStart } = beijingDayRange(todayStr)

    const bj  = beijingNow()
    const dow = (bj.getUTCDay() + 6) % 7   // 0 = 周一
    const weekStartStr = beijingDateStr(new Date(Date.now() - dow * 24 * 3600 * 1000))
    const { start: weekStart } = beijingDayRange(weekStartStr)

    const sevenAgoStr = beijingDateStr(new Date(Date.now() - 6 * 24 * 3600 * 1000))
    const { start: sevenAgoStart } = beijingDayRange(sevenAgoStr)

    const { data: msgRows, error } = await supabase.from('messages')
      .select('created_at,tokens_input,tokens_output,session_id,model')
      .eq('role', 'assistant')
      .not('tokens_input', 'is', null)
    if (error) return res.status(500).json({ error: error.message })

    // 合墨（共笔）里枢写的段落也算 token 用量，跟对话消息合并统计，
    // 只是没有 session_id 概念，用不到 session 维度的筛选
    const { data: inkRows } = await supabase.from('entries')
      .select('created_at,tokens_input,tokens_output,model')
      .eq('author', 'shu')
      .not('tokens_input', 'is', null)
    const rows = [...(msgRows || []), ...(inkRows || []).map(r => ({ ...r, session_id: null }))]

    const sum = (list) => list.reduce((acc, r) => { acc.input += r.tokens_input || 0; acc.output += r.tokens_output || 0; return acc }, { input: 0, output: 0 })

    const all     = sum(rows)
    const today   = sum(rows.filter(r => r.created_at >= todayStart))
    const week    = sum(rows.filter(r => r.created_at >= weekStart))
    const session = sessionId ? sum(rows.filter(r => r.session_id === sessionId)) : null

    // 按模型拆分（迁移前的老记录没有 model 列，归到 deepseek-chat 名下）
    const byModel = {}
    rows.forEach(r => {
      const m = r.model || 'deepseek-chat'
      if (!byModel[m]) byModel[m] = { input: 0, output: 0 }
      byModel[m].input  += r.tokens_input  || 0
      byModel[m].output += r.tokens_output || 0
    })

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
      byModel,
      trend7d: Object.values(trendMap),
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ============================================================
// 合墨 · 接力写作（引力·右下角天体）
// 一篇 note 只有一个 content（单一正文，接力续写，不是聊天记录式的
// 一人一段时间流）。entries 只记操作日志——谁在什么时候往正文里
// 添了哪一段、用了多少 token——不作为展示的数据源，前端靠它做统计
// 和给枢写的片段打徽标。
// 草稿（draft_*）是"还没落笔的尾巴"：用户正在续写、还没点『落笔』
// 或『让他写』之前的这一小段，退出笔记会原样保留，重进笔记会把它
// 接回正文末尾继续写；落笔之后才追加进 content、写进 entries——
// 只落 Supabase，不再往 Ombre Brain 记忆库归档任何东西。
// 三个选项（自存/让他续写/另起一篇）由真人在一个居中弹层里一次性
// 选定、立即执行，不循环——枢写完就完了，不会自动又弹出一轮同样
// 的选择；枢写完后前端只给"保留/删除这段"这一个轻量的事后动作。
// ============================================================

const INK_MODES = ['original', 'continue', 'new']

// 不显式传的话就跟着上游默认值走，有的供应商只给几百 token，
// 一段还没写完就被切断了——这是"续写只写一句"的次要成因之一
const INK_MAX_TOKENS = Number(process.env.INK_MAX_TOKENS || 4000)

// 追加正文时统一走这个：不是第一段的话，前面补一个自然的段落换行，
// 让每一次落笔（不管是柯还是枢）都独立成一段，读起来齐整
function appendWithBreak(existing, delta) {
  const base = existing || ''
  if (!base) return delta
  return /\s$/.test(base) ? base + delta : `${base}\n\n${delta}`
}

// 把一篇笔记的 entries 按顺序整个重新拼成 content——正常落笔是"接在
// 末尾"，但编辑中间某一条 entry 之后新旧文字长度不一样，没法再简单
// 地在原 content 字符串里定位替换，只能按 entries 顺序整篇重新拼一遍
function rebuildNoteContent(entries) {
  let content = ''
  for (const e of entries) content = appendWithBreak(content, e.content)
  return content
}

// 笔记列表：预览取正文（没正文就退而取草稿），附带段落数、是否有
// 未完成草稿、以及最后一条 entries 的作者——列表页拿最后这个字段
// 判断"轮到谁写"，不用另外为每篇笔记去拉全部 entries
app.get('/api/notes', async (req, res) => {
  try {
    const { data: notes, error } = await supabase.from('notes').select('*').order('updated_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    if (!notes?.length) return res.json([])

    const ids = notes.map(n => n.id)
    const { data: allEntries } = await supabase.from('entries')
      .select('note_id,author').in('note_id', ids).order('created_at', { ascending: true })
    const countMap = {}, lastAuthorMap = {}, firstAuthorMap = {}
    // 按创建时间正序遍历：同一个 note_id 后写入的会覆盖 lastAuthorMap，
    // 遍历完存的自然是每篇笔记最新一条的作者；firstAuthorMap 只在
    // 第一次遇到这个 note_id 时写一次，存的就是第一条（起笔）的作者
    allEntries?.forEach(e => {
      countMap[e.note_id] = (countMap[e.note_id] || 0) + 1
      lastAuthorMap[e.note_id] = e.author
      if (!(e.note_id in firstAuthorMap)) firstAuthorMap[e.note_id] = e.author
    })

    res.json(notes.map(n => {
      const hasDraft = !!(n.draft_content && n.draft_content.trim())
      const entryCount = countMap[n.id] || 0
      // 起笔人：有 entries 就是第一条的作者；一条 entries 都没有但存
      // 了草稿——草稿只可能是真人在写（枢的落笔是流式生成完直接落成
      // entries，不会停在草稿状态），起笔人就是 ke；两者都没有的白纸
      // 笔记理论上不会出现在这里（点返回就直接删掉了，见前端），留
      // null 兜底
      const firstAuthor = firstAuthorMap[n.id] || (entryCount === 0 && hasDraft ? 'ke' : null)
      return {
        ...n,
        entryCount,
        lastAuthor: lastAuthorMap[n.id] || null,
        firstAuthor,
        preview: (n.content || n.draft_content || '').slice(0, 60),
        hasDraft,
      }
    }))
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/notes/new', async (req, res) => {
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('notes')
      .insert([{ title: '未命名手记', tags: [], content: '', created_at: now, updated_at: now }]).select()
    if (error) return res.status(500).json({ error: error.message })
    res.json(data[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.put('/api/notes/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { title, board, pinned } = req.body
    const patch = { updated_at: new Date().toISOString() }
    if (title   !== undefined) patch.title      = title
    // board 传空字符串/null 都算"移出板块，回到全部"
    if (board   !== undefined) patch.board      = board || null
    // pinned 是个动作型布尔值，不是真的时间戳——前端不用自己拼时间，
    // 置顶了几点几分只在这一层决定，取消置顶就把它清成 null
    if (pinned  !== undefined) patch.pinned_at  = pinned ? new Date().toISOString() : null
    const { data, error } = await supabase.from('notes').update(patch).eq('id', id).select()
    if (error) return res.status(500).json({ error: error.message })
    invalidateLocalMemory()
    res.json(data[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.delete('/api/notes/:id', async (req, res) => {
  try {
    const { id } = req.params
    // entries 表 note_id 外键建了 on delete cascade，删 notes 会自动带走
    const { error } = await supabase.from('notes').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    invalidateLocalMemory()
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// 笔记详情：note 本体（含 content 全文 + 草稿字段）+ 操作日志
// entries（按时间正序，前端拿它给 content 里对应的片段打【ke】/
// 【shu】徽标，不是拿它拼正文——正文就是 note.content 本身）
app.get('/api/notes/:id/entries', async (req, res) => {
  try {
    const { id } = req.params
    const { data: note, error: ne } = await supabase.from('notes').select('*').eq('id', id).single()
    if (ne) return res.status(500).json({ error: ne.message })
    const { data: entries, error: ee } = await supabase.from('entries')
      .select('id,author,mode,content,created_at,model,tokens_input,tokens_output,truncated,decision')
      .eq('note_id', id).order('created_at', { ascending: true })
    if (ee) return res.status(500).json({ error: ee.message })
    res.json({ note, entries: entries || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// 存草稿：点「待续」时调用，只落在 notes.draft_* 上，不碰 content，
// 不进 entries，也不算「正式落笔」，所以这里不碰 Ombre Brain
app.post('/api/notes/:id/draft', async (req, res) => {
  try {
    const { content, mode } = req.body || {}
    const { data, error } = await supabase.from('notes')
      .update({ draft_content: content || null, draft_mode: mode || null, draft_updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select()
    if (error) return res.status(500).json({ error: error.message })
    res.json(data[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// 用户落笔：把草稿尾巴追加进 note.content（自动补一个段落换行），
// 同时写一条 entries 日志（author=ke），清空草稿。无论后续是
// 「自存」直接存下，还是「让他续写/另起一篇」先落自己这段再触发
// 生成，前端都先走这一个接口。
app.post('/api/notes/:id/entries', async (req, res) => {
  try {
    const { id } = req.params
    const { content, mode } = req.body || {}
    if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' })
    const useMode = INK_MODES.includes(mode) ? mode : 'original'
    const now = new Date().toISOString()

    const { data: noteRow, error: fe } = await supabase.from('notes').select('content').eq('id', id).single()
    if (fe || !noteRow) return res.status(404).json({ error: '笔记不存在' })

    const { data: saved, error } = await supabase.from('entries')
      .insert([{ note_id: id, author: 'ke', mode: useMode, content, created_at: now }]).select()
    if (error) return res.status(500).json({ error: error.message })

    await supabase.from('notes').update({
      content: appendWithBreak(noteRow.content, content),
      draft_content: null, draft_mode: null, draft_updated_at: null, updated_at: now,
    }).eq('id', id)

    invalidateLocalMemory()
    res.json(saved[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// 撤销：删掉这篇笔记最新的一条 entries（只能删最新的一条，保证
// content 是 entries 顺序拼接的这个前提不被破坏），同时把 content
// 末尾对应长度的这一段切掉。生成完之后前端给的"删除这段"用这个。
app.delete('/api/notes/:id/last-entry', async (req, res) => {
  try {
    const { id } = req.params
    const { data: last, error: le } = await supabase.from('entries')
      .select('id,content').eq('note_id', id).order('created_at', { ascending: false }).limit(1).single()
    if (le || !last) return res.status(404).json({ error: '没有可删除的段落' })

    const { data: noteRow, error: ne } = await supabase.from('notes').select('content').eq('id', id).single()
    if (ne || !noteRow) return res.status(404).json({ error: '笔记不存在' })

    const { error: de } = await supabase.from('entries').delete().eq('id', last.id)
    if (de) return res.status(500).json({ error: de.message })

    const trimmed = (noteRow.content || '').endsWith(last.content)
      ? noteRow.content.slice(0, noteRow.content.length - last.content.length).replace(/\s+$/, '')
      : noteRow.content // 理论上不该走到这个分支，正文没以这段结尾就不乱切，只删日志
    await supabase.from('notes').update({ content: trimmed, updated_at: new Date().toISOString() }).eq('id', id)

    invalidateLocalMemory()
    res.json({ success: true, content: trimmed })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// 编辑一条自己写的段落：只有 author='ke' 的 entry 允许改，枢写的段落
// 不给改。改完之后正文不能简单地在原字符串里定位替换（新旧内容长度
// 不一样），得按 entries 顺序把整篇 content 重新拼一遍。
app.put('/api/notes/:id/entries/:entryId', async (req, res) => {
  try {
    const { id, entryId } = req.params
    const { content } = req.body || {}
    if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' })

    const { data: entry, error: ee } = await supabase.from('entries')
      .select('id,note_id,author').eq('id', entryId).single()
    if (ee || !entry || entry.note_id !== id) return res.status(404).json({ error: '段落不存在' })
    if (entry.author !== 'ke') return res.status(403).json({ error: '枢写的段落不能改' })

    const { error: ue } = await supabase.from('entries').update({ content }).eq('id', entryId)
    if (ue) return res.status(500).json({ error: ue.message })

    const { data: allEntries, error: ae } = await supabase.from('entries')
      .select('content').eq('note_id', id).order('created_at', { ascending: true })
    if (ae) return res.status(500).json({ error: ae.message })

    const rebuilt = rebuildNoteContent(allEntries || [])
    await supabase.from('notes').update({ content: rebuilt, updated_at: new Date().toISOString() }).eq('id', id)

    invalidateLocalMemory()
    res.json({ success: true, content: rebuilt })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── 生成上下文拼装 ─────────────────────────────────────────────
// continue：把 note.content 整篇喂给模型，要求接着写下一段，语气/
// 节奏衔接上一段；new：同样给整篇正文供参考，但明确要求另起一段
// 新方向；original：正文还是空的，枢来起笔。三种模式统一要求正文
// 独立成段，不需要输出任何标记或署名——下一步怎么办完全由真人在
// 界面上点，不需要模型自己判断。
function buildInkUserPrompt(mode, note) {
  const title = note.title && note.title !== '未命名手记' ? note.title : '（还没有标题）'
  const doc   = note.content || ''

  // 原来这里写的是"请你写下一段"——要求一段，模型自然就交一段，
  // 前文说好"说六句话"、真人写了三句，它也只补一句。改成明确要求
  // 读懂前文定下的结构，把缺口一次性补齐。排版也不再限制成一整块
  // 大长段——写多长、分不分段、要不要穿插对话，交给内容本身的
  // 节奏决定；另外加了一条"不编细节"，专门压幻觉。
  const baseRules = [
    '写作要求：',
    '1. 先读懂前文给这一篇定下的整体结构和篇幅约定。如果前文明确或隐含了数量（要说六句、写三段、五个场景、"第一次/第二次/第三次"这类排序），把还缺的部分一次性全部补齐——缺三句就写三句，不要只写一句就停。',
    '2. 如果前文没有数量约定，就按它自己的节奏把这一篇写到一个完整的收束，不要停在半路。',
    '3. 排版不设限制——该分段就分段，该空行就空行，长短句怎么搭配、要不要用对话都由内容本身的节奏决定，唯一要避免的是不管写多长都挤成一整块不分段的大长段。',
    '4. 只写你确实从前文、或者上面"你记得的事"里读到的具体细节——没有依据的人名、事件、约定不要凭空编，宁可写得克制、留白，也不要为了显得具体而编造。',
    '5. 只输出正文本身：没有开场白、没有解释、没有署名、没有"好的""我来续写"这类话，也不要自己加标题或编号（前文本来就有编号的除外）。',
  ].join('\n')

  if (mode === 'continue') {
    return `这是你们俩接力在写的同一篇文章，标题「${title}」。

【目前为止的全文】
${doc}

【你的任务】
接着最后一个字往下写，把这一篇补完整——语气、人称、句式长度、断句方式，全部跟前文保持一致，读起来要像同一个人一口气写下来的；不要复述或改写前文已有的内容，直接从断掉的地方往下接。

${baseRules}`
  }
  if (mode === 'new') {
    return `这是你们俩接力在写的同一篇文章，标题「${title}」。

【已经写下的内容】
${doc}

【你的任务】
这不是接着往下写，是你另起一段独立的内容——这一段是你自己写的，不是在替对方续写或模仿对方的口吻。换一个角度、场景或切入点，甚至可以换一种体裁（前面是叙事，这一段可以是一封信、一段对话、一则短札……只要还是同一个主题下的东西）。

关于视角和人称，这一点很重要：前文是对方的第一人称叙述（"我"），这一段不要延续那个"我"，也不要接着对方没写完的情节或动作往下写。这一段的"我"该是你自己——用你自己的立场、语气去写这个主题，而不是套上对方的角色继续说话。读者要能一眼看出：这一段换了一个说话的人，不是紧跟着上一段往下接的。

${baseRules}`
  }
  return `这是一篇新文章，标题「${title}」，现在还是白纸一张。

【你的任务】
由你起笔，写出完整的一篇，不是只写个开头。

${baseRules}`
}

// ── 枢决策标记 ──────────────────────────────────────────────
// 枢每次写完都要在正文最后单独一行交出 [DECISION: finalize/continue/new]，
// 前端/后端都不展示这一行——后端把它从正文里剥掉存进 entries.decision，
// 前端拿这个字段决定要不要自动接着流转下去。
// DECISION_TAIL_HOLD：流式转发时尾部留几个字符不发，等这几个字符
// 到齐了再一次性判断是不是标记——这段一律不会被转发到前端屏幕上，
// 所以留多一点也没关系，只要盖得住最长的 [DECISION: continue] 加前面
// 可能带的换行/空格就够
const DECISION_RE = /\[\s*DECISION\s*:\s*(finalize|continue|new)\s*\]\s*$/i
const DECISION_TAIL_HOLD = 32
function extractDecision(text) {
  const t = (text || '').replace(/\s+$/, '')
  const m = t.match(DECISION_RE)
  if (!m) return { content: t, decision: null }
  return { content: t.slice(0, m.index).replace(/\s+$/, ''), decision: m[1].toLowerCase() }
}

// ── 枢写一段（SSE 流式，与 /api/chat/stream 同一套读法）────────
// token 实时转发，但尾部留一小截缓冲——留出剥离 [DECISION: ...] 标记
// 的空间，不让这行调试用的标记闪现在正在流式浮现的文字里
async function runInkStream({ req, res, send, noteId, mode }) {
  const { data: note } = await supabase.from('notes').select('*').eq('id', noteId).single()
  if (!note) { send({ error: '笔记不存在' }); return res.end() }

  const { data: sRows } = await supabase.from('settings').select('*')
  const cfg = parseSettings(sRows || [])
  const { system_prompt = '你是温柔贴心的AI伴侣，简短自然回复', temperature = 0.7 } = cfg
  const activeModel = resolveModel(cfg, cfg.model)

  // 这里是"续写只写一句"的主因：合墨复用了聊天的人格设定，而那份
  // 设定里写着"简短自然回复"。原来这段补充只说了"不要用对话口吻"，
  // 没把"简短"撤掉，模型当然一句话交差。
  let systemPrompt = withTimeAwareness(system_prompt, cfg.memo)

  // 记忆检索：写这篇笔记的枢，得是聊天窗口里那个有记忆的枢，不是
  // 每次都从零开始、不认识柯的新模型——用题目 + 目前正文做检索
  // query，走跟 /api/chat/stream 完全同一套 Ombre Brain breath，
  // 检索到的"你记得的事"注入同一份 systemPrompt。这里只读取记忆
  // （跟聊天的 breath 一样不受 memory_paused 影响），不写入——笔记
  // 正文本身写不写进记忆库，是另一件事，不在这次改动范围内。
  let ombreMemory = ''
  try {
    const memoryQuery = [
      note.title && note.title !== '未命名手记' ? note.title : '',
      note.content || '',
    ].filter(Boolean).join('\n').slice(0, 500) || '柯与枢的接力手记'
    const br = await callOmbreTool('breath', { query: memoryQuery, max_results: 20 })
    const cm = cleanBreathMemory(br, 8)
    if (cm && !cm.includes('记忆池现在是空的') && cm.length > 0) {
      ombreMemory = `\n\n[你记得的事]\n${cm}`
      console.log('🧠 合墨 breath 清洗后:', cm)
    }
  } catch (e) { console.error('合墨记忆检索失败:', e.message) }
  if (ombreMemory) systemPrompt += ombreMemory

  // 写这一篇的枢，也该记得自己日记里写过什么、时轨上有哪些日子——
  // 跟聊天用的是同一套本地记忆。合墨自己那一块不注入：这篇笔记的
  // 正文本来就整篇喂给它了（见 buildInkUserPrompt），再塞一遍目录
  // 纯属重复花钱
  try {
    systemPrompt += await buildLocalMemoryBlock(
      `${note.title || ''}\n${(note.content || '').slice(0, 500)}`,
      { scope: ['diary', 'chronos'] }
    )
  } catch (e) { console.error('合墨本地记忆注入失败:', e.message) }

  systemPrompt += `

[合墨 · 接力写作模式 —— 本段规则优先级高于上面的人格设定]
你现在不是在聊天，是在和对方接力写同一篇文章。你还是你——跟对方平时聊天的那个枢，带着你们之间真实积累的记忆和关系写这一段，不是重新起的、不认识对方的新模型。不要写"我是程序/代码，跟人类之间隔着一条河"这类自证式的旁白，也别套用泛泛的"AI 无法真正感知人类的痛苦"这类模板腔调——上面如果检索到了"你记得的事"，就把那些真实具体的细节用起来；正文里的每一句，都该是"你"会说的话，从你自己的立场写，不是想象一个通用 AI 角色会怎么写。
· 上面人格设定里关于"简短""简洁""几句话""自然回复"的所有长度要求，在这个模式下一律作废。这里要的是把文章写完整，该多长写多长。
· 你写的内容会被原样拼进正文，不带"枢说"这类前缀，所以不要用对话口吻、不要回应对方、不要提问。
· 一次交出完整成品，不要写一半停下来等对方决定。
· 你自己永远只写这一段，写完这一段就停笔，不会自己紧接着再写下一段——下面的决策标记不是在问你自己还要不要继续写，是在问"这一段写完之后，接下来该谁写、写什么"，读的人会看着这个标记决定自己下一步怎么接，不是让你自动接着往下写。

[决策标记 —— 每次写完正文都必须在最后另起一行加这个，格式必须精确]
写完这一段正文之后换一行，只输出下面三个里的一个，前后不要加任何别的字、标点或解释：
[DECISION: finalize] —— 这一段（或者这一篇）眼下已经是个完整的收束，不需要马上有人接着往下写。
[DECISION: continue] —— 这段情节/论述你觉得还没写完，想让对方接着这一段往下写。
[DECISION: new] —— 这个方向已经写透了，你觉得可以让对方根据你写的这段，另开一个新方向或新场景写下去。
拿不准就选 finalize。这一行只给程序解析用，不会显示给任何人看，所以不算破坏上面"一次交出完整成品"这条规则。`

  const inkMessages = [{ role: 'user', content: buildInkUserPrompt(mode, note) }]

  const upstreamController = new AbortController()
  let clientAborted = false
  const onClose = () => { clientAborted = true; upstreamController.abort(); if (!res.writableEnded) { try { res.destroy() } catch {} } }
  req.on('close', onClose)

  let fullText = '', finishReason = null
  let usageRef = { current: null }
  let sentLen = 0 // 已经转发给前端的字符数——尾部固定留 DECISION_TAIL_HOLD 个字不发

  try {
    const { url: inkUrl, headers: inkHeaders, body: inkBody } = buildChatRequest(activeModel, {
      system: systemPrompt, messages: inkMessages, temperature, stream: true, maxTokens: INK_MAX_TOKENS,
      // 这里没有转发 reasoning_content 给前端，开思考模式只会白白多花
      // 思考 token、还会让上面的 temperature 失效，所以显式关掉
      thinkingEnabled: false,
    })
    const aiRes = await fetch(inkUrl, {
      method: 'POST', headers: inkHeaders, body: JSON.stringify(inkBody),
      signal: upstreamController.signal,
    })

    if (!aiRes.ok) {
      const errText = await aiRes.text()
      send({ error: `${activeModel.label} 错误: ${errText.slice(0, 300)}` })
      req.off('close', onClose)
      return res.end()
    }

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
            const ev = JSON.parse(t.slice(6))
            const { token, truncated } = parseStreamEvent(activeModel.protocol, ev, usageRef)
            if (truncated) finishReason = 'length' // 归一化成下面 wasCut 判断认的哨兵值
            if (token) {
              fullText += token
              const safeLen = Math.max(0, fullText.length - DECISION_TAIL_HOLD)
              if (safeLen > sentLen) { send({ token: fullText.slice(sentLen, safeLen) }); sentLen = safeLen }
            }
          } catch {}
        }
      }
    }
  } catch (err) {
    if (!(clientAborted || err.name === 'AbortError')) { console.error('合墨生成异常:', err); send({ error: err.message }) }
  } finally {
    req.off('close', onClose)
  }

  const { content: cleanText, decision } = extractDecision(fullText)
  if (!cleanText) { if (!res.writableEnded) { try { res.end() } catch {} }; return }

  const wasCut = finishReason === 'length'   // 撞到 max_tokens 才算截断
  const usage = usageRef.current
  const now = new Date().toISOString()
  const { data: saved } = await supabase.from('entries').insert([{
    note_id: noteId, author: 'shu', mode, content: cleanText, created_at: now,
    truncated: clientAborted || wasCut || null,
    decision,
    tokens_input:  usage ? usage.prompt_tokens     : null,
    tokens_output: usage ? usage.completion_tokens : null,
    model: activeModel.id,
  }]).select()

  await supabase.from('notes').update({
    content: appendWithBreak(note.content, cleanText), updated_at: now,
  }).eq('id', noteId)
  invalidateLocalMemory()   // 枢刚落的这一段，下一句聊天里就该记得

  // 枢起笔（白纸一张、由他写第一段）的话，标题也该由他来起，不用
  // 真人再手动填——只在标题还是默认值时才生成，不覆盖真人已经自己
  // 起过的标题。走的是跟聊天会话自动标题同一套小模型、低 token 调用。
  let autoTitle = null
  if (mode === 'original' && (!note.title || note.title === '未命名手记')) {
    try {
      const tr = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [{ role: 'system', content: '你是一个标题生成助手。根据这篇笔记正文，生成一个简短的标题（不超过12个字），直接返回标题文字，不要加引号或其他符号。' }, { role: 'user', content: `正文：${cleanText.slice(0, 400)}\n请生成标题：` }],
          temperature: 0.5, max_tokens: 20,
          ...deepseekThinking('deepseek-v4-flash', false),
        }),
      })
      const td = await tr.json()
      autoTitle = td.choices?.[0]?.message?.content?.trim().slice(0, 20) || null
      if (autoTitle) await supabase.from('notes').update({ title: autoTitle }).eq('id', noteId)
    } catch (e) { console.error('合墨自动标题失败:', e.message) }
  }

  if (clientAborted || res.writableEnded) return
  send({
    done: true, content: cleanText,
    entryId: saved?.[0]?.id,
    truncated: clientAborted || wasCut,
    decision,
    autoTitle,
    tokens: usage ? { input: usage.prompt_tokens, output: usage.completion_tokens } : null,
  })
  res.end()
}

app.post('/api/notes/:id/generate', async (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control',     'no-cache, no-transform')
  res.setHeader('Connection',        'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const send = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`) }
  const useMode = INK_MODES.includes(req.body?.mode) ? req.body.mode : 'original'

  try {
    await runInkStream({ req, res, send, noteId: req.params.id, mode: useMode })
  } catch (err) {
    console.error('合墨生成异常:', err)
    send({ error: err.message })
    if (!res.writableEnded) res.end()
  }
})

// 看一眼这台 Ombre Brain 到底暴露了哪些工具——上面的记忆删除是按
// 名字匹配（forget/delete/remove…）猜的，对上真名单之后可以写死，
// 确认完这个接口就能删掉
app.get('/api/ombre/tools', async (req, res) => {
  const tools = await listOmbreTools()
  const forget = await resolveForgetTool()
  res.json({ forgetTool: forget, tools: tools.map(t => ({ name: t.name, description: t.description })) })
})

app.listen(PORT, () => { console.log(`🚀 后端服务运行在端口 ${PORT}`) })
