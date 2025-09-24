import 'dotenv/config';
import express from 'express';
import { middleware, Client } from '@line/bot-sdk';
import { predictVeggie } from './teachable.js';
import { getMessageBuffer } from './utils.js';
import { veggiesInfo, resolveVeggie } from './veggies.js';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error('❌ โปรดตั้งค่า LINE_CHANNEL_ACCESS_TOKEN และ LINE_CHANNEL_SECRET ใน ENV');
  process.exit(1);
}

const MIN_CONF = 0.65; // เกณฑ์ความมั่นใจ (0..1) ปรับได้

const app = express();
const client = new Client(config);

// Health check
app.get('/', (_req, res) => res.send('Veggie Bot on Render ✅'));

// Webhook endpoint
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;

  // ---------- รับรูปภาพ ----------
  if (event.message.type === 'image') {
    try {
      const buf = await getMessageBuffer(client, event.message.id);
      const { label, confidences } = await predictVeggie(buf);

      const top = confidences[0];
      const confStr = confidences
        .slice(0, 3)
        .map(c => `${c.label}: ${(c.prob * 100).toFixed(1)}%`)
        .join('\n');

      // กรณีความมั่นใจต่ำ
      if (top.prob < MIN_CONF) {
        const unsureText =
          `🤔 ยังไม่มั่นใจ (${(top.prob * 100).toFixed(1)}%)\n` +
          `Top 3:\n${confStr}\n\n` +
          `ช่วยส่งรูปที่ชัดขึ้น/หลายมุม หรือพิมพ์ชื่อผัก (EN/TH) ได้เลยครับ เช่น: Carrot`;
        return client.replyMessage(event.replyToken, { type: 'text', text: unsureText });
      }

      // map ชื่อที่ทาย → คีย์ในฐานข้อมูล
      const key = resolveVeggie(label);
      const info = veggiesInfo[key];

      const shownName = info?.nameTH ? `${key} (${info.nameTH})` : key;

      let replyText = `🥬 ผักที่คาดว่าเป็น: ${shownName}\nความมั่นใจ (Top 3)\n${confStr}`;
      if (info) {
        replyText += `\n\nประโยชน์: ${info.benefit}\nเมนูแนะนำ: ${info.menu}`;
      } else {
        replyText += `\n\nℹ️ ยังไม่มีข้อมูลประโยชน์/เมนูของ "${shownName}"\n` +
          `พิมพ์: เพิ่มข้อมูล ${key} ไทย=<ชื่อไทย> ประโยชน์=<ข้อความ> เมนู=<ข้อความ>`;
      }

      return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
    } catch (e) {
      console.error('predict error:', e);
      return client.replyMessage(event.replyToken, { type: 'text', text: 'ขออภัย วิเคราะห์ภาพไม่สำเร็จ 😢' });
    }
  }

  // ---------- รับข้อความ ----------
  if (event.message.type === 'text') {
    const text = (event.message.text || '').trim();

    if (/^ช่วย|วิธีใช้|help$/i.test(text)) {
      const guide =
        `ส่งรูปผักให้บอททายชื่อ พร้อมประโยชน์และเมนู\n` +
        `- ถ้าทายไม่ชัวร์จะบอกเปอร์เซ็นต์และขอรูปใหม่\n` +
        `- เพิ่มข้อมูลเองได้ เช่น:\n` +
        `  เพิ่มข้อมูล Carrot ไทย=แครอท ประโยชน์=บำรุงสายตา เมนู=แกงส้มแครอท`;
      return client.replyMessage(event.replyToken, { type: 'text', text: guide });
    }

    // เพิ่มข้อมูลผ่านแชท (ไทย= เป็น option)
    if (text.startsWith('เพิ่มข้อมูล ')) {
      const m = text.match(/^เพิ่มข้อมูล\s+(\S+)\s+(?:ไทย=(.+?)\s+)?ประโยชน์=(.+?)\s+เมนู=(.+)$/);
      if (m) {
        const nameEN = resolveVeggie(m[1]);
        const nameTH = (m[2] || veggiesInfo[nameEN]?.nameTH || '').trim();
        const benefit = m[3].trim();
        const menu = m[4].trim();
        const current = veggiesInfo[nameEN] || { nameTH: '', benefit: '', menu: '' };
        veggiesInfo[nameEN] = { ...current, nameTH, benefit, menu };
        return client.replyMessage(
          event.replyToken,
          { type: 'text', text: `บันทึกข้อมูลผัก "${nameEN}${nameTH ? ` (${nameTH})` : ''}" แล้ว ✅` }
        );
      }
      return client.replyMessage(
        event.replyToken,
        { type: 'text', text: 'รูปแบบไม่ถูกต้อง ลอง: เพิ่มข้อมูล Carrot ไทย=แครอท ประโยชน์=... เมนู=...' }
      );
    }

    // ผู้ใช้พิมพ์ชื่อผักมาโดยตรง → แสดงข้อมูลถ้ามี
    const key = resolveVeggie(text);
    if (veggiesInfo[key]) {
      const v = veggiesInfo[key];
      const shownName = v.nameTH ? `${key} (${v.nameTH})` : key;
      const msg = `🥬 ${shownName}\nประโยชน์: ${v.benefit}\nเมนูแนะนำ: ${v.menu}`;
      return client.replyMessage(event.replyToken, { type: 'text', text: msg });
    }

    return client.replyMessage(event.replyToken, { type: 'text', text: 'ส่งรูปผักมาได้เลย หรือพิมพ์ "ช่วย" เพื่อดูวิธีใช้' });
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server listening on :${PORT}`));
