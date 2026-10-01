import crypto from 'node:crypto';

export function validateTelegram(initData, token, now = Date.now()) {
  if (!token || typeof initData !== 'string' || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  if (new Set([...params.keys()]).size !== [...params.keys()].length) return null;
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;
  const authDate = Number(params.get('auth_date'));
  const age = now / 1000 - authDate;
  if (!authDate || !Number.isFinite(age) || age < -60 || age > 86400) return null;
  try {
    const user = JSON.parse(params.get('user'));
    if (!Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return {id: String(user.id), name: String(user.first_name || user.username || 'Player').slice(0,50)};
  } catch { return null; }
}

export default function mountScores(app, express, pool, options) {
  const {token, origin = 'https://stonk-city-v2-game-pup.onrender.com'} = options;
  if (token && options.startBot !== false) startStonkBot(token, origin).catch(() => console.error('Stonk City Telegram bot could not initialize. Check the bot token.'));
  let ready;
  async function databaseReady() {
    if (!ready) ready = pool.query(`CREATE TABLE IF NOT EXISTS stonk_scores (
      telegram_id BIGINT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('city', 'space')),
      display_name TEXT NOT NULL,
      score INTEGER NOT NULL CHECK (score >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (telegram_id, mode)
    )`).catch(error => {ready = null; throw error;});
    return ready;
  }
  app.use('/api/stonk-city', (req,res,next) => {
    const requestOrigin = req.get('Origin');
    if (requestOrigin && requestOrigin !== origin) return res.status(403).json({error:'Origin not allowed'});
    if (requestOrigin) res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary','Origin');
    res.set('Cache-Control','no-store');
    res.set('Access-Control-Allow-Methods','GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers','Content-Type,X-Telegram-Init-Data');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  }, express.json({limit:'2kb'}));
  app.get('/api/stonk-city/health', async (_req,res) => {
    try {
      if (!token || !options.databaseConfigured) return res.status(503).json({error:'Score settings are missing'});
      await databaseReady();
      res.json({ok:true,service:'stonk-city-scores'});
    } catch {res.status(503).json({error:'Score database unavailable'});}
  });
  app.get('/api/stonk-city/leaderboard', async (req,res) => {
    const mode = req.query.mode || 'city';
    if (!['city','space'].includes(mode)) return res.status(400).json({error:'Invalid mode'});
    try {
      await databaseReady();
      const {rows} = await pool.query('SELECT display_name, score AS best_score FROM stonk_scores WHERE mode=$1 ORDER BY score DESC, updated_at ASC, telegram_id ASC LIMIT 25',[mode]);
      res.json({scores:rows});
    } catch {res.status(503).json({error:'Leaderboard database unavailable'});}
  });
  app.post('/api/stonk-city/score', async (req,res) => {
    const user = validateTelegram(req.get('X-Telegram-Init-Data'),token);
    if (!user) return res.status(401).json({error:'Open Stonk City using the Mini App button in @GAMEPUPbot to save scores.'});
    const {mode,score} = req.body || {};
    if (!['city','space'].includes(mode) || !Number.isInteger(score) || score < 0 || score > 10000000)
      return res.status(400).json({error:'Invalid score'});
    try {
      await databaseReady();
      const {rows} = await pool.query(`INSERT INTO stonk_scores (telegram_id,mode,display_name,score)
        VALUES ($1,$2,$3,$4) ON CONFLICT (telegram_id,mode) DO UPDATE SET
        display_name=EXCLUDED.display_name, score=GREATEST(stonk_scores.score,EXCLUDED.score),
        updated_at=CASE WHEN EXCLUDED.score>stonk_scores.score THEN now() ELSE stonk_scores.updated_at END
        RETURNING score AS best_score`,[user.id,mode,user.name,score]);
      res.json({best_score:rows[0].best_score});
    } catch {res.status(503).json({error:'Score database unavailable. Retry saving your score.'});}
  });
  app.use('/api/stonk-city', (error,_req,res,_next) => {
    res.status(error.status === 413 ? 413 : 400).json({error:error.status === 413 ? 'Request too large' : 'Invalid request'});
  });
}

export function isStonkCommand(text, username) {
  if (typeof text !== 'string') return false;
  const match = text.trim().match(/^\/(stonkcity|start)(?:@([a-z0-9_]+))?(?:\s+(.*))?$/i);
  if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return false;
  return match[1].toLowerCase() === 'stonkcity' || match[3] === 'stonkcity' || !match[3];
}

async function startStonkBot(token, gameUrl) {
  async function telegram(method, body = {}) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
      signal:AbortSignal.timeout(35000)
    });
    const data = await response.json();
    if (!data.ok) {const error = new Error('Telegram request failed');error.code = data.error_code;throw error;}
    return data.result;
  }
  const me = await telegram('getMe');
  const webhook = await telegram('getWebhookInfo');
  if (webhook.url) {
    console.error('Stonk City command requires integration with the bot existing webhook; polling was not started.');
    return;
  }
  try {
    const commands = await telegram('getMyCommands');
    const merged = commands.filter(command => command.command !== 'stonkcity');
    merged.push({command:'stonkcity',description:'Play Stonk City and save your high score'});
    await telegram('setMyCommands',{commands:merged.slice(0,100)});
  } catch {console.error('Could not register the Telegram command menu. /stonkcity can still be typed.');}
  let offset = 0, stopped = false;
  const stop = () => {stopped = true;};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  console.log('Stonk City Telegram /stonkcity command listener started.');
  while (!stopped) {
    try {
      const updates = await telegram('getUpdates',{offset,timeout:25,allowed_updates:['message']});
      for (const update of updates) {
        const message = update.message;
        if (message && isStonkCommand(message.text,me.username)) {
          const button = message.chat.type === 'private'
            ? {text:'🎮 PLAY STONK CITY',web_app:{url:gameUrl}}
            : {text:'🎮 PLAY STONK CITY',url:`https://t.me/${me.username}?start=stonkcity`};
          await telegram('sendMessage',{
            chat_id:message.chat.id,
            text:message.chat.type === 'private'
              ? '🎮 STONK CITY\nChoose your hero. Smash the shorts. Climb the leaderboard!\nTap PLAY STONK CITY below.'
              : '🎮 STONK CITY\nTap below to open the bot, then tap Start and PLAY STONK CITY.',
            reply_markup:{inline_keyboard:[[button]]}
          });
        }
        offset = update.update_id + 1;
      }
    } catch(error) {
      if (error.code === 409) {
        console.error('Another Telegram listener is using this bot. Stop the duplicate listener before using /stonkcity.');
        return;
      }
      console.error('Telegram command listener will retry.');
      await new Promise(resolve => setTimeout(resolve,5000));
    }
  }
}
