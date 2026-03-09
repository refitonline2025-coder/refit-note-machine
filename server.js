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
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
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
        refit_post_numbers TEXT DEFAULT '',
        post_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id SERIAL PRIMARY KEY,
        article_title TEXT,
        likes_estimate INT,
        structure_pattern TEXT,
        keywords TEXT,
        cta_content TEXT,
        source_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS articles (
        id SERIAL PRIMARY KEY,
        customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        title TEXT,
        body TEXT,
        status TEXT DEFAULT 'draft',
        refit_included BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Default settings
    await client.query(`
      INSERT INTO settings (key, value) VALUES ('like_threshold', '100')
      ON CONFLICT (key) DO NOTHING;
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

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
    const result = await pool.query('SELECT value FROM settings WHERE key = $1', [req.params.key]);
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
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
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
    const result = await pool.query('SELECT * FROM knowledge ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/knowledge/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM knowledge WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Research ---
app.post('/api/research', async (req, res) => {
  try {
    const thresholdResult = await pool.query("SELECT value FROM settings WHERE key = 'like_threshold'");
    const threshold = thresholdResult.rows[0]?.value || '100';

    const systemPrompt = `あなたはNoteのダイエット・食事系記事のリサーチ専門家です。
WebSearchを使い、現在Noteでバズっているダイエット・食事系の人気記事を
10件以上調査してください。各記事について以下をJSON形式で返してください：
article_title, likes_estimate（推定いいね数）, structure_pattern
（見出し構成・文字数・導線の特徴）, keywords（配列）,
cta_content（LINE誘導文やCTAの内容）, source_url
閾値：${threshold}以上のもののみ含めること。
必ずJSONの配列のみを返し、他のテキストは含めないこと。`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 10,
      }],
      messages: [
        {
          role: 'user',
          content: 'Noteのダイエット・食事系の人気記事をリサーチして、JSON形式で結果を返してください。',
        },
      ],
    });

    // Extract text from response
    let resultText = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        resultText += block.text;
      }
    }

    // Parse JSON from response
    let articles = [];
    try {
      // Try to extract JSON array from response
      const jsonMatch = resultText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        articles = JSON.parse(jsonMatch[0]);
      } else {
        // Try parsing as-is
        articles = JSON.parse(resultText);
      }
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr.message);
      console.error('Raw response:', resultText);
      return res.status(500).json({ error: 'リサーチ結果のパースに失敗しました。再度お試しください。' });
    }

    if (!Array.isArray(articles)) {
      articles = [articles];
    }

    // Save to knowledge DB
    let savedCount = 0;
    for (const article of articles) {
      const likesEstimate = parseInt(article.likes_estimate) || 0;
      if (likesEstimate >= parseInt(threshold)) {
        await pool.query(
          `INSERT INTO knowledge (article_title, likes_estimate, structure_pattern, keywords, cta_content, source_url)
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

    res.json({ success: true, savedCount, totalFound: articles.length });
  } catch (err) {
    console.error('Research error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Customers ---
app.get('/api/customers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM customers ORDER BY created_at DESC');
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
      refit_trigger, refit_post_numbers,
    } = req.body;
    const result = await pool.query(
      `INSERT INTO customers (nickname, age_group, job_lifestyle, diet_concerns,
        initial_status, current_status, personality, living_env,
        refit_trigger, refit_post_numbers)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [nickname, age_group, job_lifestyle, diet_concerns,
        initial_status, current_status, personality, living_env,
        refit_trigger, refit_post_numbers || '']
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
      refit_trigger, refit_post_numbers,
    } = req.body;
    const result = await pool.query(
      `UPDATE customers SET nickname=$1, age_group=$2, job_lifestyle=$3, diet_concerns=$4,
        initial_status=$5, current_status=$6, personality=$7, living_env=$8,
        refit_trigger=$9, refit_post_numbers=$10
       WHERE id=$11 RETURNING *`,
      [nickname, age_group, job_lifestyle, diet_concerns,
        initial_status, current_status, personality, living_env,
        refit_trigger, refit_post_numbers || '', req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/customers/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM customers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Articles ---
app.get('/api/articles', async (req, res) => {
  try {
    const { status } = req.query;
    let query = `SELECT a.*, c.nickname FROM articles a
                 LEFT JOIN customers c ON a.customer_id = c.id
                 ORDER BY a.created_at DESC`;
    const params = [];
    if (status && status !== 'all') {
      query = `SELECT a.*, c.nickname FROM articles a
               LEFT JOIN customers c ON a.customer_id = c.id
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
    const { customer_id, additional_notes } = req.body;

    // Get customer
    const custResult = await pool.query('SELECT * FROM customers WHERE id = $1', [customer_id]);
    if (custResult.rows.length === 0) {
      return res.status(404).json({ error: '顧客が見つかりません' });
    }
    const customer = custResult.rows[0];
    const nextPostNumber = customer.post_count + 1;

    // Check if ReFit should be mentioned
    const refitNumbers = customer.refit_post_numbers
      ? customer.refit_post_numbers.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n))
      : [];
    const includeRefit = refitNumbers.includes(nextPostNumber);

    // Get knowledge for context
    const knowledgeResult = await pool.query(
      'SELECT article_title, structure_pattern, keywords, cta_content FROM knowledge ORDER BY created_at DESC LIMIT 10'
    );
    const knowledgeSummary = knowledgeResult.rows.map(k =>
      `タイトル: ${k.article_title}\n構成: ${k.structure_pattern}\nキーワード: ${k.keywords}\nCTA: ${k.cta_content}`
    ).join('\n---\n');

    const systemPrompt = `あなたは30〜40代女性の体験談をNote記事として書くライターです。
以下のルールを厳守してください：
- 一人称は「私」
- 顧客の性格・文体イメージに合わせた自然な文体
- 1500〜2000文字程度
- 見出し（##）を2〜3個
- ReFit言及指示がある場合のみ、記事後半にさりげなく1回だけ触れる
- ReFit言及なしの場合は純粋な体験談として書く
- タイトルは最初の行に「# タイトル」形式
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
- ReFitを知ったきっかけ: ${customer.refit_trigger}

【ReFit言及】${includeRefit ? 'この記事ではReFitにさりげなく1回だけ言及してください。' : 'この記事ではReFitには一切触れないでください。純粋な体験談として書いてください。'}

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
      `INSERT INTO articles (customer_id, title, body, status, refit_included)
       VALUES ($1, $2, $3, 'pending', $4) RETURNING *`,
      [customer_id, title, articleText, includeRefit]
    );

    // Update post count
    await pool.query('UPDATE customers SET post_count = $1 WHERE id = $2', [nextPostNumber, customer_id]);

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
      "UPDATE articles SET status = 'approved' WHERE id = $1 RETURNING *",
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
    await pool.query('DELETE FROM articles WHERE id = $1', [req.params.id]);
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
