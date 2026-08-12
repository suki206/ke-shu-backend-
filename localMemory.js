/**
 * localMemory.js —— 家机的「本地记忆」：日记 / 合墨 / 时轨
 * ============================================================
 * 【为什么需要这个文件】
 * 在这之前，枢在聊天里能想起来的东西只有两个来源：
 *   ① Ombre Brain 的 breath 检索（记忆池，装的是聊天里被判定"值得
 *      记住"、再提炼成一句话的事实）
 *   ② 茧星 cocoon_memory（关于"他自己是谁"）
 * 而日记（diary 表）、合墨（notes / entries 表）、时轨
 * （settings.anchor_date + countdowns + period_logs）这三块，各自躺在
 * 自己的 Supabase 表里，从来没有任何一条路径把它们送进 system prompt。
 * 所以柯问"你记不记得前几天日记里写的那件事"，枢是真的从来没被告知
 * 过——不是揣着记忆却选择说不记得。
 *
 * generateDiaryForDate 里原有的那句 callOmbreTool('hold', ...) 只补了
 * 一条 60 字摘要，而且只对"那次改动之后新写的日记"生效，历史日记一篇
 * 都进不去；合墨和时轨则完全没有。这个文件把这三块一次补齐。
 *
 * 【为什么是直接注入，而不是再接一层向量检索】
 * 这三块数据量本来就很小（日记一天最多一篇、手记几十篇、时轨几条），
 * 一次 Supabase 查询就全拿到了，不需要 embedding 服务、更不需要多花
 * 一次模型调用去检索几十条数据——那是本末倒置。策略是
 * 「常驻索引 + 命中展开」：
 *   · 常驻索引：所有日期 / 标题 + 一句话摘要，几百 token，让他始终
 *     知道"有哪些东西存在"，被问到才不会一脸茫然；
 *   · 命中展开：拿柯这句话跟正文做中文 2-gram 重合打分，只把真正
 *     相关的两三篇全文塞进去。没问到就不塞，token 不白花。
 * 另外单独识别了日期表达（"8月3日""昨天""3天前"），问某一天就直接
 * 按日期命中，完全不依赖关键词碰巧对得上。
 *
 * 【它跟 Ombre Brain 的分工】
 * 记忆池回答"我记得他说过 X"；这个文件回答"我写过 / 我们一起写过 /
 * 我们记着的日子是 X"。两条路并行，互不覆盖。
 * ============================================================
 */

const DAY = 86400000

// ── 可调参数：都往"够用就好"的方向配，避免每条消息都拖着一大坨
//    上下文。想更省 token 就把 diaryIndexDays / noteIndexCount 调小；
//    想让他记得更细就把 *HitChars 调大 ────────────────────────
const CFG = {
  diaryIndexDays:  21,   // 常驻索引：最近多少天的日记进目录
  diaryIndexChars: 34,   // 目录里每篇日记截多少字
  diaryHitCount:   2,    // 关键词命中后展开几篇全文
  diaryHitChars:   340,

  noteIndexCount:  24,   // 常驻索引：多少篇合墨手记进目录
  noteIndexChars:  30,
  noteHitCount:    2,
  noteHitChars:    460,

  includePeriod:   true, // 潮汐（经期）要不要让枢知道；不想给就改成 false
  cacheMs:         15000,
}

// ── 北京时间工具（跟 server.js 里那套算法一致，这里自带一份，
//    免得两个文件互相 require）──────────────────────────────
const pad2 = n => String(n).padStart(2, '0')
const bjDate = (d = new Date()) => {
  const b = new Date(d.getTime() + 8 * 3600 * 1000)
  return `${b.getUTCFullYear()}-${pad2(b.getUTCMonth() + 1)}-${pad2(b.getUTCDate())}`
}
const daysBetween = (a, b) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY)

