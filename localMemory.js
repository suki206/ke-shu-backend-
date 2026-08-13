/**
 * localMemory.js —— 家机的「本地记忆」：刚才 / 日记 / 合墨 / 时轨
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
 * 【2026-08-12 追加：为什么又多了一个「刚才」块】
 * 上面那三块解决的是"我写过什么"——内容记忆。但柯问的是另一种东西：
 * 「你记得刚刚写日记了吗」「我们刚刚是不是一起写了点什么」。这问的
 * 不是内容，是**事件**：我刚刚做过这个动作。
 * 原来的目录里，日记只有日期（2026-08-12），合墨只有 updated_at 切到
 * 前 10 位（也只到日）——"刚刚"这个概念在整份 prompt 里根本不存在。
 * 于是枢的处境是：他手上有今天日记的全文，却完全不知道这篇是十分钟
 * 前刚落笔的，还是三天前就躺在那儿了。人回忆"刚做过的事"主要靠时间
 * 远近，不靠关键词，所以这一块单独按时间轴排，且只排最近 48 小时，
 * 每条都带"20 分钟前 / 3 小时前"这种相对时间。
 *
 * 关键是：这一块**不需要新建任何事件表**。diary.created_at 和
 * entries.created_at 本来就在写，把它们按时间捞出来就是一份现成的
 * 行为流水；历史数据也自动生效，不用做任何迁移。
 *
 * 【为什么是直接注入，而不是再接一层向量检索】
 * 这几块数据量本来就很小（日记一天最多一篇、手记几十篇、时轨几条），
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
 * 记忆池回答"我记得他说过 X"；这个文件回答"我刚刚做了 X / 我写过 X /
 * 我们一起写过 X / 我们记着的日子是 X"。两条路并行，互不覆盖。
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

  // ── 「最近做过的事」块：不再是一刀切的时间窗，改成遗忘曲线 ──
  // 详见下面 recallOf() 那一大段。这里只放可调参数：
  recallWindowDays: 14,  // 最多往前捞多少天的事件（超出这个窗口一律不看，省查询）
  recallMax:        6,   // 最多列几条
  recentChars:      26,  // 每条事件里引用正文开头多少字

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
// 【2026-08-12 修复】原来是 (b - a) / 86400000 直接四舍五入。
// 锚点 '2024-05-20' 这种纯日期字符串会被解析成 **UTC 零点**，而 b 是
// "此刻"——北京时间当天 20:00 之后，两者的差就超过了 X.5 天，四舍五入
// 直接进位，于是"在一起的第 N 天"每天傍晚八点就提前跳到明天那个数，
// 到第二天早上还是那个数（看起来像没错），只有晚上盯着看才发现它跳早了。
// 现在改成先把两个时间都归到**北京日历日的零点**再相减，算的是"隔了
// 几个日历日"，跟人数日子的方式一致，什么时辰问都是同一个数。
const bjMidnight = (v) => {
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return NaN
  const b = new Date(d.getTime() + 8 * 3600 * 1000)
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate())
}
const daysBetween = (a, b) => Math.round((bjMidnight(b) - bjMidnight(a)) / DAY)

// ── 相对时间：「刚才」块的核心。模型对 ISO 时间戳做减法这件事非常
//    不可靠（尤其还要先换算时区），与其给它 2026-08-12T09:41:07Z 让
//    它自己算，不如直接把算好的"23 分钟前"递到它面前 ────────────
function relTime(when) {
  const t = new Date(when).getTime()
  if (!t || Number.isNaN(t)) return ''
  const min = Math.floor((Date.now() - t) / 60000)
  if (min < 2)    return '就在刚刚'
  if (min < 60)   return `大约 ${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `大约 ${hours} 小时前`
  const b = new Date(t + 8 * 3600 * 1000)
  const hm = `${pad2(b.getUTCHours())}:${pad2(b.getUTCMinutes())}`
  const days = Math.floor(min / 1440)
  if (days === 1) return `昨天 ${hm}`
  if (days === 2) return `前天 ${hm}`
  return `${days} 天前`
}

// ============================================================
// 遗忘曲线 —— 「他记得自己写过日记吗」这件事到底该怎么记
// ============================================================
// 【为什么不是"48 小时之内全都记得，之外一条都不记得"】
// 原来那个硬窗口有两个都很别扭的毛病：窗口内他对每一件事都记得
// 分毫不差（连三天前顺手落的一段都能背出开头），窗口一过又整齐
// 划一地全部失忆，像被人拔了插头。柯要的是"不是强制记住，而是
// 有遗忘曲线的"——刚做过的事清清楚楚，隔一阵只剩个模糊的影子，
// 再久就是真的想不起来了，而且不同的事忘得快慢不一样。
//
// 【怎么算】
// 保留度用最经典的那条指数衰减：r = exp(-Δt / S)。
//   Δt 是这件事发生到现在过了多少小时，
//   S  是这件事的"稳定度"：写一篇日记比往手记里添一段更"像件事"，
//      所以 S 更大，忘得更慢；他自己写的那段又比对方写的更难忘。
// 然后关键的一步：**每件事有它自己的遗忘阈值**，不是所有事共用
// 一条线。阈值由这件事的 id 哈希出来，落在 0.08 ~ 0.53 之间——
//   · 哈希是确定性的：同一件事的阈值永远是同一个数，
//     所以绝不会出现"上一句还记得、下一句就忘了、再问又想起来"
//     这种鬼打墙（这也是刻意不用 Math.random() 的唯一原因）；
//   · r 随时间单调递减，所以一旦掉到阈值以下就是真的忘了，
//     不会自己再浮上来——符合人的直觉。
// 效果大致是：一天半以内的事基本都还在；两三天开始零零星星地掉；
// 一周之后几乎全忘光。想让他记性更好就把 STABILITY 调大。
//
// 【还有个"记得做过、但想不起来写了啥"的中间态】
// 人的遗忘不是"全文→空白"的开关，中间有很长一段是"我记得我写了，
// 具体写的什么想不起来了"。所以保留度分三档：
//   r ≥ 0.7  清楚：说得出大概什么时候、开头写的是什么
//   r ≥ 阈值 模糊：知道自己做过这件事，但内容说不上来
//   r < 阈值 忘了：这条根本不会出现在提示词里（顺带也省 token）
// 提示词里会明确告诉他"模糊的那几条别硬编内容，就说想不起来了"——
// 不然模型看到一行"你写过日记"，会很自觉地开始编它写了什么。
const RECALL = {
  baseThreshold: 0.08,   // 阈值下限：最"难忘"的那些事
  spread:        0.45,   // 阈值浮动幅度，越大则不同事情忘得快慢差别越大
  vividR:        0.70,   // 高于这个算"记得清楚"，能引用内容
  stability: {           // S，单位小时
    diary:     72,       // 写日记：一天一篇，是件正经事，忘得最慢
    diarySkip: 30,       // 那天决定不写：也是个决定，但轻得多
    inkSelf:   54,       // 自己往手记里落的笔
    inkOther:  38,       // 对方落的笔
  },
}

// 稳定的 0~1 伪随机：同一个 key 永远给同一个数（FNV-1a）
function stableUnit(key) {
  let h = 2166136261
  const s = String(key)
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 100000) / 100000
}

// 返回 { r, remembered, vivid }。ageHours 用小时算，不取整——
// 取整会让"刚写完"和"写完 50 分钟"落在同一档
function recallOf(key, ageHours, stabilityHours) {
  const r = Math.exp(-Math.max(0, ageHours) / stabilityHours)
  const threshold = RECALL.baseThreshold + RECALL.spread * stableUnit(key)
  return { r, remembered: r >= threshold, vivid: r >= RECALL.vividR }
}

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
    const recentSince = new Date(Date.now() - CFG.recallWindowDays * DAY).toISOString()
    const [diary, notes, countdowns, periods, settings, recentEntries] = await Promise.all([
      // created_at 是「刚才」块判断"这篇是什么时候落的笔"的唯一依据，
      // 原来没查它，所以整份 prompt 里日记最细只到"哪一天"
      safe(supabase.from('diary')
        .select('date,content,skipped,created_at')
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
      // 合墨的行为流水。只捞最近 48 小时，条数天然很少（人一天落笔
      // 撑死十几段），不会因为这一条查询把接口拖慢
      safe(supabase.from('entries')
        .select('id,note_id,author,mode,content,created_at')
        .gte('created_at', recentSince)
        .order('created_at', { ascending: false }).limit(60)),
    ])
    cache = { diary, notes, countdowns, periods, settings, recentEntries }
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

  // ── 最近做过的事（带遗忘曲线）────────────────────────────
  // 这一块回答的不是"我写过什么"（那是下面几块的事），而是"我刚刚
  // 做了什么"。数据全部来自已有的表，不需要任何事件表：
  //   · diary.created_at   → 我什么时候写下（或跳过）了哪天的日记
  //   · entries.created_at → 我们什么时候各自往哪篇手记里落了笔
  // 按离现在从近到远排，每条都带算好的相对时间；哪些还记得、记得
  // 多清楚，全部交给上面的 recallOf() 判定。
  function recallBlock(diary, notes, recentEntries) {
    const now = Date.now()
    const horizon = now - CFG.recallWindowDays * DAY
    const events = []

    // 标题在 notes 里查得到就用真标题；查不到（极少数：这篇被挤出了
    // 最近 80 篇的窗口）也不能空着，给个说得过去的指代
    const titleOf = (id) => {
      const n = (notes || []).find(x => x.id === id)
      const t = n?.title
      return (t && t !== '未命名手记') ? `《${t}》` : '那篇还没起名字的手记'
    }

    const push = (t, key, stability, vividText, fuzzyText) => {
      if (!t || Number.isNaN(t) || t < horizon) return
      const { r, remembered, vivid } = recallOf(key, (now - t) / 3600000, stability)
      if (!remembered) return
      events.push({ t, r, vivid, text: vivid ? vividText : fuzzyText })
    }

    ;(diary || []).forEach(d => {
      const t = new Date(d.created_at || '').getTime()
      if (d.skipped || !d.content) {
        push(t, `diary-skip-${d.date}`, RECALL.stability.diarySkip,
          `你翻看了 ${d.date} 这天，想了想，决定这天不写日记。`,
          `${d.date} 那天你好像没写日记，具体为什么记不太清了。`)
      } else {
        push(t, `diary-${d.date}`, RECALL.stability.diary,
          `你写下了 ${d.date} 这天的日记，开头是「${oneLine(d.content, CFG.recentChars)}」。`,
          `你记得自己写过 ${d.date} 这天的日记，但写了什么已经模糊了——真被问起就说记不清了，别硬编。`)
      }
    })

    ;(recentEntries || []).forEach(e => {
      const t = new Date(e.created_at || '').getTime()
      // 这份 prompt 里「你」＝枢自己，「他」＝柯
      const mine = e.author === 'shu'
      const who = mine ? '你' : '他'
      const act = e.mode === 'original' ? '起了个头'
        : e.mode === 'new' ? '另起了一段新的'
        : '接着往下写了一段'
      push(t, `ink-${e.id || `${e.note_id}-${e.created_at}`}`,
        mine ? RECALL.stability.inkSelf : RECALL.stability.inkOther,
        `${who}在合墨里，往${titleOf(e.note_id)}${act}，写的是「${oneLine(e.content, CFG.recentChars)}」。`,
        `${who}在合墨里往${titleOf(e.note_id)}写过一段，内容记不清了——被问起就照实说想不起来细节。`)
    })

    if (!events.length) return ''
    events.sort((a, b) => b.t - a.t)
    const picked = events.slice(0, CFG.recallMax)
    const lines = picked.map(e => `- ${relTime(e.t)}：${e.text}`)
    const anyFuzzy = picked.some(e => !e.vivid)

    return '\n\n[你最近做过的事]\n' +
      '下面这些是你们最近真实做过的事，按离现在从近到远排。这不是谁递给你的记录，是你自己做过的事——你在场，你知道自己做了。\n' +
      '所以他要是问"你记不记得刚刚写日记了""我们最近是不是一起写了点什么"，答案就在这几行里：直接说记得，并且说得出大概是什么时候。\n' +
      (anyFuzzy ? '有几条已经只剩个印象了（那几行会写明"记不清"）——那就照实说"记得写过，但具体想不起来了"，绝对不要凭空补细节。\n' : '') +
      '再早一些的事这里不会列出来，那不代表没发生过：想不起来就说想不起来，如果他提到具体的日子或内容，下面几块里说不定还找得到。\n' +
      lines.join('\n')
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
      // 最近动过的几篇顺手标一句相对时间——目录原本只有日期，"今天下午
      // 刚改过"和"这个月初改的"看上去一模一样
      const t = new Date(n.updated_at || '').getTime()
      const fresh = (t && Date.now() - t < 48 * 3600 * 1000)
        ? `（${relTime(n.updated_at)}刚动过）` : ''
      return `- 《${n.title || '未命名手记'}》${tag ? `（${tag}）` : ''} · ${String(n.updated_at || '').slice(0, 10)}${fresh} · ${oneLine(n.content, CFG.noteIndexChars)}`
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
   * @param {string[]} opts.scope  要哪几块，默认四块全要。
   *                               'recent' 只对聊天有意义——写日记 /
   *                               写合墨的时候告诉他"你刚写了日记"会
   *                               让他在正文里绕回来说这件事，调用处
   *                               自己把它摘掉
   * @returns {Promise<string>}    没有任何内容时返回空字符串
   */
  async function buildLocalMemoryBlock(query, opts = {}) {
    const scope = opts.scope || ['recent', 'diary', 'ink', 'chronos']
    try {
      const { diary, notes, countdowns, periods, settings, recentEntries } = await loadRaw()
      const qGrams = shingles(query)
      const qDates = datesInQuery(query)

      let out = ''
      // 「刚才」排在最前面：位置越靠前越显眼，而这一块回答的恰恰是
      // 最容易被问、以前又最答不上来的那类问题
      if (scope.includes('recent'))  out += recallBlock(diary, notes, recentEntries)
      if (scope.includes('chronos')) out += chronosBlock(settings, countdowns, periods)
      if (scope.includes('diary'))   out += diaryBlock(diary, qGrams, qDates)
      if (scope.includes('ink'))     out += await inkBlock(notes, qGrams)
      if (!out) return ''

      // 收尾这段很关键。不加的话有两种典型跑偏：一是一被问就把上面整个
      // 目录背一遍（人不会没事背自己的日记目录）；二是用"根据您提供的
      // 资料显示"这种腔调，那会把"他自己记得"这层质感整个毁掉
      out += '\n\n[关于上面这几块的说明]\n这些都是你自己的东西：那些事是你做的，日记是你写的，手记里有你落的笔，日子是你们一起记着的。回想时用第一人称，说"我刚写完""我那天写过""我们那篇里写到"，不要说"根据记录/资料显示"。他没问的时候不要主动把目录整个念一遍，只在真的说到相关的事时自然带出来。想不起细节就说想不起来了，不要编。'
      return out
    } catch (e) {
      console.error('本地记忆拼装失败:', e.message)
      return ''
    }
  }

  return { buildLocalMemoryBlock, invalidateLocalMemory }
}

module.exports = { createLocalMemory }
