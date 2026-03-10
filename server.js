require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk').default;
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.PASSWORD || '112311';

// --- Database ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

// --- Anthropic ---
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Middleware ---
app.use(express.json());
app.use(express.static('public'));

// --- DB Init ---
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS refit_customers (
      id SERIAL PRIMARY KEY,
      nickname TEXT NOT NULL,
      age_group TEXT,
      job_lifestyle TEXT,
      diet_concerns TEXT,
      initial_status TEXT,
      current_status TEXT,
      personality TEXT,
      living_env TEXT,
      refit_trigger TEXT,
      refit_post_numbers TEXT,
      post_count INTEGER DEFAULT 0,
      themes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refit_knowledge (
      id SERIAL PRIMARY KEY,
      article_title TEXT,
      likes_estimate INTEGER,
      structure_pattern TEXT,
      keywords TEXT,
      cta_content TEXT,
      source_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refit_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refit_articles (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES refit_customers(id) ON DELETE CASCADE,
      title TEXT,
      body TEXT,
      status TEXT DEFAULT 'pending',
      refit_included BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Migrations for existing tables
  await pool.query(`ALTER TABLE refit_customers ADD COLUMN IF NOT EXISTS themes TEXT`);

  await pool.query(`
    INSERT INTO refit_settings (key, value) VALUES ('like_threshold', '100')
    ON CONFLICT (key) DO NOTHING
  `);

  console.log('Database initialized');
}

// --- Health ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --- Auth ---
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, message: 'パスワードが違います' });
});

// --- Settings ---
app.get('/api/settings/:key', async (req, res) => {
  try {
    const result = await pool.query('SELECT value FROM refit_settings WHERE key = $1', [req.params.key]);
    if (result.rows.length === 0) return res.json({ value: null });
    res.json({ value: result.rows[0].value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    await pool.query(
      'INSERT INTO refit_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, value]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Knowledge ---
app.get('/api/knowledge', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM refit_knowledge ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/knowledge/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM refit_knowledge WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Research (2-batch split for rate limit) ---
async function searchBatch(keywords, threshold) {
  const systemPrompt = `あなたはNoteのダイエット・食事系記事のリサーチ専門家です。
WebSearchを使い、以下のキーワードで必ずNote.com内の記事を検索してください。

検索キーワード：
${keywords.map(k => '- ' + k).join('\n')}

各記事について以下をJSON配列形式で返してください：
[{
  "article_title": "記事タイトル",
  "likes_estimate": いいね推定数（数値）,
  "structure_pattern": "見出し構成・文字数・導線の特徴の説明",
  "keywords": ["キーワード1", "キーワード2"],
  "cta_content": "LINE誘導文やCTAの内容",
  "source_url": "https://note.com/...の実際のURL"
}]

重要なルール：
- 必ずNote.com（https://note.com/）のURLのみを返す
- 実在する記事のURLのみ返す。存在が不確かなURLは含めない
- ダイエット・食事・体重管理・食事指導に関係ない記事は除外する
- URLが取得できない記事は除外する
- 閾値（${threshold}いいね）以上と推定される記事のみ含める
- JSONのみ返し、他のテキストは一切含めない`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: systemPrompt,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,
    }],
    messages: [
      {
        role: 'user',
        content: 'Noteのダイエット・食事系の人気記事をリサーチして、JSON形式で結果を返してください。',
      },
    ],
  });

  let resultText = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      resultText += block.text;
    }
  }

  try {
    const jsonMatch = resultText.match(/\[[\s\S]*\]/);
    let parsed = [];
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      parsed = JSON.parse(resultText);
    }
    if (!Array.isArray(parsed)) parsed = [parsed];
    return parsed;
  } catch (parseErr) {
    console.error('JSON parse error in batch:', parseErr.message);
    return [];
  }
}