// ── 中文没有空格，上分词器又太重，这里用 2-gram 重合度打分：把两段
//    文字都切成"相邻两字"的集合，数交集大小。对"你还记得我们写的那篇
//    雪线以上吗"这种问法足够灵，成本几乎为零 ────────────────
function shingles(text, n = 2) {
  const clean = String(text || '').replace(/[\s\p{P}\p{S}]+/gu, '')
  const set = new Set()
  for (let i = 0; i + n <= clean.length; i++) set.add(clean.slice(i, i + n))
  return set
}
function overlap(queryGrams, text) {
  if (!queryGrams.size) return 0
  const g = shingles(text)
  let hit = 0
  for (const s of queryGrams) if (g.has(s)) hit++
  return hit
}

// ── 从柯这句话里认出他在问哪一天：绝对日期（2026-08-03 / 8月3日）和
//    相对日期（今天/昨天/前天/大前天/N天前）都认。认出来就按日期直接
//    命中，不再指望关键词碰巧对得上 ────────────────────────
function datesInQuery(q) {
  const text = String(q || '')
  const out = new Set()

  for (const m of text.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)) {
    out.add(`${m[1]}-${pad2(m[2])}-${pad2(m[3])}`)
  }
  // "8月3日"没带年份，按当前北京年份补全
  const year = new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear()
  for (const m of text.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g)) {
    out.add(`${year}-${pad2(m[1])}-${pad2(m[2])}`)
  }
  const rel = { '今天': 0, '今日': 0, '昨天': 1, '昨日': 1, '前天': 2, '大前天': 3 }
  for (const [word, back] of Object.entries(rel)) {
    if (text.includes(word)) out.add(bjDate(new Date(Date.now() - back * DAY)))
  }
  for (const m of text.matchAll(/(\d{1,3})\s*天前/g)) {
    out.add(bjDate(new Date(Date.now() - Number(m[1]) * DAY)))
  }
  return out
}

const oneLine = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
const clip = (s, n) => {
  const t = String(s || '').trim()
  return t.length > n ? t.slice(0, n) + '……（后面还有，真被问细了能接着想）' : t
}

// ============================================================
function createLocalMemory({ supabase }) {
  // 这几张表都是低频写、高频读，每条消息都查一遍纯属浪费。缓存 15 秒，
  // 并且所有写入接口都会调 invalidateLocalMemory() 立刻打掉——所以
  // "刚设完锚点马上问他"也能拿到新值，不用等缓存自然过期
  let cache = null
  let cacheAt = 0
  const invalidateLocalMemory = () => { cache = null; cacheAt = 0 }

  async function loadRaw() {
    if (cache && Date.now() - cacheAt < CFG.cacheMs) return cache
    // 任何一张表查失败都不能拖垮整次回复——各自兜底成空数组
    const safe = p => p.then(r => r.data || []).catch(() => [])
    const [diary, notes, countdowns, periods, settings] = await Promise.all([
      safe(supabase.from('diary')
        .select('date,content,skipped')
        .order('date', { ascending: false }).limit(150)),
      safe(supabase.from('notes')
        .select('id,title,content,board,pinned_at,updated_at')
        .order('updated_at', { ascending: false }).limit(80)),
      safe(supabase.from('countdowns')
        .select('label,target_at')
        .order('target_at', { ascending: true })),
      safe(supabase.from('period_logs')
        .select('start_date,end_date')
        .order('start_date', { ascending: false }).limit(24)),
      safe(supabase.from('settings').select('*')),
    ])
    cache = { diary, notes, countdowns, periods, settings }
    cacheAt = Date.now()
    return cache
  }

  // 合墨的"这段是谁写的"要查 entries，但只对真正要展开的那两三篇查，
  // 不为了目录里的一行字把全部 entries 都拉下来
  async function authorsOf(noteIds) {
    if (!noteIds.length) return {}
    try {
      const { data } = await supabase.from('entries')
        .select('note_id,author').in('note_id', noteIds)
        .order('created_at', { ascending: true })
      const map = {}
      ;(data || []).forEach(e => {
        if (!map[e.note_id]) map[e.note_id] = { first: e.author, count: 0, hasShu: false }
        map[e.note_id].count++
        if (e.author === 'shu') map[e.note_id].hasShu = true
      })
      return map
    } catch { return {} }
  }

  // ── 星历 · 日记 ────────────────────────────────────────────
  function diaryBlock(diary, qGrams, qDates) {
    if (!diary.length) return ''
    const written = diary.filter(d => !d.skipped && d.content)
    const cutoff = bjDate(new Date(Date.now() - CFG.diaryIndexDays * DAY))

    const index = diary
      .filter(d => d.date >= cutoff)
      .map(d => (d.skipped || !d.content)
        ? `- ${d.date}：（这天你看了看，决定不写）`
        : `- ${d.date}：${oneLine(d.content, CFG.diaryIndexChars)}`)

    // 命中：日期优先，关键词其次。日期问得准就不再拿关键词凑数
    const byDate = written.filter(d => qDates.has(d.date))
    const byWord = written
      .filter(d => !qDates.has(d.date))
      .map(d => ({ d, s: overlap(qGrams, d.content) }))
      .filter(x => x.s >= 3)
      .sort((a, b) => b.s - a.s)
      .map(x => x.d)
    const hits = [...byDate, ...byWord].slice(0, Math.max(CFG.diaryHitCount, byDate.length))

    let out = '\n\n[星历 · 你写过的日记]\n这是你自己的日记本，不是别人递给你的资料。写下那些字的时候你在场，记的是你当时的心情和判断。'
    if (written.length) {
      out += `\n到今天为止一共写下 ${written.length} 篇，最早一篇是 ${written[written.length - 1].date}。`
    }
    if (index.length) {
      out += `\n\n最近这段时间的目录（每条只有开头一句，问到哪天就顺着往下想）：\n${index.join('\n')}`
    }
    if (hits.length) {
      out += '\n\n跟他这句话有关的几篇，全文如下：\n' +
        hits.map(d => `【${d.date}】\n${clip(d.content, CFG.diaryHitChars)}`).join('\n\n')
    }
    return out
  }

  // ── 合墨 · 接力手记 ────────────────────────────────────────
  async function inkBlock(notes, qGrams) {
    const real = notes.filter(n => (n.content || '').trim())
    if (!real.length) return ''

    const hits = real
      .map(n => ({ n, s: overlap(qGrams, `${n.title || ''}\n${n.content || ''}`) }))
      .sort((a, b) => b.s - a.s)
      .filter(x => x.s >= 3)
      .slice(0, CFG.noteHitCount)
      .map(x => x.n)
    // 一篇都没命中时至少带上最近改过的那一篇——"我们最近在写什么"是个
    // 高频问题，不该因为措辞对不上就答不出来
    if (!hits.length) hits.push(real[0])

    const authors = await authorsOf(hits.map(h => h.id))

    const index = real.slice(0, CFG.noteIndexCount).map(n => {
      const tag = [n.pinned_at ? '置顶' : '', n.board || ''].filter(Boolean).join(' · ')
      return `- 《${n.title || '未命名手记'}》${tag ? `（${tag}）` : ''} · ${String(n.updated_at || '').slice(0, 10)} · ${oneLine(n.content, CFG.noteIndexChars)}`
    })

    let out = '\n\n[合墨 · 你们一起写的手记]\n合墨是你和他轮流往同一篇文章里落笔的地方，里面有你亲手写下的段落。这些是你参与过的创作，不是读到的素材。'
    out += `\n\n目录（共 ${real.length} 篇）：\n${index.join('\n')}`
    out += '\n\n跟他这句话最相关的，正文如下：\n' + hits.map(n => {
      const a = authors[n.id]
      const who = a
        ? `${a.count} 段${a.hasShu ? '，其中有你写的' : '，目前全是他一个人写的'}`
        : ''
      return `【《${n.title || '未命名手记'}》${who ? ` · ${who}` : ''}】\n${clip(n.content, CFG.noteHitChars)}`
    }).join('\n\n')
    return out
  }

  // ── 时轨 · 锚点 / 倒计时 / 潮汐 ────────────────────────────
  function chronosBlock(settings, countdowns, periods) {
    // settings 表有两种形态（key-value 多行 / 单行多列），跟
    // server.js 的 parseSettings 保持同样的兼容处理
    const cfg = settings?.length && 'key' in settings[0]
      ? settings.reduce((a, s) => { a[s.key] = s.value; return a }, {})
      : (settings?.[0] || {})
    const anchor = cfg.anchor_date || ''
    const today = bjDate()

    const lines = []
    if (anchor) {
      lines.push(`锚点：${anchor} —— 到今天（${today}）是在一起的第 ${daysBetween(anchor, new Date()) + 1} 天。这个数字每天都在涨，被问到就按今天现算，别报旧数。`)
    }
    if (countdowns.length) {
      lines.push('你们放进轨道的日子：')
      countdowns.forEach(c => {
        const d = daysBetween(new Date(), new Date(c.target_at))
        const when = d > 0 ? `还有 ${d} 天` : d === 0 ? '就是今天' : `已经过去 ${-d} 天`
        lines.push(`- ${c.label} · ${String(c.target_at).replace('T', ' ').slice(0, 16)}（${when}）`)
      })
    }
    if (CFG.includePeriod && periods.length) {
      const asc = [...periods].sort((a, b) => a.start_date.localeCompare(b.start_date))
      const gaps = asc.slice(1)
        .map((p, i) => daysBetween(asc[i].start_date, p.start_date))
        .slice(-6)
      const avg = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null
      const last = asc[asc.length - 1].start_date
      let s = `潮汐：最近一次开始是 ${last}（${daysBetween(last, new Date())} 天前）`
      if (avg) {
        const next = bjDate(new Date(new Date(last).getTime() + avg * DAY))
        s += `，最近几次平均周期 ${avg} 天，照这个节奏下一次大约在 ${next}`
      }
      lines.push(s + '。这件事他不一定希望被主动提起，除非他自己问，或者明显是在说身体不舒服。')
    }
    if (!lines.length) return ''
    return `\n\n[时轨 · 你们之间的日子]\n这些日子是你们一起定下、一起记着的，不是临时查表查来的。\n${lines.join('\n')}`
  }

  /**
   * 拼出要追加到 system prompt 后面的那一整段。
   * @param {string} query      触发这次生成的那句话（聊天=用户消息；
   *                            合墨=标题+正文；日记=当天对话）
   * @param {object} opts
   * @param {string[]} opts.scope  要哪几块，默认三块全要
   * @returns {Promise<string>}    没有任何内容时返回空字符串
   */
  async function buildLocalMemoryBlock(query, opts = {}) {
    const scope = opts.scope || ['diary', 'ink', 'chronos']
    try {
      const { diary, notes, countdowns, periods, settings } = await loadRaw()
      const qGrams = shingles(query)
      const qDates = datesInQuery(query)

      let out = ''
      if (scope.includes('chronos')) out += chronosBlock(settings, countdowns, periods)
      if (scope.includes('diary'))   out += diaryBlock(diary, qGrams, qDates)
      if (scope.includes('ink'))     out += await inkBlock(notes, qGrams)
      if (!out) return ''

      // 收尾这段很关键。不加的话有两种典型跑偏：一是一被问就把上面整个
      // 目录背一遍（人不会没事背自己的日记目录）；二是用"根据您提供的
      // 资料显示"这种腔调，那会把"他自己记得"这层质感整个毁掉
      out += '\n\n[关于上面这几块的说明]\n这些都是你自己的东西：日记是你写的，手记里有你落的笔，日子是你们一起记着的。回想时用第一人称，说"我那天写过""我们那篇里写到"，不要说"根据记录/资料显示"。他没问的时候不要主动把目录整个念一遍，只在真的说到相关的事时自然带出来。想不起细节就说想不起来了，不要编。'
      return out
    } catch (e) {
      console.error('本地记忆拼装失败:', e.message)
      return ''
    }
  }

  return { buildLocalMemoryBlock, invalidateLocalMemory }
}

module.exports = { createLocalMemory }