app.post('/api/research', async (req, res) => {
  try {
    const thresholdResult = await pool.query("SELECT value FROM refit_settings WHERE key = 'like_threshold'");
    const threshold = thresholdResult.rows[0]?.value || '100';

    const batch1 = ['site:note.com ダイエット 体験談', 'site:note.com 食事制限 30代 女性'];
    const batch2 = ['site:note.com 食事管理 痩せた', 'site:note.com オンライン食事指導', 'site:note.com ダイエット 成功 主婦'];

    const results1 = await searchBatch(batch1, threshold);
    const results2 = await searchBatch(batch2, threshold);
    const allArticles = [...results1, ...results2];

    if (allArticles.length === 0) {
      return res.status(500).json({ error: 'リサーチ結果のパースに失敗しました。再度お試しください。' });
    }

    // Save to knowledge DB (deduplicate by source_url)
    let savedCount = 0;
    const seenUrls = new Set();
    for (const article of allArticles) {
      const likesEstimate = parseInt(article.likes_estimate) || 0;
      if (!article.source_url || !article.source_url.includes('note.com')) {
        continue;
      }
      if (seenUrls.has(article.source_url)) continue;
      seenUrls.add(article.source_url);
      if (likesEstimate >= parseInt(threshold)) {
        await pool.query(
          `INSERT INTO refit_knowledge (article_title, likes_estimate, structure_pattern, keywords, cta_content, source_url)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            article.article_title || '',
            likesEstimate,
            article.structure_pattern || '',
            Array.isArray(article.keywords) ? article.keywords.join(', ') : (article.keywords || ''),
            article.cta_content || '',
            article.source_url || '',
          ]
        );
        savedCount++;
      }
    }

    res.json({ success: true, savedCount, totalFound: allArticles.length });
  } catch (err) {
    console.error('Research error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Customers ---
app.get('/api/customers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM refit_customers ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers', async (req, res) => {
  try {
    const {
      nickname, age_group, job_lifestyle, diet_concerns,
      initial_status, current_status, personality, living_env,
      refit_trigger, refit_post_numbers, themes,
    } = req.body;
    const result = await pool.query(
      `INSERT INTO refit_customers (nickname, age_group, job_lifestyle, diet_concerns,
        initial_status, current_status, personality, living_env,
        refit_trigger, refit_post_numbers, themes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [nickname, age_group, job_lifestyle, diet_concerns,
        initial_status, current_status, personality, living_env,
        refit_trigger, refit_post_numbers || '', themes || '']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/customers/:id', async (req, res) => {
  try {
    const {
      nickname, age_group, job_lifestyle, diet_concerns,
      initial_status, current_status, personality, living_env,
      refit_trigger, refit_post_numbers, themes,
    } = req.body;
    const result = await pool.query(
      `UPDATE refit_customers SET nickname=$1, age_group=$2, job_lifestyle=$3, diet_concerns=$4,
        initial_status=$5, current_status=$6, personality=$7, living_env=$8,
        refit_trigger=$9, refit_post_numbers=$10, themes=$11
       WHERE id=$12 RETURNING *`,
      [nickname, age_group, job_lifestyle, diet_concerns,
        initial_status, current_status, personality, living_env,
        refit_trigger, refit_post_numbers || '', themes || '', req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/customers/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM refit_customers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Articles ---
app.get('/api/articles', async (req, res) => {
  try {
    const { status } = req.query;
    let query = `SELECT a.*, c.nickname FROM refit_articles a
                 LEFT JOIN refit_customers c ON a.customer_id = c.id
                 ORDER BY a.created_at DESC`;
    const params = [];
    if (status && status !== 'all') {
      query = `SELECT a.*, c.nickname FROM refit_articles a
               LEFT JOIN refit_customers c ON a.customer_id = c.id
               WHERE a.status = $1
               ORDER BY a.created_at DESC`;
      params.push(status);
    }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/articles/generate', async (req, res) => {
  try {
    const { customer_id, additional_notes, theme } = req.body;

    // Get customer
    const custResult = await pool.query('SELECT * FROM refit_customers WHERE id = $1', [customer_id]);
    if (custResult.rows.length === 0) {
      return res.status(404).json({ error: '顧客が見つかりません' });
    }
    const customer = custResult.rows[0];
    const nextPostNumber = customer.post_count + 1;

    // Check if ReFit Online should be mentioned
    const refitNumbers = customer.refit_post_numbers
      ? customer.refit_post_numbers.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n))
      : [];
    const includeRefit = refitNumbers.includes(nextPostNumber);

    // Parse customer themes for fallback
    const themesMap = {};
    if (customer.themes) {
      customer.themes.split('\n').forEach(line => {
        const match = line.match(/^(\d+)[：:](.+)/);
        if (match) themesMap[parseInt(match[1])] = match[2].trim();
      });
    }
    const effectiveTheme = theme || themesMap[nextPostNumber] || '';

    // Get knowledge for context
    const knowledgeResult = await pool.query(
      'SELECT article_title, structure_pattern, keywords, cta_content FROM refit_knowledge ORDER BY created_at DESC LIMIT 10'
    );
    const knowledgeSummary = knowledgeResult.rows.map(k =>
      `タイトル: ${k.article_title}\n構成: ${k.structure_pattern}\nキーワード: ${k.keywords}\nCTA: ${k.cta_content}`
    ).join('\n---\n');

    const systemPrompt = `あなたは30〜40代女性の体験談をNote記事として書くライターです。
以下のルールを厳守してください：
- 一人称は「私」
- 顧客の性格・文体イメージに合わせた自然な文体
- 1500〜2000文字程度
- タイトルは「# タイトル」形式（H1）で出力
- 見出しは「## **見出しテキスト**」形式（H2・太字）で2〜3個
- Note貼り付け時にそのままMarkdown形式で反映されるよう、Markdown記法を厳守すること
- ReFit Online言及指示がある場合のみ、記事後半にさりげなく1回だけ触れる
- ReFit Online言及なしの場合は純粋な体験談として書く
- 以下のナレッジを参考にバズりやすい構成にすること：
${knowledgeSummary || '（ナレッジなし）'}`;

    const userMessage = `以下の顧客ペルソナに基づいて、${nextPostNumber}本目のNote記事を作成してください。

【顧客情報】
- ニックネーム: ${customer.nickname}
- 年代: ${customer.age_group}
- 職業・ライフスタイル: ${customer.job_lifestyle}
- ダイエットの悩み: ${customer.diet_concerns}
- 開始時の状態: ${customer.initial_status}
- 現在の状態: ${customer.current_status}
- 性格・文体イメージ: ${customer.personality}
- 生活環境: ${customer.living_env}
- ReFit Onlineを知ったきっかけ: ${customer.refit_trigger}

【ReFit Online言及】${includeRefit ? 'この記事ではReFit Onlineにさりげなく1回だけ言及してください。' : 'この記事ではReFit Onlineには一切触れないでください。純粋な体験談として書いてください。'}

${effectiveTheme ? `【今回のテーマ・フレームワーク】\n${effectiveTheme}` : ''}

${additional_notes ? `【追記・今回特に触れたいこと】\n${additional_notes}` : ''}

記事を作成してください。`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    let articleText = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        articleText += block.text;
      }
    }

    // Extract title from first line
    let title = '';
    const lines = articleText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('# ')) {
        title = trimmed.replace(/^#\s+/, '');
        break;
      }
    }
    if (!title) {
      title = `${customer.nickname}の体験談 ${nextPostNumber}本目`;
    }

    // Save article
    const articleResult = await pool.query(
      `INSERT INTO refit_articles (customer_id, title, body, status, refit_included)
       VALUES ($1, $2, $3, 'pending', $4) RETURNING *`,
      [customer_id, title, articleText, includeRefit]
    );

    // Update post count
    await pool.query('UPDATE refit_customers SET post_count = $1 WHERE id = $2', [nextPostNumber, customer_id]);

    const article = articleResult.rows[0];
    article.nickname = customer.nickname;
    article.post_number = nextPostNumber;

    res.json(article);
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/articles/:id/approve', async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE refit_articles SET status = 'approved' WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '記事が見つかりません' });
    }

    const article = result.rows[0];

    // Send LINE Notify if token is configured
    if (process.env.LINE_NOTIFY_TOKEN) {
      try {
        await sendLineNotify(`【ReFit Note】記事が承認されました\nタイトル: ${article.title}`);
      } catch (lineErr) {
        console.error('LINE Notify error:', lineErr.message);
      }
    }

    res.json(article);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/articles/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM refit_articles WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- LINE Notify ---
function sendLineNotify(message) {
  return new Promise((resolve, reject) => {
    const postData = `message=${encodeURIComponent(message)}`;
    const options = {
      hostname: 'notify-api.line.me',
      path: '/api/notify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${process.env.LINE_NOTIFY_TOKEN}`,
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else reject(new Error(`LINE Notify error: ${res.statusCode} ${data}`));
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// --- Start ---
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
